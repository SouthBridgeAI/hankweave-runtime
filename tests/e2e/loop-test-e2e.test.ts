#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  CodonCompletedEvent,
  CodonStartedEvent,
  SentinelLoadedEvent,
  SentinelUnloadedEvent,
  ServerReadyEvent,
} from "../../server/schemas/event-schemas.js";
import { CodonId } from "../../server/types/branded-types.js";
import { launchStrandweave } from "../utils/strandweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

describe("Loop E2E Test", () => {
  it("should execute codons in correct order with loop expansion", async () => {
    const configPath = "tests/config/test-codons-with-loop.config.json";
    const port = await getFreePort();
    const strandweave = await launchStrandweave({
      configPath,
      port,
      logPrefix: "[loop-test]",
    });

    try {
      // Wait for server ready and capture execution path
      const readyEvent = (await strandweave.waitForEvent("server.ready")) as ServerReadyEvent;
      const executionPath = readyEvent.data.executionPath;

      // Expected codons:
      // 1. codon-1 (regular)
      // 2. write-poem#0 (loop iteration 0)
      // 3. review-poem#0 (loop iteration 0)
      // 4. write-poem#1 (loop iteration 1)
      // 5. review-poem#1 (loop iteration 1)
      // 6. codon-3 (regular)

      const expectedCodons = [
        "codon-1",
        "write-poem#0",
        "review-poem#0",
        "write-poem#1",
        "review-poem#1",
        "codon-3",
      ];

      const codonEvents: CodonStartedEvent[] = [];
      const completedCodons: CodonCompletedEvent[] = [];
      let lastTimestamp: string | undefined;

      // Wait for all codons to complete (with longer timeout per codon)
      for (const expectedCodonId of expectedCodons) {
        const startEvent = (await strandweave.waitForCodonStart(
          expectedCodonId,
          lastTimestamp,
          300_000, // 5 minute timeout for codon start
        )) as CodonStartedEvent;

        expect(startEvent.data.codonId).toBe(expectedCodonId);
        codonEvents.push(startEvent);

        const completedEvent = (await strandweave.waitForCodonCompletion(
          expectedCodonId,
          startEvent.timestamp,
          300_000, // 5 minute timeout for codon completion
        )) as CodonCompletedEvent;

        expect(completedEvent.data.success).toBe(true);
        completedCodons.push(completedEvent);
        lastTimestamp = completedEvent.timestamp;
      }

      // Verify codon execution order
      const codonIds = codonEvents.map((e) => e.data.codonId);
      expect(codonIds).toEqual([
        "codon-1",
        "write-poem#0",
        "review-poem#0",
        "write-poem#1",
        "review-poem#1",
        "codon-3",
      ]);

      // Verify all codons completed successfully
      expect(completedCodons.length).toBe(6);
      for (const codon of completedCodons) {
        expect(codon.data.success).toBe(true);
      }

      // Verify loop iteration naming
      const loopCodonIds = codonEvents
        .filter((e) => e.data.codonId.includes("#"))
        .map((e) => e.data.codonId);

      expect(loopCodonIds).toContain("write-poem#0");
      expect(loopCodonIds).toContain("review-poem#0");
      expect(loopCodonIds).toContain("write-poem#1");
      expect(loopCodonIds).toContain("review-poem#1");

      // Verify codon names for loop iterations
      const writePoemCodons = codonEvents.filter((e) => e.data.codonId.startsWith("write-poem"));

      expect(writePoemCodons.length).toBe(2);
      for (const codon of writePoemCodons) {
        expect(codon.data.codonName).toBe("Write Additional Poem");
      }

      // Verify session continuity across loop iterations
      const writePoemCodon0 = codonEvents.find((e) => e.data.codonId === "write-poem#0");
      const reviewPoemCodon0 = codonEvents.find((e) => e.data.codonId === "review-poem#0");

      expect(writePoemCodon0?.data.sessionId).toBeTruthy();
      if (writePoemCodon0?.data.sessionId) {
        expect(reviewPoemCodon0?.data.previousSessionId).toBe(writePoemCodon0.data.sessionId);
      }

      // Second iteration should continue from first
      const writePoemCodon1 = codonEvents.find((e) => e.data.codonId === "write-poem#1");
      const reviewPoemCodon1 = codonEvents.find((e) => e.data.codonId === "review-poem#1");

      if (reviewPoemCodon0?.data.sessionId && writePoemCodon1?.data.sessionId) {
        expect(writePoemCodon1.data.previousSessionId).toBe(reviewPoemCodon0.data.sessionId);
        expect(reviewPoemCodon1?.data.previousSessionId).toBe(writePoemCodon1.data.sessionId);
      }

      // Verify loop termination (2 codons per iteration * 2 iterations = 4 codons)
      const loopIterations = codonEvents.filter(
        (e) =>
          e.data.codonId.startsWith("write-poem#") || e.data.codonId.startsWith("review-poem#"),
      );
      expect(loopIterations.length).toBe(4);

      // Verify codon-3 executed after loop
      const codon3 = completedCodons.find((e) => e.data.codonId === "codon-3");
      expect(codon3).toBeTruthy();
      expect(codon3?.data.success).toBe(true);

      // Verify file output from loop iterations
      const notesDir = path.join(executionPath, "notes");
      expect(fs.existsSync(notesDir)).toBe(true);

      const files = fs.readdirSync(notesDir);

      // Find all additional poem files (should be 2 - one per iteration)
      const additionalPoemFiles = files.filter(
        (f) => f.startsWith("additional_poem_") && f.endsWith(".txt"),
      );
      expect(additionalPoemFiles.length).toBe(2);

      // Find all poem review files (should be 2 - one per iteration)
      const poemReviewFiles = files.filter(
        (f) => f.startsWith("poem_review_") && f.endsWith(".txt"),
      );
      expect(poemReviewFiles.length).toBe(2);

      // Verify files are not empty
      for (const file of [...additionalPoemFiles, ...poemReviewFiles]) {
        const filePath = path.join(notesDir, file);
        expect(fs.existsSync(filePath)).toBe(true);
        const content = fs.readFileSync(filePath, "utf-8");
        expect(content.length).toBeGreaterThan(0);
      }

      // Wait for the run to complete naturally (RunCompleted state transition)
      await strandweave.waitForRunToComplete(10_000);

      // Verify sentinel lifecycle events in loop codons
      // Sentinels should be loaded once per loop codon iteration with iteration-specific IDs

      const expectedLoopCodonsWithSentinels = [
        "write-poem#0",
        "review-poem#0",
        "write-poem#1",
        "review-poem#1",
      ];

      // Wait a bit for sentinel cleanup to complete
      // await new Promise((resolve) => setTimeout(resolve, 5000));

      // Get all events
      const events = strandweave.getEvents();

      // Verify sentinel.loaded events
      const loadedEvents = events.filter(
        (e) => e.type === "sentinel.loaded",
      ) as SentinelLoadedEvent[];

      // Should have 4 loaded events (1 per loop codon iteration)
      expect(loadedEvents.length).toBe(4);

      // Verify each loaded event has correct codonId with iteration suffix
      const loadedCodonIds = loadedEvents.map((e) => e.data.codonId).sort();
      expect(loadedCodonIds).toEqual(expectedLoopCodonsWithSentinels.sort());

      // Verify sentinel ID is consistent
      for (const event of loadedEvents) {
        expect(event.data.sentinelId).toBe("loop-test-sentinel");
        expect(event.data.source).toBe("file");
        expect(event.data.triggerType).toBe("event");
      }

      // Verify sentinel.unloaded events
      const unloadedEvents = events.filter(
        (e) => e.type === "sentinel.unloaded",
      ) as SentinelUnloadedEvent[];

      // Should have 4 unloaded events (1 per loop codon iteration)
      expect(unloadedEvents.length).toBe(4);

      // Verify each unloaded event has correct codonId with iteration suffix
      const unloadedCodonIds = unloadedEvents.map((e) => e.data.codonId).sort();
      expect(unloadedCodonIds).toEqual(expectedLoopCodonsWithSentinels.sort());

      // Verify unload reasons
      for (const event of unloadedEvents) {
        expect(event.data.sentinelId).toBe("loop-test-sentinel");
        expect(["codon-complete", "shutdown"]).toContain(event.data.reason);
        expect(typeof event.data.finalCost).toBe("number");
        expect(typeof event.data.llmCallCount).toBe("number");
      }

      // Verify loaded and unloaded events are properly paired per iteration
      for (const codonId of expectedLoopCodonsWithSentinels) {
        const loaded = loadedEvents.find((e) => e.data.codonId === codonId);
        const unloaded = unloadedEvents.find((e) => e.data.codonId === codonId);

        expect(loaded).toBeDefined();
        expect(unloaded).toBeDefined();

        if (loaded && unloaded) {
          // Unloaded should happen after loaded
          expect(new Date(unloaded.timestamp).getTime()).toBeGreaterThan(
            new Date(loaded.timestamp).getTime(),
          );
        }
      }

      // Verify loopContext is set correctly for loop codons and not set for non-loop codons
      const finalState = strandweave.getState();
      const currentRun = finalState.runs[0];
      expect(currentRun).toBeDefined();

      // Get all codons from current run
      const allCodons = currentRun.codons;

      // Verify codon-1 (non-loop codon) has no loopContext
      const codon1State = allCodons.find((p) => p.codonId === "codon-1");
      expect(codon1State).toBeDefined();
      expect(codon1State?.loopContext).toBeUndefined();

      // Verify write-poem#0 has correct loopContext
      const writePoemCodon0State = allCodons.find((p) => p.codonId === "write-poem#0");
      expect(writePoemCodon0State).toBeDefined();
      expect(writePoemCodon0State?.loopContext).toBeDefined();
      expect(writePoemCodon0State?.loopContext?.loopId).toBe(CodonId("iterative-refinement"));
      expect(writePoemCodon0State?.loopContext?.iteration).toBe(0);
      expect(writePoemCodon0State?.loopContext?.codonIndexInLoop).toBe(0);

      // Verify review-poem#0 has correct loopContext
      const reviewPoemCodon0State = allCodons.find((p) => p.codonId === "review-poem#0");
      expect(reviewPoemCodon0State).toBeDefined();
      expect(reviewPoemCodon0State?.loopContext).toBeDefined();
      expect(reviewPoemCodon0State?.loopContext?.loopId).toBe(CodonId("iterative-refinement"));
      expect(reviewPoemCodon0State?.loopContext?.iteration).toBe(0);
      expect(reviewPoemCodon0State?.loopContext?.codonIndexInLoop).toBe(1);

      // Verify write-poem#1 has correct loopContext
      const writePoemCodon1State = allCodons.find((p) => p.codonId === "write-poem#1");
      expect(writePoemCodon1State).toBeDefined();
      expect(writePoemCodon1State?.loopContext).toBeDefined();
      expect(writePoemCodon1State?.loopContext?.loopId).toBe(CodonId("iterative-refinement"));
      expect(writePoemCodon1State?.loopContext?.iteration).toBe(1);
      expect(writePoemCodon1State?.loopContext?.codonIndexInLoop).toBe(0);

      // Verify review-poem#1 has correct loopContext
      const reviewPoemCodon1State = allCodons.find((p) => p.codonId === "review-poem#1");
      expect(reviewPoemCodon1State).toBeDefined();
      expect(reviewPoemCodon1State?.loopContext).toBeDefined();
      expect(reviewPoemCodon1State?.loopContext?.loopId).toBe(CodonId("iterative-refinement"));
      expect(reviewPoemCodon1State?.loopContext?.iteration).toBe(1);
      expect(reviewPoemCodon1State?.loopContext?.codonIndexInLoop).toBe(1);

      // Verify codon-3 (non-loop codon) has no loopContext
      const codon3State = allCodons.find((p) => p.codonId === "codon-3");
      expect(codon3State).toBeDefined();
      expect(codon3State?.loopContext).toBeUndefined();

      // Verify log files exist for each loop iteration and are not overwritten
      // Logs are stored in .strandweave/runs/{runId}/ directory
      const runId = currentRun.runId;
      const runFolder = path.join(executionPath, ".strandweave", "runs", runId);
      expect(fs.existsSync(runFolder)).toBe(true);

      // Check that each codon has its own log file
      // Log files are named {codon.id}-claude.log with # replaced by -
      const expectedLogFiles = [
        "codon-1-claude.log",
        "write-poem-0-claude.log",
        "review-poem-0-claude.log",
        "write-poem-1-claude.log",
        "review-poem-1-claude.log",
        "codon-3-claude.log",
      ];

      for (const logFile of expectedLogFiles) {
        const logPath = path.join(runFolder, logFile);
        expect(fs.existsSync(logPath)).toBe(true); // Log file should exist

        // Verify log file is not empty
        const stats = fs.statSync(logPath);
        expect(stats.size).toBeGreaterThan(0); // Log file should not be empty
      }

      // Verify that loop iteration log files contain different content (not overwritten)
      const writePoemLog0 = fs.readFileSync(
        path.join(runFolder, "write-poem-0-claude.log"),
        "utf-8",
      );
      const writePoemLog1 = fs.readFileSync(
        path.join(runFolder, "write-poem-1-claude.log"),
        "utf-8",
      );

      // The logs should be different (different sessions, different content)
      expect(writePoemLog0).not.toBe(writePoemLog1); // write-poem#0 and write-poem#1 logs should differ

      // Verify session IDs in the logs match the codon events
      // Each log should contain references to its own session ID
      if (writePoemCodon0?.data.sessionId) {
        expect(writePoemLog0).toContain(writePoemCodon0.data.sessionId); // write-poem#0 log should contain its session ID
      }

      if (writePoemCodon1?.data.sessionId) {
        expect(writePoemLog1).toContain(writePoemCodon1.data.sessionId); // write-poem#1 log should contain its session ID
      }

      // Server will shutdown automatically, wait for connection close
      await strandweave.waitForConnectionClose(5000);
    } finally {
      // Only stop if server is still running
      if (strandweave.process.exitCode === null && strandweave.process.signalCode === null) {
        await strandweave.stop();
      }
    }
  }, 600_000); // 10 minute timeout

  it("should complete loop successfully with rig setup failures when allowFailure is true", async () => {
    const configPath = "tests/config/test-codons-with-loop-rig-setup.config.json";
    const port = await getFreePort();
    const strandweave = await launchStrandweave({
      configPath,
      port,
      logPrefix: "[loop-rig-test]",
    });

    try {
      // Wait for server ready
      const readyEvent = (await strandweave.waitForEvent("server.ready")) as ServerReadyEvent;
      const executionPath = readyEvent.data.executionPath;

      // Expected codons:
      // 1. setup-codon (regular)
      // 2. loop-codon-with-setup#0 (loop iteration 0)
      // 3. loop-codon-with-setup#1 (loop iteration 1)
      // 4. final-codon (regular)

      const expectedCodons = [
        "setup-codon",
        "loop-codon-with-setup#0",
        "loop-codon-with-setup#1",
        "final-codon",
      ];

      const codonEvents: CodonStartedEvent[] = [];
      const completedCodons: CodonCompletedEvent[] = [];
      let lastTimestamp: string | undefined;

      // Wait for all codons to complete
      for (const expectedCodonId of expectedCodons) {
        const startEvent = (await strandweave.waitForCodonStart(
          expectedCodonId,
          lastTimestamp,
          300_000, // 5 minute timeout
        )) as CodonStartedEvent;

        expect(startEvent.data.codonId).toBe(expectedCodonId);
        codonEvents.push(startEvent);

        const completedEvent = (await strandweave.waitForCodonCompletion(
          expectedCodonId,
          startEvent.timestamp,
          300_000, // 5 minute timeout
        )) as CodonCompletedEvent;

        expect(completedEvent.data.success).toBe(true);
        completedCodons.push(completedEvent);
        lastTimestamp = completedEvent.timestamp;
      }

      // Verify all codons completed successfully
      expect(completedCodons.length).toBe(4);
      for (const codon of completedCodons) {
        expect(codon.data.success).toBe(true);
      }

      // Verify rig setup log was created (from the command that doesn't fail)
      const setupLogPath = path.join(executionPath, "notes", "setup_log.txt");
      expect(fs.existsSync(setupLogPath)).toBe(true);

      // Should have 2 entries (one per loop iteration)
      const setupLogContent = fs.readFileSync(setupLogPath, "utf-8");
      const logLines = setupLogContent.trim().split("\n");
      expect(logLines.length).toBe(2);

      // Should have error events for the failed command operations (allowFailure=true)
      const rigSetupErrors = strandweave
        .getEvents()
        .filter((e) => e.type === "error")
        .filter((e) => e.data.message?.includes("allowFailure=true"));
      expect(rigSetupErrors.length).toBeGreaterThan(0);

      // Verify that copied.txt was NOT created (because cp command failed)
      const copiedPath = path.join(executionPath, "notes", "copied.txt");
      expect(fs.existsSync(copiedPath)).toBe(false);

      // Verify message files were created (2 iterations)
      const notesDir = path.join(executionPath, "notes");
      const files = fs.readdirSync(notesDir);
      const messageFiles = files.filter((f) => f.startsWith("message_") && f.endsWith(".txt"));
      expect(messageFiles.length).toBe(2);

      // Verify summary file was created by final codon
      const summaryPath = path.join(executionPath, "notes", "summary.txt");
      expect(fs.existsSync(summaryPath)).toBe(true);
      const summaryContent = fs.readFileSync(summaryPath, "utf-8");
      expect(summaryContent.length).toBeGreaterThan(0);

      // Wait for the run to complete
      await strandweave.waitForRunToComplete(10_000);

      // Server will shutdown automatically
      await strandweave.waitForConnectionClose(5000);
    } finally {
      // Only stop if server is still running
      if (strandweave.process.exitCode === null && strandweave.process.signalCode === null) {
        await strandweave.stop();
      }
    }
  }, 600_000); // 10 minute timeout

  it("should handle rollback from interrupted codon inside loop iteration", async () => {
    const configPath = "tests/config/test-codons-with-loop-error.config.json";
    const port = await getFreePort();
    let strandweave = await launchStrandweave({
      configPath,
      port,
      logPrefix: "[loop-rollback-test]",
    });

    try {
      // Wait for server ready
      const readyEvent = (await strandweave.waitForEvent("server.ready")) as ServerReadyEvent;
      const executionPath = readyEvent.data.executionPath;

      await strandweave.waitForCodonStart("setup-codon");
      const setupCompleted = (await strandweave.waitForCodonCompletion(
        "setup-codon",
      )) as CodonCompletedEvent;
      expect(setupCompleted.data.success).toBe(true);

      await strandweave.waitForCodonStart("write-iteration#0");

      await strandweave.waitForRunToFail();

      // run will fail because of the existing dir new-notes
      // let's clean up and restart
      const offendingDir = path.join(executionPath, "new-notes");
      fs.rmdirSync(offendingDir, { recursive: true });

      // Small delay before reconnecting
      await new Promise((resolve) => setTimeout(resolve, 1000));

      expect(strandweave.hasLockFile()).toBeFalse();

      // relaunch the server and request previous events to capture rollback
      strandweave = await launchStrandweave({
        configPath,
        port,
        logPrefix: "[loop-rollback-test]",
        executionDir: executionPath,
        reuseTestDirectory: true,
        sendPreviousEvents: true,
      });

      await strandweave.waitForRunToComplete();

      // make sure we have all the artifacts from all the codons
      // 2 iterations + review files
      const notesDir = path.join(executionPath, "notes");
      expect(fs.existsSync(notesDir)).toBe(true);

      const files = fs.readdirSync(notesDir);

      expect(files.filter((f) => f.startsWith("iteration_") && f.endsWith(".txt")).length).toBe(2);

      expect(files.filter((f) => f.startsWith("review_") && f.endsWith(".txt")).length).toBe(2);

      const finalPath = path.join(executionPath, "notes", "final.txt");
      expect(fs.existsSync(finalPath)).toBe(true);
      const finalContent = fs.readFileSync(finalPath, "utf-8");
      expect(finalContent.trim()).toBe("Final codon reached");
    } finally {
      // Only stop if server is still running
      if (strandweave.process.exitCode === null && strandweave.process.signalCode === null) {
        await strandweave.stop();
      }
    }
  }, 600_000); // 10 minute timeout
});
