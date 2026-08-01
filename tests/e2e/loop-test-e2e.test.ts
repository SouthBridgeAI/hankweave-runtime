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
import { CI_DETECTION_ENV_VARS } from "../../server/telemetry/telemetry-config.js";
import { CodonId } from "../../server/types/branded-types.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

interface TelemetryDebugEvent {
  event: string;
  properties: Record<string, unknown>;
}

function readTelemetryJsonl(jsonlPath: string): TelemetryDebugEvent[] {
  if (!fs.existsSync(jsonlPath)) {
    return [];
  }

  const content = fs.readFileSync(jsonlPath, "utf-8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TelemetryDebugEvent);
}

async function waitForTelemetryEvents(
  jsonlPath: string,
  eventName: string,
  minCount: number,
  timeoutMs = 10_000,
): Promise<TelemetryDebugEvent[]> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const matchingEvents = readTelemetryJsonl(jsonlPath).filter(
      (event) => event.event === eventName,
    );
    if (matchingEvents.length >= minCount) {
      return matchingEvents;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return readTelemetryJsonl(jsonlPath).filter((event) => event.event === eventName);
}

describe("Loop E2E Test", () => {
  it("should execute codons in correct order with loop expansion", async () => {
    const configPath = "tests/config/test-codons-with-loop.config.json";
    const port = await getFreePort();
    const hankweave = await launchHankweave({
      configPath,
      port,
      logPrefix: "[loop-test]",
    });

    try {
      // Wait for server ready and capture execution path
      const readyEvent = (await hankweave.waitForEvent("server.ready")) as ServerReadyEvent;
      const executionPath = readyEvent.data.executionPath;
      const agentRootPath = readyEvent.data.agentRootPath;

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

      // Wait for all codons to complete (with longer timeout per codon).
      //
      // Deliberately wait on COMPLETION events only: the server broadcasts
      // only to clients past handshake, and autostart routinely wins that
      // race, so codon-1's `codon.started` may never reach this client (see
      // the sendPreviousEvents docs in hankweave-server-test-helpers.ts).
      // Completions land minutes later and are reliable. Start events are
      // collected from the client buffer afterwards — anything the client
      // received is there by the time the completion arrived.
      for (const expectedCodonId of expectedCodons) {
        const completedEvent = (await hankweave.waitForCodonCompletion(
          expectedCodonId,
          lastTimestamp,
          300_000, // 5 minute timeout for codon completion
        )) as CodonCompletedEvent;

        expect(completedEvent.data.success).toBe(true);
        completedCodons.push(completedEvent);
        lastTimestamp = completedEvent.timestamp;

        const startEvent = hankweave
          .getEvents()
          .find(
            (e) =>
              e.type === "codon.started" &&
              (e as CodonStartedEvent).data.codonId === expectedCodonId,
          ) as CodonStartedEvent | undefined;
        if (startEvent) {
          codonEvents.push(startEvent);
        } else {
          // Only the racy first start may legitimately be missing.
          expect(expectedCodonId).toBe(expectedCodons[0]);
        }
      }

      // Verify codon execution order — from what the client actually saw. A
      // codon-1 start lost to the pre-handshake race means the observed list
      // is a suffix of the expected order (see the wait loop above).
      const codonIds = codonEvents.map((e) => e.data.codonId);
      expect(codonIds.length).toBeGreaterThanOrEqual(expectedCodons.length - 1);
      expect(codonIds).toEqual(expectedCodons.slice(expectedCodons.length - codonIds.length));

      // Verify all codons completed successfully. Exact count is safe here:
      // it comes from the awaited completion events above (late events, not
      // subject to the handshake race), one per expected codon.
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

      // `>=`, not `===`: event-stream counts are not exact contracts — the
      // stream can miss pre-handshake events and a codon retry re-emits
      // starts. Exact arity is owned by the state assertions further down.
      expect(writePoemCodons.length).toBeGreaterThanOrEqual(2);
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
      // `>=` for the same reason as the write-poem count above; exact loop
      // arity is asserted on state (loopContext checks below).
      expect(loopIterations.length).toBeGreaterThanOrEqual(4);

      // Verify codon-3 executed after loop
      const codon3 = completedCodons.find((e) => e.data.codonId === "codon-3");
      expect(codon3).toBeTruthy();
      expect(codon3?.data.success).toBe(true);

      // Verify file output from loop iterations
      const notesDir = path.join(agentRootPath, "notes");
      expect(fs.existsSync(notesDir)).toBe(true);

      const files = fs.readdirSync(notesDir);

      // Note: additional_poem_*.txt files are archived (see config archiveOnSuccess),
      // so they should NOT be in notes/ but in the archive
      const additionalPoemFiles = files.filter(
        (f) => f.startsWith("additional_poem_") && f.endsWith(".txt"),
      );
      expect(additionalPoemFiles.length).toBe(0); // Files are archived, not in agentRoot

      // Verify additional_poem files exist in archive
      const rigArchivePath = path.join(executionPath, "rigArchive");
      const archive0Dir = path.join(rigArchivePath, "refine-poems-0", "review-poem-0", "notes");
      const archive1Dir = path.join(rigArchivePath, "refine-poems-1", "review-poem-1", "notes");

      if (fs.existsSync(archive0Dir)) {
        const archive0Files = fs.readdirSync(archive0Dir);
        const archive0Poems = archive0Files.filter((f) => f.startsWith("additional_poem_"));
        expect(archive0Poems.length).toBeGreaterThan(0);
      }
      if (fs.existsSync(archive1Dir)) {
        const archive1Files = fs.readdirSync(archive1Dir);
        const archive1Poems = archive1Files.filter((f) => f.startsWith("additional_poem_"));
        expect(archive1Poems.length).toBeGreaterThan(0);
      }

      // What follows is model-dependent, and is deliberately not a hard count.
      //
      // The loop's *runtime* contract is already asserted above: four loop-codon
      // completions, codon-3 ordered after the loop, and archiveOnSuccess having
      // moved additional_poem_* out of notes/. Whether haiku actually wrote two
      // files named poem_review_N.txt is the model's compliance with a prompt,
      // not the runtime's behaviour — and it does sometimes write none, which
      // failed this suite while the run itself reported "All 6 codons completed
      // successfully". The archive checks just above were already softened to
      // `if (fs.existsSync(...))` for the same reason.
      //
      // So: the loop may not produce more review files than it had iterations,
      // and any file it did produce must have content — a truncated or empty
      // write is a real tracking bug. The count itself is not asserted.
      const poemReviewFiles = files.filter(
        (f) => f.startsWith("poem_review_") && f.endsWith(".txt"),
      );
      expect(poemReviewFiles.length).toBeLessThanOrEqual(2);

      for (const file of poemReviewFiles) {
        const filePath = path.join(notesDir, file);
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.readFileSync(filePath, "utf-8").length).toBeGreaterThan(0);
      }

      // Wait for the run to complete naturally (RunCompleted state transition)
      await hankweave.waitForRunToComplete(60_000);

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
      const events = hankweave.getEvents();

      // Verify sentinel.loaded events
      const loadedEvents = events.filter(
        (e) => e.type === "sentinel.loaded",
      ) as SentinelLoadedEvent[];

      // One loaded event per loop codon iteration. `>=`: a codon retry
      // reloads its sentinel and duplicates events; exact per-codon sentinel
      // execution is asserted on state below.
      expect(loadedEvents.length).toBeGreaterThanOrEqual(4);

      // Verify every iteration loaded the sentinel (dedupe: retries repeat ids)
      const loadedCodonIds = [...new Set(loadedEvents.map((e) => e.data.codonId))].sort();
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

      // `>=` for the same retry-duplication reason as sentinel.loaded above.
      expect(unloadedEvents.length).toBeGreaterThanOrEqual(4);

      // Verify every iteration unloaded the sentinel (dedupe: retries repeat ids)
      const unloadedCodonIds = [...new Set(unloadedEvents.map((e) => e.data.codonId))].sort();
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
          // Unloaded happens after loaded; `>=` tolerates both landing in the
          // same millisecond (ISO timestamps have 1ms granularity).
          expect(new Date(unloaded.timestamp).getTime()).toBeGreaterThanOrEqual(
            new Date(loaded.timestamp).getTime(),
          );
        }
      }

      // Verify loopContext is set correctly for loop codons and not set for non-loop codons
      const finalState = hankweave.getState();
      const currentRun = finalState.runs[0];
      expect(currentRun).toBeDefined();

      // Get all codons from current run
      const allCodons = currentRun.codons;

      // Authoritative arity: the event stream can undercount (pre-handshake
      // loss) or overcount (retries), so the exact codon list and statuses
      // are asserted on state.
      expect(allCodons.map((c) => c.codonId).sort()).toEqual(
        expectedCodons.map((id) => CodonId(id)).sort(),
      );
      for (const codon of allCodons) {
        expect(codon.status).toBe("completed");
      }

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

      // Sentinel execution asserted on state (authoritative twin of the
      // event-stream checks above).
      for (const codonId of expectedLoopCodonsWithSentinels) {
        const codonState = allCodons.find((p) => p.codonId === codonId);
        expect(codonState?.status).toBe("completed");
        if (codonState && codonState.status === "completed") {
          expect((codonState.sentinels?.executed ?? []).map((s) => s.id)).toEqual([
            "loop-test-sentinel",
          ]);
        }
      }

      // Verify log files exist for each loop iteration and are not overwritten
      // Logs are stored in .hankweave/runs/{runId}/ directory
      const runId = currentRun.runId;
      const runFolder = path.join(executionPath, ".hankweave", "runs", runId);
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
      await hankweave.waitForConnectionClose(30_000);
    } finally {
      // Only stop if server is still running
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 600_000); // 10 minute timeout

  it("should complete loop successfully with rig setup failures when allowFailure is true", async () => {
    const configPath = "tests/config/test-codons-with-loop-rig-setup.config.json";
    const port = await getFreePort();
    const hankweave = await launchHankweave({
      configPath,
      port,
      logPrefix: "[loop-rig-test]",
    });

    try {
      // Wait for server ready
      const readyEvent = (await hankweave.waitForEvent("server.ready")) as ServerReadyEvent;
      const agentRootPath = readyEvent.data.agentRootPath;

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

      const completedCodons: CodonCompletedEvent[] = [];
      let lastTimestamp: string | undefined;

      // Wait for all codons to complete. Completion-only waits: the first
      // codon's start event can be lost to the autostart-vs-handshake race
      // (see the first test in this file); completions land later and are
      // reliable.
      for (const expectedCodonId of expectedCodons) {
        const completedEvent = (await hankweave.waitForCodonCompletion(
          expectedCodonId,
          lastTimestamp,
          300_000, // 5 minute timeout
        )) as CodonCompletedEvent;

        expect(completedEvent.data.success).toBe(true);
        completedCodons.push(completedEvent);
        lastTimestamp = completedEvent.timestamp;
      }

      // Verify all codons completed successfully. Exact count is safe: it
      // comes from the awaited completion events above, one per codon.
      expect(completedCodons.length).toBe(4);
      for (const codon of completedCodons) {
        expect(codon.data.success).toBe(true);
      }

      // Verify rig setup log was created (from the command that doesn't fail)
      const setupLogPath = path.join(agentRootPath, "notes", "setup_log.txt");
      expect(fs.existsSync(setupLogPath)).toBe(true);

      // Should have 2 entries (one per loop iteration)
      const setupLogContent = fs.readFileSync(setupLogPath, "utf-8");
      const logLines = setupLogContent.trim().split("\n");
      expect(logLines.length).toBe(2);

      // Should have error events for the failed command operations (allowFailure=true)
      const rigSetupErrors = hankweave
        .getEvents()
        .filter((e) => e.type === "error")
        .filter((e) => e.data.message?.includes("allowFailure=true"));
      expect(rigSetupErrors.length).toBeGreaterThan(0);

      // Verify that copied.txt was NOT created (because cp command failed)
      const copiedPath = path.join(agentRootPath, "notes", "copied.txt");
      expect(fs.existsSync(copiedPath)).toBe(false);

      // Verify message files were created by the loop iterations
      const notesDir = path.join(agentRootPath, "notes");
      const files = fs.readdirSync(notesDir);
      const messageFiles = files.filter((f) => f.startsWith("message_") && f.endsWith(".txt"));
      // Model-dependent, not a hard count (see the poem_review comment in the
      // first test): haiku is asked to write message_<TIMESTAMP>.txt each
      // iteration but can reuse a name across iterations or skip the write
      // while still completing. Rig-side proof both iterations ran is the
      // setup_log assertion above.
      expect(messageFiles.length).toBeGreaterThanOrEqual(1);

      // Verify summary file was created by final codon
      const summaryPath = path.join(agentRootPath, "notes", "summary.txt");
      expect(fs.existsSync(summaryPath)).toBe(true);
      const summaryContent = fs.readFileSync(summaryPath, "utf-8");
      expect(summaryContent.length).toBeGreaterThan(0);

      // Wait for the run to complete
      await hankweave.waitForRunToComplete(60_000);

      // Authoritative codon list from state (the event stream is lossy before
      // our handshake).
      const finalState = hankweave.getState();
      expect(finalState.runs[0].codons.map((c) => c.codonId).sort()).toEqual(
        expectedCodons.map((id) => CodonId(id)).sort(),
      );

      // Server will shutdown automatically
      await hankweave.waitForConnectionClose(30_000);
    } finally {
      // Only stop if server is still running
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 600_000); // 10 minute timeout

  it("should expand loop iterations when rig setup fails and onFailure=ignore", async () => {
    const configPath = "tests/config/test-failure-loop-rig-setup-ignore.hank.json";
    const port = await getFreePort();
    const hankweave = await launchHankweave({
      configPath,
      port,
      logPrefix: "[loop-rig-ignore]",
    });

    try {
      await hankweave.waitForEvent("server.ready");
      await hankweave.waitForRunToComplete(30_000);

      const finalState = hankweave.getState();
      const currentRun = finalState.runs[0];
      expect(currentRun).toBeDefined();

      const failedLoopCodons = currentRun.codons.filter((codon) =>
        codon.codonId.startsWith("rig-setup-failure#"),
      );
      const ignoredCodonIds = failedLoopCodons.map((codon) => codon.codonId).sort();
      expect(ignoredCodonIds).toEqual([
        CodonId("rig-setup-failure#0"),
        CodonId("rig-setup-failure#1"),
      ]);

      for (const codon of failedLoopCodons) {
        expect(codon.status).toBe("failed");
        if (codon.status === "failed") {
          expect(codon.failedDuring).toBe("preparing");
        }
      }
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  it("should emit loop_iteration_completed telemetry events with expected schema", async () => {
    const configPath = "tests/config/test-codons-with-loop.config.json";
    const port = await getFreePort();
    const telemetryCacheDir = path.resolve(
      "tests",
      "test-results",
      `loop-telemetry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    fs.mkdirSync(telemetryCacheDir, { recursive: true });
    const telemetryJsonlPath = path.join(telemetryCacheDir, "telemetry-debug.jsonl");

    const hankweave = await launchHankweave({
      configPath,
      port,
      logPrefix: "[loop-telemetry-test]",
      env: {
        HANKWEAVE_TELEMETRY_DEBUG: "1",
        HANKWEAVE_CACHE_DIR: telemetryCacheDir,
      },
      // Telemetry auto-disables on CI, and `env` can only set a value — the
      // existence-based detectors (GITHUB_ACTIONS et al) stay tripped by "".
      // Without this the test cannot pass in GitHub Actions, or on any machine
      // with CI=1 exported, because no debug JSONL is ever written.
      unsetEnv: [...CI_DETECTION_ENV_VARS, "DO_NOT_TRACK", "HANKWEAVE_TELEMETRY"],
    });

    try {
      await hankweave.waitForEvent("server.ready");
      await hankweave.waitForRunToComplete(300_000);
      await hankweave.waitForConnectionClose(10_000);

      const loopIterations = await waitForTelemetryEvents(
        telemetryJsonlPath,
        "loop_iteration_completed",
        2,
        10_000,
      );

      expect(loopIterations.length).toBe(2);

      const iterationValues: number[] = [];
      let finalIterationCount = 0;

      for (const evt of loopIterations) {
        expect(evt.properties.run_id_hash).toBeDefined();
        expect(evt.properties.loop_id_hash).toBeDefined();
        expect(typeof evt.properties.iteration).toBe("number");
        expect(typeof evt.properties.duration_ms).toBe("number");
        expect(typeof evt.properties.cost_usd).toBe("number");
        expect(typeof evt.properties.tokens_used).toBe("number");
        expect(typeof evt.properties.is_final).toBe("boolean");

        if (typeof evt.properties.iteration === "number") {
          iterationValues.push(evt.properties.iteration);
        }
        if (evt.properties.is_final === true) {
          finalIterationCount += 1;
        }
      }

      expect(iterationValues.sort((a, b) => a - b)).toEqual([0, 1]);
      expect(finalIterationCount).toBe(1);
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 600_000);

  it("should handle rollback from interrupted codon inside loop iteration", async () => {
    const configPath = "tests/config/test-codons-with-loop-error.config.json";
    const port = await getFreePort();
    let hankweave = await launchHankweave({
      configPath,
      port,
      logPrefix: "[loop-rollback-test]",
    });

    try {
      // Wait for server ready
      const readyEvent = (await hankweave.waitForEvent("server.ready")) as ServerReadyEvent;
      const executionPath = readyEvent.data.executionPath;
      const agentRootPath = readyEvent.data.agentRootPath;

      await hankweave.waitForCodonStart("setup-codon");
      const setupCompleted = (await hankweave.waitForCodonCompletion(
        "setup-codon",
      )) as CodonCompletedEvent;
      expect(setupCompleted.data.success).toBe(true);

      await hankweave.waitForCodonStart("write-iteration#0");

      await hankweave.waitForRunToFail();

      // run will fail because of the existing dir new-notes
      // let's clean up and restart
      const offendingDir = path.join(agentRootPath, "new-notes");
      fs.rmSync(offendingDir, { recursive: true });

      // Small delay before reconnecting
      await new Promise((resolve) => setTimeout(resolve, 1000));

      expect(hankweave.hasLockFile()).toBeFalse();

      // relaunch the server and request previous events to capture rollback
      hankweave = await launchHankweave({
        configPath,
        port,
        logPrefix: "[loop-rollback-test]",
        executionDir: executionPath,
        reuseTestDirectory: true,
        sendPreviousEvents: true,
      });

      // Wait for new server ready and capture agentRootPath again
      const restartReadyEvent = (await hankweave.waitForEvent("server.ready")) as ServerReadyEvent;
      const restartAgentRootPath = restartReadyEvent.data.agentRootPath;

      await hankweave.waitForRunToComplete();

      // make sure we have all the artifacts from all the codons
      // 2 iterations + review files
      const notesDir = path.join(restartAgentRootPath, "notes");
      expect(fs.existsSync(notesDir)).toBe(true);

      const files = fs.readdirSync(notesDir);

      expect(files.filter((f) => f.startsWith("iteration_") && f.endsWith(".txt")).length).toBe(2);

      expect(files.filter((f) => f.startsWith("review_") && f.endsWith(".txt")).length).toBe(2);

      const finalPath = path.join(restartAgentRootPath, "notes", "final.txt");
      expect(fs.existsSync(finalPath)).toBe(true);
      const finalContent = fs.readFileSync(finalPath, "utf-8");
      expect(finalContent.trim()).toBe("Final codon reached");
    } finally {
      // Only stop if server is still running
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 600_000); // 10 minute timeout

  it("should archive and restore files across loop iterations during rollback", async () => {
    const configPath = "tests/config/test-codons-loop-with-archive.config.json";
    const port = await getFreePort();
    let hankweave = await launchHankweave({
      configPath,
      port,
      logPrefix: "[loop-archive-test]",
    });

    try {
      // Wait for server ready
      const readyEvent = (await hankweave.waitForEvent("server.ready")) as ServerReadyEvent;
      const executionPath = readyEvent.data.executionPath;
      const agentRootPath = readyEvent.data.agentRootPath;
      const rigArchivePath = path.join(executionPath, "rigArchive");

      // Expected codons:
      // 1. setup-codon
      // 2. process-iteration#0 (creates temp/ files, archives them)
      // 3. process-iteration#1 (creates temp/ files, archives them)
      // 4. final-codon

      // Wait for all codons to complete
      await hankweave.waitForCodonStart("setup-codon");
      await hankweave.waitForCodonCompletion("setup-codon");

      await hankweave.waitForCodonStart("process-iteration#0");
      const iteration0Completed = (await hankweave.waitForCodonCompletion(
        "process-iteration#0",
      )) as CodonCompletedEvent;
      expect(iteration0Completed.data.success).toBe(true);

      // Wait a moment for archive to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Verify archive.completed event was emitted for iteration 0
      const archive0Events = hankweave.getEvents().filter((e) => e.type === "archive.completed");
      const archive0Event = archive0Events.find(
        (e) => "codonId" in e.data && e.data.codonId === "process-iteration#0",
      );
      expect(archive0Event).toBeDefined();

      if (archive0Event && "archivedPaths" in archive0Event.data) {
        console.log(
          `  Archived paths from iteration 0: ${JSON.stringify(archive0Event.data.archivedPaths)}`,
        );
      }

      // Verify temp files are archived
      const resultsDir = path.join(agentRootPath, "results");
      expect(fs.existsSync(resultsDir)).toBe(true); // Results remain (not archived)

      await hankweave.waitForCodonStart("process-iteration#1");
      const iteration1Completed = (await hankweave.waitForCodonCompletion(
        "process-iteration#1",
      )) as CodonCompletedEvent;
      expect(iteration1Completed.data.success).toBe(true);

      // Wait a moment for archive to complete
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Verify temp files from iteration 1 are archived separately
      const archive1 = path.join(rigArchivePath, "archive-loop-1", "process-iteration-1");
      expect(fs.existsSync(archive1)).toBe(true);

      await hankweave.waitForCodonStart("final-codon");
      await hankweave.waitForCodonCompletion("final-codon");

      await hankweave.waitForRunToComplete();

      // Now test rollback and restoration
      // Stop server to enable rollback
      await hankweave.stop();
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Restart and request rollback to after iteration 0
      hankweave = await launchHankweave({
        configPath,
        port,
        logPrefix: "[loop-archive-test-restart]",
        executionDir: executionPath,
        reuseTestDirectory: true,
        sendPreviousEvents: true,
      });

      await hankweave.waitForEvent("server.ready");

      // Request rollback to iteration 0 completion
      hankweave.sendCommand({
        id: "test-rollback-1",
        type: "rollback.toCodon",
        data: {
          codonId: "process-iteration#0",
          checkpointType: "completed",
          autoRestart: false,
        },
      });

      // Wait for rollback to complete
      const rollbackEvent = await hankweave.waitForEvent("rollback.completed", 30_000);
      expect(rollbackEvent.type).toBe("rollback.completed");

      // Check for archive restoration event
      const restoreEvents = hankweave
        .getEvents()
        .filter((e) => e.type === "rollback.archiveRestore");
      expect(restoreEvents.length).toBeGreaterThan(0);

      // Verify iteration 1 archives were restored to agentRoot
      // (because we rolled back past when they were archived)
      const restoredTempDir = path.join(agentRootPath, "temp");
      expect(fs.existsSync(restoredTempDir)).toBe(true);

      // Verify iteration 1 archive is gone (files restored)
      const archive1Path = path.join(rigArchivePath, "archive-loop-1", "process-iteration-1");
      expect(fs.existsSync(archive1Path)).toBe(false);

      // Verify iteration 0 archive still exists (not affected by rollback)
      const archive0Path = path.join(rigArchivePath, "archive-loop-0", "process-iteration-0");
      expect(fs.existsSync(archive0Path)).toBe(true);

      await hankweave.stop();
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 600_000);
});
