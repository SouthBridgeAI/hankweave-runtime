#!/usr/bin/env bun
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerReadyEvent } from "../../server/schemas/event-schemas.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_DIR = path.join(TEST_ROOT, "tests/fixtures/plan-gen-execution");

const CODON_IDS = [
  "step-1-main",
  "step-2-plan",
  "step-3-codex",
  "step-4-merge",
  "step-5-blind-review#0",
  "step-6-update#0",
  "step-5-blind-review#1",
  "step-6-update#1",
  "step-5-blind-review#2",
  "step-6-update#2",
  "implement-loop-step-1-implement#0",
  "implement-loop-step-2-update#0",
  "implement-loop-step-1-implement#1",
  "implement-loop-step-2-update#1",
  "implement-loop-step-1-implement#2",
  "implement-loop-step-2-update#2",
  "final-step-compress",
];

/**
 * Strip all "timestamp" fields from JSONL log files so replay fast-forwards
 * using the fixed replaySpeed (5ms per line) instead of real timing gaps.
 */
function stripTimestampsFromLogs(dir: string): void {
  const runsDir = path.join(dir, ".hankweave/runs");
  if (!fs.existsSync(runsDir)) return;

  const logFiles = fs
    .readdirSync(runsDir, { recursive: true })
    .filter((f) => String(f).endsWith(".log"));

  for (const logFile of logFiles) {
    const filePath = path.join(runsDir, String(logFile));
    const content = fs.readFileSync(filePath, "utf-8");
    const stripped = content
      .split("\n")
      .map((line) => {
        if (!line.trim()) return line;
        try {
          const parsed = JSON.parse(line);
          delete parsed.timestamp;
          return JSON.stringify(parsed);
        } catch {
          return line;
        }
      })
      .join("\n");
    fs.writeFileSync(filePath, stripped);
  }
}

// ──────────────────────────────────────────────────────
// Replay E2E — plan-gen hank (17 codons with loops)
// ──────────────────────────────────────────────────────

describe("Replay E2E — plan-gen hank", () => {
  let replayDir: string;

  beforeAll(() => {
    // Copy fixture to a temp dir so we don't modify the original
    replayDir = path.join(
      os.tmpdir(),
      `hankweave-replay-plan-gen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    );
    fs.cpSync(FIXTURE_DIR, replayDir, { recursive: true });

    // Strip timestamps from LLM logs so replay fast-forwards
    stripTimestampsFromLogs(replayDir);
  });

  afterAll(() => {
    try {
      fs.rmSync(replayDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("replays all 17 codons (plan-gen pipeline with loops) without real LLM calls", async () => {
    const port = await getFreePort();
    const configPath = path.join(FIXTURE_DIR, "hank-config/hank.json");
    const dataDir = path.join(FIXTURE_DIR, "data");

    const server = await launchHankweave({
      port,
      configPath,
      dataDir,
      replayDir,
      logPrefix: "[Replay-PlanGen]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await server.waitForEvent("server.ready", 30_000)) as ServerReadyEvent;
      expect(readyEvent).toBeDefined();

      // Wait for all codons to complete
      for (const codonId of CODON_IDS) {
        await server.waitForCodonCompletion(codonId, undefined, 5_000);
      }
      await server.waitForRunToComplete(20_000);

      // Verify state
      const state = server.getState();
      // Original run from copied state + replay run
      expect(state.runs.length).toBe(2);

      const replayRun = state.runs[0]; // newest run
      expect(replayRun.status).toBe("completed");
      expect(replayRun.codons.length).toBe(CODON_IDS.length);
      for (const codon of replayRun.codons) {
        expect(codon.status).toBe("completed");
      }

      // Verify key events flowed through the pipeline
      const events = server.getEvents();
      const startedEvents = events.filter((e) => e.type === "codon.started");
      const completedEvents = events.filter((e) => e.type === "codon.completed");

      expect(startedEvents.length).toBe(CODON_IDS.length);
      expect(completedEvents.length).toBe(CODON_IDS.length);
    } finally {
      await server.stop();
    }
  }, 60_000); // 1 min
});
