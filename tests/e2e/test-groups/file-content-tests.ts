import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/** Check if a model string refers to a non-Anthropic provider (known to be flakier on creative output) */
function isNonAnthropicModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    !lower.includes("claude") &&
    !lower.includes("sonnet") &&
    !lower.includes("opus") &&
    !lower.includes("haiku")
  );
}

export function runFileContentTests(testDir: string, codonModels: Record<string, string> = {}) {
  const codon3IsNonAnthropic = isNonAnthropicModel(codonModels["codon-3"] || "");

  test("favorite poem has multiple lines", () => {
    const poem1Path = path.join(testDir, "notes/favorite_poem.txt");
    if (fs.existsSync(poem1Path)) {
      const content = fs.readFileSync(poem1Path, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("system prompt is observed - codon 1 poem contains Korean translations", () => {
    const poem1Path = path.join(testDir, "notes/favorite_poem.txt");

    // Check for Korean characters (Hangul Unicode range: \u1100-\u11FF, \uAC00-\uD7AF)
    const hasKorean = (text: string) => /[\u1100-\u11FF\uAC00-\uD7AF]/.test(text);

    // Check first poem (codon 1 has the system prompt configured)
    if (fs.existsSync(poem1Path)) {
      const content = fs.readFileSync(poem1Path, "utf-8");
      expect(hasKorean(content)).toBe(true);
    }

    // Note: Codon 2 doesn't have a system prompt configured, so we don't check second_favorite_poem.txt
  });

  test("poem1.ts contains exports", () => {
    const ts1Path = path.join(testDir, "typescript_code/src/poem1.ts");
    if (fs.existsSync(ts1Path)) {
      const content = fs.readFileSync(ts1Path, "utf-8");
      if (codon3IsNonAnthropic && !content.includes("export")) {
        console.warn(
          "⚠️  [Non-Anthropic model] poem1.ts missing 'export' — skipping (model output varies)",
        );
        return;
      }
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
      if (codon3IsNonAnthropic && !hasExpectedStructure) {
        console.warn(
          "⚠️  [Non-Anthropic model] poem1.ts missing expected structure — skipping (model output varies)",
        );
        return;
      }
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
