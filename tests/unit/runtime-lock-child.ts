import fs from "node:fs";
import path from "node:path";
import { RuntimeLock, RuntimeLockHeldError } from "../../server/runtime-lock.js";

const [dir, mode, readyFile] = process.argv.slice(2);
// A compromise must bypass application exception handlers and graceful shutdown.
process.on("uncaughtException", () => {
  if (readyFile) fs.writeFileSync(`${readyFile}.caught`, "unexpected recovery");
});
try {
  const lock = await RuntimeLock.acquire(dir);
  if (mode === "hold-hooks" || mode === "hold-hooks-duplicate") {
    // Markers live outside the protected execution directory.
    RuntimeLock.registerShutdownHook(() => fs.appendFileSync(`${readyFile}.hooks`, "owner\n"));
    let hookOwner = RuntimeLock;
    if (mode === "hold-hooks-duplicate") {
      // Force a second module evaluation regardless of the bundler's current behavior.
      const duplicatePath = `${path.resolve(import.meta.dir, "../../server/runtime-lock.ts")}?duplicate`;
      hookOwner = (await import(duplicatePath)).RuntimeLock;
      if (hookOwner === RuntimeLock) throw new Error("Expected distinct RuntimeLock classes");
    }
    const record = () => fs.appendFileSync(`${readyFile}.hooks`, "cleanup\n");
    const unregister = hookOwner.registerShutdownHook(record);
    hookOwner.registerShutdownHook(() => {
      throw new Error("cleanup failure");
    });
    hookOwner.registerShutdownHook(record);
    unregister();
    unregister();
    RuntimeLock.registerShutdownHook(() => fs.appendFileSync(`${readyFile}.hooks`, "last\n"));
  }
  const result = JSON.stringify({ acquired: true });
  if (readyFile) fs.writeFileSync(readyFile, result);
  else console.log(result);
  if (mode === "hold" || mode === "hold-hooks" || mode === "hold-hooks-duplicate") {
    process.stdin.resume();
    process.stdin.on("end", async () => {
      await lock.release();
      process.exit(0);
    });
  } else {
    await lock.release();
  }
} catch (error) {
  if (!(error instanceof RuntimeLockHeldError)) throw error;
  const result = JSON.stringify({ acquired: false });
  if (readyFile) fs.writeFileSync(readyFile, result);
  else console.log(result);
  process.exitCode = 2;
}
