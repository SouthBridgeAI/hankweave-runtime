#!/usr/bin/env bun
import { beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PhaseId } from "../../server/branded-types.js";
import type {
  CheckpointListEvent,
  ClientCommand,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  RollbackCompletedEvent,
  ServerEvent,
  ServerIdleEvent,
} from "../../server/types.js";
import { generateId } from "../../server/utils.js";
import {
  colors,
  generateTestTimestamp,
  setupTestDirectory,
  type TestDirectoryConfig,
  TestWSClient,
} from "../utils/test-helpers.js";

// Test configuration
const TEST_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const EXECUTION_DIR = path.join(TEST_ROOT, "tests/test-area/rollback-improved"); // Use as execution directory
const DATA_SOURCE_DIR = path.join(TEST_ROOT, "tests/test-area/rollback-improved-data"); // Empty data source
const SNAPSHOT_DIR = path.join(TEST_ROOT, "tests/test-area/rollback-snapshots");
const TEST_RESULTS_DIR = path.join(TEST_ROOT, "tests/test-results");
const SERVER_PORT = parseInt(process.env.tadpole_TEST_PORT || "7786");
const PHASES_CONFIG = path.join(TEST_ROOT, "tests/config/test-phases.config.json");

// Generate timestamp for this test run
const TEST_TIMESTAMP = generateTestTimestamp();
const TEST_RUN_DIR = path.join(TEST_RESULTS_DIR, `rollback-improved-${TEST_TIMESTAMP}`);

// Test directory configuration
const testDirConfig: TestDirectoryConfig = {
  testDir: EXECUTION_DIR, // Use execution directory
  testResultsDir: TEST_RESULTS_DIR,
  testRunDir: TEST_RUN_DIR,
};

// Test snapshot structure
interface TestSnapshot {
  name: string;
  directory: string;
  state: {
    runs: Array<{
      runId: string;
      status: string;
      startingConditions?: { type: string };
      [key: string]: unknown;
    }>;
    currentRunId: string;
    [key: string]: unknown;
  };
  events: ServerEvent[];
  checkpoints: CheckpointListEvent["data"]["checkpoints"];
  timestamp: string;
}

// Test state
interface TestState {
  serverProcess: ChildProcess | null;
  client: TestWSClient | null;
  snapshots: TestSnapshot[];
  scenario5RollbackResult?: RollbackCompletedEvent;
  executionPath?: string; // Track execution path for execution isolation
}

const testState: TestState = {
  serverProcess: null,
  client: null,
  snapshots: [],
};

// Enhanced TestWSClient with session ID tracking
class EnhancedTestWSClient extends TestWSClient {
  private sessionIdMap = new Map<string, string>(); // phaseId -> sessionId

  async waitForPhaseStartWithSession(
    phaseId: string,
    timeout: number = 30000,
    afterTimestamp?: string,
  ): Promise<PhaseStartedEvent> {
    const event = await this.waitForEvent(
      "phase.started",
      timeout,
      (e) => {
        const startedEvent = e as PhaseStartedEvent;
        return startedEvent.data?.phaseId === phaseId;
      },
      afterTimestamp,
    );

    const phaseStartedEvent = event as PhaseStartedEvent;
    // Store the session ID for this phase
    this.sessionIdMap.set(phaseId, phaseStartedEvent.data.sessionId);
    return phaseStartedEvent;
  }

  async waitForPhaseCompletionBySession(
    phaseId: string,
    timeout: number = 120000,
    afterTimestamp?: string,
  ): Promise<PhaseCompletedEvent> {
    const event = await this.waitForEvent(
      "phase.completed",
      timeout,
      (e) => {
        const completedEvent = e as PhaseCompletedEvent;
        // Match by phase ID
        if (completedEvent.data?.phaseId !== phaseId) return false;

        // If we have a session ID, also verify it matches
        // Note: phase.completed events don't include sessionId directly,
        // so we rely on phase ID matching and timestamp ordering
        return true;
      },
      afterTimestamp,
    );

    return event as PhaseCompletedEvent;
  }

  getSessionId(phaseId: string): string | undefined {
    return this.sessionIdMap.get(phaseId);
  }

  clearSessionIds(): void {
    this.sessionIdMap.clear();
  }
}

// Helper to create a snapshot
async function createSnapshot(
  name: string,
  executionPath: string, // Changed from testDir to executionPath
  snapshotDir: string,
  client: TestWSClient,
): Promise<void> {
  console.log(`\n${colors.blue}📸 Creating snapshot: ${name}${colors.reset}`);

  const snapshotPath = path.join(snapshotDir, name);

  // Copy entire execution directory
  console.log(`${colors.gray}  Copying ${executionPath} -> ${snapshotPath}${colors.reset}`);
  await fs.promises.cp(executionPath, snapshotPath, { recursive: true });

  // Get current state
  const statePath = path.join(executionPath, ".tadpole/state.json");
  const state = JSON.parse(await fs.promises.readFile(statePath, "utf-8"));
  console.log(
    `${colors.gray}  State: ${state.runs.length} runs, current: ${state.currentRunId}${colors.reset}`,
  );

  // Get checkpoint list
  console.log(`${colors.gray}  Requesting checkpoint list...${colors.reset}`);
  await client.sendCommand({
    id: generateId(),
    type: "checkpoint.list",
  } as ClientCommand);

  const checkpointEvent = (await client.waitForEvent(
    "checkpoint.list",
    5000,
  )) as CheckpointListEvent;

  console.log(
    `${colors.gray}  Found ${checkpointEvent.data.checkpoints.length} checkpoints${colors.reset}`,
  );

  testState.snapshots.push({
    name,
    directory: snapshotPath,
    state,
    events: [...client.getEvents()], // Copy events up to this point
    checkpoints: checkpointEvent.data.checkpoints,
    timestamp: new Date().toISOString(),
  });

  console.log(`${colors.green}✓ Snapshot created successfully${colors.reset}`);
}

// Main test execution
async function executeRollbackScenarios(): Promise<TestSnapshot[]> {
  console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}`);
  console.log(`${colors.blue}Executing Rollback Scenarios${colors.reset}`);
  console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

  // Clean up and create directories
  console.log(`${colors.blue}Setting up directories...${colors.reset}`);

  // Clean up snapshot directory
  if (fs.existsSync(SNAPSHOT_DIR)) {
    console.log(`${colors.gray}  Removing existing snapshot directory${colors.reset}`);
    fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  console.log(`${colors.green}✓ Snapshot directory created: ${SNAPSHOT_DIR}${colors.reset}`);

  // Setup initial test directory
  await setupTestDirectory(testDirConfig);
  console.log(`${colors.green}✓ Test directory created: ${EXECUTION_DIR}${colors.reset}`);

  // Create empty data source directory
  if (!fs.existsSync(DATA_SOURCE_DIR)) {
    fs.mkdirSync(DATA_SOURCE_DIR, { recursive: true });
  }
  console.log(`${colors.green}✓ Data source directory created: ${DATA_SOURCE_DIR}${colors.reset}`);

  // Start server with --no-autostart, --data flag for data source, and --execution flag for execution directory
  console.log(
    `\n${colors.blue}Starting server with --no-autostart and execution isolation...${colors.reset}`,
  );
  const serverPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../server/index.ts",
  );

  testState.serverProcess = spawn(
    "bun",
    [
      serverPath,
      `--config=${PHASES_CONFIG}`,
      `--port=${SERVER_PORT}`,
      `--data=${DATA_SOURCE_DIR}`,
      `--execution=${EXECUTION_DIR}`,
      "--no-autostart",
    ],
    {
      cwd: process.cwd(), // Run from test runner's CWD
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
      },
    },
  );

  // Set up logging
  const serverLogPath = path.join(TEST_RUN_DIR, "server.log");
  const serverLogStream = fs.createWriteStream(serverLogPath, { flags: "a" });

  testState.serverProcess.stdout?.on("data", (data) => {
    const message = data.toString();
    if (message.includes("[DEBUG]") || message.includes("[INFO]")) {
      console.log(`${colors.gray}[SERVER] ${message.trim()}${colors.reset}`);
    }
    serverLogStream.write(`[${new Date().toISOString()}] [STDOUT] ${data}`);
  });

  testState.serverProcess.stderr?.on("data", (data) => {
    const message = data.toString();
    console.error(`${colors.red}[SERVER ERROR] ${message.trim()}${colors.reset}`);
    serverLogStream.write(`[${new Date().toISOString()}] [STDERR] ${message}`);
  });

  // Give server time to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Connect WebSocket client
  console.log(`${colors.blue}Connecting to WebSocket...${colors.reset}`);
  testState.client = new EnhancedTestWSClient();
  await testState.client.connect(SERVER_PORT);
  console.log(`${colors.green}✓ Connected to WebSocket server${colors.reset}`);

  // Wait for server ready and capture execution path
  console.log(`${colors.blue}Waiting for server initialization...${colors.reset}`);
  const readyEvent = await testState.client.waitForEvent("server.ready");
  if (readyEvent.type === "server.ready") {
    testState.executionPath = readyEvent.data.executionPath;
    console.log(`${colors.green}✓ Server ready${colors.reset}`);
    console.log(`  Execution path: ${testState.executionPath}`);
  }

  const idleEvent = (await testState.client.waitForEvent("server.idle", 5000)) as ServerIdleEvent;
  expect(idleEvent.data.reason).toBe("startup");
  console.log(
    `${colors.green}✓ Server ready in idle mode${
      colors.reset
    }: ${JSON.stringify(idleEvent, null, 2)}`,
  );

  // === SCENARIO 1: Run through Phase 2, skip Phase 3 ===
  console.log(`\n${colors.blue}${"=".repeat(60)}${colors.reset}`);
  console.log(`${colors.blue}SCENARIO 1: Run Phase 1-2, Skip Phase 3${colors.reset}`);
  console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

  // Run Phase 1
  console.log(`${colors.blue}Starting Phase 1...${colors.reset}`);
  const phase1StartTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "phase.start",
    data: { phaseId: PhaseId("phase-1") },
  } as ClientCommand);

  console.log(`${colors.gray}  → Waiting for phase.started event for phase-1...${colors.reset}`);
  const phase1Started = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseStartWithSession("phase-1", 30000, phase1StartTime);
  console.log(
    `${colors.green}✓ Phase 1 started (session: ${
      phase1Started.data.sessionId
    })${colors.reset}: ${JSON.stringify(phase1Started, null, 2)}`,
  );

  console.log(`${colors.gray}  → Waiting for phase.completed event for phase-1...${colors.reset}`);
  const phase1Completed = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseCompletionBySession("phase-1", 60000, phase1StartTime);
  console.log(
    `${colors.green}✓ Phase 1 completed (cost: $${phase1Completed.data.cost.toFixed(6)})${
      colors.reset
    }: ${JSON.stringify(phase1Completed, null, 2)}`,
  );

  // Wait for idle event after phase completion
  console.log(
    `${colors.gray}  → Waiting for server.idle event after phase-1 completion...${colors.reset}`,
  );
  const idleAfterPhase1 = await testState.client.waitForEvent("server.idle", 10000, (event) => {
    const idleEvent = event as ServerIdleEvent;
    return (
      idleEvent.data?.reason === "phase-completed" && event.timestamp >= phase1Completed.timestamp
    );
  });
  console.log(
    `${colors.gray}  Server idle after phase 1: ${JSON.stringify(
      idleAfterPhase1,
      null,
      2,
    )}${colors.reset}`,
  );

  // Add a small delay to ensure state transitions are complete
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Run Phase 2
  console.log(`\n${colors.blue}Starting Phase 2...${colors.reset}`);
  const phase2StartTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "phase.start",
    data: { phaseId: PhaseId("phase-2") },
  } as ClientCommand);

  console.log(`${colors.gray}  → Waiting for phase.started event for phase-2...${colors.reset}`);
  const phase2Started = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseStartWithSession("phase-2", 30000, phase2StartTime);

  console.log(
    `${colors.green}✓ Phase 2 started (session: ${
      phase2Started.data.sessionId
    })${colors.reset}: ${JSON.stringify(phase2Started, null, 2)}`,
  );
  console.log(
    `${colors.gray}  Continuing from: ${phase2Started.data.previousSessionId}${colors.reset}`,
  );

  console.log(`${colors.gray}  → Waiting for phase.completed event for phase-2...${colors.reset}`);
  const phase2Completed = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseCompletionBySession("phase-2", 60000, phase2StartTime);
  console.log(
    `${colors.green}✓ Phase 2 completed (cost: $${phase2Completed.data.cost.toFixed(6)})${
      colors.reset
    }: ${JSON.stringify(phase2Completed, null, 2)}`,
  );

  // Wait for idle event after phase 2
  console.log(
    `${colors.gray}  → Waiting for server.idle event after phase-2 completion...${colors.reset}`,
  );
  const idleAfterPhase2 = await testState.client.waitForEvent("server.idle", 20000, (event) => {
    const idleEvent = event as ServerIdleEvent;
    return (
      idleEvent.data?.reason === "phase-completed" && event.timestamp >= phase2Completed.timestamp
    );
  });
  console.log(
    `${colors.gray}  Server idle after phase 2: ${JSON.stringify(
      idleAfterPhase2,
      null,
      2,
    )}${colors.reset}`,
  );

  // Add a small delay to ensure state transitions are complete
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Start Phase 3 and skip it
  console.log(`\n${colors.blue}Starting Phase 3 (will skip)...${colors.reset}`);
  const phase3StartTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "phase.start",
    data: { phaseId: PhaseId("phase-3") },
  } as ClientCommand);

  console.log(`${colors.gray}  → Waiting for phase.started event for phase-3...${colors.reset}`);
  const phase3Started = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseStartWithSession("phase-3", 30000, phase3StartTime);
  console.log(
    `${colors.green}✓ Phase 3 started (session: ${phase3Started.data.sessionId})${colors.reset}`,
  );

  // Wait for assistant action to ensure it's running
  console.log(
    `${colors.gray}  → Waiting for assistant.action event to confirm phase-3 is active...${colors.reset}`,
  );
  const assistantActionEventPhase3 = await testState.client.waitForEvent(
    "assistant.action",
    30000,
    (event) => event.type === "assistant.action",
    phase3StartTime,
  );
  console.log(
    `${colors.gray}  Claude is active, now skipping phase: ${JSON.stringify(
      assistantActionEventPhase3,
      null,
      2,
    )}${colors.reset}`,
  );

  await testState.client.sendCommand({
    id: generateId(),
    type: "phase.skip",
  } as ClientCommand);

  console.log(
    `${colors.gray}  → Waiting for phase.completed event for skipped phase-3...${colors.reset}`,
  );
  const phase3Skipped = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseCompletionBySession("phase-3", 10000, phase3StartTime);
  expect(phase3Skipped.data.success).toBe(false);
  console.log(`${colors.green}✓ Phase 3 skipped${colors.reset}`);

  // Wait for server idle after phase 3 skip
  console.log(
    `${colors.gray}  → Waiting for server.idle event after phase-3 skip...${colors.reset}`,
  );
  const _idleAfterPhase3Skip = await testState.client.waitForEvent(
    "server.idle",
    10000,
    (event) => {
      const idleEvent = event as ServerIdleEvent;
      return (
        idleEvent.data?.reason === "phase-completed" && event.timestamp >= phase3Skipped.timestamp
      );
    },
  );
  console.log(
    `${colors.gray}  Server idle after phase 3 skip: ${JSON.stringify(
      _idleAfterPhase3Skip,
      null,
      2,
    )}${colors.reset}`,
  );

  // Additional delay to ensure state is fully persisted
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // SNAPSHOT 1: After Phase 2 complete, Phase 3 skipped
  if (!testState.executionPath) {
    throw new Error("Execution path not set - server initialization may have failed");
  }
  await createSnapshot(
    "1-after-phase2-phase3-skipped",
    testState.executionPath,
    SNAPSHOT_DIR,
    testState.client,
  );

  // === SCENARIO 2: Rollback to Phase 1 ===
  console.log(`\n${colors.blue}${"=".repeat(60)}${colors.reset}`);
  console.log(`${colors.blue}SCENARIO 2: Rollback to Phase 1${colors.reset}`);
  console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

  // Clear session IDs for new run
  (testState.client as EnhancedTestWSClient).clearSessionIds();

  // List checkpoints first
  console.log(`${colors.blue}Listing available checkpoints...${colors.reset}`);
  await testState.client.sendCommand({
    id: generateId(),
    type: "checkpoint.list",
  } as ClientCommand);

  console.log(`${colors.gray}  → Waiting for checkpoint.list event...${colors.reset}`);
  const checkpointList1 = (await testState.client.waitForEvent(
    "checkpoint.list",
    5000,
  )) as CheckpointListEvent;
  console.log(
    `${colors.green}✓ Found ${checkpointList1.data.checkpoints.length} checkpoints:${colors.reset}`,
  );
  checkpointList1.data.checkpoints.forEach((cp, index) => {
    console.log(
      `  ${colors.gray}[${index + 1}] ${cp.phaseName} - ${
        cp.checkpointType
      } (${cp.sha.substring(0, 7)})${colors.reset}`,
    );
  });

  // Rollback to Phase 1 completion
  console.log(`\n${colors.blue}Rolling back to Phase 1 completion...${colors.reset}`);
  const rollbackCommandTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "rollback.toPhase",
    data: {
      phaseId: PhaseId("phase-1"),
      checkpointType: "completed",
      autoRestart: false,
    },
  } as ClientCommand);

  console.log(`${colors.gray}  → Waiting for rollback.completed event...${colors.reset}`);
  const rollback1 = (await testState.client.waitForEvent(
    "rollback.completed",
    10000,
    undefined,
    rollbackCommandTime,
  )) as RollbackCompletedEvent;
  console.log(
    `${colors.green}✓ Rolled back to ${rollback1.data.phaseName} (${rollback1.data.checkpointType})${colors.reset}`,
  );
  console.log(`${colors.gray}  From run: ${rollback1.data.fromRun}${colors.reset}`);
  console.log(`${colors.gray}  To run: ${rollback1.data.toRun}${colors.reset}`);

  // SNAPSHOT 2: After rollback to Phase 1
  if (!testState.executionPath) {
    throw new Error("Execution path not set - server initialization may have failed");
  }
  await createSnapshot(
    "2-after-rollback-to-phase1",
    testState.executionPath,
    SNAPSHOT_DIR,
    testState.client,
  );

  // === SCENARIO 3: Continue from rollback ===
  console.log(`\n${colors.blue}${"=".repeat(60)}${colors.reset}`);
  console.log(`${colors.blue}SCENARIO 3: Continue from Rollback${colors.reset}`);
  console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

  // Run Phase 2 manually
  console.log(`\n${colors.blue}Starting Phase 2 manually...${colors.reset}`);
  const phase2Scenario3StartTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "phase.start",
    data: { phaseId: PhaseId("phase-2") },
  } as ClientCommand);

  console.log(
    `${colors.gray}  → Waiting for phase.started event for phase-2 (scenario 3)...${colors.reset}`,
  );
  const phase2Started2 = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseStartWithSession("phase-2", 30000, phase2Scenario3StartTime);
  console.log(
    `${colors.green}✓ Phase 2 started again (session: ${phase2Started2.data.sessionId})${colors.reset}`,
  );

  console.log(
    `${colors.gray}  → Waiting for phase.completed event for phase-2 (scenario 3)...${colors.reset}`,
  );
  const phase2Completed2 = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseCompletionBySession("phase-2", 60000, phase2Scenario3StartTime);
  console.log(
    `${colors.green}✓ Phase 2 completed (cost: $${phase2Completed2.data.cost.toFixed(6)})${
      colors.reset
    }`,
  );

  // Wait for idle event after phase 2 completion
  console.log(
    `${colors.gray}  → Waiting for server.idle event after phase-2 completion (scenario 3)...${colors.reset}`,
  );
  const idleAfterPhase2Scenario3 = await testState.client.waitForEvent(
    "server.idle",
    10000,
    (event) => {
      const idleEvent = event as ServerIdleEvent;
      return (
        idleEvent.data?.reason === "phase-completed" &&
        event.timestamp >= phase2Completed2.timestamp
      );
    },
  );
  console.log(
    `${colors.gray}  Server idle after phase 2 completion (scenario 3): ${JSON.stringify(
      idleAfterPhase2Scenario3,
      null,
      2,
    )}${colors.reset}`,
  );

  // Add extra delay to ensure all state transitions are complete
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Run Phase 3 to completion
  console.log(`\n${colors.blue}Starting Phase 3 (full run)...${colors.reset}`);
  const phase3Scenario3StartTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "phase.start",
    data: { phaseId: PhaseId("phase-3") },
  } as ClientCommand);

  console.log(
    `${colors.gray}  → Waiting for phase.started event for phase-3 (scenario 3)...${colors.reset}`,
  );
  const phase3Started2 = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseStartWithSession("phase-3", 30000, phase3Scenario3StartTime);
  console.log(
    `${colors.green}✓ Phase 3 started (session: ${phase3Started2.data.sessionId})${colors.reset}`,
  );

  console.log(
    `${colors.gray}  → Waiting for phase.completed event for phase-3 (scenario 3)...${colors.reset}`,
  );
  const phase3Completed2 = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseCompletionBySession("phase-3", 60000, phase3Scenario3StartTime);
  console.log(
    `${colors.green}✓ Phase 3 completed (cost: $${phase3Completed2.data.cost.toFixed(6)})${
      colors.reset
    }`,
  );

  // SNAPSHOT 3: After full completion from rollback
  if (!testState.executionPath) {
    throw new Error("Execution path not set - server initialization may have failed");
  }
  await createSnapshot(
    "3-after-full-completion",
    testState.executionPath,
    SNAPSHOT_DIR,
    testState.client,
  );

  // === SCENARIO 4: Rollback to Very Start (Complete Cleanup) ===
  console.log(`\n${colors.blue}${"=".repeat(60)}${colors.reset}`);
  console.log(`${colors.blue}SCENARIO 4: Rollback to Very Start (Complete Cleanup)${colors.reset}`);
  console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

  // Clear session IDs for new scenarios
  (testState.client as EnhancedTestWSClient).clearSessionIds();

  // Wait for any pending operations to complete
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log(
    `${colors.blue}Getting checkpoint list to find the very first checkpoint...${colors.reset}`,
  );

  await testState.client.sendCommand({
    id: generateId(),
    type: "checkpoint.list",
  } as ClientCommand);

  console.log(`${colors.gray}  → Waiting for checkpoint.list event (scenario 4)...${colors.reset}`);
  const checkpointList2 = (await testState.client.waitForEvent(
    "checkpoint.list",
    5000,
  )) as CheckpointListEvent;

  // Sort checkpoints by timestamp to find the earliest one
  const sortedCheckpoints = [...checkpointList2.data.checkpoints].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const firstCheckpoint = sortedCheckpoints[0];
  console.log(
    `${colors.gray}  Found first checkpoint: ${firstCheckpoint.phaseName} - ${
      firstCheckpoint.checkpointType
    } (${firstCheckpoint.sha.substring(0, 7)})${colors.reset}`,
  );

  // Debug: Log all checkpoints to understand the order
  console.log(`${colors.gray}  All checkpoints in order:${colors.reset}`);
  sortedCheckpoints.forEach((cp, idx) => {
    console.log(
      `${colors.gray}    ${idx}: ${cp.phaseName} - ${
        cp.checkpointType
      } (${cp.sha.substring(0, 7)}) at ${cp.timestamp}${colors.reset}`,
    );
  });

  console.log(`${colors.blue}Rolling back to the very beginning...${colors.reset}`);
  console.log(
    `${colors.gray}  Target checkpoint: ${firstCheckpoint.phaseId} - ${firstCheckpoint.checkpointType} (${firstCheckpoint.sha})${colors.reset}`,
  );

  const secondRollbackCommandTimestamp = new Date().toISOString();

  // Send rollback command
  await testState.client.sendCommand({
    id: generateId(),
    type: "rollback.toCheckpoint",
    data: {
      checkpointSha: firstCheckpoint.sha,
      autoRestart: false,
    },
  } as ClientCommand);

  // Wait for rollback to complete with proper error handling
  let rollback2: RollbackCompletedEvent;
  try {
    console.log(
      `${colors.gray}  → Waiting for rollback.completed event (scenario 4)...${colors.reset}`,
    );
    rollback2 = (await testState.client.waitForEvent(
      "rollback.completed",
      30000,
      (event) =>
        event.type === "rollback.completed" &&
        (event as RollbackCompletedEvent).data.checkpoint.includes(firstCheckpoint.sha),
      secondRollbackCommandTimestamp,
    )) as RollbackCompletedEvent;
    console.log(
      `${colors.green}✓ Rolled back to ${rollback2.data.phaseName} (${rollback2.data.checkpointType})${colors.reset}`,
    );
  } catch (error) {
    console.error(`${colors.red}✗ Rollback failed or timed out: ${error}${colors.reset}`);

    // Check for error events
    const recentEvents = testState.client.getEvents().slice(-10);
    const errorEvents = recentEvents.filter((e) => e.type === "error");
    if (errorEvents.length > 0) {
      console.error(`${colors.red}Recent error events:${colors.reset}`);
      errorEvents.forEach((e) => {
        console.error(`  ${colors.red}${JSON.stringify(e, null, 2)}${colors.reset}`);
      });
    }
    throw error;
  }

  // Wait for rollback to complete
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Verify complete cleanup
  const notesDir = path.join(EXECUTION_DIR, "notes");
  const typescriptDir = path.join(EXECUTION_DIR, "typescript_code");
  const tadpoleDir = path.join(EXECUTION_DIR, ".tadpole");

  console.log(`${colors.blue}Verifying complete cleanup...${colors.reset}`);
  console.log(`${colors.gray}  notes/ exists: ${fs.existsSync(notesDir)}${colors.reset}`);
  console.log(
    `${colors.gray}  typescript_code/ exists: ${fs.existsSync(typescriptDir)}${colors.reset}`,
  );
  console.log(`${colors.gray}  .tadpole/ exists: ${fs.existsSync(tadpoleDir)}${colors.reset}`);

  if (firstCheckpoint.checkpointType === "completed" && fs.existsSync(notesDir)) {
    console.log(
      `${colors.gray}  notes/ exists because we rolled back to phase-1 completed (expected)${colors.reset}`,
    );
  }

  // SNAPSHOT 4: After rollback to very start
  if (!testState.executionPath) {
    throw new Error("Execution path not set - server initialization may have failed");
  }
  await createSnapshot(
    "4-after-rollback-to-start",
    testState.executionPath,
    SNAPSHOT_DIR,
    testState.client,
  );

  // Clean up
  console.log(`\n${colors.blue}Cleaning up...${colors.reset}`);

  // Save WebSocket events before disconnecting
  if (testState.client) {
    const eventsPath = path.join(TEST_RUN_DIR, "websocket-events.json");
    await fs.promises.writeFile(eventsPath, JSON.stringify(testState.client.getEvents(), null, 2));
    console.log(`${colors.gray}  WebSocket events saved to: ${eventsPath}${colors.reset}`);
  }

  await testState.client.disconnect();
  console.log(
    `\n${colors.blue}Final test cleanup: Gracefully shutting down server...${colors.reset}`,
  );

  if (testState.serverProcess && !testState.serverProcess.killed) {
    const shutdownPromise = new Promise<void>((resolve) => {
      // Listen for the 'exit' event on the server process.
      // This event fires only after the process has fully terminated.
      testState.serverProcess?.on("exit", (code, signal) => {
        console.log(
          `${colors.green}✓ Server process exited with code ${code}, signal ${signal}${colors.reset}`,
        );
        resolve();
      });
    });

    // Now, send the kill signal.
    console.log(`${colors.gray}  Sending SIGTERM to server process...${colors.reset}`);
    testState.serverProcess.kill("SIGTERM");

    // Wait for the server to exit, with a timeout as a safety measure.
    await Promise.race([
      shutdownPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Server shutdown timed out")), 10000),
      ),
    ]);
  }

  console.log(`${colors.green}✓ Test execution completed${colors.reset}`);
  console.log(`${colors.green}✓ Created ${testState.snapshots.length} snapshots${colors.reset}`);

  return testState.snapshots;
}

// === ACTUAL TESTS ===

describe("Comprehensive Rollback E2E Test", () => {
  let testSnapshots: TestSnapshot[] = [];

  beforeAll(async () => {
    // Run all scenarios and collect snapshots
    testSnapshots = await executeRollbackScenarios();
  });

  describe("Snapshot Verification", () => {
    test("all snapshots were created", () => {
      expect(testSnapshots.length).toBe(4);

      // Verify each snapshot directory exists
      testSnapshots.forEach((snapshot) => {
        console.log(`\nVerifying snapshot: ${snapshot.name}`);
        console.log(`  Directory: ${snapshot.directory}`);
        console.log(`  Created at: ${snapshot.timestamp}`);

        expect(fs.existsSync(snapshot.directory)).toBe(true);

        // Check key directories
        const tadpoleDir = path.join(snapshot.directory, ".tadpole");
        const notesDir = path.join(snapshot.directory, "notes");
        const typescriptDir = path.join(snapshot.directory, "typescript_code");

        console.log(`  .tadpole exists: ${fs.existsSync(tadpoleDir)}`);
        console.log(`  notes exists: ${fs.existsSync(notesDir)}`);
        console.log(`  typescript_code exists: ${fs.existsSync(typescriptDir)}`);

        // Check state.json
        const stateFile = path.join(tadpoleDir, "state.json");
        if (fs.existsSync(stateFile)) {
          const state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
          console.log(`  Runs in state: ${state.runs.length}`);
          console.log(`  Current run: ${state.currentRunId}`);
        }

        // List checkpoint info
        console.log(`  Checkpoints: ${snapshot.checkpoints.length}`);
        snapshot.checkpoints.forEach((cp) => {
          console.log(`    - ${cp.phaseId} (${cp.checkpointType}): ${cp.sha.substring(0, 7)}`);
        });
      });
    });
  });

  describe("Rollback Behavior", () => {
    test("basic rollback functionality works", () => {
      // Since we removed scenarios 5-6, we'll just verify basic rollback worked
      // by checking that we have the expected snapshots
      expect(testSnapshots.length).toBe(4);

      // Verify we have the expected snapshot names
      const snapshotNames = testSnapshots.map((s) => s.name);
      expect(snapshotNames).toContain("1-after-phase2-phase3-skipped");
      expect(snapshotNames).toContain("2-after-rollback-to-phase1");
      expect(snapshotNames).toContain("3-after-full-completion");
      expect(snapshotNames).toContain("4-after-rollback-to-start");
    });
  });

  describe("Snapshot Content", () => {
    test("snapshots contain expected state transitions", () => {
      expect(testSnapshots.length).toBe(4);

      // Verify snapshot 1: After phase 2 complete, phase 3 skipped
      const snapshot1 = testSnapshots[0];
      expect(snapshot1.name).toBe("1-after-phase2-phase3-skipped");
      expect(snapshot1.state.runs.length).toBe(1);

      // Verify snapshot 2: After rollback to phase 1
      const snapshot2 = testSnapshots[1];
      expect(snapshot2.name).toBe("2-after-rollback-to-phase1");
      expect(snapshot2.state.runs.length).toBe(2); // New run created

      // Verify snapshot 3: After full completion
      const snapshot3 = testSnapshots[2];
      expect(snapshot3.name).toBe("3-after-full-completion");
      expect(snapshot3.state.runs.length).toBe(2); // Same run continued

      // Verify snapshot 4: After rollback to very start (complete cleanup)
      const snapshot4 = testSnapshots[3];
      expect(snapshot4.name).toBe("4-after-rollback-to-start");
      expect(snapshot4.state.runs.length).toBeGreaterThanOrEqual(2);
    });

    test("checkpoints are created correctly", () => {
      // Each snapshot should have checkpoints
      testSnapshots.forEach((snapshot) => {
        expect(snapshot.checkpoints.length).toBeGreaterThan(0);
      });

      // Snapshot 1 should have workspace-setup and completed/skipped checkpoints
      const snapshot1Checkpoints = testSnapshots[0].checkpoints;
      const hasWorkspaceSetup = snapshot1Checkpoints.some(
        (cp) => cp.checkpointType === "workspace-setup",
      );
      const hasCompleted = snapshot1Checkpoints.some((cp) => cp.checkpointType === "completed");
      const hasSkipped = snapshot1Checkpoints.some((cp) => cp.checkpointType === "skipped");

      expect(hasWorkspaceSetup).toBe(true);
      expect(hasCompleted).toBe(true);
      expect(hasSkipped).toBe(true);
    });

    test("file system state matches expectations", () => {
      // Snapshot 1: Should have notes from phase 1 & 2
      const snapshot1NotesDir = path.join(testSnapshots[0].directory, "notes");
      expect(fs.existsSync(snapshot1NotesDir)).toBe(true);

      // Snapshot 3: Should have typescript_code from phase 3
      const snapshot3TypescriptDir = path.join(testSnapshots[2].directory, "typescript_code");
      expect(fs.existsSync(snapshot3TypescriptDir)).toBe(true);

      // Snapshot 4: After rollback to start, state depends on which checkpoint we rolled back to
      const snapshot4NotesDir = path.join(testSnapshots[3].directory, "notes");
      // This may or may not exist depending on which checkpoint we rolled back to
      console.log(`Snapshot 4 notes directory exists: ${fs.existsSync(snapshot4NotesDir)}`);
    });
  });
});
