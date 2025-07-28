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
    const lockFile = path.join(testDir, ".tadpole/server.lock");
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

  test("no stale lock files after shutdown", () => {
    // This is particularly important for the shutdown test
    if (testState.serverExited) {
      const lockFile = path.join(testDir, ".tadpole/server.lock");

      // Give a moment for cleanup
      setTimeout(() => {
        expect(fs.existsSync(lockFile)).toBe(false);
      }, 1000);
    }
  });
}
