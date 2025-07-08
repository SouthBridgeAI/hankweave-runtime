import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseJSONL } from "../../utils/test-data-helpers.js";

export function runLogOrderingTests(testDir: string) {
  test("log messages maintain causal ordering", () => {
    ["phase-1", "phase-2", "phase-3"].forEach((phaseId) => {
      const logPath = path.join(testDir, `.langton/logs/log-${phaseId}.jsonl`);
      if (!fs.existsSync(logPath)) return;

      const entries = parseJSONL(fs.readFileSync(logPath, "utf-8"));

      // System init should be first
      expect(entries[0]?.type).toBe("system");
      expect(entries[0]?.subtype).toBe("init");

      // Result should be last (if phase completed)
      const resultIndex = entries.findIndex((e) => e.type === "result");
      if (resultIndex !== -1) {
        expect(resultIndex).toBe(entries.length - 1);
      }

      // No user messages should appear before first assistant message
      const firstAssistant = entries.findIndex((e) => e.type === "assistant");
      const firstUser = entries.findIndex((e) => e.type === "user");
      if (firstUser !== -1 && firstAssistant !== -1) {
        expect(firstAssistant).toBeLessThan(firstUser);
      }
    });
  });

  test("stderr output is captured in logs", () => {
    // Check for stderr entries in Claude logs
    ["phase-1", "phase-2", "phase-3"].forEach((phaseId) => {
      const logPath = path.join(testDir, `.langton/logs/log-${phaseId}.jsonl`);
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
