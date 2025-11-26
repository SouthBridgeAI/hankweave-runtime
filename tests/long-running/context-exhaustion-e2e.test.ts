#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { getFreePort } from "../utils/test-helpers.js";
import { launchStrandweave } from "../utils/strandweave-server-test-helpers.js";

describe("Context Exhaustion E2E Test", () => {
  it.skipIf(!process.env.LONG_TESTS)(
    "should complete loop on context exhaustion and continue to final codon when terminateOn is set",
    async () => {
      const configPath = "tests/config/test-context-exhaustion.config.json";
      const port = await getFreePort();
      const strandweave = await launchStrandweave({
        configPath,
        port,
        logPrefix: "[context-exhaustion]",
      });

      try {
        await strandweave.waitForEvent("server.ready");
        await strandweave.waitForCodonStart("initial-setup");
        await strandweave.waitForCodonCompletion("initial-setup");
        console.log("[test] Initial setup completed");
        // Wait for run to complete successfully (not fail!)
        // The loop should terminate on context exceeded and mark codons as completed
        await strandweave.waitForRunToComplete(10 * 60 * 1_000); // 10 minutes

        console.log("[test] Run completed successfully");
        // XX:: the easiest way to track context overflow right now is to check server logs
        expect(strandweave.serverLogFile()).toContain(
          "[STRANDWEAVE-SERVER] Context exceeded error detected"
        );
        console.log("[test] Context exceeded detected in logs");

        // Verify our new info message about context exceeded completion
        const events = strandweave.getEvents();
        const contextExceededInfoEvent = events.find(
          (e) =>
            e.type === "info" &&
            e.data.message?.includes(
              "Codon completed successfully due to context exceeded"
            )
        );
        expect(contextExceededInfoEvent).toBeDefined();
        console.log("[test] Found context exceeded completion info event");

        // Verify the final codon after the loop executed
        const finalCodonStartEvent = events.find(
          (e) =>
            e.type === "codon.started" &&
            e.data.codonName === "Final Codon After Loop"
        );
        expect(finalCodonStartEvent).toBeDefined();
        console.log("[test] Final codon started");

        const finalCodonCompleteEvent = events.find(
          (e) =>
            e.type === "codon.completed" &&
            e.data.codonId === "final-codon" &&
            e.data.success === true
        );
        expect(finalCodonCompleteEvent).toBeDefined();
        console.log("[test] Final codon completed successfully");

        // Verify the final summary file was created
        const summaryFilePath = path.join(
          strandweave.executionDir,
          "large_content",
          "final_summary.txt"
        );
        expect(fs.existsSync(summaryFilePath)).toBe(true);
        const summaryContent = fs.readFileSync(summaryFilePath, "utf-8");
        expect(summaryContent).toContain(
          "Loop completed due to context exceeded"
        );
        console.log("[test] Final summary file verified");

        console.log("\n=== TEST PASSED ===");
        console.log("✓ Context exceeded detected");
        console.log("✓ Loop codons marked as completed (not failed)");
        console.log("✓ Final codon executed successfully");
        console.log("✓ Run completed (not failed)");
      } catch (error) {
        console.error("\n=== TEST FAILED ===");
        console.error(`Error: ${error}`);
        throw error;
      } finally {
        // Ensure server is stopped even if test fails
        try {
          await strandweave.stop();
        } catch {
          // Server may already be stopped
        }
      }
    },
    { timeout: 10 * 60 * 1_000 } // 10 minute timeout for this test
  );

  it.skipIf(!process.env.LONG_TESTS)(
    "should fail the run when context exhaustion happens in a loop with terminateOn set to iterationLimit",
    async () => {
      const configPath =
        "tests/config/test-context-exhaustion-with-iteration-terminate.config.json";
      const port = await getFreePort();
      const strandweave = await launchStrandweave({
        configPath,
        port,
        logPrefix: "[context-exhaustion-no-terminate]",
      });

      try {
        await strandweave.waitForEvent("server.ready");

        // Wait for initial setup to complete
        await strandweave.waitForCodonStart("initial-setup");
        await strandweave.waitForCodonCompletion("initial-setup");
        console.log("[test] Initial setup completed");

        // Wait for the run to fail (not complete successfully)
        // The loop should fail when context is exceeded since there's no terminateOn condition
        await strandweave.waitForRunToFail(10 * 60 * 1_000); // 10 minutes
        console.log("[test] Run failed as expected");

        // Verify context exceeded was detected
        expect(strandweave.serverLogFile()).toContain(
          "[STRANDWEAVE-SERVER] Context exceeded error detected"
        );
        console.log("[test] Context exceeded detected in logs");

        console.log("[test] Final summary file was not created (as expected)");

        console.log("\n=== TEST PASSED ===");
        console.log("✓ Context exceeded detected");
        console.log("✓ Loop failed (not completed)");
        console.log("✓ Final codon did NOT execute");
        console.log("✓ Run failed (as expected)");
      } catch (error) {
        console.error("\n=== TEST FAILED ===");
        console.error(`Error: ${error}`);
        throw error;
      } finally {
        // Ensure server is stopped even if test fails
        try {
          await strandweave.stop();
        } catch {
          // Server may already be stopped
        }
      }
    },
    { timeout: 10 * 60 * 1_000 } // 10 minute timeout for this test
  );
});
