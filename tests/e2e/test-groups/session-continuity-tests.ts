import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseJSONL } from "../../utils/test-data-helpers.js";

export function runSessionContinuityTests(testDir: string) {
  test("Phase 2 log shows continuation from Phase 1 session", () => {
    const phase1Log = path.join(testDir, ".langton/logs/log-phase-1.jsonl");
    const phase2Log = path.join(testDir, ".langton/logs/log-phase-2.jsonl");

    if (fs.existsSync(phase1Log) && fs.existsSync(phase2Log)) {
      const phase1Entries = parseJSONL(fs.readFileSync(phase1Log, "utf-8"));
      const phase2Entries = parseJSONL(fs.readFileSync(phase2Log, "utf-8"));

      const phase1SessionId = phase1Entries.find(
        (e) => e.type === "system" && e.subtype === "init",
      )?.session_id;
      const phase2Resume = phase2Entries.find((e) => e.type === "system" && e.subtype === "info");

      if (phase2Resume?.message && phase1SessionId) {
        expect(phase2Resume.message).toContain(phase1SessionId);
      }
    }
  });
}
