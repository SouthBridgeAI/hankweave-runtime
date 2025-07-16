import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

export function runServerStateTests(testDir: string) {
  test("server lock file was properly cleaned up", () => {
    // Lock file should be removed after server shutdown
    const lockFilePath = path.join(testDir, ".langton/server.lock");
    expect(fs.existsSync(lockFilePath)).toBe(false);
  });

  test("lock file contains valid PID", () => {
    const lockFilePath = path.join(testDir, ".langton/server.lock");
    if (fs.existsSync(lockFilePath)) {
      const lockContent = fs.readFileSync(lockFilePath, "utf-8").trim();

      // The lock file is now JSON format with { pid, runId, startTime, lastHeartbeat }
      try {
        const lockData = JSON.parse(lockContent);
        expect(typeof lockData.pid).toBe("number");
        expect(lockData.pid).toBeGreaterThan(0);
        expect(typeof lockData.runId).toBe("string");
        expect(lockData.runId.length).toBeGreaterThan(0);
      } catch (_error) {
        // Old format - just PID
        expect(/^\d+$/.test(lockContent)).toBe(true);
      }
    }
  });
}
