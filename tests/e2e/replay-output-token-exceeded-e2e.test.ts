#!/usr/bin/env bun
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodonCompletedEvent, ServerReadyEvent } from "../../server/schemas/event-schemas.js";
import { CodonId } from "../../server/types/branded-types.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Fixture: an execution directory extracted from hankweave.zip.
// Expected layout:
//   tests/fixtures/replay-hankweave-zip/
//   ├── .hankweave/                          ← from the zip (execution state & logs)
//   │   ├── state.json
//   │   ├── execution-meta.json
//   │   └── runs/{runId}/
//   │       ├── parse-separate-claude.log
//   │       ├── claude-research-0-claude.log
//   │       ├── claude-research-1-claude.log
//   │       ├── synthesize-compress-claude.log
//   │       └── assemble-polish-claude.log   ← has synthetic "output token exceeded" msg, no result
//   ├── hank.json                            ← added manually (original path in execution-meta.json
//   │                                          points to the zip author's machine)
//   └── data.txt                             ← added manually (dummy; --force bypasses hash mismatch)
const FIXTURE_DIR = path.resolve(TEST_ROOT, "tests/fixtures/replay-hankweave-zip");

const FIXTURE_DOWNLOAD_URL = "https://linear.app/southbridge/issue/ENG-201";

if (!fs.existsSync(path.join(FIXTURE_DIR, ".hankweave"))) {
  throw new Error(
    `Fixture not found at ${FIXTURE_DIR}\n` +
      `Download hankweave.zip from ${FIXTURE_DOWNLOAD_URL} and extract it to tests/fixtures/replay-hankweave-zip/`,
  );
}

// 5 codons: parse-separate, claude-research#0, claude-research#1, synthesize-compress, assemble-polish
const EXPECTED_CODON_COUNT = 5;
const COMPLETED_CODON_IDS = [
  "parse-separate",
  "claude-research#0",
  "claude-research#1",
  "synthesize-compress",
];

describe("Replay E2E — hankweave.zip fixture", () => {
  test("replays 5 codons; assemble-polish fails due to output token exceeded (no result message)", async () => {
    const port = await getFreePort();

    const server = await launchHankweave({
      port,
      configPath: path.join(FIXTURE_DIR, "hank.json"),
      dataDir: path.join(FIXTURE_DIR, "data.txt"),
      replayDir: FIXTURE_DIR,
      logPrefix: "[Replay-ZipFixture]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await server.waitForEvent("server.ready", 30_000)) as ServerReadyEvent;
      expect(readyEvent).toBeDefined();

      // First 4 codons complete successfully
      for (const codonId of COMPLETED_CODON_IDS) {
        await server.waitForCodonCompletion(codonId, undefined, 90_000);
      }

      // assemble-polish's log contains a synthetic "output token exceeded" assistant
      // message (line 84) from the Agent SDK, followed by SDK recovery (line 85),
      // but no result message — the original execution was still running when captured.
      // As a standalone codon with no result, this correctly causes a failure.
      await server.waitForRunToFail(90_000);

      // Verify state
      const state = server.getState();
      expect(state.runs.length).toBe(1);

      const replayRun = state.runs[0];
      expect(replayRun.status).toBe("failed");
      expect(replayRun.codons.length).toBe(EXPECTED_CODON_COUNT);

      // First 4 codons completed
      for (let i = 0; i < 4; i++) {
        expect(replayRun.codons[i].status).toBe("completed");
      }

      // assemble-polish failed
      const assemblePolish = replayRun.codons[4];
      expect(assemblePolish.codonId).toBe(CodonId("assemble-polish"));
      expect(assemblePolish.status).toBe("failed");

      // Verify events
      const events = server.getEvents();
      const startedEvents = events.filter((e) => e.type === "codon.started");
      const completedEvents = events.filter(
        (e) => e.type === "codon.completed",
      ) as CodonCompletedEvent[];

      expect(startedEvents.length).toBe(EXPECTED_CODON_COUNT);
      expect(completedEvents.length).toBe(EXPECTED_CODON_COUNT);

      // assemble-polish's codon.completed event should report success=false
      const apCompleted = completedEvents.find((e) => e.data.codonId === "assemble-polish");
      expect(apCompleted).toBeDefined();
      expect(apCompleted?.data.success).toBe(false);
    } finally {
      await server.stop();
    }
  }, 120_000);
});
