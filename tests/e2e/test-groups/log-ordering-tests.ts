import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseJSONL } from "../../utils/test-data-helpers.js";

export function runLogOrderingTests(testDir: string) {
  test("log messages maintain causal ordering", () => {
    // Find the run folder
    const runsDir = path.join(testDir, ".strandweave/runs");
    let runFolder = "";
    if (fs.existsSync(runsDir)) {
      const runFolders = fs.readdirSync(runsDir);
      if (runFolders.length > 0) {
        runFolder = path.join(runsDir, runFolders[0]);
      }
    }

    if (!runFolder) return;

    ["codon-1", "codon-2", "codon-3"].forEach((codonId) => {
      const logPath = path.join(runFolder, `${codonId}-claude.log`);
      if (!fs.existsSync(logPath)) return;

      const entries = parseJSONL(fs.readFileSync(logPath, "utf-8"));
      // Ignore hook_response system messages that precede init
      const filteredEntries = entries.filter(
        (e) => !(e.type === "system" && e.subtype === "hook_response"),
      );
      if (filteredEntries.length === 0) return;

      // System init should be first
      expect(filteredEntries[0]?.type).toBe("system");
      expect(filteredEntries[0]?.subtype).toBe("init");

      // Result should be last (if codon completed)
      const resultIndex = filteredEntries.findIndex((e) => e.type === "result");
      if (resultIndex !== -1) {
        expect(resultIndex).toBe(filteredEntries.length - 1);
      }

      // No user messages should appear before first assistant message
      const firstAssistant = filteredEntries.findIndex((e) => e.type === "assistant");
      const firstUser = filteredEntries.findIndex((e) => e.type === "user");
      if (firstUser !== -1 && firstAssistant !== -1) {
        expect(firstAssistant).toBeLessThan(firstUser);
      }
    });
  });

  test("stderr output is captured in logs", () => {
    // Find the run folder
    const runsDir = path.join(testDir, ".strandweave/runs");
    let runFolder = "";
    if (fs.existsSync(runsDir)) {
      const runFolders = fs.readdirSync(runsDir);
      if (runFolders.length > 0) {
        runFolder = path.join(runsDir, runFolders[0]);
      }
    }

    if (!runFolder) return;

    // Check for stderr entries in Claude logs
    ["codon-1", "codon-2", "codon-3"].forEach((codonId) => {
      const logPath = path.join(runFolder, `${codonId}-claude.log`);
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, "utf-8");
        // Look for stderr entries (if any errors occurred)
        const hasStderr = content.includes('"type":"stderr"');
        // It's OK if there's no stderr, but if there is, it should be valid JSON
        if (hasStderr) {
          const lines = content.split("\n").filter((l) => l.includes('"type":"stderr"'));
          lines.forEach((line) => {
            expect(() => JSON.parse(line)).not.toThrow();
          });
        }
      }
    });
  });
}
