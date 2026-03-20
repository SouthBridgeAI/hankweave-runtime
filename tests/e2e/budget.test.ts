#!/usr/bin/env bun
import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CodonCompletedEvent,
  InfoEvent,
  ServerReadyEvent,
} from "../../server/schemas/event-schemas.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Fixture source directories (read-only originals)
const FIXTURE_SOURCES = {
  budgetExceeded: path.resolve(TEST_ROOT, "tests/fixtures/budget-exceeded-replay"),
  globalUniform: path.resolve(TEST_ROOT, "tests/fixtures/budget-global-uniform-replay"),
  loop: path.resolve(TEST_ROOT, "tests/fixtures/budget-loop-replay"),
  loopLevel: path.resolve(TEST_ROOT, "tests/fixtures/budget-loop-level-replay"),
  onExceededFail: path.resolve(TEST_ROOT, "tests/fixtures/budget-on-exceeded-fail-replay"),
  onExceededOverride: path.resolve(TEST_ROOT, "tests/fixtures/budget-on-exceeded-override-replay"),
  planGen: path.resolve(TEST_ROOT, "tests/fixtures/plan-gen-execution"),
};

// Verify all fixtures exist
for (const [name, dir] of Object.entries(FIXTURE_SOURCES)) {
  if (!fs.existsSync(path.join(dir, ".hankweave"))) {
    throw new Error(
      `Fixture not found at ${dir} (${name})\n` +
        "Run the corresponding test in live mode first to capture the execution directory.",
    );
  }
}

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

/**
 * Create a unique temp copy of a fixture with timestamps stripped.
 * Each test gets its own copy to avoid conflicts during concurrent execution.
 */
function prepareReplayDir(fixtureKey: keyof typeof FIXTURE_SOURCES): string {
  const src = FIXTURE_SOURCES[fixtureKey];
  const tmp = path.join(
    os.tmpdir(),
    `hw-budget-${fixtureKey}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  fs.cpSync(src, tmp, { recursive: true });
  stripTimestampsFromLogs(tmp);
  tempDirs.push(tmp);
  return tmp;
}

const tempDirs: string[] = [];

describe("Budget Exceeded E2E Test", () => {
  afterAll(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  it("should complete budget-exceeded codon then run followup codon successfully", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("budgetExceeded");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank.json"),
      dataDir: path.join(replayDir, "data.txt"),
      replayDir,
      port,
      logPrefix: "[budget-exceeded-replay]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      await hankweave.waitForRunToComplete(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("completed");
      expect(run.codons.length).toBe(2);

      // budget-codon exceeded its budget
      const codon1 = run.codons.find((c) => c.codonId === "budget-codon");
      expect(codon1).toBeDefined();
      expect(codon1?.status).toBe("completed");
      if (codon1?.status === "completed") {
        expect(codon1.budgetExceeded).toBeDefined();
        expect(codon1.budgetExceeded?.currency).toBe("cost");
      }

      // Verify info event about budget limit
      const events = hankweave.getEvents();
      const budgetInfoEvent = events.find(
        (e) => e.type === "info" && (e as InfoEvent).data.message.includes("budget limit reached"),
      );
      expect(budgetInfoEvent).toBeDefined();

      // followup-codon completed normally
      const codon2 = run.codons.find((c) => c.codonId === "followup-codon");
      expect(codon2).toBeDefined();
      expect(codon2?.status).toBe("completed");
      if (codon2?.status === "completed") {
        expect(codon2.budgetExceeded).toBeUndefined();
      }

      await hankweave.waitForConnectionClose(60_000);
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  it("should use first-past-the-post shared pool: expensive codon consumes budget, later codons exceed", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("globalUniform");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank.json"),
      dataDir: path.join(replayDir, "data.txt"),
      replayDir,
      port,
      logPrefix: "[budget-global-test]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      await hankweave.waitForRunToComplete(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("completed");
      expect(run.codons.length).toBe(3);

      // expensive-codon had access to the full pool — completes successfully
      const expensive = run.codons.find((c) => c.codonId === "expensive-codon");
      expect(expensive).toBeDefined();
      expect(expensive?.status).toBe("completed");

      // simple codons exceeded their budget (pool exhausted by expensive-codon)
      for (const codonId of ["simple-codon-1", "simple-codon-2"]) {
        const codon = run.codons.find((c) => c.codonId === codonId);
        expect(codon).toBeDefined();
        expect(codon?.status).toBe("completed");
        if (codon?.status === "completed") {
          expect(codon.budgetExceeded).toBeDefined();
          expect(codon.budgetExceeded?.currency).toBe("cost");
        }
      }

      await hankweave.waitForConnectionClose(60_000);
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  it("should apply per-codon budget fresh each loop iteration (not cumulative)", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("loop");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank.json"),
      dataDir: path.join(replayDir, "data.txt"),
      replayDir,
      port,
      logPrefix: "[budget-loop-test]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      await hankweave.waitForRunToComplete(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("completed");

      // All 5 iterations should have completed (budget resets each iteration)
      const loopCodons = run.codons.filter((c) => c.codonId.startsWith("loop-codon#"));
      expect(loopCodons.length).toBe(5);

      // Every iteration should complete without budget exceeded
      for (const codon of loopCodons) {
        expect(codon.status).toBe("completed");
        if (codon.status === "completed") {
          expect(codon.budgetExceeded).toBeUndefined();
        }
      }

      // Post-loop codon completed normally
      const postLoop = run.codons.find((c) => c.codonId === "post-loop-codon");
      expect(postLoop).toBeDefined();
      expect(postLoop?.status).toBe("completed");
      if (postLoop?.status === "completed") {
        expect(postLoop?.budgetExceeded).toBeUndefined();
      }

      await hankweave.waitForConnectionClose(60_000);
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  it("should enforce budget via --max-cost flag (operator override)", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("budgetExceeded");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank-no-budget.json"),
      dataDir: path.join(replayDir, "data.txt"),
      replayDir,
      port,
      logPrefix: "[budget-max-cost-replay]",
      extraArgs: ["--force", "--max-cost", "0.0001"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      await hankweave.waitForRunToComplete(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("completed");
      expect(run.codons.length).toBe(2);

      // budget-codon exceeded the --max-cost budget
      const codon1 = run.codons.find((c) => c.codonId === "budget-codon");
      expect(codon1).toBeDefined();
      expect(codon1?.status).toBe("completed");
      if (codon1?.status === "completed") {
        expect(codon1.budgetExceeded).toBeDefined();
        expect(codon1.budgetExceeded?.currency).toBe("cost");
      }

      // Verify info event mentions budget limit
      const events = hankweave.getEvents();
      const budgetInfoEvent = events.find(
        (e) => e.type === "info" && (e as InfoEvent).data.message.includes("budget limit reached"),
      );
      expect(budgetInfoEvent).toBeDefined();

      // Both codons completed — budget exceeded is graceful, not failure
      const codon2 = run.codons.find((c) => c.codonId === "followup-codon");
      expect(codon2).toBeDefined();
      expect(codon2?.status).toBe("completed");

      await hankweave.waitForConnectionClose(60_000);
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  it("should enforce output token budget via replay (per-codon maxOutputTokens)", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("budgetExceeded");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank-token-budget.json"),
      dataDir: path.join(replayDir, "data.txt"),
      replayDir,
      port,
      logPrefix: "[budget-token-replay]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      await hankweave.waitForRunToComplete(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("completed");
      expect(run.codons.length).toBe(2);

      // budget-codon exceeded output token budget
      const codon1 = run.codons.find((c) => c.codonId === "budget-codon");
      expect(codon1).toBeDefined();
      expect(codon1?.status).toBe("completed");
      if (codon1?.status === "completed") {
        expect(codon1.budgetExceeded).toBeDefined();
        expect(codon1.budgetExceeded?.currency).toBe("outputTokens");
      }

      // followup-codon completed normally (no token limit)
      const codon2 = run.codons.find((c) => c.codonId === "followup-codon");
      expect(codon2).toBeDefined();
      expect(codon2?.status).toBe("completed");
      if (codon2?.status === "completed") {
        expect(codon2.budgetExceeded).toBeUndefined();
      }

      await hankweave.waitForConnectionClose(60_000);
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  it("should enforce context token budget via replay (per-codon maxContextTokens)", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("budgetExceeded");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank-context-token-budget.json"),
      dataDir: path.join(replayDir, "data.txt"),
      replayDir,
      port,
      logPrefix: "[budget-context-token-replay]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      await hankweave.waitForRunToComplete(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("completed");
      expect(run.codons.length).toBe(2);

      // budget-codon exceeded context token budget
      const codon1 = run.codons.find((c) => c.codonId === "budget-codon");
      expect(codon1).toBeDefined();
      expect(codon1?.status).toBe("completed");
      if (codon1?.status === "completed") {
        expect(codon1.budgetExceeded).toBeDefined();
        expect(codon1.budgetExceeded?.currency).toBe("contextTokens");
      }

      // followup-codon completed normally (no token limit)
      const codon2 = run.codons.find((c) => c.codonId === "followup-codon");
      expect(codon2).toBeDefined();
      expect(codon2?.status).toBe("completed");
      if (codon2?.status === "completed") {
        expect(codon2.budgetExceeded).toBeUndefined();
      }

      await hankweave.waitForConnectionClose(60_000);
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  it("should enforce hank-level time budget via --max-time flag", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("budgetExceeded");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank-no-budget.json"),
      dataDir: path.join(replayDir, "data.txt"),
      replayDir,
      port,
      logPrefix: "[budget-max-time-replay]",
      extraArgs: ["--force", "--max-time", "0.001"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      await hankweave.waitForRunToComplete(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("completed");
      expect(run.codons.length).toBe(2);

      // Both codons exceeded duration budget
      for (const codonId of ["budget-codon", "followup-codon"]) {
        const codon = run.codons.find((c) => c.codonId === codonId);
        expect(codon).toBeDefined();
        expect(codon?.status).toBe("completed");
        if (codon?.status === "completed") {
          expect(codon.budgetExceeded).toBeDefined();
          expect(codon.budgetExceeded?.currency).toBe("duration");
        }
      }

      await hankweave.waitForConnectionClose(60_000);
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  it("should enforce loop-level budget and terminate loop early while post-loop codon still runs", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("loopLevel");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank.json"),
      dataDir: path.join(replayDir, "data.txt"),
      replayDir,
      port,
      logPrefix: "[budget-loop-level-test]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      await hankweave.waitForRunToComplete(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("completed");

      // The loop should have terminated early — fewer than 50 iterations
      const loopCodons = run.codons.filter((c) => c.codonId.startsWith("loop-codon#"));
      expect(loopCodons.length).toBeGreaterThanOrEqual(1);
      expect(loopCodons.length).toBeLessThan(50);

      // At least one loop codon should have budget exceeded (cost)
      const exceededCodons = loopCodons.filter((c) => c.status === "completed" && c.budgetExceeded);
      expect(exceededCodons.length).toBeGreaterThanOrEqual(1);
      const firstExceeded = exceededCodons[0];
      if (firstExceeded.status === "completed") {
        expect(firstExceeded.budgetExceeded?.currency).toBe("cost");
      }

      // Post-loop codon completed normally (hank budget still has room)
      const postLoop = run.codons.find((c) => c.codonId === "post-loop-codon");
      expect(postLoop).toBeDefined();
      expect(postLoop?.status).toBe("completed");
      if (postLoop?.status === "completed") {
        expect(postLoop?.budgetExceeded).toBeUndefined();
      }

      await hankweave.waitForConnectionClose(60_000);
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  it("should carry over budget spending from previous run on resume", async () => {
    const port = await getFreePort();

    // Global maxDollars=$0.002, 2 codons with shared allocation (default).
    // First codon (file creation) costs ~$0.003–0.005, exceeding its uniform share of $0.001.
    // After stop and resume, the continuation run's Budget should account for
    // Run 1's spending when computing the remaining pool for followup-codon.
    //
    // Correct behavior: alreadySpent=$0.003+, globalRemaining=max(0,$0.002-$0.003)=$0,
    //   followup-codon gets $0 → immediately exceeds budget.
    // Bug behavior: Budget starts fresh on resume (alreadySpent=0),
    //   followup-codon gets full $0.002 → completes normally without budget exceeded.
    const hankweave = await launchHankweave({
      configPath: "tests/config/test-budget-resume.config.json",
      port,
      logPrefix: "[budget-resume-test]",
    });

    let execDir = "";

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready")) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();
      execDir = hankweave.executionDir;

      // --- Run 1: budget-codon should exceed its uniform share ---

      await hankweave.waitForCodonStart("budget-codon", undefined, 120_000);

      const budgetCompleted = (await hankweave.waitForCodonCompletion(
        "budget-codon",
        undefined,
        300_000,
      )) as CodonCompletedEvent;

      expect(budgetCompleted.data.success).toBe(true);
      expect(budgetCompleted.data.budgetExceeded).toBeDefined();
      expect(budgetCompleted.data.budgetExceeded?.currency).toBe("cost");

      // Record how much the first codon actually spent
      const firstCodonCost = budgetCompleted.data.budgetExceeded?.used ?? 0;
      expect(firstCodonCost).toBeGreaterThan(0.001); // Should exceed the $0.001 uniform share

      // Stop the server (graceful SIGINT) before followup-codon finishes
      await hankweave.stop();
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }

    // Small delay before reconnecting
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // --- Resume: continuation run should carry over budget spending ---

    const resumedServer = await launchHankweave({
      configPath: "tests/config/test-budget-resume.config.json",
      port,
      executionDir: execDir,
      reuseTestDirectory: true,
      sendPreviousEvents: true,
      logPrefix: "[budget-resume-resumed]",
    });

    try {
      // Wait for server ready
      await resumedServer.waitForEvent("server.ready", 60_000);

      // followup-codon runs in the continuation run
      await resumedServer.waitForCodonStart("followup-codon", undefined, 120_000);

      const followupCompleted = (await resumedServer.waitForCodonCompletion(
        "followup-codon",
        undefined,
        300_000,
      )) as CodonCompletedEvent;

      expect(followupCompleted.data.success).toBe(true);

      // KEY ASSERTION: If budget carry-over works correctly, the global pool ($0.002)
      // is already exhausted by budget-codon's spending ($0.003+) from Run 1.
      // The followup-codon should get maxDollars=$0 and immediately exceed.
      //
      // This assertion will FAIL with the current code because Budget starts fresh
      // on resume (completedSpending is empty), so followup-codon gets $0.002
      // and completes without exceeding budget.
      expect(followupCompleted.data.budgetExceeded).toBeDefined();
      expect(followupCompleted.data.budgetExceeded?.currency).toBe("cost");

      await resumedServer.waitForRunToComplete(60_000);
      await resumedServer.waitForConnectionClose(60_000);
    } finally {
      if (resumedServer.process.exitCode === null && resumedServer.process.signalCode === null) {
        await resumedServer.stop();
      }
    }
  }, 600_000);

  it("should mark codon as failed when onExceeded is 'fail' and budget is exceeded", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("onExceededFail");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank.json"),
      dataDir: path.join(replayDir, "data.txt"),
      replayDir,
      port,
      logPrefix: "[budget-on-exceeded-fail]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      await hankweave.waitForRunToFail(60_000);
      await hankweave.waitForConnectionClose(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("failed");

      // fail-on-budget should be failed
      const failedCodon = run.codons.find((c) => c.codonId === "fail-on-budget");
      expect(failedCodon).toBeDefined();
      expect(failedCodon?.status).toBe("failed");

      // Budget exceeded info is on the codon.completed event (not always in state for failed codons)
      const events = hankweave.getEvents();
      const failedEvent = events.find(
        (e) =>
          e.type === "codon.completed" &&
          (e as CodonCompletedEvent).data?.codonId === "fail-on-budget",
      ) as CodonCompletedEvent | undefined;
      expect(failedEvent).toBeDefined();
      expect(failedEvent?.data.success).toBe(false);
      expect(failedEvent?.data.budgetExceeded).toBeDefined();
      expect(failedEvent?.data.budgetExceeded?.currency).toBe("cost");

      // followup-codon should not have run (still pending or not in codons)
      const followup = run.codons.find((c) => c.codonId === "followup-codon");
      if (followup) {
        expect(followup.status).not.toBe("completed");
      }
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  it("should allow codon-level onExceeded to override hank-level", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("onExceededOverride");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank.json"),
      dataDir: path.join(replayDir, "data.txt"),
      replayDir,
      port,
      logPrefix: "[budget-on-exceeded-override]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      // Run fails because followup-codon inherits hank onExceeded="fail"
      await hankweave.waitForRunToFail(60_000);
      await hankweave.waitForConnectionClose(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("failed");

      // override-codon completed (codon-level onExceeded="complete" overrides hank "fail")
      const overrideCodon = run.codons.find((c) => c.codonId === "override-codon");
      expect(overrideCodon).toBeDefined();
      expect(overrideCodon?.status).toBe("completed");
      if (overrideCodon?.status === "completed") {
        expect(overrideCodon.budgetExceeded).toBeDefined();
        expect(overrideCodon.budgetExceeded?.currency).toBe("cost");
      }

      // followup-codon failed (inherited hank-level onExceeded="fail")
      const followup = run.codons.find((c) => c.codonId === "followup-codon");
      expect(followup).toBeDefined();
      expect(followup?.status).toBe("failed");
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  it("should fail plan-gen pipeline when hank-level maxDollars is exceeded (cost overflow)", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("planGen");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank-config/hank-budget-fail.json"),
      dataDir: path.join(replayDir, "data"),
      replayDir,
      port,
      logPrefix: "[budget-plan-gen-fail]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      await hankweave.waitForRunToFail(60_000);
      await hankweave.waitForConnectionClose(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("failed");

      // step-1-main costs ~$1.87 in replay, far exceeding $0.001 limit
      const firstCodon = run.codons.find((c) => c.codonId === "step-1-main");
      expect(firstCodon).toBeDefined();
      expect(firstCodon?.status).toBe("failed");

      // Verify budget exceeded info on the codon.completed event
      const events = hankweave.getEvents();
      const completedEvent = events.find(
        (e) =>
          e.type === "codon.completed" &&
          (e as CodonCompletedEvent).data?.codonId === "step-1-main",
      ) as CodonCompletedEvent | undefined;
      expect(completedEvent).toBeDefined();
      expect(completedEvent?.data.success).toBe(false);
      expect(completedEvent?.data.budgetExceeded).toBeDefined();
      expect(completedEvent?.data.budgetExceeded?.currency).toBe("cost");

      // Downstream codons should not have run
      const step2 = run.codons.find((c) => c.codonId === "step-2-plan");
      if (step2) {
        expect(step2.status).not.toBe("completed");
      }
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────
  // Scenario 1: Shared Pool Starvation Mid-Pipeline
  //
  // Budget: $13.50 shared pool, onExceeded: "complete"
  //
  // The plan-gen pipeline with a $13.50 shared pool:
  //   - step-1-main ($1.87) fits → pool: $11.63
  //   - step-2-plan ($11.36) fits → pool: $0.27
  //   - step-3-codex ($0.84) exceeds mid-execution (only $0.27 left)
  //   - step-4 through final-step-compress all exceed immediately ($0 pool)
  //
  // Key behavior tested: shared pool starvation at scale. Early codons
  // succeed, later codons all starve, but the run still completes
  // successfully because onExceeded is "complete" (graceful).
  // ──────────────────────────────────────────────────────────────────────
  it("plan-gen: shared pool starvation — early codons succeed, later ones starve gracefully", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("planGen");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank-config/hank-budget-shared-starvation.json"),
      dataDir: path.join(replayDir, "data"),
      replayDir,
      port,
      logPrefix: "[budget-shared-starvation]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      await hankweave.waitForRunToComplete(120_000);
      await hankweave.waitForConnectionClose(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("completed");

      // step-1 and step-2 should complete without exceeding (they fit in the $15 pool)
      for (const codonId of ["step-1-main", "step-2-plan"]) {
        const codon = run.codons.find((c) => c.codonId === codonId);
        expect(codon).toBeDefined();
        expect(codon?.status).toBe("completed");
        if (codon?.status === "completed") {
          expect(codon.budgetExceeded).toBeUndefined();
        }
      }

      // Every codon after step-2 should have budgetExceeded (pool exhausted).
      // Note: loop iterations beyond the first may not exist because loop
      // expansion stops when budget is exceeded. We check all codons that
      // DID run after step-2 — they should all be budget-exceeded.
      const nonStarvedIds = new Set(["step-1-main", "step-2-plan"]);
      const starvedCodons = run.codons.filter((c) => !nonStarvedIds.has(c.codonId));
      expect(starvedCodons.length).toBeGreaterThanOrEqual(1);
      for (const codon of starvedCodons) {
        expect(codon.status).toBe("completed");
        if (codon.status === "completed") {
          expect(codon.budgetExceeded).toBeDefined();
          expect(codon.budgetExceeded?.currency).toBe("cost");
        }
      }

      // Verify we got budget info events
      const events = hankweave.getEvents();
      const budgetInfoEvents = events.filter(
        (e) => e.type === "info" && (e as InfoEvent).data.message.includes("budget limit reached"),
      );
      expect(budgetInfoEvents.length).toBeGreaterThanOrEqual(1);
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────
  // Scenario 2: Codon Hard Cap Tighter Than Proportional Share
  //
  // Budget: $100 proportional, step-2-plan gets 25% ($25 share)
  // But step-2-plan has a codon-level maxDollars: $5
  //
  // The codon cap ($5) is tighter than the proportional share ($25).
  // step-2-plan costs $11.36 → hits the $5 cap, NOT the $25 share.
  // The unused $20 from step-2's share flows back to the pool
  // (generous proportional mode), so all other codons have plenty.
  //
  // Key behavior tested: codon-level maxDollars overrides proportional
  // allocation. The tighter of the two wins.
  // ──────────────────────────────────────────────────────────────────────
  it("plan-gen: codon hard cap ($5) overrides proportional share ($25) — only step-2 exceeds", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("planGen");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank-config/hank-budget-codon-cap-override.json"),
      dataDir: path.join(replayDir, "data"),
      replayDir,
      port,
      logPrefix: "[budget-codon-cap]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      await hankweave.waitForRunToComplete(120_000);
      await hankweave.waitForConnectionClose(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("completed");

      // step-2-plan should be the ONLY codon with budgetExceeded
      // Its $5 codon cap is tighter than its $25 proportional share
      const step2 = run.codons.find((c) => c.codonId === "step-2-plan");
      expect(step2).toBeDefined();
      expect(step2?.status).toBe("completed");
      if (step2?.status === "completed") {
        expect(step2.budgetExceeded).toBeDefined();
        expect(step2.budgetExceeded?.currency).toBe("cost");
      }

      // step-1 should complete without budget issues
      const step1 = run.codons.find((c) => c.codonId === "step-1-main");
      expect(step1?.status).toBe("completed");
      if (step1?.status === "completed") {
        expect(step1.budgetExceeded).toBeUndefined();
      }

      // Other codons should also complete without exceeding —
      // $100 total with generous flowback means plenty of budget for all
      for (const codonId of ["step-3-codex", "step-4-merge", "final-step-compress"]) {
        const codon = run.codons.find((c) => c.codonId === codonId);
        expect(codon).toBeDefined();
        expect(codon?.status).toBe("completed");
        if (codon?.status === "completed") {
          expect(codon.budgetExceeded).toBeUndefined();
        }
      }
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────
  // Scenario 3: Loop-Level Budget Terminates Loop Early
  //
  // No hank-level budget. blind-reviews loop has budget.maxDollars: $10.
  //
  // blind-review loop iteration costs:
  //   iter 0: $0.82 (review) + $8.30 (update) = $9.12  → fits in $10
  //   iter 1: $0.98 (review) → cumulative ~$10.10 → exceeds
  //
  // The loop terminates early (1 full iteration + partial 2nd).
  // Crucially, post-loop codons (implementation-review-loop,
  // final-step-compress) still run normally — loop budget is isolated.
  //
  // Key behavior tested: loop-level budget isolation. The loop's budget
  // is its own scope; exceeding it doesn't affect the rest of the pipeline.
  // ──────────────────────────────────────────────────────────────────────
  it("plan-gen: loop budget ($10) terminates blind-reviews early, post-loop codons unaffected", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("planGen");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank-config/hank-budget-loop-terminate.json"),
      dataDir: path.join(replayDir, "data"),
      replayDir,
      port,
      logPrefix: "[budget-loop-terminate]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      await hankweave.waitForRunToComplete(120_000);
      await hankweave.waitForConnectionClose(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("completed");

      // The blind-review loop should have terminated early — fewer than 6 codons
      // (3 full iterations × 2 codons = 6). We expect 2-3 codons (1 full iter + partial)
      const blindReviewCodons = run.codons.filter(
        (c) =>
          c.codonId.startsWith("step-5-blind-review#") || c.codonId.startsWith("step-6-update#"),
      );
      expect(blindReviewCodons.length).toBeLessThan(6);
      expect(blindReviewCodons.length).toBeGreaterThanOrEqual(2);

      // At least one blind-review codon should have budget exceeded
      const exceededInLoop = blindReviewCodons.filter(
        (c) => c.status === "completed" && c.budgetExceeded,
      );
      expect(exceededInLoop.length).toBeGreaterThanOrEqual(1);
      if (exceededInLoop[0].status === "completed") {
        expect(exceededInLoop[0].budgetExceeded?.currency).toBe("cost");
      }

      // Post-loop codons should run normally (no hank-level budget constraining them)
      // implementation-review-loop codons should have no budget issues
      const implCodons = run.codons.filter(
        (c) =>
          c.codonId.startsWith("implement-loop-step-1-implement#") ||
          c.codonId.startsWith("implement-loop-step-2-update#"),
      );
      expect(implCodons.length).toBeGreaterThanOrEqual(1);
      for (const codon of implCodons) {
        expect(codon.status).toBe("completed");
        if (codon.status === "completed") {
          expect(codon.budgetExceeded).toBeUndefined();
        }
      }

      // final-step-compress should complete without budget issues
      const finalCodon = run.codons.find((c) => c.codonId === "final-step-compress");
      expect(finalCodon).toBeDefined();
      expect(finalCodon?.status).toBe("completed");
      if (finalCodon?.status === "completed") {
        expect(finalCodon.budgetExceeded).toBeUndefined();
      }
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────
  // Scenario 4: Output Token Cap on Specific Codon
  //
  // No dollar budget anywhere. step-2-plan has maxOutputTokens: 100.
  //
  // step-2-plan (Opus, heavy planning codon) generates far more than
  // 100 output tokens during its $11.36 execution. It gets stopped
  // with budgetExceeded.currency === "outputTokens".
  //
  // All other codons have no token or dollar limits and run normally.
  //
  // Key behavior tested: output token budget works independently of
  // cost budgets, on individual codons within a multi-model pipeline.
  // ──────────────────────────────────────────────────────────────────────
  it("plan-gen: output token cap (100) on step-2-plan stops it while rest of pipeline runs", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("planGen");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank-config/hank-budget-output-tokens.json"),
      dataDir: path.join(replayDir, "data"),
      replayDir,
      port,
      logPrefix: "[budget-output-tokens]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      await hankweave.waitForRunToComplete(120_000);
      await hankweave.waitForConnectionClose(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("completed");

      // step-2-plan should have output token budget exceeded
      const step2 = run.codons.find((c) => c.codonId === "step-2-plan");
      expect(step2).toBeDefined();
      expect(step2?.status).toBe("completed");
      if (step2?.status === "completed") {
        expect(step2.budgetExceeded).toBeDefined();
        expect(step2.budgetExceeded?.currency).toBe("outputTokens");
      }

      // step-1 should complete normally (no token budget)
      const step1 = run.codons.find((c) => c.codonId === "step-1-main");
      expect(step1?.status).toBe("completed");
      if (step1?.status === "completed") {
        expect(step1.budgetExceeded).toBeUndefined();
      }

      // step-3 and beyond should complete normally (no token limits on them)
      const step3 = run.codons.find((c) => c.codonId === "step-3-codex");
      expect(step3?.status).toBe("completed");
      if (step3?.status === "completed") {
        expect(step3.budgetExceeded).toBeUndefined();
      }

      // final-step-compress should complete normally
      const finalCodon = run.codons.find((c) => c.codonId === "final-step-compress");
      expect(finalCodon?.status).toBe("completed");
      if (finalCodon?.status === "completed") {
        expect(finalCodon.budgetExceeded).toBeUndefined();
      }
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);

  // ──────────────────────────────────────────────────────────────────────
  // Scenario 5: Mixed onExceeded Policies in Proportional Mode
  //
  // Budget: $20 proportional with explicit 10% shares for steps 1-4.
  // Hank-level onExceeded: "complete" (default graceful behavior).
  // But step-2-plan overrides to onExceeded: "fail".
  //
  // step-1-main gets 15% of $20 = $3.00. Costs ~$2.00 tracked → fits.
  // step-2-plan gets 10% of $20 = $2.00. Costs $11.36 → exceeds at ~$2.
  //
  // Because step-2's onExceeded is "fail" (codon override), and
  // default onFailure is "abort", the ENTIRE run fails at step-2.
  // step-3+ never execute.
  //
  // Key behavior tested: a single codon with onExceeded:"fail" can halt
  // an entire proportionally-budgeted pipeline. Codon-level policy
  // overrides hank-level policy.
  // ──────────────────────────────────────────────────────────────────────
  it("plan-gen: mixed policies — step-2 onExceeded=fail halts proportional pipeline", async () => {
    const port = await getFreePort();
    const replayDir = prepareReplayDir("planGen");

    const hankweave = await launchHankweave({
      configPath: path.join(replayDir, "hank-config/hank-budget-mixed-policies.json"),
      dataDir: path.join(replayDir, "data"),
      replayDir,
      port,
      logPrefix: "[budget-mixed-policies]",
      extraArgs: ["--force"],
    });

    try {
      const readyEvent = (await hankweave.waitForEvent("server.ready", 60_000)) as ServerReadyEvent;
      expect(readyEvent.data.executionPath).toBeDefined();

      await hankweave.waitForRunToFail(60_000);
      await hankweave.waitForConnectionClose(60_000);

      const state = hankweave.getState();
      const run = state.runs[0];
      expect(run).toBeDefined();
      expect(run.status).toBe("failed");

      // step-1 should complete normally — ~$2.00 tracked cost fits within its $3.00 share
      const step1 = run.codons.find((c) => c.codonId === "step-1-main");
      expect(step1).toBeDefined();
      expect(step1?.status).toBe("completed");
      if (step1?.status === "completed") {
        expect(step1.budgetExceeded).toBeUndefined();
      }

      // step-2 should FAIL (not complete) — exceeds $2 share, onExceeded="fail"
      const step2 = run.codons.find((c) => c.codonId === "step-2-plan");
      expect(step2).toBeDefined();
      expect(step2?.status).toBe("failed");

      // Verify the codon.completed event carries budget exceeded info
      const events = hankweave.getEvents();
      const step2CompletedEvent = events.find(
        (e) =>
          e.type === "codon.completed" &&
          (e as CodonCompletedEvent).data?.codonId === "step-2-plan",
      ) as CodonCompletedEvent | undefined;
      expect(step2CompletedEvent).toBeDefined();
      expect(step2CompletedEvent?.data.success).toBe(false);
      expect(step2CompletedEvent?.data.budgetExceeded).toBeDefined();
      expect(step2CompletedEvent?.data.budgetExceeded?.currency).toBe("cost");

      // step-3+ should not have run (run aborted at step-2)
      const step3 = run.codons.find((c) => c.codonId === "step-3-codex");
      if (step3) {
        expect(step3.status).not.toBe("completed");
      }
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 120_000);
});
