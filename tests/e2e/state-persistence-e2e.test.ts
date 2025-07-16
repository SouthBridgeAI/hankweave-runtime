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
const TEST_DIR = path.join(TEST_ROOT, "tests/test-area/state-persistence");
const SERVER_PORT = parseInt(process.env.LANGTON_TEST_PORT || "7780");
const PHASES_CONFIG = path.join(TEST_ROOT, "tests/config/test-phases.config.json");

// Test state
interface TestState {
  serverProcess1: ChildProcess | null;
  serverProcess2: ChildProcess | null;
  client1: TestWSClient | null;
  client2: TestWSClient | null;
  events1: ServerEvent[];
  events2: ServerEvent[];
  runId1?: string | null;
  runId2?: string | null;
  stateBeforeShutdown?: TestLangtonState;
  stateAfterRestart?: TestLangtonState;
  cleanupCompleted: boolean;
}

const testState: TestState = {
  serverProcess1: null,
  serverProcess2: null,
  client1: null,
  client2: null,
  events1: [],
  events2: [],
  cleanupCompleted: false,
};

async function runStatePersistenceTest(): Promise<void> {
  // Setup test directory
  await setupTestDirectory({
    testDir: TEST_DIR,
    testResultsDir: path.join(TEST_ROOT, "tests/test-results"),
    testRunDir: path.join(TEST_ROOT, "tests/test-results/state-persistence"),
  });

  console.log(`${colors.blue}Starting first server instance...${colors.reset}`);

  // Start first server
  testState.serverProcess1 = startServer({
    testRunDir: TEST_DIR,
    phasesConfig: PHASES_CONFIG,
    port: SERVER_PORT,
    testMode: "e2e-state-persistence",
    cwd: TEST_DIR,
  });

  // Give server time to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Connect WebSocket client
  testState.client1 = new TestWSClient();
  await testState.client1.connect(SERVER_PORT);

  // Wait for server ready
  await testState.client1.waitForEvent("server.ready");
  await testState.client1.waitForEvent("state.snapshot");

  // Start phase 1 and wait for completion
  const phase1Started = await testState.client1.waitForPhaseStart("phase-1", 10000);
  console.log(
    `${colors.green}✓ Phase 1 started with session ID: ${phase1Started.data.sessionId}${colors.reset}`,
  );

  // Wait for phase 1 to complete
  const phase1Completed = await testState.client1.waitForPhaseCompletion("phase-1", 30000);
  console.log(
    `${colors.green}✓ Phase 1 completed with cost: $${phase1Completed.data.cost.toFixed(6)}${
      colors.reset
    }`,
  );

  // Skip phase 2 to test skipped phase persistence
  testState.client1.sendCommand({
    id: "test-skip-2",
    type: "phase.skip",
  });

  // Wait for phase 2 to be skipped
  const _phase2Completed = await testState.client1.waitForPhaseCompletion("phase-2", 10000);
  console.log(`${colors.yellow}✓ Phase 2 skipped${colors.reset}`);

  // Capture state before shutdown
  const statePath = path.join(TEST_DIR, ".langton/state.json");
  if (fs.existsSync(statePath)) {
    const stateData = JSON.parse(fs.readFileSync(statePath, "utf-8")) as TestLangtonState;
    testState.stateBeforeShutdown = stateData;
    testState.runId1 = stateData.currentRunId;
    console.log(`${colors.blue}Run ID from first server: ${testState.runId1}${colors.reset}`);
  } else {
    throw new Error("State file not found before shutdown - test cannot continue");
  }

  // Store events from first server
  testState.events1 = [...testState.client1.getEvents()];

  // Gracefully shutdown server
  console.log(`${colors.blue}Shutting down first server...${colors.reset}`);
  testState.client1.sendCommand({
    id: "test-shutdown-1",
    type: "server.shutdown",
  });

  // Wait for server to shutdown
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Disconnect client
  testState.client1.disconnect();

  console.log(`${colors.blue}Starting second server instance (restart)...${colors.reset}`);

  // Start second server - should load persisted state
  testState.serverProcess2 = startServer({
    testRunDir: TEST_DIR,
    phasesConfig: PHASES_CONFIG,
    port: SERVER_PORT,
    testMode: "e2e-state-persistence",
    cwd: TEST_DIR,
  });

  // Give server time to start and load state
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Connect second client
  testState.client2 = new TestWSClient();
  await testState.client2.connect(SERVER_PORT);

  // Wait for server ready
  await testState.client2.waitForEvent("server.ready");
  const _stateSnapshot = await testState.client2.waitForEvent("state.snapshot");

  // Read state after restart
  if (fs.existsSync(statePath)) {
    const stateData = JSON.parse(fs.readFileSync(statePath, "utf-8")) as TestLangtonState;
    testState.stateAfterRestart = stateData;
    testState.runId2 = stateData.currentRunId;
    console.log(`${colors.blue}Run ID from second server: ${testState.runId2}${colors.reset}`);
  } else {
    throw new Error("State file not found after restart - test cannot continue");
  }

  // NOTE: The rollback/continuation feature is not yet implemented.
  // When a server restarts after graceful shutdown, it starts a new run from phase 1.
  // In the future, it should detect the previous run and ask the user if they want to
  // rollback to the last completed phase and continue from there.
  // For now, we'll just verify that state was loaded correctly.

  // Store events from second server
  testState.events2 = [...testState.client2.getEvents()];

  // Shutdown second server
  testState.client2.sendCommand({
    id: "test-shutdown-2",
    type: "server.shutdown",
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));
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
console.log(`${colors.blue}Langton State Persistence Test${colors.reset}`);
console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

await runStatePersistenceTest();

// Cleanup after tests
afterAll(async () => {
  await cleanup();
});

// Tests
describe("State Persistence E2E", () => {
  test(
    "state survives server restart",
    () => {
      // State should be preserved
      expect(testState.stateBeforeShutdown).toBeDefined();
      expect(testState.stateAfterRestart).toBeDefined();

      // Ensure states are defined for TypeScript
      if (!testState.stateBeforeShutdown || !testState.stateAfterRestart) {
        throw new Error("Test setup failed: state not captured");
      }

      // Should have the same runs
      expect(testState.stateAfterRestart.runs.length).toBeGreaterThanOrEqual(
        testState.stateBeforeShutdown.runs.length,
      );

      // First run should still exist with same data
      const run1Before = testState.stateBeforeShutdown.runs.find(
        (r: TestRun) => r.runId === testState.runId1,
      );
      const run1After = testState.stateAfterRestart.runs.find(
        (r: TestRun) => r.runId === testState.runId1,
      );

      expect(run1After).toBeDefined();
      expect(run1Before).toBeDefined();

      if (!run1After || !run1Before) {
        throw new Error("Test setup failed: run not found");
      }

      expect(run1After.phases.length).toBe(run1Before.phases.length);
      expect(run1After.status).toBe("completed"); // Should be completed after first shutdown
    },
    TEST_TIMEOUT,
  );

  test("phase history is preserved", () => {
    if (!testState.stateAfterRestart) {
      throw new Error("Test setup failed: state after restart not captured");
    }

    const run1After = testState.stateAfterRestart.runs.find(
      (r: TestRun) => r.runId === testState.runId1,
    );

    if (!run1After) {
      throw new Error("Test setup failed: run1 not found after restart");
    }

    // Should have phase 1 completed
    const phase1 = run1After.phases.find((p: TestPhaseExecution) => p.phaseId === "phase-1");
    expect(phase1).toBeDefined();

    if (!phase1) {
      throw new Error("Test setup failed: phase 1 not found");
    }

    expect(phase1.status).toBe("completed");
    if (phase1.status === "completed") {
      expect(phase1.finalCost).toBeGreaterThan(0);
    }

    // Should have phase 2 skipped
    const phase2 = run1After.phases.find((p: TestPhaseExecution) => p.phaseId === "phase-2");
    expect(phase2).toBeDefined();

    if (!phase2) {
      throw new Error("Test setup failed: phase 2 not found");
    }

    expect(phase2.status).toBe("skipped");
    if (phase2.status === "skipped") {
      expect(phase2.partialCost).toBe(0);
    }
  });

  // TODO: Enable this test when rollback/continuation feature is implemented
  test.skip("costs are calculated correctly after restart", () => {
    if (!testState.stateBeforeShutdown || !testState.stateAfterRestart) {
      throw new Error("Test setup failed: state not captured");
    }

    // Get total cost from state
    const totalCostBefore = testState.stateBeforeShutdown.runs.reduce(
      (total: number, run: TestRun) => {
        const runCost = run.phases.reduce((pTotal: number, phase: TestPhaseExecution) => {
          if (phase.status === "completed") return pTotal + (phase.finalCost || 0);
          if (phase.status === "failed") return pTotal + (phase.partialCost || 0);
          return pTotal;
        }, 0);
        return total + runCost;
      },
      0,
    );

    const totalCostAfter = testState.stateAfterRestart.runs.reduce(
      (total: number, run: TestRun) => {
        const runCost = run.phases.reduce((pTotal: number, phase: TestPhaseExecution) => {
          if (phase.status === "completed") return pTotal + (phase.finalCost || 0);
          if (phase.status === "failed") return pTotal + (phase.partialCost || 0);
          return pTotal;
        }, 0);
        return total + runCost;
      },
      0,
    );

    // After restart, total cost should include phase 3
    // (This will work when rollback feature allows continuing from phase 2)
    expect(totalCostAfter).toBeGreaterThan(totalCostBefore);
  });

  test("new run is created after restart", () => {
    // Second server should create a new run
    expect(testState.runId2).toBeDefined();
    expect(testState.runId2).not.toBe(testState.runId1);

    if (!testState.stateAfterRestart) {
      throw new Error("Test setup failed: state after restart not captured");
    }

    // New run should exist in state
    const run2 = testState.stateAfterRestart.runs.find(
      (r: TestRun) => r.runId === testState.runId2,
    );
    expect(run2).toBeDefined();

    if (!run2) {
      throw new Error("Test setup failed: run2 not found");
    }

    expect(run2.phases.length).toBeGreaterThan(0);
  });

  test("run folders are preserved", () => {
    const runsDir = path.join(TEST_DIR, ".langton/runs");
    expect(fs.existsSync(runsDir)).toBe(true);

    const runFolders = fs.readdirSync(runsDir);

    // Should have folders for both runs
    expect(runFolders).toContain(testState.runId1);
    expect(runFolders).toContain(testState.runId2);

    // Check that log files exist in run folders
    if (testState.runId1) {
      const run1LogsDir = path.join(runsDir, testState.runId1);
      const run1Logs = fs.readdirSync(run1LogsDir);
      const claudeLogs = run1Logs.filter((f) => f.includes("claude.log"));
      expect(claudeLogs.length).toBeGreaterThan(0);
    }
  });

  // TODO: Enable this test when rollback/continuation feature is implemented
  test.skip("session continuity is preserved", () => {
    if (!testState.stateAfterRestart) {
      throw new Error("Test setup failed: state after restart not captured");
    }

    // When continuation is implemented:
    // Phase 3 should continue from phase 1 (since phase 2 was skipped)
    const run2 = testState.stateAfterRestart.runs.find(
      (r: TestRun) => r.runId === testState.runId2,
    );
    const phase3 = run2?.phases.find((p: TestPhaseExecution) => p.phaseId === "phase-3");

    // Get phase 1 session ID from first run
    const run1 = testState.stateAfterRestart.runs.find(
      (r: TestRun) => r.runId === testState.runId1,
    );
    const phase1 = run1?.phases.find((p: TestPhaseExecution) => p.phaseId === "phase-1");

    // Phase 3 should have previousSessionId from phase 1
    // Both phases should exist and have session IDs at this point
    expect(phase3).toBeDefined();
    expect(phase1).toBeDefined();

    if (!phase3 || !phase1) {
      throw new Error("Test setup failed: phases not found");
    }

    // Check that both session IDs exist
    const phase3PreviousSessionId = phase3.previousSessionId;
    const phase1SessionId = phase1.claudeSessionId;

    expect(phase3PreviousSessionId).toBeDefined();
    expect(phase1SessionId).toBeDefined();

    // Now we can safely compare them since we've verified they're both defined
    // TypeScript requires explicit type narrowing here
    if (phase3PreviousSessionId && phase1SessionId) {
      expect(phase3PreviousSessionId).toBe(phase1SessionId);
    } else {
      // This should never happen given the checks above, but satisfies TypeScript
      throw new Error("Session IDs should be defined at this point");
    }
  });

  test("state file backup exists", () => {
    const stateBackupPath = path.join(TEST_DIR, ".langton/state.json.bak");
    expect(fs.existsSync(stateBackupPath)).toBe(true);

    // Backup should be valid JSON
    const backup = JSON.parse(fs.readFileSync(stateBackupPath, "utf-8"));
    expect(backup).toHaveProperty("runs");
    expect(backup).toHaveProperty("currentRunId");
  });
});
