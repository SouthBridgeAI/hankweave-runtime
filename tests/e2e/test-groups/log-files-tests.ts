import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseJSONL } from "../../utils/test-data-helpers.js";

export function runLogFilesTests(testDir: string) {
  for (const phaseId of ["phase-1", "phase-2", "phase-3"]) {
    describe(`${phaseId} logs`, () => {
      const logPath = path.join(testDir, `.langton/logs/log-${phaseId}.jsonl`);

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