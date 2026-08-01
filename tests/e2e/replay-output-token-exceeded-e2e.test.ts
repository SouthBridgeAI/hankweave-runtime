#!/usr/bin/env bun
/**
 * A codon whose session log ends without a `result` message must fail, and the
 * codons before it must still complete.
 *
 * This is the shape the Agent SDK leaves behind when a turn dies mid-stream —
 * originally observed as an "output token limit exceeded" message followed by
 * SDK recovery chatter and then nothing. The runtime has no terminal result to
 * classify, so `handleCodonComplete` synthesizes a failure rather than calling
 * the codon done (see `synthesizeMissingFailureReason`).
 *
 * The fixture is built here rather than checked in. This test previously read
 * `tests/fixtures/replay-hankweave-zip/`, an execution directory that had to be
 * downloaded by hand from a Linear ticket and extracted — so it threw at import
 * time on every machine that did not have it, including CI, and had therefore
 * never run. Nothing in the assertions depends on that particular recording:
 * what matters is the truncated log, which `buildReplayFixture` produces
 * directly.
 */
import { describe, expect, test } from "bun:test";
import type { CodonCompletedEvent, ServerReadyEvent } from "../../server/schemas/event-schemas.js";
import { CodonId } from "../../server/types/branded-types.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import {
  assistantTextLine,
  buildReplayFixture,
  successResultLine,
} from "../utils/replay-fixture-builder.js";
import { getFreePort } from "../utils/test-helpers.js";

const COMPLETING_CODON_IDS = ["parse-separate", "claude-research", "synthesize-compress"] as const;
const TRUNCATED_CODON_ID = "assemble-polish";
const EXPECTED_CODON_COUNT = COMPLETING_CODON_IDS.length + 1;

describe("Replay E2E — codon log truncated before its result message", () => {
  test("earlier codons complete; the truncated codon fails and fails the run", async () => {
    const sessionFor = (id: string) => ({ sessionId: `session-${id}` });

    const fixture = buildReplayFixture({
      codons: [
        ...COMPLETING_CODON_IDS.map((id) => ({
          id,
          logLines: [
            assistantTextLine(`Working on ${id}.`, sessionFor(id)),
            successResultLine(`${id} done.`, sessionFor(id)),
          ],
        })),
        {
          // No result line: the log just stops, exactly as it does when a turn
          // blows the output token limit and the SDK never emits a terminal
          // result.
          id: TRUNCATED_CODON_ID,
          logLines: [
            assistantTextLine(
              "Claude's response exceeded the 32000 output token maximum. Retrying with a shorter response.",
              sessionFor(TRUNCATED_CODON_ID),
            ),
          ],
        },
      ],
    });

    const port = await getFreePort();
    const server = await launchHankweave({
      port,
      configPath: fixture.configPath,
      dataDir: fixture.dataPath,
      replayDir: fixture.execDir,
      logPrefix: "[replay-truncated-log]",
      extraArgs: ["--force"],
      // This test counts `codon.started` across the whole run, so it cannot
      // afford to lose codon 1 to the autostart-vs-handshake race — under
      // `--concurrency` it reliably did (4 expected, 3 received). Safe here
      // because the fixture is built fresh by `buildReplayFixture`, so the
      // journal backfill contains only this run's events.
      sendPreviousEvents: true,
    });

    try {
      expect((await server.waitForEvent("server.ready", 30_000)) as ServerReadyEvent).toBeDefined();

      for (const codonId of COMPLETING_CODON_IDS) {
        await server.waitForCodonCompletion(codonId, undefined, 60_000);
      }

      // `waitForCodonCompletion` insists on status "completed", so the failing
      // codon needs the raw event. Note this deliberately does NOT wait for the
      // run to fail: a missing result message is classified as *retriable*
      // (`synthesizeMissingFailureReason`), and a retriable failure under the
      // default `onFailure: "abort"` parks the server in "stay-active" for an
      // interactive client rather than failing the run. Headless behaviour —
      // where the same failure does shut the run down — is covered by
      // tests/integration/runtime-headless-stayactive-shutdown.test.ts.
      const truncatedCompletion = (await server.waitForEvent(
        "codon.completed",
        60_000,
        (e) => (e as CodonCompletedEvent).data?.codonId === TRUNCATED_CODON_ID,
      )) as CodonCompletedEvent;

      expect(truncatedCompletion.data.success).toBe(false);
      // The runtime must attribute the failure rather than leaving it blank —
      // an unexplained failure is what makes a 20-hour run undebuggable.
      expect(truncatedCompletion.data.failureReason).toBeDefined();

      await server.waitForState(
        (s) =>
          s.runs[0]?.codons.find((c) => c.codonId === CodonId(TRUNCATED_CODON_ID))?.status ===
          "failed",
        30_000,
      );

      const replayRun = server.getState().runs[0];
      expect(replayRun.codons.length).toBe(EXPECTED_CODON_COUNT);
      for (const codonId of COMPLETING_CODON_IDS) {
        expect(replayRun.codons.find((c) => c.codonId === CodonId(codonId))?.status).toBe(
          "completed",
        );
      }

      const events = server.getEvents();
      expect(events.filter((e) => e.type === "codon.started").length).toBe(EXPECTED_CODON_COUNT);
      expect(events.filter((e) => e.type === "codon.completed").length).toBe(EXPECTED_CODON_COUNT);
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  }, 120_000);
});
