import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseJSONL } from "../../utils/test-data-helpers.js";

export function runSessionContinuityTests(testDir: string) {
  test("Codon 2 log shows continuation from Codon 1 session", () => {
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

    const codon1Log = path.join(runFolder, "codon-1-claude.log");
    const codon2Log = path.join(runFolder, "codon-2-claude.log");

    if (fs.existsSync(codon1Log) && fs.existsSync(codon2Log)) {
      const codon1Entries = parseJSONL(fs.readFileSync(codon1Log, "utf-8"));
      const codon2Entries = parseJSONL(fs.readFileSync(codon2Log, "utf-8"));

      const codon1SessionId = codon1Entries.find(
        (e) => e.type === "system" && e.subtype === "init",
      )?.session_id;
      const codon2Resume = codon2Entries.find((e) => e.type === "system" && e.subtype === "info");

      if (codon2Resume?.message && typeof codon2Resume.message === "string" && codon1SessionId) {
        expect(codon2Resume.message).toContain(codon1SessionId);
      }
    }
  });
}
