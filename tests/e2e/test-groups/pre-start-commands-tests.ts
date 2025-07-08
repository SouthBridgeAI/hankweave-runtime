import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

export function runPreStartCommandsTests(testDir: string) {
  test("pre-start command created notes directory", () => {
    expect(fs.existsSync(path.join(testDir, "notes"))).toBe(true);
  });

  test("pre-start command ran bun install", () => {
    const bunLockFile = path.join(testDir, "typescript_code/bun.lockb");
    expect(fs.existsSync(bunLockFile)).toBe(true);
  });

  test("pre-start command installed dependencies", () => {
    const nodeModulesExists = fs.existsSync(path.join(testDir, "typescript_code/node_modules"));
    expect(nodeModulesExists).toBe(true);
  });
}