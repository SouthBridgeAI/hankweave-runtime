import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "./execution-layout.js";
import type { RuntimeLock } from "./runtime-lock.js";

/** Remove artifacts without removing the lease that excludes other commands. */
export async function removeExecutionContents(dir: string, lock: RuntimeLock): Promise<void> {
  lock.assertHeldFor(dir);
  for (const entry of await fs.promises.readdir(dir)) {
    if (entry === ExecutionLayout.RUNTIME_LOCK) continue;
    await fs.promises.rm(path.join(dir, entry), { recursive: true, force: true });
  }
}

/** Exit handlers cannot await filesystem work; the same lease exclusion applies. */
function removeExecutionContentsSync(dir: string, lock: RuntimeLock): void {
  lock.assertHeldFor(dir);
  for (const entry of fs.readdirSync(dir)) {
    if (entry === ExecutionLayout.RUNTIME_LOCK) continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

/**
 * Call only after releasing ownership. Never recurse or retry: a successor may
 * already have acquired the lease and started populating the directory again.
 * Mount points and directories under unwritable parents may also need to remain.
 */
export function removeEmptyExecutionDirectory(dir: string): string | undefined {
  try {
    fs.rmdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    return `Execution directory retained at ${dir}: ${(error as Error).message}`;
  }
}

/** Register before copying, then await the returned cleanup after replay drains. */
export function registerReplayCleanup(dir: string, lock: RuntimeLock): () => Promise<void> {
  // Fatal exits bypass finally. Clean partial copies too, but never touch
  // the execution after lease loss or release to another command.
  const onExit = () => {
    try {
      // Windows cannot remove the process's current working directory.
      process.chdir(os.tmpdir());
      lock.assertHeldFor(dir);
      try {
        removeExecutionContentsSync(dir, lock);
      } finally {
        lock.releaseSync();
      }
      removeEmptyExecutionDirectory(dir);
    } catch {
      // Best-effort cleanup must not interrupt other exit handlers.
    }
  };
  process.once("exit", onExit);
  return async () => {
    try {
      await removeExecutionContents(dir, lock);
    } catch (error) {
      // Retry synchronously while still owning the lease. The exit handler
      // cannot safely retry once normal cleanup has released ownership.
      onExit();
      throw error;
    } finally {
      process.off("exit", onExit);
      await lock.release();
      const warning = removeEmptyExecutionDirectory(dir);
      if (warning) console.warn(warning);
    }
  };
}
