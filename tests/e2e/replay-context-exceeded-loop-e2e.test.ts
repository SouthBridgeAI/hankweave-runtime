#!/usr/bin/env bun
/**
 * `terminateOn: {type: "contextExceeded"}` — the runtime half, proven offline.
 *
 * The live marathon (tests/long-running/context-exhaustion-e2e.test.ts) is the
 * only other coverage of this mechanism, and it is expensive by construction:
 * it must drive a real model out of a real context window. This suite pins the
 * entire runtime side for free by replaying the exact log shape the Agent SDK
 * leaves behind on context exhaustion: a synthetic `<synthetic>`-model
 * assistant message and then nothing — no terminal result.
 *
 * That truncated shape exercises the real pipeline end to end:
 * `BaseProcessManager.emitExit()` scans the parsed log (`isContextExceeded`),
 * the exit carries `isContextExceeded=true` into `handleCodonComplete`, which
 * consults `isContextExceededAcceptable` (the loop's terminateOn), marks the
 * codon COMPLETED rather than failed, terminates the loop at the current
 * iteration, and continues to the post-loop codon.
 *
 * Two loops cover both detector patterns (output-token-maximum text and
 * "API Error: terminated"); a second test pins the counterpart contract: the
 * same signal OUTSIDE a contextExceeded loop must fail the codon, not
 * silently complete it.
 *
 * See intermediates/54-context-exceeded-testing/plan.md (layer L2).
 */
import { describe, expect, test } from "bun:test";
import type { CodonCompletedEvent } from "../../server/schemas/event-schemas.js";
import { CodonId } from "../../server/types/branded-types.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import {
  assistantTextLine,
  buildReplayFixture,
  compactBoundaryLine,
  errorResultLine,
  successResultLine,
  syntheticContextExceededLine,
} from "../utils/replay-fixture-builder.js";
import { getFreePort } from "../utils/test-helpers.js";

const OUTPUT_TOKEN_TEXT =
  "Claude's response exceeded the 32000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.";

describe("Replay E2E — contextExceeded loop termination", () => {
  test("both detector patterns complete their loops at the current iteration and the post-loop codon runs", async () => {
    const sessionFor = (id: string) => ({ sessionId: `session-${id}` });

    const fixture = buildReplayFixture({
      // Log specs keyed by BASE codon id — Replay.resolveCodonConfig falls
      // back from the runtime id (`gen#0`) to the base id (`gen`).
      codons: [
        {
          id: "setup",
          logLines: [
            assistantTextLine("Seeding the session.", sessionFor("setup")),
            successResultLine("setup done.", sessionFor("setup")),
          ],
        },
        {
          id: "gen",
          // Truncated: synthetic context-exceeded line, then nothing. Replay
          // exits 0 with no result message, exactly like the live SDK path.
          logLines: [
            assistantTextLine("Filling the window...", sessionFor("gen")),
            syntheticContextExceededLine(OUTPUT_TOKEN_TEXT, sessionFor("gen")),
          ],
        },
        {
          id: "gen2",
          logLines: [
            assistantTextLine("Filling the window again...", sessionFor("gen2")),
            syntheticContextExceededLine("API Error: terminated", sessionFor("gen2")),
          ],
        },
        {
          id: "gen3",
          // NOT truncated: an explicit ERROR result carrying the Claude
          // SDK's input-overflow wording. Replay stops at the result and
          // exits 0 — this pins that the context-exceeded check runs BEFORE
          // the exit-0-error-result failure branch in handleCodonComplete
          // (the live SDK path exits 1; without the ordering, live completed
          // while replay failed).
          logLines: [
            assistantTextLine("Filling the window a third time...", sessionFor("gen3")),
            errorResultLine("Prompt is too long", { sessionId: "session-gen3" }),
          ],
        },
        {
          id: "gen4",
          // The PRIMARY real-world shape on modern SDKs: the session
          // compacts (window filled), the codon then finishes its work with
          // a normal SUCCESS result. The flag riding the exit event must
          // still terminate the loop — completion takes the success branch,
          // termination happens in loop expansion.
          logLines: [
            assistantTextLine("Filling the window a fourth time...", sessionFor("gen4")),
            compactBoundaryLine({ sessionId: "session-gen4" }),
            assistantTextLine("Continuing after compaction.", sessionFor("gen4")),
            successResultLine("gen4 done.", { sessionId: "session-gen4" }),
          ],
        },
        {
          id: "after-loop",
          logLines: [
            assistantTextLine("Summarizing.", sessionFor("after-loop")),
            successResultLine("after-loop done.", sessionFor("after-loop")),
          ],
        },
      ],
      // contextExceeded loops require continue-previous codons (validation
      // rejects "fresh" — a fresh session never accumulates context), and
      // continue-previous needs a predecessor session: hence the setup codon,
      // mirroring the live marathon config's topology.
      hank: {
        hank: [
          {
            id: "setup",
            name: "Setup",
            promptText: "Replay fixture: seed the session.",
            model: "haiku",
            continuationMode: "fresh",
          },
          {
            type: "loop",
            id: "exhaust-loop",
            name: "Exhaust Loop (output-token pattern)",
            terminateOn: { type: "contextExceeded" },
            codons: [
              {
                id: "gen",
                name: "Generate",
                promptText: "Replay fixture: fill the context window.",
                model: "haiku",
                continuationMode: "continue-previous",
              },
            ],
          },
          {
            type: "loop",
            id: "exhaust-loop-2",
            name: "Exhaust Loop (API Error: terminated pattern)",
            terminateOn: { type: "contextExceeded" },
            codons: [
              {
                id: "gen2",
                name: "Generate 2",
                promptText: "Replay fixture: fill the context window again.",
                model: "haiku",
                continuationMode: "continue-previous",
              },
            ],
          },
          {
            type: "loop",
            id: "exhaust-loop-3",
            name: "Exhaust Loop (input-overflow error-result pattern)",
            terminateOn: { type: "contextExceeded" },
            codons: [
              {
                id: "gen3",
                name: "Generate 3",
                promptText: "Replay fixture: fill the context window a third time.",
                model: "haiku",
                continuationMode: "continue-previous",
              },
            ],
          },
          {
            type: "loop",
            id: "exhaust-loop-4",
            name: "Exhaust Loop (auto-compaction pattern)",
            terminateOn: { type: "contextExceeded" },
            codons: [
              {
                id: "gen4",
                name: "Generate 4",
                promptText: "Replay fixture: fill the context window a fourth time.",
                model: "haiku",
                continuationMode: "continue-previous",
              },
            ],
          },
          {
            id: "after-loop",
            name: "After Loop",
            promptText: "Replay fixture: post-loop codon.",
            model: "haiku",
            continuationMode: "fresh",
          },
        ],
      },
    });

    const port = await getFreePort();
    const server = await launchHankweave({
      port,
      configPath: fixture.configPath,
      dataDir: fixture.dataPath,
      replayDir: fixture.execDir,
      logPrefix: "[replay-ctx-exceeded]",
      extraArgs: ["--force"],
      // Exact event counts below need the journal backfill; safe because the
      // fixture is built fresh, so the journal contains only this run.
      sendPreviousEvents: true,
    });

    try {
      expect(await server.waitForEvent("server.ready", 30_000)).toBeDefined();

      // Loop iteration 0 must COMPLETE (not fail) on the exhaustion signal.
      await server.waitForCodonCompletion("gen#0", undefined, 60_000);
      await server.waitForCodonCompletion("gen2#0", undefined, 60_000);
      await server.waitForCodonCompletion("gen3#0", undefined, 60_000);
      await server.waitForCodonCompletion("gen4#0", undefined, 60_000);
      await server.waitForCodonCompletion("after-loop", undefined, 60_000);
      await server.waitForRunToComplete(30_000);

      // State is authoritative: exactly one iteration per loop — termination
      // happened at iteration 0, no `#1` entries were ever planned or run.
      const run = server.getState().runs[0];
      expect(run.codons.map((c) => c.codonId).sort()).toEqual([
        CodonId("after-loop"),
        CodonId("gen#0"),
        CodonId("gen2#0"),
        CodonId("gen3#0"),
        CodonId("gen4#0"),
        CodonId("setup"),
      ]);
      for (const codon of run.codons) {
        expect(codon.status).toBe("completed");
      }

      const events = server.getEvents();

      // The runtime narrates the mechanism: one info event per loop whose
      // iteration ended ON the exhaustion signal (gen, gen2, gen3). gen4
      // completes via the plain SUCCESS branch — compaction happened
      // mid-codon and the work finished normally — so its loop terminates in
      // expansion without the info event. `e.type === "info"` narrows the
      // discriminated union — no casts.
      const contextExceededInfos = events.filter(
        (e) =>
          e.type === "info" &&
          e.data.message.includes("completed successfully due to context exceeded"),
      );
      expect(contextExceededInfos.length).toBe(3);

      // codon.completed events report success for the exhausted iterations.
      for (const id of ["gen#0", "gen2#0", "gen3#0", "gen4#0"]) {
        const completed = events.find(
          (e): e is CodonCompletedEvent => e.type === "codon.completed" && e.data.codonId === id,
        );
        expect(completed).toBeDefined();
        expect(completed?.data.success).toBe(true);
      }
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  }, 120_000);

  test("the same signal outside a contextExceeded loop fails the codon", async () => {
    const fixture = buildReplayFixture({
      codons: [
        {
          id: "plain",
          logLines: [
            assistantTextLine("Working...", { sessionId: "session-plain" }),
            syntheticContextExceededLine(OUTPUT_TOKEN_TEXT, { sessionId: "session-plain" }),
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
      logPrefix: "[replay-ctx-exceeded-plain]",
      extraArgs: ["--force"],
      sendPreviousEvents: true,
    });

    try {
      expect(await server.waitForEvent("server.ready", 30_000)).toBeDefined();

      // Not in a terminateOn:contextExceeded loop → isContextExceededAcceptable
      // is false and the codon must FAIL. Completing it here would silently
      // truncate work in ordinary hanks whenever a session blew its window.
      const completed = await server.waitForEvent(
        "codon.completed",
        60_000,
        (e) => e.type === "codon.completed" && e.data.codonId === "plain",
      );
      if (completed.type !== "codon.completed") throw new Error("unreachable: filtered on type");
      expect(completed.data.success).toBe(false);

      await server.waitForState(
        (s) => s.runs[0]?.codons.find((c) => c.codonId === CodonId("plain"))?.status === "failed",
        30_000,
      );
    } finally {
      await server.stop();
      fixture.cleanup();
    }
  }, 120_000);
});
