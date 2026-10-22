import fs from "node:fs";
import lockfile from "proper-lockfile";
import { ExecutionLayout } from "./execution-layout.js";
import { canonicalFilePath } from "./utils.js";

// Keep this fixed for runtime startup, cleanup, and journal maintenance:
// proper-lockfile judges an existing heartbeat using the acquiring command's
// timeout, not the owner's. Per-command overrides could let a shorter timeout
// reclaim a live owner's lease during a pause that its longer timeout allows.
// One shared value avoids disagreement from CLI flags, environment, or config
// resolved from different working directories. 60 seconds leaves headroom for
// synchronous Git commands and setup work that delay renewal; a pause beyond
// this timeout can still allow takeover, even if the owner is alive.
const LOCK_STALE_AFTER_MS = 60_000;
const LOCK_UPDATE_INTERVAL_MS = 5_000;
// A killed owner leaves a heartbeat at most one update interval old, so its lease
// becomes reclaimable within stale + update; the margin covers slow filesystems.
export const LOCK_TAKEOVER_WAIT_MS = LOCK_STALE_AFTER_MS + LOCK_UPDATE_INTERVAL_MS + 5_000;
const LOCK_RETRY_INTERVAL_MS = 1_000;

// Lease loss must stop every agent even if the bundler emits this module twice.
// Keep the registry on the global object so each copy shares the same hooks.
const SHUTDOWN_HOOKS_KEY = Symbol.for("@southbridgeai/hankweave/runtime-lock/shutdown-hooks");
const shutdownHookGlobal = globalThis as typeof globalThis & {
  [SHUTDOWN_HOOKS_KEY]?: Set<() => void>;
};
shutdownHookGlobal[SHUTDOWN_HOOKS_KEY] ??= new Set<() => void>();
const shutdownHooks = shutdownHookGlobal[SHUTDOWN_HOOKS_KEY];

export interface AcquireOptions {
  /**
   * Keep retrying until an abandoned lease ages past the stale window instead of
   * failing on first contact.
   *
   * A lease cannot tell a live owner from one that was SIGKILLed a moment ago:
   * both leave a heartbeat younger than the stale window. Only time separates
   * them — a live owner keeps renewing, a dead one never does. Supervised
   * relaunches (systemd, Kubernetes, the bench crash supervisor) restart the
   * runtime within seconds of the kill, while the previous heartbeat is still
   * fresh, so a single-shot acquire fails every relaunch under a 60-second
   * window and roughly one in seven under the old 10-second one — that lost two
   * bench blocks in the 2026-09-22 superbench crash run. The runtime start path
   * must opt in; offline commands (cleanup, journal) keep failing promptly.
   */
  waitForStale?: boolean;
}

export class RuntimeLockHeldError extends Error {
  constructor(
    readonly executionPath: string,
    waitMs = 0,
  ) {
    super(
      waitMs
        ? `Execution ${executionPath} is still locked after waiting ~${waitMs / 1000} seconds`
        : `Execution ${executionPath} is in use by another command`,
    );
    this.name = "RuntimeLockHeldError";
  }
}

/** Command-scoped ownership. Renewal, recovery and exit cleanup belong to proper-lockfile. */
export class RuntimeLock {
  private releasing?: Promise<void>;
  private compromised = false;

  private constructor(
    private readonly executionPath: string,
    private readonly unlock: () => Promise<void>,
  ) {}

  /** Verify this command still holds the lease for the requested execution. */
  assertHeldFor(executionPath: string): void {
    if (this.compromised) {
      throw new Error(`Execution lease for ${this.executionPath} was lost`);
    }
    if (this.releasing) {
      throw new Error(`Execution lease for ${this.executionPath} is releasing or released`);
    }
    if (canonicalFilePath(executionPath) !== this.executionPath) {
      throw new Error(`Execution lease for ${this.executionPath} does not cover ${executionPath}`);
    }
  }

  /**
   * Register process-wide emergency cleanup on lease loss; returns an unregister function.
   * Hooks must stop work synchronously, without writing protected files or awaiting
   * teardown. Normal shutdown must not run after ownership has been lost.
   */
  static registerShutdownHook(hook: () => void): () => void {
    const registered = () => hook();
    shutdownHooks.add(registered);
    return () => {
      shutdownHooks.delete(registered);
    };
  }

  private static runShutdownHooks(): void {
    const hooks = [...shutdownHooks];
    shutdownHooks.clear();
    for (const hook of hooks) {
      try {
        hook();
      } catch {
        // One failed cleanup must not prevent the remaining hooks or fatal exit.
      }
    }
  }

  /**
   * Acquire once before any execution writes. Fails promptly when occupied unless
   * `waitForStale` is set, in which case a live owner still wins after the takeover
   * window elapses and only an abandoned lease is reclaimed.
   */
  static async acquire(executionPath: string, options: AcquireOptions = {}): Promise<RuntimeLock> {
    const directory = canonicalFilePath(executionPath);
    // Every participant must use the same entry on the execution's filesystem,
    // including containers that share only this directory as a mounted volume.
    // Keep it outside .hankweave, which fresh-start setup renames for backup.
    // Runtime startup relies on this creating a fresh execution root; offline
    // commands (cleanup, journal maintenance) check existence before acquiring
    // so a mistyped path does not leave an empty directory tree behind.
    try {
      await fs.promises.mkdir(directory, { recursive: true });
    } catch (error) {
      if (["EEXIST", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new Error(`Execution path is not a directory: ${directory}`, { cause: error });
      }
      throw error;
    }
    let ownership: RuntimeLock | undefined;
    try {
      const release = await lockfile.lock(directory, {
        realpath: false,
        lockfilePath: new ExecutionLayout(directory).runtimeLockPath,
        stale: LOCK_STALE_AFTER_MS,
        update: LOCK_UPDATE_INTERVAL_MS,
        // Each retry re-runs the stale check, so a dead owner's lease is removed
        // and taken the moment its last heartbeat crosses the stale line.
        retries: options.waitForStale
          ? {
              retries: Math.ceil(LOCK_TAKEOVER_WAIT_MS / LOCK_RETRY_INTERVAL_MS),
              factor: 1,
              minTimeout: LOCK_RETRY_INTERVAL_MS,
              maxTimeout: LOCK_RETRY_INTERVAL_MS,
            }
          : 0,
        onCompromised(error) {
          if (ownership) ownership.compromised = true;
          // Bypass uncaughtException handlers and normal shutdown: both may write.
          try {
            fs.writeSync(2, `Fatal: execution lease lost for ${directory}: ${error.message}\n`);
          } finally {
            try {
              RuntimeLock.runShutdownHooks();
            } finally {
              process.exit(1);
            }
          }
        },
      });
      ownership = new RuntimeLock(directory, release);
      return ownership;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED") {
        throw new RuntimeLockHeldError(directory, options.waitForStale ? LOCK_TAKEOVER_WAIT_MS : 0);
      }
      throw error;
    }
  }

  /** Release after all protected work has drained. Repeated calls share completion. */
  release(): Promise<void> {
    this.releasing ??= this.unlock();
    return this.releasing;
  }

  /** Synchronous release for process exit handlers, which cannot await cleanup. */
  releaseSync(): void {
    this.assertHeldFor(this.executionPath);
    this.releasing = Promise.resolve();
    lockfile.unlockSync(this.executionPath, {
      realpath: false,
      lockfilePath: new ExecutionLayout(this.executionPath).runtimeLockPath,
    });
  }
}
