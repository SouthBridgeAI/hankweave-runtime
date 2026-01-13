import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseJSONL } from "../../utils/test-data-helpers.js";

export function runLogFilesTests(testDir: string) {
  // Find the run folder - there should be exactly one
  const runsDir = path.join(testDir, ".hankweave/runs");
  let runFolder = "";

  if (fs.existsSync(runsDir)) {
    const runFolders = fs.readdirSync(runsDir);
    if (runFolders.length > 0) {
      runFolder = path.join(runsDir, runFolders[0]);
    }
  }

  for (const codonId of ["codon-1", "codon-2", "codon-3"]) {
    describe(`${codonId} logs`, () => {
      // Logs are now in .hankweave/runs/{runId}/codon-{codonId}-claude.log
      const logPath = path.join(runFolder, `${codonId}-claude.log`);

      test(`log file exists`, () => {
        expect(fs.existsSync(logPath)).toBe(true);
      });

      test(`contains init message`, () => {
        if (fs.existsSync(logPath)) {
          const logContent = fs.readFileSync(logPath, "utf-8");
          const logEntries = parseJSONL(logContent);
          const hasInit = logEntries.some((e) => e.type === "system" && e.subtype === "init");
          expect(hasInit).toBe(true);
        }
      });

      test(`contains result message`, () => {
        if (fs.existsSync(logPath)) {
          const logContent = fs.readFileSync(logPath, "utf-8");
          const logEntries = parseJSONL(logContent);
          const hasResult = logEntries.some((e) => e.type === "result");
          expect(hasResult).toBe(true);
        }
      });

      test(`result shows success`, () => {
        if (fs.existsSync(logPath)) {
          const logContent = fs.readFileSync(logPath, "utf-8");
          const logEntries = parseJSONL(logContent);
          const resultEntry = logEntries.find((e) => e.type === "result");
          expect(resultEntry?.subtype).toBe("success");
        }
      });
    });
  }
}
