#!/usr/bin/env bun
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerReadyEvent } from "../../server/schemas/event-schemas.js";
import type { HankweaveState } from "../../server/types/state-types.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { generateTestTimestamp, getFreePort } from "../utils/test-helpers.js";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_AREA = path.join(TEST_ROOT, "tests/test-area");
const TEST_TIMESTAMP = generateTestTimestamp();

const isWindows = process.platform === "win32";
const RUN_TIMEOUT_MS = isWindows ? 8 * 60_000 : 5 * 60_000;

// ──────────────────────────────────────────────────────
// Helper: run a hank, then replay it and verify
// ──────────────────────────────────────────────────────

interface ReplayScenario {
  /** Directory where the execution lives */
  execDir: string;
  /** Path to hank.json */
  configPath: string;
  /** Path to data dir/file */
  dataDir: string;
  /** Number of codons expected in a completed run */
  expectedCodonCount: number;
  /** Codon IDs to wait for during replay */
  codonIds: string[];
}

/**
 * Replay an already-executed hank and verify the full pipeline works.
 */
async function replayAndVerify(scenario: ReplayScenario, logPrefix: string) {
  const port = await getFreePort();

  const server = await launchHankweave({
    port,
    configPath: scenario.configPath,
    dataDir: scenario.dataDir,
    replayDir: scenario.execDir,
    logPrefix,
  });

  try {
    const readyEvent = (await server.waitForEvent("server.ready", 30_000)) as ServerReadyEvent;
    expect(readyEvent).toBeDefined();

    // All codons should replay and complete
    for (const codonId of scenario.codonIds) {
      await server.waitForCodonCompletion(codonId, undefined, 60_000);
    }
    await server.waitForRunToComplete(60_000);

    // Verify state
    const state = server.getState();
    // Original run from copied state + replay run
    expect(state.runs.length).toBe(2);

    const replayRun = state.runs[0]; // newest run
    expect(replayRun.status).toBe("completed");
    expect(replayRun.codons.length).toBe(scenario.expectedCodonCount);
    for (const codon of replayRun.codons) {
      expect(codon.status).toBe("completed");
    }

    // Verify key events flowed through the pipeline
    const events = server.getEvents();
    const startedEvents = events.filter((e) => e.type === "codon.started");
    const completedEvents = events.filter((e) => e.type === "codon.completed");

    expect(startedEvents.length).toBe(scenario.expectedCodonCount);
    expect(completedEvents.length).toBe(scenario.expectedCodonCount);
  } finally {
    await server.stop();
  }
}

// ──────────────────────────────────────────────────────
// 1. Replay init-generated hank (3 codons: haiku, gemini, codex)
// ──────────────────────────────────────────────────────

describe("Replay E2E — init-generated hank", () => {
  const INIT_DIR = path.join(TEST_AREA, `replay-init-${TEST_TIMESTAMP}`);

  beforeAll(async () => {
    fs.mkdirSync(INIT_DIR, { recursive: true });

    // Phase 1: Run --init to scaffold hank.json, prompts, and data
    const serverEntry = path.join(TEST_ROOT, "server/index.ts");
    const initChild = spawn("bun", [serverEntry, "--init"], {
      cwd: INIT_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    initChild.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    initChild.stderr?.on("data", (d) => process.stderr.write(d));

    const [initExit] = await once(initChild, "exit");
    if (initExit !== 0) {
      throw new Error(`--init exited with code ${initExit}:\n${stdout}`);
    }

    // Phase 2: Execute the generated hank (real LLM calls)
    const port = await getFreePort();
    const server = await launchHankweave({
      port,
      configPath: path.join(INIT_DIR, "hank.json"),
      dataDir: path.join(INIT_DIR, "data"),
      cwd: INIT_DIR,
      executionDir: INIT_DIR,
      reuseTestDirectory: true,
      logPrefix: "[Init-Exec]",
    });

    try {
      await server.waitForEvent("server.ready", 30_000);
      await server.waitForRunToComplete(RUN_TIMEOUT_MS);

      const state = server.getState();
      const run = state.runs[0];
      expect(run.status).toBe("completed");
      expect(run.codons.length).toBe(3);
      for (const codon of run.codons) {
        expect(codon.status).toBe("completed");
      }
    } finally {
      await server.stop(10_000);
    }
  }, RUN_TIMEOUT_MS + 60_000);

  afterAll(() => {
    try {
      fs.rmSync(INIT_DIR, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("replays all 3 codons (haiku, gemini, codex) without real LLM calls", async () => {
    await replayAndVerify(
      {
        execDir: INIT_DIR,
        configPath: path.join(INIT_DIR, "hank.json"),
        dataDir: path.join(INIT_DIR, "data"),
        expectedCodonCount: 3,
        codonIds: ["analyze-haiku", "analyze-gemini", "analyze-codex"],
      },
      "[Replay-Init]",
    );
  }, 90_000);

  test(
    "replay with timestamps takes approximately the same time as original execution",
    async () => {
      // 1. Read original run duration from state.json
      const stateJson = fs.readFileSync(path.join(INIT_DIR, ".hankweave/state.json"), "utf-8");
      const state: HankweaveState = JSON.parse(stateJson);
      const run = state.runs[0];
      const endTime = run.endTime ?? run.startTime;
      const originalDurationMs = new Date(endTime).getTime() - new Date(run.startTime).getTime();

      console.log(`[Replay-Timing] Original run duration: ${originalDurationMs}ms`);

      // 2. Replay and measure wall-clock time
      const replayStart = Date.now();
      await replayAndVerify(
        {
          execDir: INIT_DIR,
          configPath: path.join(INIT_DIR, "hank.json"),
          dataDir: path.join(INIT_DIR, "data"),
          expectedCodonCount: 3,
          codonIds: ["analyze-haiku", "analyze-gemini", "analyze-codex"],
        },
        "[Replay-Timing]",
      );
      const replayDurationMs = Date.now() - replayStart;

      console.log(`[Replay-Timing] Replay duration: ${replayDurationMs}ms`);
      console.log(`[Replay-Timing] Ratio: ${(replayDurationMs / originalDurationMs).toFixed(2)}x`);

      // 3. Assert replay duration is close to original
      // MAX_REPLAY_DELAY_MS (5s) caps individual gaps, so replay is typically
      // shorter than original (which has real LLM calls). We assert it's
      // at least 10% of original (timestamps are being used, not 5ms fixed)
      // and not more than 2x original (not pathologically slow).
      expect(replayDurationMs).toBeGreaterThan(originalDurationMs * 0.1);
      expect(replayDurationMs).toBeLessThan(originalDurationMs * 2);
    },
    5 * 60_000,
  );
});

// ──────────────────────────────────────────────────────
// 2. Replay happy-path hank (3 codons with rig setup,
//    sentinels, and continue-previous)
// ──────────────────────────────────────────────────────

describe("Replay E2E — happy-path hank", () => {
  const HAPPY_DIR = path.join(TEST_AREA, `replay-happy-${TEST_TIMESTAMP}`);

  beforeAll(async () => {
    fs.mkdirSync(HAPPY_DIR, { recursive: true });

    // Execute the default test config (tests/config/test-codons.config.json)
    // which has rig setups, sentinels, continue-previous, and mixed models.
    const port = await getFreePort();
    const server = await launchHankweave({
      port,
      executionDir: HAPPY_DIR,
      logPrefix: "[Happy-Exec]",
    });

    try {
      await server.waitForEvent("server.ready", 30_000);
      await server.waitForRunToComplete(RUN_TIMEOUT_MS);

      const state = server.getState();
      const run = state.runs[0];
      expect(run.status).toBe("completed");
      expect(run.codons.length).toBe(3);
      for (const codon of run.codons) {
        expect(codon.status).toBe("completed");
      }
    } finally {
      await server.stop(10_000);
    }
  }, RUN_TIMEOUT_MS + 60_000);

  afterAll(() => {
    try {
      fs.rmSync(HAPPY_DIR, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("replays all 3 codons (rig setup, sentinels, continue-previous) without real LLM calls", async () => {
    await replayAndVerify(
      {
        execDir: HAPPY_DIR,
        configPath: path.resolve(TEST_ROOT, "tests/config/test-codons.config.json"),
        dataDir: path.resolve(TEST_ROOT, "tests/config/poem_guides.txt"),
        expectedCodonCount: 3,
        codonIds: ["codon-1", "codon-2", "codon-3"],
      },
      "[Replay-Happy]",
    );
  }, 90_000);

  test("fails when a codon log file is missing (no silent fallback to real execution)", async () => {
    // Copy the execution dir and delete one codon's log file
    const corruptDir = path.join(TEST_AREA, `replay-corrupt-${TEST_TIMESTAMP}`);
    fs.cpSync(HAPPY_DIR, corruptDir, { recursive: true });

    try {
      // Find the run folder and delete the first codon's log
      const stateJson = fs.readFileSync(path.join(corruptDir, ".hankweave/state.json"), "utf-8");
      const state: HankweaveState = JSON.parse(stateJson);
      const targetCodon = state.runs[0].codons[0] as { claudeLogPath?: string };
      const logPath = path.join(corruptDir, targetCodon.claudeLogPath as string);
      fs.unlinkSync(logPath);

      // Replay should fail — the server process should crash during
      // manifest loading because a codon log is missing.
      const port = await getFreePort();
      const serverEntry = path.join(TEST_ROOT, "server/index.ts");
      const child = spawn(
        "bun",
        [
          serverEntry,
          "--config",
          path.resolve(TEST_ROOT, "tests/config/test-codons.config.json"),
          "--data",
          path.resolve(TEST_ROOT, "tests/config/poem_guides.txt"),
          "--port",
          String(port),
          "--replay",
          corruptDir,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      let stderr = "";
      child.stdout?.on("data", (d) => {
        console.log(`[Replay-Corrupt] ${d.toString().trimEnd()}`);
      });
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
        console.error(`[Replay-Corrupt] ${d.toString().trimEnd()}`);
      });

      const [exitCode] = await once(child, "exit");
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("codon log file(s) not found");
    } finally {
      fs.rmSync(corruptDir, { recursive: true, force: true });
    }
  }, 30_000);
});
