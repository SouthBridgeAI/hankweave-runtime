#!/usr/bin/env bun

import { afterAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServerEvent } from "../../server/types.js";
import { executeTestCleanup, logCleanupResults } from "../utils/cleanup-integration.js";
import type { TestLangtonState, TestPhaseExecution, TestRun } from "../utils/state-types-helper.js";
import { colors, setupTestDirectory, startServer, TestWSClient } from "../utils/test-helpers.js";

// Test configuration
const TEST_TIMEOUT = 60 * 1000; // 1 minute
const TEST_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const TEST_DIR = path.join(TEST_ROOT, "tests/test-area/crash-recovery");
const SERVER_PORT = parseInt(process.env.LANGTON_TEST_PORT || "7779");
const PHASES_CONFIG = path.join(TEST_ROOT, "tests/config/test-phases.config.json");

// Test state
interface TestState {
  serverProcess1: ChildProcess | null;
  serverProcess2: ChildProcess | null;
  client: TestWSClient | null;
  events: ServerEvent[];
  runId1: string | null;
  runId2: string | null;
  cleanupCompleted: boolean;
}

const testState: TestState = {
  serverProcess1: null,
  serverProcess2: null,
  client: null,
  events: [],
  runId1: null,
  runId2: null,
  cleanupCompleted: false,
};

async function runCrashRecoveryTest(): Promise<void> {
  // Setup test directory
  await setupTestDirectory({
    testDir: TEST_DIR,
    testResultsDir: path.join(TEST_ROOT, "tests/test-results"),
    testRunDir: path.join(TEST_ROOT, "tests/test-results/crash-recovery"),
  });

  console.log(`${colors.blue}Starting first server instance...${colors.reset}`);

  // Start first server
  testState.serverProcess1 = startServer({
    testRunDir: TEST_DIR,
    phasesConfig: PHASES_CONFIG,
    port: SERVER_PORT,
    testMode: "e2e-crash-recovery",
    cwd: TEST_DIR,
  });

  // Give server time to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Connect WebSocket client
  testState.client = new TestWSClient();
  await testState.client.connect(SERVER_PORT);

  // Wait for server ready
  await testState.client.waitForEvent("server.ready");
  await testState.client.waitForEvent("state.snapshot");

  // Wait for phase 1 to start and get into running state
  const phase1Started = await testState.client.waitForPhaseStart("phase-1", 10000);
  console.log(
    `${colors.green}✓ Phase 1 started with session ID: ${phase1Started.data.sessionId}${colors.reset}`,
  );

  // Wait a bit to ensure phase is running and state is saved
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Extract run ID from state.json
  const statePath = path.join(TEST_DIR, ".langton/state.json");
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    testState.runId1 = state.currentRunId;
    console.log(`${colors.blue}Run ID from first server: ${testState.runId1}${colors.reset}`);
  }

  // Store events from first server
  testState.events = [...testState.client.getEvents()];

  // Simulate crash by killing the process without cleanup
  console.log(`${colors.yellow}Simulating server crash...${colors.reset}`);
  testState.client.disconnect(); // Disconnect client first
  testState.serverProcess1.kill("SIGKILL"); // Hard kill

  // Wait for process to die
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Verify lock file still exists (wasn't cleaned up)
  const lockFile = path.join(TEST_DIR, ".langton/server.lock");
  expect(fs.existsSync(lockFile)).toBe(true);

  console.log(`${colors.blue}Starting second server instance (recovery)...${colors.reset}`);

  // Start second server - should detect crashed run
  testState.serverProcess2 = startServer({
    testRunDir: TEST_DIR,
    phasesConfig: PHASES_CONFIG,
    port: SERVER_PORT,
    testMode: "e2e-crash-recovery",
    cwd: TEST_DIR,
  });

  // Give recovery time
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Read state again to check if crash was detected
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    testState.runId2 = state.currentRunId;
    console.log(`${colors.blue}Run ID from second server: ${testState.runId2}${colors.reset}`);
  }

  // Let the server run for a bit
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

// Cleanup function
async function cleanup(): Promise<void> {
  if (testState.cleanupCompleted) return;

  // Kill any running processes
  if (testState.serverProcess1) {
    try {
      testState.serverProcess1.kill();
    } catch (_error) {
      // Process might already be dead
    }
  }

  if (testState.serverProcess2) {
    try {
      testState.serverProcess2.kill();
    } catch (_error) {
      // Process might already be dead
    }
  }

  // Wait for processes to die
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Run cleanup
  const cleanupResult = await executeTestCleanup({
    testDir: TEST_DIR,
    phasesConfig: PHASES_CONFIG,
    skipConfirmation: true,
    force: true,
  });

  logCleanupResults(cleanupResult, true);
  testState.cleanupCompleted = true;
}

// Run test
console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}`);
console.log(`${colors.blue}Langton Server Crash Recovery Test${colors.reset}`);
console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

await runCrashRecoveryTest();

// Cleanup after tests
afterAll(async () => {
  await cleanup();
});

// Tests
describe("Crash Recovery E2E", () => {
  test(
    "server recovers from crash mid-phase",
    () => {
      // Should have detected the crash
      const statePath = path.join(TEST_DIR, ".langton/state.json");
      expect(fs.existsSync(statePath)).toBe(true);

      const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as TestLangtonState;

      // Should have at least 1 run
      expect(state.runs.length).toBeGreaterThanOrEqual(1);

      // The server should continue the same run after recovery
      const firstRun = state.runs.find((r: TestRun) => r.runId === testState.runId1);
      expect(firstRun).toBeDefined();

      // The run should still be "running" since it was recovered
      if (firstRun) {
        expect(firstRun.status).toBe("running");
      }

      // The current run ID should be the same as before the crash
      expect(state.currentRunId).toBe(testState.runId1);
    },
    TEST_TIMEOUT,
  );

  test("crashed run has proper metadata", () => {
    const statePath = path.join(TEST_DIR, ".langton/state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as TestLangtonState;

    const crashedRun = state.runs.find((r: TestRun) => r.status === "crashed");
    if (crashedRun) {
      expect(crashedRun.endTime).toBeDefined();

      // Should have at least one phase that was running
      const runningPhase = crashedRun.phases.find(
        (p: TestPhaseExecution) =>
          p.status === "failed" && p.failureReason?.message?.includes("crashed"),
      );
      expect(runningPhase).toBeDefined();
    }
  });

  test("lock file is updated after recovery", () => {
    const lockFile = path.join(TEST_DIR, ".langton/server.lock");
    // After recovery, lock file should be updated with new PID
    if (fs.existsSync(lockFile)) {
      const lockData = JSON.parse(fs.readFileSync(lockFile, "utf-8"));
      expect(lockData.runId).toBeDefined();

      // The run ID in lock should be the SAME as the crashed run (recovery continues the run)
      expect(lockData.runId).toBe(testState.runId1);

      // But the PID and heartbeat should be updated
      expect(lockData.pid).toBeDefined();
      expect(lockData.lastHeartbeat).toBeDefined();

      // The heartbeat should be recent (within last minute)
      const heartbeatAge = Date.now() - new Date(lockData.lastHeartbeat).getTime();
      expect(heartbeatAge).toBeLessThan(60000); // Less than 1 minute old
    }
  });

  test("run folders exist for both runs", () => {
    const runsDir = path.join(TEST_DIR, ".langton/runs");
    expect(fs.existsSync(runsDir)).toBe(true);

    const runFolders = fs.readdirSync(runsDir);

    // Should have folders for both runs
    expect(runFolders.length).toBeGreaterThanOrEqual(1);

    // Check if crashed run folder exists
    if (testState.runId1) {
      expect(runFolders).toContain(testState.runId1);
    }
  });

  test("state file has proper structure", () => {
    const statePath = path.join(TEST_DIR, ".langton/state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));

    // Validate state structure
    expect(state).toHaveProperty("runs");
    expect(Array.isArray(state.runs)).toBe(true);
    expect(state).toHaveProperty("currentRunId");

    // Each run should have required fields
    for (const run of state.runs) {
      expect(run).toHaveProperty("runId");
      expect(run).toHaveProperty("status");
      expect(run).toHaveProperty("phases");
      expect(run).toHaveProperty("startTime");
      expect(Array.isArray(run.phases)).toBe(true);
    }
  });
});
