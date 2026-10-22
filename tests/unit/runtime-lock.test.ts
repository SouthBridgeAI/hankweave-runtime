import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CleanupCommand } from "../../server/cleanup-command.js";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { RuntimeLock, RuntimeLockHeldError } from "../../server/runtime-lock.js";

let root: string;
let dir: string;
const handles: RuntimeLock[] = [];
const childScript = path.resolve(import.meta.dir, "runtime-lock-child.ts");
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "runtime-lock-")));
  dir = path.join(root, "execution");
  fs.mkdirSync(dir);
});
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.release();
  fs.rmSync(root, { recursive: true, force: true });
});
async function claim() {
  const lock = await RuntimeLock.acquire(dir);
  handles.push(lock);
  return lock;
}
function attemptChild() {
  const result = spawnSync(process.execPath, [childScript, dir, "once"], { encoding: "utf8" });
  if (result.error || ![0, 2].includes(result.status ?? -1)) throw new Error(result.stderr);
  return JSON.parse(result.stdout) as { acquired: boolean };
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for lock child");
    await Bun.sleep(10);
  }
}

test("acquisition excludes competing commands and repeated release shares completion", async () => {
  const lock = await claim();
  await expect(claim()).rejects.toBeInstanceOf(RuntimeLockHeldError);
  expect(attemptChild().acquired).toBe(false);
  const releasing = lock.release();
  expect(() => lock.assertHeldFor(dir)).toThrow("releasing or released");
  expect(lock.release()).toBe(releasing);
  await releasing;
  expect(() => lock.assertHeldFor(dir)).toThrow("releasing or released");
  expect(attemptChild().acquired).toBe(true);
});

test("aliases share ownership, distinct executions do not", async () => {
  const alias = path.join(root, "alias");
  fs.symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
  const lock = await claim();
  expect(() => lock.assertHeldFor(dir)).not.toThrow();
  expect(() => lock.assertHeldFor(alias)).not.toThrow();
  expect(() => lock.assertHeldFor(path.join(root, "other"))).toThrow("does not cover");
  await expect(RuntimeLock.acquire(alias)).rejects.toBeInstanceOf(RuntimeLockHeldError);
  const other = await RuntimeLock.acquire(path.join(root, "other"));
  await other.release();
});

test("shared timeout protects a 45-second-old heartbeat and reclaims after 60 seconds", async () => {
  fs.mkdirSync(new ExecutionLayout(dir).runtimeLockPath);
  const fresh = new Date(Date.now() - 45_000);
  fs.utimesSync(new ExecutionLayout(dir).runtimeLockPath, fresh, fresh);
  await expect(claim()).rejects.toBeInstanceOf(RuntimeLockHeldError);
  expect(attemptChild().acquired).toBe(false);

  const expired = new Date(Date.now() - 75_000);
  fs.utimesSync(new ExecutionLayout(dir).runtimeLockPath, expired, expired);
  await (await claim()).release();
  expect(fs.existsSync(new ExecutionLayout(dir).runtimeLockPath)).toBe(false);
});

test("cleanup retains ownership through recursive removal", async () => {
  fs.mkdirSync(path.join(dir, "artifacts"));
  fs.writeFileSync(path.join(dir, "artifacts", "result"), "protected");
  let checked = false;
  const original = fs.promises.rm;
  const remove = spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
    await original(target, options);
    expect(target).not.toBe(dir);
    expect(attemptChild().acquired).toBe(false);
    checked = true;
  });
  try {
    expect(
      (await new CleanupCommand({ executionPath: dir, skipConfirmation: true }).execute()).success,
    ).toBe(true);
  } finally {
    remove.mockRestore();
  }
  expect(checked).toBe(true);
  expect(fs.existsSync(dir)).toBe(false);
  expect(attemptChild().acquired).toBe(true);
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "a writable execution under an unwritable parent can run and clean its contents",
  async () => {
    fs.writeFileSync(path.join(dir, "artifact"), "result");
    fs.chmodSync(root, 0o555);
    try {
      expect(() => fs.mkdirSync(path.join(root, "unwritable"))).toThrow();
      const lock = await claim();
      expect(fs.statSync(new ExecutionLayout(dir).runtimeLockPath).isDirectory()).toBe(true);
      expect(attemptChild().acquired).toBe(false);
      await lock.release();
      const result = await new CleanupCommand({
        executionPath: dir,
        skipConfirmation: true,
      }).execute();
      expect(result.success).toBe(true);
      expect(result.directoriesRemoved).toEqual([]);
      expect(result.warnings[0]).toContain("directory retained");
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.chmodSync(root, 0o755);
    }
  },
);

test("cleanup leaves a successor's lease and files intact after releasing ownership", async () => {
  fs.writeFileSync(path.join(dir, "old"), "old execution");
  const original = RuntimeLock.prototype.release;
  let successor: RuntimeLock | undefined;
  const release = spyOn(RuntimeLock.prototype, "release").mockImplementation(async function (
    this: RuntimeLock,
  ) {
    await original.call(this);
    if (!successor) {
      successor = await claim();
      fs.writeFileSync(path.join(dir, "new"), "successor's work");
    }
  });
  try {
    const result = await new CleanupCommand({
      executionPath: dir,
      skipConfirmation: true,
    }).execute();
    expect(result.success).toBe(true);
    expect(result.directoriesRemoved).toEqual([]);
    expect(result.warnings[0]).toContain("directory retained");
    expect(fs.existsSync(path.join(dir, "old"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "new"), "utf8")).toBe("successor's work");
    expect(attemptChild().acquired).toBe(false);
  } finally {
    release.mockRestore();
  }
});

test("failed artifact removal releases the lease without deleting remaining contents", async () => {
  fs.writeFileSync(path.join(dir, "artifact"), "keep");
  const remove = spyOn(fs.promises, "rm").mockRejectedValue(new Error("injected removal failure"));
  try {
    const result = await new CleanupCommand({
      executionPath: dir,
      skipConfirmation: true,
    }).execute();
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("injected removal failure");
    expect(fs.readFileSync(path.join(dir, "artifact"), "utf8")).toBe("keep");
    expect(attemptChild().acquired).toBe(true);
  } finally {
    remove.mockRestore();
  }
});

test.each(["hold-hooks", "hold-hooks-duplicate"])(
  "compromise runs hooks across module copies despite failures, preserving the successor's lock (%s)",
  async (mode) => {
    const ready = path.join(root, "ready");
    const child = Bun.spawn([process.execPath, childScript, dir, mode, ready], {
      stdin: "pipe",
      stderr: "pipe",
    });
    try {
      await waitFor(() => fs.existsSync(ready));
      // proper-lockfile may round mtimes to seconds; takeover must get a distinct one.
      await Bun.sleep(1_100);
      fs.rmdirSync(new ExecutionLayout(dir).runtimeLockPath);
      await claim();
      expect(await child.exited).toBe(1);
      expect(await new Response(child.stderr).text()).toContain("Fatal: execution lease lost");
      expect(fs.existsSync(`${ready}.caught`)).toBe(false);
      expect(fs.readFileSync(`${ready}.hooks`, "utf8")).toBe("owner\ncleanup\nlast\n");
      expect(attemptChild().acquired).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await child.exited;
    }
  },
  10_000,
);

test("waitForStale outlasts a killed owner's fresh heartbeat; prompt acquire does not", async () => {
  const ready = path.join(root, "ready");
  const child = Bun.spawn([process.execPath, childScript, dir, "hold", ready], { stdin: "pipe" });
  try {
    await waitFor(() => fs.existsSync(ready));
    child.kill("SIGKILL");
    await child.exited;
    // Age the dead owner's heartbeat to just inside the 60-second window so the
    // waiting acquire crosses the stale line within a few retries.
    const nearlyStale = new Date(Date.now() - 58_000);
    fs.utimesSync(new ExecutionLayout(dir).runtimeLockPath, nearlyStale, nearlyStale);
    await expect(claim()).rejects.toBeInstanceOf(RuntimeLockHeldError);
    const started = Date.now();
    const successor = await RuntimeLock.acquire(dir, { waitForStale: true });
    handles.push(successor);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
    expect(attemptChild().acquired).toBe(false);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
}, 15_000);

test("a killed owner's fresh lock fails promptly; its expired lock is reclaimable", async () => {
  const ready = path.join(root, "ready");
  const child = Bun.spawn([process.execPath, childScript, dir, "hold", ready], { stdin: "pipe" });
  try {
    await waitFor(() => fs.existsSync(ready));
    child.kill("SIGKILL");
    await child.exited;
    await expect(claim()).rejects.toBeInstanceOf(RuntimeLockHeldError);
    fs.utimesSync(new ExecutionLayout(dir).runtimeLockPath, new Date(0), new Date(0));
    await (await claim()).release();
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
});
