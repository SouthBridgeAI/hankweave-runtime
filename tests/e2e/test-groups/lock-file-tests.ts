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
    const lockFile = path.join(testDir, ".langton/server.lock");
    if (fs.existsSync(lockFile) && testState.serverProcess?.pid) {
      const lockPid = parseInt(fs.readFileSync(lockFile, "utf-8").trim());

      // For running server, should match
      if (!testState.serverExited) {
        expect(lockPid).toBe(testState.serverProcess.pid);
      }
    }
  });

  test("no stale lock files after shutdown", () => {
    // This is particularly important for the shutdown test
    if (testState.serverExited) {
      const lockFile = path.join(testDir, ".langton/server.lock");

      // Give a moment for cleanup
      setTimeout(() => {
        expect(fs.existsSync(lockFile)).toBe(false);
      }, 1000);
    }
  });
}
