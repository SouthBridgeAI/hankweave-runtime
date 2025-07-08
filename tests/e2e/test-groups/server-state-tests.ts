import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

export function runServerStateTests(testDir: string) {
  test("server lock file exists", () => {
    const lockFilePath = path.join(testDir, ".langton/server.lock");
    expect(fs.existsSync(lockFilePath)).toBe(true);
  });

  test("lock file contains valid PID", () => {
    const lockFilePath = path.join(testDir, ".langton/server.lock");
    if (fs.existsSync(lockFilePath)) {
      const lockPid = fs.readFileSync(lockFilePath, "utf-8").trim();
      expect(/^\d+$/.test(lockPid)).toBe(true);
    }
  });
}
