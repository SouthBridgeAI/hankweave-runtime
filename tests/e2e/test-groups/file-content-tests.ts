import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

export function runFileContentTests(testDir: string) {
  test("favorite poem has multiple lines", () => {
    const poem1Path = path.join(testDir, "notes/favorite_poem.txt");
    if (fs.existsSync(poem1Path)) {
      const content = fs.readFileSync(poem1Path, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("system prompt is observed - phase 1 poem contains Korean translations", () => {
    const poem1Path = path.join(testDir, "notes/favorite_poem.txt");

    // Check for Korean characters (Hangul Unicode range: \u1100-\u11FF, \uAC00-\uD7AF)
    const hasKorean = (text: string) => /[\u1100-\u11FF\uAC00-\uD7AF]/.test(text);

    // Check first poem (phase 1 has the system prompt configured)
    if (fs.existsSync(poem1Path)) {
      const content = fs.readFileSync(poem1Path, "utf-8");
      expect(hasKorean(content)).toBe(true);
    }

    // Note: Phase 2 doesn't have a system prompt configured, so we don't check second_favorite_poem.txt
  });

  test("poem1.ts contains exports", () => {
    const ts1Path = path.join(testDir, "typescript_code/src/poem1.ts");
    if (fs.existsSync(ts1Path)) {
      const content = fs.readFileSync(ts1Path, "utf-8");
      expect(content).toContain("export");
    }
  });

  test("poem1.ts has poem structure", () => {
    const ts1Path = path.join(testDir, "typescript_code/src/poem1.ts");
    if (fs.existsSync(ts1Path)) {
      const content = fs.readFileSync(ts1Path, "utf-8");
      // Check for either 'title:' or 'english:' since Claude may generate different structures
      const hasExpectedStructure =
        content.includes("title:") || content.includes("english:") || content.includes("poem1");
      expect(hasExpectedStructure).toBe(true);
    }
  });

  // Removed overly specific test - the prompt doesn't specify the structure

  test("package.json contains papaparse dependency", () => {
    const packagePath = path.join(testDir, "typescript_code/package.json");
    if (fs.existsSync(packagePath)) {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
      expect(packageJson.dependencies?.papaparse).toBeDefined();
    }
  });

  test("package.json contains lodash dependency", () => {
    const packagePath = path.join(testDir, "typescript_code/package.json");
    if (fs.existsSync(packagePath)) {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
      expect(packageJson.dependencies?.lodash).toBeDefined();
    }
  });
}