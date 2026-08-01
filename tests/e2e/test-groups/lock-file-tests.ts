import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

interface TestState {
  serverProcess: ChildProcess | null;
  serverExited?: boolean;
}

export function runLockFileTests(testState: TestState, testDir: string) {
  test("lock file PID matches server process", () => {
    const lockFile = path.join(testDir, ".hankweave/runtime.lock");
    if (fs.existsSync(lockFile) && testState.serverProcess?.pid) {
      const lockContent = fs.readFileSync(lockFile, "utf-8");

      // The lock file is now JSON format with { pid, runId, startTime, lastHeartbeat }
      try {
        const lockData = JSON.parse(lockContent);
        const lockPid = lockData.pid;

        // For running server, should match
        if (!testState.serverExited) {
          expect(lockPid).toBe(testState.serverProcess.pid);
        }
      } catch (_error) {
        // Old format - just PID
        const lockPid = parseInt(lockContent.trim());
        if (!testState.serverExited) {
          expect(lockPid).toBe(testState.serverProcess.pid);
        }
      }
    }
  });

  test("no stale lock files after shutdown", async () => {
    // This is particularly important for the shutdown test
    if (!testState.serverExited) return;

    const lockFile = path.join(testDir, ".hankweave/runtime.lock");

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
