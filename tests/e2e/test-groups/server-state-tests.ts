import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { ExecutionLayout } from "../../../server/execution-layout.js";

export function runServerStateTests(testDir: string) {
  test("server lock file was properly cleaned up", () => {
    // Lock file should be removed after server shutdown
    const lockFilePath = new ExecutionLayout(testDir).runtimeLockPath;
    expect(fs.existsSync(lockFilePath)).toBe(false);
  });
}
