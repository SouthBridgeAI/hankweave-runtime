import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CodonCompletedEvent, CodonStartedEvent } from "../../../server/types/types.js";

interface TestState {
  codon1Started: CodonStartedEvent | null;
  codon1Completed: CodonCompletedEvent | null;
  codon2Started: CodonStartedEvent | null;
  codon2Completed: CodonCompletedEvent | null;
  codon3Started: CodonStartedEvent | null;
  codon3Completed: CodonCompletedEvent | null;
}

export function runFileSystemTests(_testState: TestState, testDir: string) {
  // Rig setup tests
  test("Codon 1 rig setup created notes directory", () => {
    expect(fs.existsSync(path.join(testDir, "notes"))).toBe(true);
    expect(fs.statSync(path.join(testDir, "notes")).isDirectory()).toBe(true);
  });

  test("Codon 3 rig setup copied typescript_structure", () => {
    const typescriptCodeDir = path.join(testDir, "typescript_code");
    expect(fs.existsSync(typescriptCodeDir)).toBe(true);
    expect(fs.statSync(typescriptCodeDir).isDirectory()).toBe(true);

    // Check that files from typescript_structure were copied
    expect(fs.existsSync(path.join(typescriptCodeDir, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(typescriptCodeDir, "tsconfig.json"))).toBe(true);
    expect(fs.existsSync(path.join(typescriptCodeDir, "src"))).toBe(true);
    expect(fs.statSync(path.join(typescriptCodeDir, "src")).isDirectory()).toBe(true);
  });

  test("Codon 3 rig setup ran bun install", () => {
    const typescriptCodeDir = path.join(testDir, "typescript_code");
    // Check that bun install created node_modules or updated bun.lockb
    const bunLockExists = fs.existsSync(path.join(typescriptCodeDir, "bun.lockb"));
    const nodeModulesExists = fs.existsSync(path.join(typescriptCodeDir, "node_modules"));
    expect(bunLockExists || nodeModulesExists).toBe(true);
  });

  // Original tests
  test("Codon 1 created favorite_poem.txt", () => {
    expect(fs.existsSync(path.join(testDir, "notes/favorite_poem.txt"))).toBe(true);
  });

  test("Codon 2 created second_favorite_poem.txt", () => {
    expect(fs.existsSync(path.join(testDir, "notes/second_favorite_poem.txt"))).toBe(true);
  });

  test("Codon 3 created poem1.ts", () => {
    expect(fs.existsSync(path.join(testDir, "typescript_code/src/poem1.ts"))).toBe(true);
  });

  test("Codon 3 created poem2.ts", () => {
    expect(fs.existsSync(path.join(testDir, "typescript_code/src/poem2.ts"))).toBe(true);
  });
}
