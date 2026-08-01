#!/usr/bin/env bun
/**
 * Marathon ground truth for context exhaustion — everything real: real Claude
 * SDK, real Anthropic API, a real 200k window. Together the two tests are the
 * live on/off pair for auto-compaction (intermediates/55):
 *
 *   Test 1 — compaction default-OFF, terminateOn: contextExceeded.
 *   The window fills until the REAL boundary rejects a request. Measured
 *   (CLI 2.1.215): with compaction disabled the SDK surfaces a terminal
 *   "Prompt is too long" error result (isContextExceeded Pattern 2) — via
 *   the provider's overflow 400 or the CLI's own pre-flight on reported
 *   usage. The loop must COMPLETE on it, with zero compact_boundary lines
 *   anywhere (proof the default is really off against the live API).
 *
 *   Test 2 — autoCompact: true, terminateOn: iterationLimit.
 *   The codon opts in; the SDK compacts reactively at the boundary and the
 *   loop keeps iterating THROUGH it to its limit. Compaction emits
 *   compact_boundary (Pattern 3), which must NOT terminate an iterationLimit
 *   loop (execution-planner PRIORITY 1 applies only to contextExceeded
 *   loops).
 *
 * The free layers already pin these mechanisms offline (unit detector cases,
 * the claude/pi compaction-mock discriminators, the replay canary); what only
 * this suite can prove is that the REAL provider and SDK still produce those
 * shapes at the real boundary.
 *
 * Context is filled by INGESTION, not generation: rig setup deterministically
 * writes 10 corpus files (~50k tokens each) and every loop iteration reads one
 * into the continued session. Reading fills the window at input/cache speed —
 * the old shape asked haiku to WRITE 45k-word essays and, at output speed,
 * reached only ~129k of 200k before its own 10-minute timeout, which is why
 * this suite had never passed under the runner.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

/** The boundary typically lands at iteration 6-8, a few minutes in. */
const TEST_TIMEOUT_MS = 10 * 60 * 1_000;
const RUN_WAIT_MS = 8 * 60 * 1_000;

/** Count compact_boundary lines across every codon JSONL log of a run. */
function countCompactBoundaries(executionDir: string): number {
  let count = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith("-claude.log")) {
        const content = fs.readFileSync(p, "utf-8");
        for (const line of content.split("\n")) {
          if (line.includes('"compact_boundary"')) count++;
        }
      }
    }
  };
  walk(executionDir);
  return count;
}

describe("Context Exhaustion E2E Test", () => {
  it.skipIf(!process.env.LONG_TESTS)(
    "should complete loop on context exhaustion and continue to final codon when terminateOn is set",
    async () => {
      const configPath = "tests/config/test-context-exhaustion.config.json";
      const port = await getFreePort();
      const hankweave = await launchHankweave({
        configPath,
        port,
        logPrefix: "[context-exhaustion]",
      });

      try {
        await hankweave.waitForEvent("server.ready");
        await hankweave.waitForCodonStart("initial-setup");
        await hankweave.waitForCodonCompletion("initial-setup");
        console.log("[test] Initial setup completed");

        // Compaction is OFF (default): the loop must terminate on the real
        // overflow rejection and the run must COMPLETE (not fail, not run
        // forever — the config's loop budget is only the runaway brake, and
        // hitting it fails the run).
        await hankweave.waitForRunToComplete(RUN_WAIT_MS);
        console.log("[test] Run completed successfully");

        // The runtime logs this when an exit event carries the exhaustion
        // flag — the authoritative marker that the signal genuinely arrived.
        expect(hankweave.serverLogFile()).toContain(
          "[HANKWEAVE-SERVER] Context exceeded error detected",
        );
        console.log("[test] Context exceeded detected in logs");

        // The loop terminated EARLY on the signal: the 10-file corpus supports
        // at most ~10 meaningful iterations and the boundary lands around 6-8.
        // A loop that needed the budget brake instead ran to 160+ iterations.
        const state = hankweave.getState();
        const ingestIterations = state.runs[0].codons.filter((c) =>
          String(c.codonId).startsWith("ingest-content#"),
        );
        expect(ingestIterations.length).toBeGreaterThan(0);
        expect(ingestIterations.length).toBeLessThanOrEqual(12);
        for (const codon of ingestIterations) {
          expect(codon.status).toBe("completed");
        }
        console.log(`[test] Loop terminated after ${ingestIterations.length} iteration(s)`);

        // Compaction default is OFF — the live proof: not a single
        // compact_boundary in any codon log. The boundary arrived as the
        // provider/SDK overflow error (Pattern 2), not as compaction.
        expect(countCompactBoundaries(hankweave.executionDir)).toBe(0);
        console.log("[test] Zero compact_boundary lines — compaction genuinely off");

        // Verify the final codon after the loop executed
        const events = hankweave.getEvents();
        const finalCodonCompleteEvent = events.find(
          (e) =>
            e.type === "codon.completed" &&
            e.data.codonId === "final-codon" &&
            e.data.success === true,
        );
        expect(finalCodonCompleteEvent).toBeDefined();
        console.log("[test] Final codon completed successfully");

        // Verify the final summary file was created. Agent files live under
        // agentRoot/ inside the execution directory (<%PROJECT_DIR%> resolves
        // to agentRootPath — the old executionDir-relative path predated the
        // agentRoot split and could never have matched).
        const summaryFilePath = path.join(
          hankweave.executionDir,
          "agentRoot",
          "large_content",
          "final_summary.txt",
        );
        expect(fs.existsSync(summaryFilePath)).toBe(true);
        const summaryContent = fs.readFileSync(summaryFilePath, "utf-8");
        expect(summaryContent).toContain("Loop completed due to context exceeded");
        console.log("[test] Final summary file verified");

        console.log("\n=== TEST PASSED ===");
        console.log("✓ Context exceeded (compaction) detected");
        console.log("✓ Loop terminated early, codons completed (not failed)");
        console.log("✓ Final codon executed successfully");
        console.log("✓ Run completed (not failed)");
      } catch (error) {
        console.error("\n=== TEST FAILED ===");
        console.error(`Error: ${error}`);
        throw error;
      } finally {
        // Ensure server is stopped even if test fails
        try {
          await hankweave.stop();
        } catch {
          // Server may already be stopped
        }
      }
    },
    { timeout: TEST_TIMEOUT_MS },
  );

  it.skipIf(!process.env.LONG_TESTS)(
    "iterationLimit loop absorbs compaction and completes all its iterations",
    async () => {
      const configPath = "tests/config/test-context-exhaustion-with-iteration-terminate.config.json";
      const port = await getFreePort();
      const hankweave = await launchHankweave({
        configPath,
        port,
        logPrefix: "[context-exhaustion-iterlimit]",
      });

      try {
        await hankweave.waitForEvent("server.ready");

        // Wait for initial setup to complete
        await hankweave.waitForCodonStart("initial-setup");
        await hankweave.waitForCodonCompletion("initial-setup");
        console.log("[test] Initial setup completed");

        // ON-mode contract (intermediates/55): the codon sets autoCompact:
        // true, so when the window fills around iteration 6-8 the SDK
        // compacts reactively at the boundary and keeps going. An
        // iterationLimit loop must iterate THROUGH the boundary to its limit —
        // the exhaustion flag only terminates terminateOn:contextExceeded
        // loops (execution-planner PRIORITY 1). Without the opt-in this run
        // would FAIL at the window (compaction default is OFF — test 1).
        await hankweave.waitForRunToComplete(RUN_WAIT_MS);
        console.log("[test] Run completed");

        // The boundary genuinely happened mid-loop...
        expect(hankweave.serverLogFile()).toContain(
          "[HANKWEAVE-SERVER] Context exceeded error detected",
        );
        // ...as REAL compaction: autoCompact: true produced compact_boundary
        // lines in the codon logs (the live ON-mode proof, mirroring test 1's
        // zero-boundary OFF-mode proof).
        expect(countCompactBoundaries(hankweave.executionDir)).toBeGreaterThan(0);
        console.log("[test] Compaction boundary detected in logs");

        // ...and the loop still ran its full iteration count.
        const state = hankweave.getState();
        const ingestIterations = state.runs[0].codons.filter((c) =>
          String(c.codonId).startsWith("ingest-content#"),
        );
        expect(ingestIterations.length).toBe(12);
        for (const codon of ingestIterations) {
          expect(codon.status).toBe("completed");
        }
        console.log("[test] All 12 iterations completed across the compaction boundary");

        // The post-loop codon ran (the run completed normally).
        const summaryFilePath = path.join(
          hankweave.executionDir,
          "agentRoot",
          "large_content",
          "final_summary.txt",
        );
        expect(fs.existsSync(summaryFilePath)).toBe(true);
        console.log("[test] Final codon ran after the loop");

        console.log("\n=== TEST PASSED ===");
        console.log("✓ Compaction boundary detected mid-loop");
        console.log("✓ iterationLimit loop absorbed it and completed all iterations");
        console.log("✓ Run completed");
      } catch (error) {
        console.error("\n=== TEST FAILED ===");
        console.error(`Error: ${error}`);
        throw error;
      } finally {
        // Ensure server is stopped even if test fails
        try {
          await hankweave.stop();
        } catch {
          // Server may already be stopped
        }
      }
    },
    { timeout: TEST_TIMEOUT_MS },
  );
});
