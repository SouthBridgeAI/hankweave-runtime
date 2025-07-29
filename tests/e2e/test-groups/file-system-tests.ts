import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PhaseCompletedEvent, PhaseStartedEvent } from "../../../server/types/types.js";

interface TestState {
  phase1Started: PhaseStartedEvent | null;
  phase1Completed: PhaseCompletedEvent | null;
  phase2Started: PhaseStartedEvent | null;
  phase2Completed: PhaseCompletedEvent | null;
  phase3Started: PhaseStartedEvent | null;
  phase3Completed: PhaseCompletedEvent | null;
}

export function runFileSystemTests(_testState: TestState, testDir: string) {
  // Workspace setup tests
  test("Phase 1 workspace setup created notes directory", () => {
    expect(fs.existsSync(path.join(testDir, "notes"))).toBe(true);
    expect(fs.statSync(path.join(testDir, "notes")).isDirectory()).toBe(true);
  });

  test("Phase 3 workspace setup copied typescript_structure", () => {
    const typescriptCodeDir = path.join(testDir, "typescript_code");
    expect(fs.existsSync(typescriptCodeDir)).toBe(true);
    expect(fs.statSync(typescriptCodeDir).isDirectory()).toBe(true);

    // Check that files from typescript_structure were copied
    expect(fs.existsSync(path.join(typescriptCodeDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(typescriptCodeDir, "tsconfig.json"))).toBe(true);
    expect(fs.existsSync(path.join(typescriptCodeDir, "src"))).toBe(true);
    expect(fs.statSync(path.join(typescriptCodeDir, "src")).isDirectory()).toBe(true);
  });

  test("Phase 3 workspace setup ran bun install", () => {
    const typescriptCodeDir = path.join(testDir, "typescript_code");
    // Check that bun install created node_modules or updated bun.lockb
    const bunLockExists = fs.existsSync(path.join(typescriptCodeDir, "bun.lockb"));
    const nodeModulesExists = fs.existsSync(path.join(typescriptCodeDir, "node_modules"));
    expect(bunLockExists || nodeModulesExists).toBe(true);
  });

  // Original tests
  test("Phase 1 created favorite_poem.txt", () => {
    expect(fs.existsSync(path.join(testDir, "notes/favorite_poem.txt"))).toBe(true);
  });

  test("Phase 2 created second_favorite_poem.txt", () => {
    expect(fs.existsSync(path.join(testDir, "notes/second_favorite_poem.txt"))).toBe(true);
  });

  test("Phase 3 created poem1.ts", () => {
    expect(fs.existsSync(path.join(testDir, "typescript_code/src/poem1.ts"))).toBe(true);
  });

  test("Phase 3 created poem2.ts", () => {
    expect(fs.existsSync(path.join(testDir, "typescript_code/src/poem2.ts"))).toBe(true);
  });
}
