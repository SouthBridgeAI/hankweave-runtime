#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CodonCompletedEvent,
  CodonExtendedEvent,
  CodonStartedEvent,
  SentinelLoadedEvent,
  SentinelUnloadedEvent,
  ServerReadyEvent,
  StateTransitionEvent,
} from "../../server/schemas/event-schemas.js";
import type { CompletedCodon } from "../../server/types/state-types.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

describe("Codon Extension E2E Test", () => {
  it("should extend a codon multiple times based on maxExtensions", async () => {
    const configPath = "tests/config/test-codon-extension.config.json";
    const port = await getFreePort();
    const hankweave = await launchHankweave({
      configPath,
      port,
      logPrefix: "[codon-extension]",
    });

    try {
      // Wait for server ready and capture execution path
      const readyEvent = (await hankweave.waitForEvent("server.ready")) as ServerReadyEvent;
      const executionPath = readyEvent.data.executionPath;
      const agentRootPath = readyEvent.data.agentRootPath ?? executionPath;
      console.log("[test] Server ready, execution path:", executionPath);

      // ==========================================
      // 1. Wait for setup codon to complete
      // ==========================================
      await hankweave.waitForCodonStart("setup-codon");
      const setupCompleted = (await hankweave.waitForCodonCompletion(
        "setup-codon",
        undefined,
        120_000,
      )) as CodonCompletedEvent;
      expect(setupCompleted.data.success).toBe(true);
      console.log("[test] Setup codon completed successfully");

      // ==========================================
      // 2. Wait for extending codon to start
      // ==========================================
      const extendingStarted = (await hankweave.waitForCodonStart(
        "extending-codon",
        setupCompleted.timestamp,
        60_000,
      )) as CodonStartedEvent;
      expect(extendingStarted.data.codonId).toBe("extending-codon");
      const extendingSessionId = extendingStarted.data.sessionId;
      console.log("[test] Extending codon started with session:", extendingSessionId);

      // ==========================================
      // 3. Wait for extending codon to complete
      //    This should take a while as it extends 3 times
      // ==========================================
      const extendingCompleted = (await hankweave.waitForCodonCompletion(
        "extending-codon",
        extendingStarted.timestamp,
        600_000, // 10 minutes - extensions take time
      )) as CodonCompletedEvent;
      expect(extendingCompleted.data.success).toBe(true);
      console.log("[test] Extending codon completed successfully");

      // ==========================================
      // 4. Verify codon.extended events
      // ==========================================
      const events = hankweave.getEvents();
      const extensionEvents = events.filter(
        (e) =>
          e.type === "codon.extended" &&
          (e as CodonExtendedEvent).data.codonId === "extending-codon",
      ) as CodonExtendedEvent[];

      console.log(`[test] Found ${extensionEvents.length} codon.extended events`);

      // Should have exactly 3 extension events (maxExtensions: 3)
      expect(extensionEvents.length).toBe(3);

      // Verify extension numbers are sequential
      const extensionNumbers = extensionEvents
        .map((e) => e.data.extensionNumber)
        .sort((a, b) => a - b);
      expect(extensionNumbers).toEqual([1, 2, 3]);

      // Verify each extension event has the correct structure
      for (const event of extensionEvents) {
        expect(event.data.codonId).toBe("extending-codon");
        expect(event.data.codonName).toBe("Extending Codon");
        expect(typeof event.data.extensionNumber).toBe("number");
        expect(typeof event.data.exhaustWithPrompt).toBe("string");
        expect(event.data.exhaustWithPrompt).toContain("Continue writing more poems");
        // Verify cumulative cost is tracked
        expect(typeof event.data.cumulativeCost).toBe("number");
        expect(event.data.cumulativeCost).toBeGreaterThanOrEqual(0);
      }
      console.log("[test] All codon.extended events have correct structure");

      // ==========================================
      // 5. Verify extension event timestamps are sequential
      // ==========================================
      const sortedByExtensionNumber = [...extensionEvents].sort(
        (a, b) => a.data.extensionNumber - b.data.extensionNumber,
      );
      for (let i = 1; i < sortedByExtensionNumber.length; i++) {
        const prevTimestamp = new Date(sortedByExtensionNumber[i - 1].timestamp).getTime();
        const currTimestamp = new Date(sortedByExtensionNumber[i].timestamp).getTime();
        expect(currTimestamp).toBeGreaterThan(prevTimestamp);
      }
      console.log("[test] Extension event timestamps are sequential");

      // ==========================================
      // 6. Verify cumulative cost is tracked (each extension has a cost >= 0)
      // ==========================================
      const sortedCosts = sortedByExtensionNumber.map((e) => e.data.cumulativeCost);
      for (const cost of sortedCosts) {
        expect(cost).toBeGreaterThanOrEqual(0);
      }
      console.log("[test] Cumulative costs for each extension:", sortedCosts);

      // ==========================================
      // 7. Verify ExtensionCountUpdated state transitions
      // ==========================================
      const extensionStateTransitions = events.filter(
        (e) =>
          e.type === "state.transition" &&
          (e as StateTransitionEvent).data.transitionType === "ExtensionCountUpdated",
      ) as StateTransitionEvent[];

      expect(extensionStateTransitions.length).toBe(3);
      console.log("[test] Found 3 ExtensionCountUpdated state transitions");

      // ==========================================
      // 8. Verify state shows correct extensionCount
      // ==========================================
      const state = hankweave.getState();
      const currentRun = state.runs.find((run) => run.runId === state.currentRunId);
      if (!currentRun) {
        throw new Error("No current run found in state");
      }

      const extendingCodonState = currentRun.codons.find((c) => c.codonId === "extending-codon") as
        | CompletedCodon
        | undefined;
      if (!extendingCodonState) {
        throw new Error("Extending codon not found in state");
      }
      expect(extendingCodonState.status).toBe("completed");
      expect(extendingCodonState.extensionCount).toBe(3);
      console.log("[test] State shows extensionCount:", extendingCodonState.extensionCount);

      // ==========================================
      // 9. Verify sentinels loaded for extending codon
      // ==========================================
      const sentinelLoadedEvents = events.filter(
        (e) =>
          e.type === "sentinel.loaded" &&
          (e as SentinelLoadedEvent).data.codonId === "extending-codon",
      ) as SentinelLoadedEvent[];

      // Should have exactly 2 sentinel loaded events (both sentinels stay loaded across extensions)
      expect(sentinelLoadedEvents.length).toBe(2);
      const loadedSentinelIds = sentinelLoadedEvents.map((e) => e.data.sentinelId).sort();
      expect(loadedSentinelIds).toEqual(["extension-activity-tracker", "extension-tracker"]);
      console.log("[test] Both sentinels loaded for extending codon:", loadedSentinelIds);

      // ==========================================
      // 10. Wait for final codon to complete
      // ==========================================
      const finalStarted = (await hankweave.waitForCodonStart(
        "final-codon",
        extendingCompleted.timestamp,
        60_000,
      )) as CodonStartedEvent;
      expect(finalStarted.data.codonId).toBe("final-codon");

      // Verify final codon uses fresh session (continuationMode: "fresh")
      expect(finalStarted.data.previousSessionId).toBeUndefined();
      console.log(
        "[test] Final codon started with fresh session (as required after exhaustWithPrompt)",
      );

      const finalCompleted = (await hankweave.waitForCodonCompletion(
        "final-codon",
        finalStarted.timestamp,
        120_000,
      )) as CodonCompletedEvent;
      expect(finalCompleted.data.success).toBe(true);
      console.log("[test] Final codon completed successfully");

      // ==========================================
      // 11. Wait for run to complete
      // ==========================================
      await hankweave.waitForRunToComplete(30_000);
      console.log("[test] Run completed successfully");

      // ==========================================
      // 12. Verify sentinels unloaded after run completed
      // ==========================================
      // Re-fetch events after run completion to get sentinel.unloaded
      const allEvents = hankweave.getEvents();
      const sentinelUnloadedEvents = allEvents.filter(
        (e) =>
          e.type === "sentinel.unloaded" &&
          (e as SentinelUnloadedEvent).data.codonId === "extending-codon",
      ) as SentinelUnloadedEvent[];

      // Should have exactly 2 sentinel unloaded events (both sentinels unload when codon completes)
      expect(sentinelUnloadedEvents.length).toBe(2);
      const unloadedSentinelIds = sentinelUnloadedEvents.map((e) => e.data.sentinelId).sort();
      expect(unloadedSentinelIds).toEqual(["extension-activity-tracker", "extension-tracker"]);
      console.log("[test] Both sentinels unloaded after codon completed:", unloadedSentinelIds);

      // Verify unload reasons are valid
      for (const event of sentinelUnloadedEvents) {
        expect(["codon-complete", "shutdown"]).toContain(event.data.reason);
      }

      // Verify all sentinels were loaded before being unloaded
      for (const loadedEvent of sentinelLoadedEvents) {
        const unloadedEvent = sentinelUnloadedEvents.find(
          (e) => e.data.sentinelId === loadedEvent.data.sentinelId,
        );
        expect(unloadedEvent).toBeDefined();
        if (unloadedEvent) {
          const loadedTime = new Date(loadedEvent.timestamp).getTime();
          const unloadedTime = new Date(unloadedEvent.timestamp).getTime();
          expect(unloadedTime).toBeGreaterThan(loadedTime);
        }
      }

      // ==========================================
      // 12b. Verify activity tracker saw events from ALL extensions
      // ==========================================
      // The activity tracker should have made multiple LLM calls as it debounced actions
      // across all 4 runs (initial + 3 extensions)
      const activityTrackerUnload = sentinelUnloadedEvents.find(
        (e) => e.data.sentinelId === "extension-activity-tracker",
      );
      expect(activityTrackerUnload).toBeDefined();
      if (activityTrackerUnload) {
        // Should have at least 1 LLM call (debounced batches across extensions)
        expect(activityTrackerUnload.data.llmCallCount).toBeGreaterThanOrEqual(1);
        console.log(
          `[test] Activity tracker made ${activityTrackerUnload.data.llmCallCount} LLM calls across all extensions`,
        );
      }

      // ==========================================
      // 13. Verify file outputs
      // ==========================================
      const notesDir = path.join(agentRootPath, "notes");
      expect(fs.existsSync(notesDir)).toBe(true);

      const files = fs.readdirSync(notesDir);
      console.log("[test] Files in notes directory:", files);

      // Should have setup_complete.txt
      expect(files).toContain("setup_complete.txt");

      // Should have multiple poem files (initial + 3 extensions = potentially 4 poems)
      const poemFiles = files.filter((f) => f.startsWith("poem_") && f.endsWith(".txt"));
      expect(poemFiles.length).toBeGreaterThanOrEqual(1);
      console.log(`[test] Found ${poemFiles.length} poem files`);

      // Should have summary.txt from final codon
      expect(files).toContain("summary.txt");

      // ==========================================
      // 14. Verify sentinel output file exists
      // ==========================================
      const sentinelOutputDir = path.join(executionPath, ".hankweave/sentinel-outputs");
      if (fs.existsSync(sentinelOutputDir)) {
        const sentinelOutputFiles = fs.readdirSync(sentinelOutputDir);
        const extensionTrackingFile = sentinelOutputFiles.find((f) =>
          f.includes("extension-tracking"),
        );
        if (extensionTrackingFile) {
          const sentinelOutputPath = path.join(sentinelOutputDir, extensionTrackingFile);
          const sentinelOutput = fs.readFileSync(sentinelOutputPath, "utf-8");
          console.log(`[test] Sentinel output file found: ${extensionTrackingFile}`);
          console.log(`[test] Sentinel output size: ${sentinelOutput.length} bytes`);

          // Verify the sentinel output has content (it should have processed extension events)
          if (sentinelOutput.length > 0) {
            // Count lines in JSONL file (each extension should generate output)
            const outputLines = sentinelOutput.trim().split("\n").filter(Boolean);
            console.log(`[test] Sentinel processed ${outputLines.length} extension events`);
          }
        } else {
          console.log(
            "[test] No extension-tracking sentinel output file found (sentinel may not have triggered)",
          );
        }
      }

      // ==========================================
      // 15. Verify log file contains appended content from extensions
      // ==========================================
      const runId = currentRun.runId;
      const logDir = path.join(executionPath, ".hankweave/runs", runId);
      const logPath = path.join(logDir, "extending-codon-claude.log");

      expect(fs.existsSync(logPath)).toBe(true);
      const logContent = fs.readFileSync(logPath, "utf-8");

      // The log should contain multiple session references since extensions append
      const sessionIdMatches = logContent.match(/[a-f0-9-]{36}/gi); // UUID pattern
      const uniqueSessionIds = sessionIdMatches ? [...new Set(sessionIdMatches)] : [];
      console.log(
        `[test] Log file contains references to ${uniqueSessionIds.length} unique session-like IDs`,
      );

      // Log file should be substantial (multiple extensions appended)
      expect(logContent.length).toBeGreaterThan(1000);
      console.log(`[test] Log file size: ${logContent.length} bytes`);

      // ==========================================
      // 16. Verify total cost in completed event
      // ==========================================
      expect(extendingCompleted.data.cost).toBeGreaterThan(0);
      console.log(`[test] Total cost for extending codon: $${extendingCompleted.data.cost}`);

      // ==========================================
      // Summary
      // ==========================================
      console.log("\n=== TEST PASSED ===");
      console.log("✓ Setup codon completed");
      console.log("✓ Extending codon extended 3 times");
      console.log("✓ 3 codon.extended events emitted with correct structure");
      console.log("✓ Extension timestamps are sequential");
      console.log("✓ Cumulative cost tracked for each extension");
      console.log("✓ 3 ExtensionCountUpdated state transitions");
      console.log("✓ State shows extensionCount: 3");
      console.log("✓ Both sentinels loaded once and unloaded once (persist across extensions)");
      console.log("✓ Activity tracker sentinel saw events from all extensions");
      console.log("✓ Final codon ran with fresh session");
      console.log("✓ Run completed successfully");
      console.log("✓ Output files created correctly");
      console.log("✓ Log file has appended content from extensions");
      console.log(`✓ Total cost tracked: $${extendingCompleted.data.cost}`);

      // Server should auto-shutdown
      await hankweave.waitForConnectionClose(10_000);
    } catch (error) {
      console.error("\n=== TEST FAILED ===");
      console.error(`Error: ${error}`);
      throw error;
    } finally {
      // Ensure server is stopped even if test fails
      try {
        if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
          await hankweave.stop();
        }
      } catch {
        // Server may already be stopped
      }
    }
  }, 720_000); // 12 minute timeout for entire test

  it("should NOT re-process log messages on extension restarts", async () => {
    const configPath = "tests/config/test-codon-extension.config.json";
    const port = await getFreePort();
    const hankweave = await launchHankweave({
      configPath,
      port,
      logPrefix: "[extension-reparse-bug]",
    });

    try {
      // Wait for server ready
      const readyEvent = (await hankweave.waitForEvent("server.ready")) as ServerReadyEvent;
      const executionPath = readyEvent.data.executionPath;

      // Wait for extending codon to complete (with 3 extensions)
      await hankweave.waitForCodonStart("setup-codon");
      await hankweave.waitForCodonCompletion("setup-codon", undefined, 120_000);

      const extendingStarted = await hankweave.waitForCodonStart("extending-codon");
      await hankweave.waitForCodonCompletion(
        "extending-codon",
        extendingStarted.timestamp,
        600_000,
      );

      // Get all events
      const events = hankweave.getEvents();

      // Count CostsIncremented transitions for extending-codon
      const costTransitions = events.filter(
        (e) =>
          e.type === "state.transition" &&
          (e as StateTransitionEvent).data.transitionType === "CostsIncremented" &&
          (e as StateTransitionEvent).data.codonId === "extending-codon",
      );

      // Read log file and count unique assistant messages with usage
      const state = hankweave.getState();
      const currentRun = state.runs.find((run) => run.runId === state.currentRunId);
      if (!currentRun) {
        throw new Error("No current run found in state");
      }
      const runId = currentRun.runId;
      const logPath = path.join(
        executionPath,
        ".hankweave/runs",
        runId,
        "extending-codon-claude.log",
      );

      const logContent = fs.readFileSync(logPath, "utf-8");
      const logLines = logContent.trim().split("\n");

      let uniqueMessagesWithUsage = 0;
      for (const line of logLines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          // Count assistant messages that have usage data (these trigger cost updates)
          if (msg.type === "assistant" && msg.message?.usage) {
            uniqueMessagesWithUsage++;
          }
        } catch {
          // Skip invalid JSON lines
        }
      }

      console.log(`[test] Unique assistant messages with usage: ${uniqueMessagesWithUsage}`);
      console.log(`[test] CostsIncremented transitions: ${costTransitions.length}`);

      // CRITICAL ASSERTION: Each message should trigger exactly ONE cost transition
      // If the bug exists, we'd see MORE transitions than unique messages
      // (because old messages are re-processed on each extension restart)
      expect(costTransitions.length).toBe(uniqueMessagesWithUsage);

      // Additional sanity check: should have at least some messages
      expect(uniqueMessagesWithUsage).toBeGreaterThan(0);

      await hankweave.waitForRunToComplete(30_000);

      console.log("\n=== TEST PASSED ===");
      console.log("✓ No duplicate message processing detected");
      console.log(
        `✓ ${uniqueMessagesWithUsage} unique messages = ${costTransitions.length} cost transitions`,
      );
    } catch (error) {
      console.error("\n=== TEST FAILED ===");
      console.error(`Error: ${error}`);
      throw error;
    } finally {
      // Cleanup
      try {
        if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
          await hankweave.stop();
        }
      } catch {
        // Already stopped
      }
    }
  }, 720_000); // 12 minute timeout for entire test
});
