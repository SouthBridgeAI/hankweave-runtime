import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { colors } from "../../utils/test-helpers.js";

export function runJSONLSchemaTests(testDir: string) {
  for (const codonId of ["codon-1", "codon-2", "codon-3"]) {
    test(`${codonId} JSONL has valid schema`, () => {
      const logPath = path.join(testDir, `.strandweave/logs/log-${codonId}.jsonl`);
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, "utf-8");
        const lines = logContent.split("\n").filter((l) => l.trim());

        let _validLines = 0;
        let invalidLines = 0;

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);

            // Basic schema validation for Claude's JSONL format
            // Claude logs don't have timestamp at top level, they have session_id
            if (entry.type) {
              if (entry.type === "system" && entry.subtype && entry.session_id) _validLines++;
              else if (entry.type === "assistant" && entry.message && entry.session_id)
                _validLines++;
              else if (entry.type === "user" && entry.message && entry.session_id) _validLines++;
              else if (entry.type === "result" && entry.subtype) _validLines++;
              else {
                invalidLines++;
                if (invalidLines === 1) {
                  console.log(
                    `${colors.yellow}Invalid entry in ${codonId}: ${JSON.stringify(entry).substring(
                      0,
                      200,
                    )}${colors.reset}`,
                  );
                }
              }
            } else {
              invalidLines++;
              if (invalidLines === 1) {
                console.log(
                  `${colors.yellow}Missing type in ${codonId}: ${JSON.stringify(entry).substring(
                    0,
                    200,
                  )}${colors.reset}`,
                );
              }
            }
          } catch {
            invalidLines++;
          }
        }

        expect(invalidLines).toBe(0);
      }
    });
  }
}
