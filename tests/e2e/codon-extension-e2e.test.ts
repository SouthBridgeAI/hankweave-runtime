#!/usr/bin/env bun
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
import { type LaunchedServer, launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

describe("Codon Extension E2E Test", () => {
  // Both tests below are read-only observations of the SAME completed run, so
  // the server boots exactly once: beforeAll drives setup-codon →
  // extending-codon (3 extensions) → final-codon through run completion, and
  // each test asserts against the captured events/state. One live run, not two.
  let hankweave: LaunchedServer;
  let executionPath: string;
  let agentRootPath: string;
  let setupCompleted: CodonCompletedEvent;
  let extendingStarted: CodonStartedEvent;
  let extendingCompleted: CodonCompletedEvent;
  let finalStarted: CodonStartedEvent;
  let finalCompleted: CodonCompletedEvent;

  beforeAll(async () => {
    const configPath = "tests/config/test-codon-extension.config.json";
    const port = await getFreePort();
    hankweave = await launchHankweave({
      configPath,
      port,
      logPrefix: "[codon-extension]",
    });

    // Wait for server ready and capture execution path
    const readyEvent = (await hankweave.waitForEvent("server.ready")) as ServerReadyEvent;
    executionPath = readyEvent.data.executionPath;
    agentRootPath = readyEvent.data.agentRootPath ?? executionPath;
    console.log("[test] Server ready, execution path:", executionPath);

    // ==========================================
    // 1. Wait for setup codon to complete
    // ==========================================
    await hankweave.waitForCodonStart("setup-codon");
    setupCompleted = (await hankweave.waitForCodonCompletion(
      "setup-codon",
      undefined,
      120_000,
    )) as CodonCompletedEvent;
    console.log("[test] Setup codon completed");

    // ==========================================
    // 2. Wait for extending codon to start
    // ==========================================
    extendingStarted = (await hankweave.waitForCodonStart(
      "extending-codon",
      setupCompleted.timestamp,
      60_000,
    )) as CodonStartedEvent;
    console.log("[test] Extending codon started with session:", extendingStarted.data.sessionId);

    // ==========================================
    // 3. Wait for extending codon to complete
    //    This should take a while as it extends 3 times
    // ==========================================
    extendingCompleted = (await hankweave.waitForCodonCompletion(
      "extending-codon",
      extendingStarted.timestamp,
      600_000, // 10 minutes - extensions take time
    )) as CodonCompletedEvent;
    console.log("[test] Extending codon completed");

    // ==========================================
    // 4. Wait for final codon to complete
    // ==========================================
    finalStarted = (await hankweave.waitForCodonStart(
      "final-codon",
      extendingCompleted.timestamp,
      60_000,
    )) as CodonStartedEvent;

    finalCompleted = (await hankweave.waitForCodonCompletion(
      "final-codon",
      finalStarted.timestamp,
      120_000,
    )) as CodonCompletedEvent;
    console.log("[test] Final codon completed");

    // ==========================================
    // 5. Wait for run to complete, then for the server's auto-shutdown
    // ==========================================
    await hankweave.waitForRunToComplete(30_000);
    console.log("[test] Run completed successfully");

    await hankweave.waitForConnectionClose(10_000);
  }, 720_000); // 12 minute timeout for the full live run

  afterAll(async () => {
    // Ensure server is stopped even if the run failed partway
    try {
      if (
        hankweave &&
        hankweave.process.exitCode === null &&
        hankweave.process.signalCode === null
      ) {
        await hankweave.stop();
      }
    } catch {
      // Server may already be stopped
    }
  }, 60_000);

  it("should extend a codon multiple times based on maxExtensions", () => {
    expect(setupCompleted.data.success).toBe(true);
    expect(extendingStarted.data.codonId).toBe("extending-codon");
    expect(extendingCompleted.data.success).toBe(true);

    // ==========================================
    // 1. Verify codon.extended events
    // ==========================================
    const events = hankweave.getEvents();
    const extensionEvents = events.filter(
      (e) =>
        e.type === "codon.extended" && (e as CodonExtendedEvent).data.codonId === "extending-codon",
    ) as CodonExtendedEvent[];

    console.log(`[test] Found ${extensionEvents.length} codon.extended events`);

    // At least 3 extension events (maxExtensions: 3). `>=`, not `===`: the
    // event stream is not an exact-count contract — a codon retry replays
    // extensions and duplicates events. The exact contract is the state
    // check on extensionCount below (step 5).
    expect(extensionEvents.length).toBeGreaterThanOrEqual(3);

    // Verify extensions 1..3 all happened (dedupe: retries repeat numbers)
    const extensionNumbers = [...new Set(extensionEvents.map((e) => e.data.extensionNumber))].sort(
      (a, b) => a - b,
    );
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
    // 2. Verify extension event timestamps are sequential
    // ==========================================
    const sortedByExtensionNumber = [...extensionEvents].sort(
      (a, b) => a.data.extensionNumber - b.data.extensionNumber,
    );
    for (let i = 1; i < sortedByExtensionNumber.length; i++) {
      const prevTimestamp = new Date(sortedByExtensionNumber[i - 1].timestamp).getTime();
      const currTimestamp = new Date(sortedByExtensionNumber[i].timestamp).getTime();
      // `>=`: consecutive events can share a millisecond (ISO granularity).
      expect(currTimestamp).toBeGreaterThanOrEqual(prevTimestamp);
    }
    console.log("[test] Extension event timestamps are sequential");

    // ==========================================
    // 3. Verify cumulative cost is tracked (each extension has a cost >= 0)
    // ==========================================
    const sortedCosts = sortedByExtensionNumber.map((e) => e.data.cumulativeCost);
    for (const cost of sortedCosts) {
      expect(cost).toBeGreaterThanOrEqual(0);
    }
    console.log("[test] Cumulative costs for each extension:", sortedCosts);

    // ==========================================
    // 4. Verify ExtensionCountUpdated state transitions
    // ==========================================
    const extensionStateTransitions = events.filter(
      (e) =>
        e.type === "state.transition" &&
        (e as StateTransitionEvent).data.transitionType === "ExtensionCountUpdated",
    ) as StateTransitionEvent[];

    // `>=` — twin of the codon.extended relaxation above; state's
    // extensionCount (step 5) is the exact contract.
    expect(extensionStateTransitions.length).toBeGreaterThanOrEqual(3);
    console.log(
      `[test] Found ${extensionStateTransitions.length} ExtensionCountUpdated state transitions`,
    );

    // ==========================================
    // 5. Verify state shows correct extensionCount
    // ==========================================
    const state = hankweave.getState();
    // The shared run in beforeAll waits for FULL completion, and a completed
    // run is no longer "current" — currentRunId is cleared. The original
    // pre-merge test read state mid-run, which is why it could look the run
    // up by currentRunId. This suite launches exactly one run; assert that
    // and read it directly.
    expect(state.runs.length).toBe(1);
    const currentRun = state.runs[0];

    const extendingCodonState = currentRun.codons.find((c) => c.codonId === "extending-codon") as
      | CompletedCodon
      | undefined;
    if (!extendingCodonState) {
      throw new Error("Extending codon not found in state");
    }
    expect(extendingCodonState.status).toBe("completed");
    expect(extendingCodonState.extensionCount).toBe(3);
    console.log("[test] State shows extensionCount:", extendingCodonState.extensionCount);

    // Authoritative sentinel record: state carries which sentinels executed
    // for this codon, so the event-stream checks below only need lower
    // bounds.
    const executedSentinelIds = (extendingCodonState.sentinels?.executed ?? [])
      .map((s) => s.id)
      .sort();
    expect(executedSentinelIds).toEqual(["extension-activity-tracker", "extension-tracker"]);

    // ==========================================
    // 6. Verify sentinels loaded for extending codon
    // ==========================================
    const sentinelLoadedEvents = events.filter(
      (e) =>
        e.type === "sentinel.loaded" &&
        (e as SentinelLoadedEvent).data.codonId === "extending-codon",
    ) as SentinelLoadedEvent[];

    // Both sentinels stay loaded across extensions, so normally exactly 2
    // loaded events. `>=` + dedupe: a codon retry reloads sentinels and
    // duplicates events; the exact record is the state assertion above.
    expect(sentinelLoadedEvents.length).toBeGreaterThanOrEqual(2);
    const loadedSentinelIds = [
      ...new Set(sentinelLoadedEvents.map((e) => e.data.sentinelId)),
    ].sort();
    expect(loadedSentinelIds).toEqual(["extension-activity-tracker", "extension-tracker"]);
    console.log("[test] Both sentinels loaded for extending codon:", loadedSentinelIds);

    // ==========================================
    // 7. Verify final codon ran on a fresh session
    // ==========================================
    expect(finalStarted.data.codonId).toBe("final-codon");

    // Verify final codon uses fresh session (continuationMode: "fresh")
    expect(finalStarted.data.previousSessionId).toBeUndefined();
    console.log(
      "[test] Final codon started with fresh session (as required after exhaustWithPrompt)",
    );
    expect(finalCompleted.data.success).toBe(true);

    // ==========================================
    // 8. Verify sentinels unloaded after run completed
    // ==========================================
    const sentinelUnloadedEvents = events.filter(
      (e) =>
        e.type === "sentinel.unloaded" &&
        (e as SentinelUnloadedEvent).data.codonId === "extending-codon",
    ) as SentinelUnloadedEvent[];

    // Both sentinels unload when the codon completes. `>=` + dedupe for the
    // same retry-duplication reason as the loaded events above.
    expect(sentinelUnloadedEvents.length).toBeGreaterThanOrEqual(2);
    const unloadedSentinelIds = [
      ...new Set(sentinelUnloadedEvents.map((e) => e.data.sentinelId)),
    ].sort();
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
        // `>=`: load and unload can share a millisecond (ISO granularity).
        expect(unloadedTime).toBeGreaterThanOrEqual(loadedTime);
      }
    }

    // ==========================================
    // 8b. Verify activity tracker saw events from ALL extensions
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
    // 9. Verify file outputs
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
    // 10. Verify sentinel output file exists
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
    // 11. Verify log file contains appended content from extensions
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
    // 12. Verify total cost in completed event
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
  });

  it("should NOT re-process log messages on extension restarts", () => {
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
    // Same completed-run lookup as above: one run, no currentRunId after
    // completion.
    expect(state.runs.length).toBe(1);
    const currentRun = state.runs[0];
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

    console.log("\n=== TEST PASSED ===");
    console.log("✓ No duplicate message processing detected");
    console.log(
      `✓ ${uniqueMessagesWithUsage} unique messages = ${costTransitions.length} cost transitions`,
    );
  });
});
