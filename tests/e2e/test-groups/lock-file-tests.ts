import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { ExecutionLayout } from "../../../server/execution-layout.js";

interface TestState {
  serverProcess: ChildProcess | null;
  serverExited?: boolean;
}

export function runLockFileTests(testState: TestState, testDir: string) {
  test("runtime uses an in-directory lease without a PID marker", () => {
    expect(fs.existsSync(path.join(testDir, ".hankweave/runtime.lock"))).toBe(false);
    if (fs.existsSync(new ExecutionLayout(testDir).runtimeLockPath))
      expect(fs.statSync(new ExecutionLayout(testDir).runtimeLockPath).isDirectory()).toBe(true);
  });

  test("no stale lock files after shutdown", async () => {
    // This is particularly important for the shutdown test
    if (!testState.serverExited) return;

    const lockFile = new ExecutionLayout(testDir).runtimeLockPath;

    // Was `setTimeout(() => expect(...), 1000)` inside a synchronous test: the
    // test returned before the callback ran, so the assertion could never fail
    // it and this case had been passing unconditionally. Poll instead — it also
    // returns as soon as cleanup lands rather than always costing a full second.
    const deadline = Date.now() + 5_000;
    while (fs.existsSync(lockFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(fs.existsSync(lockFile)).toBe(false);
  });
}
