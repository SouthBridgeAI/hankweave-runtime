#!/usr/bin/env bun
/**
 * Comprehensive Rollback E2E Test Suite
 *
 * This test file combines:
 * 1. Server execution and snapshot creation (from rollback-improved-1)
 * 2. Deep snapshot analysis (from rollback-improved-2)
 * 3. All unique tests from previous versions
 *
 * Test Structure:
 * - Executes 4 rollback scenarios with real server
 * - Creates snapshots at key points
 * - Performs 7 priority levels of analysis tests
 * - Validates data integrity, state consistency, and rollback accuracy
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { type ChildProcess, execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PhaseId, RunId } from "../../server/types/branded-types";
import type { Run, TadpoleState } from "../../server/types/state-types";
import type {
  AssistantActionEvent,
  CheckpointListEvent,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  RollbackCompletedEvent,
  RollbackProgressEvent,
  RollbackStartedEvent,
  ServerEvent,
  ServerIdleEvent,
} from "../../server/types/types";
import { generateId } from "../../server/utils.js";
import { getGitCommits, getGitShas } from "../utils/git-test-helpers.js";
import { calculateCostFromUsage } from "../utils/test-data-helpers.js";
import {
  colors,
  generateTestTimestamp,
  setupTestDirectory,
  type TestDirectoryConfig,
  TestWSClient,
} from "../utils/test-helpers.js";

// ============================================================================
// TEST CONFIGURATION
// ============================================================================

const TEST_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const EXECUTION_DIR = path.join(TEST_ROOT, "tests/test-area/rollback-comprehensive");
const DATA_SOURCE_FILE = path.join(TEST_ROOT, "tests/config/poem_guides.txt");
const SNAPSHOT_DIR = path.join(TEST_ROOT, "tests/test-area/rollback-comprehensive-snapshots");
const TEST_RESULTS_DIR = path.join(TEST_ROOT, "tests/test-results");
const SERVER_PORT = parseInt(process.env.tadpole_TEST_PORT || "7787", 10);
const PHASES_CONFIG = path.join(TEST_ROOT, "tests/config/test-phases.config.json");

const TEST_TIMESTAMP = generateTestTimestamp();
const TEST_RUN_DIR = path.join(TEST_RESULTS_DIR, `rollback-comprehensive-${TEST_TIMESTAMP}`);

const testDirConfig: TestDirectoryConfig = {
  testDir: EXECUTION_DIR,
  testResultsDir: TEST_RESULTS_DIR,
  testRunDir: TEST_RUN_DIR,
};

// ============================================================================
// INTERFACES
// ============================================================================

interface TestSnapshot {
  name: string;
  directory: string;
  state: TadpoleState;
  events: ServerEvent[];
  checkpoints: CheckpointListEvent["data"]["checkpoints"];
  timestamp: string;
  git?: {
    branches: string[];
    allShas: Set<string>;
    commits: Array<{
      sha: string;
      message: string;
      timestamp: string;
    }>;
  };
}

interface TestState {
  serverProcess: ChildProcess | null;
  client: TestWSClient | null;
  snapshots: TestSnapshot[];
  executionPath?: string;
}

// ============================================================================
// HELPER CLASSES
// ============================================================================

/**
 * Enhanced WebSocket client with session ID tracking
 */
class EnhancedTestWSClient extends TestWSClient {
  private sessionIdMap = new Map<string, string>();

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
        return completedEvent.data?.phaseId === phaseId;
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

// ============================================================================
// HELPER FUNCTIONS - File System Operations
// ============================================================================

/**
 * Recursively gets all file paths in a directory
 */
async function getFilePaths(dir: string): Promise<string[]> {
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    dirents.map((dirent) => {
      const res = path.resolve(dir, dirent.name);
      return dirent.isDirectory() ? getFilePaths(res) : res;
    }),
  );
  return Array.prototype.concat(...files);
}

/**
 * Computes a hash for a directory's contents
 * Excludes .tadpole, data, and read_only_data_source directories
 */
async function hashDirectory(dir: string): Promise<string> {
  if (!fs.existsSync(dir)) {
    return "directory-does-not-exist";
  }

  const allFilePaths = (await getFilePaths(dir)).sort();
  const filePaths = allFilePaths.filter((filePath) => {
    const relativePath = path.relative(dir, filePath);
    return (
      !relativePath.startsWith(`.tadpole${path.sep}`) &&
      !relativePath.startsWith(".tadpole/") &&
      !relativePath.startsWith(`data${path.sep}`) &&
      !relativePath.startsWith("data/") &&
      relativePath !== "data" &&
      !relativePath.startsWith(`read_only_data_source${path.sep}`) &&
      !relativePath.startsWith("read_only_data_source/") &&
      relativePath !== "read_only_data_source"
    );
  });

  const hash = createHash("sha256");
  for (const filePath of filePaths) {
    const relativePath = path.relative(dir, filePath);
    hash.update(relativePath.replace(/\\/g, "/"));
    const data = await fs.promises.readFile(filePath);
    hash.update(data);
  }

  return hash.digest("hex");
}

// ============================================================================
// HELPER FUNCTIONS - Cost & State Analysis
// ============================================================================

/**
 * Reconstruct phase states from event stream
 */
function reconstructPhaseStatesFromEvents(events: ServerEvent[]): Map<
  string,
  {
    phaseId: string;
    status: string;
    sessionId?: string;
    previousSessionId?: string;
    cost: number;
    assistantMessageCount: number;
  }
> {
  const phases = new Map();

  for (const event of events) {
    if (event.type === "phase.started") {
      const data = event.data as PhaseStartedEvent["data"];
      phases.set(data.phaseId, {
        phaseId: data.phaseId,
        status: "started",
        sessionId: data.sessionId,
        previousSessionId: data.previousSessionId,
        cost: 0,
        assistantMessageCount: 0,
      });
    } else if (event.type === "phase.completed") {
      const data = event.data as PhaseCompletedEvent["data"];
      const phase = phases.get(data.phaseId);
      if (phase) {
        phase.status = data.success ? "completed" : "failed";
        phase.cost = data.cost;
      }
    } else if (event.type === "assistant.action") {
      const data = event.data as AssistantActionEvent["data"];
      const phase = phases.get(data.phaseId);
      if (phase && data.action === "message") {
        phase.assistantMessageCount++;
      }
    }
  }

  return phases;
}

/**
 * Check if a timestamp is valid ISO 8601
 */
function isValidISO8601(timestamp: string): boolean {
  const date = new Date(timestamp);
  return date.toISOString() === timestamp;
}

// ============================================================================
// SNAPSHOT CREATION
// ============================================================================

/**
 * Create a snapshot of the current execution state
 */
async function createSnapshot(
  name: string,
  executionPath: string,
  snapshotDir: string,
  client: TestWSClient,
  testState: TestState,
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
  });

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
    events: [...client.getEvents()],
    checkpoints: checkpointEvent.data.checkpoints,
    timestamp: new Date().toISOString(),
  });

  console.log(`${colors.green}✓ Snapshot created successfully${colors.reset}`);
}

// ============================================================================
// MAIN EXECUTION FLOW
// ============================================================================

/**
 * Execute all rollback scenarios and create snapshots
 */
async function executeRollbackScenarios(testState: TestState): Promise<TestSnapshot[]> {
  console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}`);
  console.log(`${colors.blue}Executing Comprehensive Rollback Scenarios${colors.reset}`);
  console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

  // Setup directories
  console.log(`${colors.blue}Setting up directories...${colors.reset}`);

  if (fs.existsSync(SNAPSHOT_DIR)) {
    console.log(`${colors.gray}  Removing existing snapshot directory${colors.reset}`);
    fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  console.log(`${colors.green}✓ Snapshot directory created: ${SNAPSHOT_DIR}${colors.reset}`);

  await setupTestDirectory(testDirConfig);
  console.log(`${colors.green}✓ Test directory created: ${EXECUTION_DIR}${colors.reset}`);

  if (!fs.existsSync(DATA_SOURCE_FILE)) {
    throw new Error(`Data source file not found: ${DATA_SOURCE_FILE}`);
  }
  console.log(`${colors.green}✓ Data source file exists: ${DATA_SOURCE_FILE}${colors.reset}`);

  // Start server
  console.log(`\n${colors.blue}Starting server with execution isolation...${colors.reset}`);
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
      `--data=${DATA_SOURCE_FILE}`,
      `--execution=${EXECUTION_DIR}`,
      "--no-autostart",
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
      },
    },
  );

  // Setup logging
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

  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Connect WebSocket client
  console.log(`${colors.blue}Connecting to WebSocket...${colors.reset}`);
  testState.client = new EnhancedTestWSClient();
  await testState.client.connect(SERVER_PORT);
  console.log(`${colors.green}✓ Connected to WebSocket server${colors.reset}`);

  // Wait for server ready
  console.log(`${colors.blue}Waiting for server initialization...${colors.reset}`);
  const readyEvent = await testState.client.waitForEvent("server.ready");
  if (readyEvent.type === "server.ready") {
    testState.executionPath = readyEvent.data.executionPath;
    console.log(`${colors.green}✓ Server ready${colors.reset}`);
    console.log(`  Execution path: ${testState.executionPath}`);
  }

  const idleEvent = (await testState.client.waitForEvent("server.idle", 5000)) as ServerIdleEvent;
  expect(idleEvent.data.reason).toBe("startup");
  console.log(`${colors.green}✓ Server ready in idle mode${colors.reset}`);

  // === SCENARIO 1: Run Phase 1-2, Skip Phase 3 ===
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
  });

  const phase1Started = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseStartWithSession("phase-1", 30000, phase1StartTime);
  console.log(
    `${colors.green}✓ Phase 1 started (session: ${phase1Started.data.sessionId})${colors.reset}`,
  );

  const phase1Completed = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseCompletionBySession("phase-1", 60000, phase1StartTime);
  console.log(
    `${colors.green}✓ Phase 1 completed (cost: $${phase1Completed.data.cost.toFixed(6)})${colors.reset}`,
  );

  await testState.client.waitForEvent("server.idle", 10000, (event) => {
    const idleEvent = event as ServerIdleEvent;
    return (
      idleEvent.data?.reason === "phase-completed" && event.timestamp >= phase1Completed.timestamp
    );
  });

  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Run Phase 2
  console.log(`\n${colors.blue}Starting Phase 2...${colors.reset}`);
  const phase2StartTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "phase.start",
    data: { phaseId: PhaseId("phase-2") },
  });

  const phase2Started = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseStartWithSession("phase-2", 30000, phase2StartTime);
  console.log(
    `${colors.green}✓ Phase 2 started (session: ${phase2Started.data.sessionId})${colors.reset}`,
  );

  const phase2Completed = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseCompletionBySession("phase-2", 60000, phase2StartTime);
  console.log(
    `${colors.green}✓ Phase 2 completed (cost: $${phase2Completed.data.cost.toFixed(6)})${colors.reset}`,
  );

  await testState.client.waitForEvent("server.idle", 20000, (event) => {
    const idleEvent = event as ServerIdleEvent;
    return (
      idleEvent.data?.reason === "phase-completed" && event.timestamp >= phase2Completed.timestamp
    );
  });

  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Start Phase 3 and skip it
  console.log(`\n${colors.blue}Starting Phase 3 (will skip)...${colors.reset}`);
  const phase3StartTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "phase.start",
    data: { phaseId: PhaseId("phase-3") },
  });

  const phase3Started = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseStartWithSession("phase-3", 30000, phase3StartTime);
  console.log(
    `${colors.green}✓ Phase 3 started (session: ${phase3Started.data.sessionId})${colors.reset}`,
  );

  await testState.client.waitForEvent(
    "assistant.action",
    30000,
    (event) => event.type === "assistant.action",
    phase3StartTime,
  );
  console.log(`${colors.gray}  Claude is active, now skipping phase${colors.reset}`);

  await testState.client.sendCommand({
    id: generateId(),
    type: "phase.skip",
  });

  const phase3Skipped = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseCompletionBySession("phase-3", 10000, phase3StartTime);
  expect(phase3Skipped.data.success).toBe(false);
  console.log(`${colors.green}✓ Phase 3 skipped${colors.reset}`);

  await testState.client.waitForEvent("server.idle", 10000, (event) => {
    const idleEvent = event as ServerIdleEvent;
    return (
      idleEvent.data?.reason === "phase-completed" && event.timestamp >= phase3Skipped.timestamp
    );
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));

  // SNAPSHOT 1
  if (!testState.executionPath) {
    throw new Error("Execution path not set");
  }
  await createSnapshot(
    "1-after-phase2-phase3-skipped",
    testState.executionPath,
    SNAPSHOT_DIR,
    testState.client,
    testState,
  );

  // === SCENARIO 2: Rollback to Phase 1 ===
  console.log(`\n${colors.blue}${"=".repeat(60)}${colors.reset}`);
  console.log(`${colors.blue}SCENARIO 2: Rollback to Phase 1${colors.reset}`);
  console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

  (testState.client as EnhancedTestWSClient).clearSessionIds();

  console.log(`${colors.blue}Listing available checkpoints...${colors.reset}`);
  await testState.client.sendCommand({
    id: generateId(),
    type: "checkpoint.list",
  });

  const checkpointList1 = (await testState.client.waitForEvent(
    "checkpoint.list",
    5000,
  )) as CheckpointListEvent;
  console.log(
    `${colors.green}✓ Found ${checkpointList1.data.checkpoints.length} checkpoints${colors.reset}`,
  );

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
  });

  const rollback1 = (await testState.client.waitForEvent(
    "rollback.completed",
    10000,
    undefined,
    rollbackCommandTime,
  )) as RollbackCompletedEvent;
  console.log(
    `${colors.green}✓ Rolled back to ${rollback1.data.phaseName} (${rollback1.data.checkpointType})${colors.reset}`,
  );

  // SNAPSHOT 2
  await createSnapshot(
    "2-after-rollback-to-phase1",
    testState.executionPath,
    SNAPSHOT_DIR,
    testState.client,
    testState,
  );

  // === SCENARIO 3: Continue from rollback ===
  console.log(`\n${colors.blue}${"=".repeat(60)}${colors.reset}`);
  console.log(`${colors.blue}SCENARIO 3: Continue from Rollback${colors.reset}`);
  console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

  console.log(`\n${colors.blue}Starting Phase 2 manually...${colors.reset}`);
  const phase2Scenario3StartTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "phase.start",
    data: { phaseId: PhaseId("phase-2") },
  });

  const phase2Started2 = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseStartWithSession("phase-2", 30000, phase2Scenario3StartTime);
  console.log(
    `${colors.green}✓ Phase 2 started again (session: ${phase2Started2.data.sessionId})${colors.reset}`,
  );

  const phase2Completed2 = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseCompletionBySession("phase-2", 60000, phase2Scenario3StartTime);
  console.log(
    `${colors.green}✓ Phase 2 completed (cost: $${phase2Completed2.data.cost.toFixed(6)})${colors.reset}`,
  );

  await testState.client.waitForEvent("server.idle", 10000, (event) => {
    const idleEvent = event as ServerIdleEvent;
    return (
      idleEvent.data?.reason === "phase-completed" && event.timestamp >= phase2Completed2.timestamp
    );
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Run Phase 3 to completion
  console.log(`\n${colors.blue}Starting Phase 3 (full run)...${colors.reset}`);
  const phase3Scenario3StartTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "phase.start",
    data: { phaseId: PhaseId("phase-3") },
  });

  const phase3Started2 = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseStartWithSession("phase-3", 30000, phase3Scenario3StartTime);
  console.log(
    `${colors.green}✓ Phase 3 started (session: ${phase3Started2.data.sessionId})${colors.reset}`,
  );

  const phase3Completed2 = await (
    testState.client as EnhancedTestWSClient
  ).waitForPhaseCompletionBySession("phase-3", 60000, phase3Scenario3StartTime);
  console.log(
    `${colors.green}✓ Phase 3 completed (cost: $${phase3Completed2.data.cost.toFixed(6)})${colors.reset}`,
  );

  // SNAPSHOT 3
  await createSnapshot(
    "3-after-full-completion",
    testState.executionPath,
    SNAPSHOT_DIR,
    testState.client,
    testState,
  );

  // === SCENARIO 4: Rollback to Very Start ===
  console.log(`\n${colors.blue}${"=".repeat(60)}${colors.reset}`);
  console.log(`${colors.blue}SCENARIO 4: Rollback to Very Start${colors.reset}`);
  console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

  (testState.client as EnhancedTestWSClient).clearSessionIds();
  await new Promise((resolve) => setTimeout(resolve, 1000));

  console.log(`${colors.blue}Getting checkpoint list...${colors.reset}`);
  await testState.client.sendCommand({
    id: generateId(),
    type: "checkpoint.list",
  });

  const checkpointList2 = (await testState.client.waitForEvent(
    "checkpoint.list",
    5000,
  )) as CheckpointListEvent;

  const sortedCheckpoints = [...checkpointList2.data.checkpoints].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const firstCheckpoint = sortedCheckpoints[0];
  console.log(
    `${colors.gray}  Found first checkpoint: ${firstCheckpoint.phaseName} - ${firstCheckpoint.checkpointType}${colors.reset}`,
  );

  console.log(`${colors.blue}Rolling back to the very beginning...${colors.reset}`);
  const secondRollbackCommandTimestamp = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "rollback.toCheckpoint",
    data: {
      checkpointSha: firstCheckpoint.sha,
      autoRestart: false,
    },
  });

  const rollback2 = (await testState.client.waitForEvent(
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

  await new Promise((resolve) => setTimeout(resolve, 2000));

  // SNAPSHOT 4
  await createSnapshot(
    "4-after-rollback-to-start",
    testState.executionPath,
    SNAPSHOT_DIR,
    testState.client,
    testState,
  );

  // Cleanup
  console.log(`\n${colors.blue}Cleaning up...${colors.reset}`);

  if (testState.client) {
    const eventsPath = path.join(TEST_RUN_DIR, "websocket-events.json");
    await fs.promises.writeFile(eventsPath, JSON.stringify(testState.client.getEvents(), null, 2));
    console.log(`${colors.gray}  WebSocket events saved to: ${eventsPath}${colors.reset}`);
  }

  await testState.client.disconnect();
  console.log(`\n${colors.blue}Gracefully shutting down server...${colors.reset}`);

  if (testState.serverProcess && !testState.serverProcess.killed) {
    const shutdownPromise = new Promise<void>((resolve) => {
      testState.serverProcess?.on("exit", (code, signal) => {
        console.log(
          `${colors.green}✓ Server process exited with code ${code}, signal ${signal}${colors.reset}`,
        );
        resolve();
      });
    });

    console.log(`${colors.gray}  Sending SIGTERM to server process...${colors.reset}`);
    testState.serverProcess.kill("SIGTERM");

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

// ============================================================================
// MAIN TEST SUITE
// ============================================================================

describe("Comprehensive Rollback E2E Test", () => {
  const testState: TestState = {
    serverProcess: null,
    client: null,
    snapshots: [],
  };

  let testSnapshots: TestSnapshot[] = [];

  beforeAll(async () => {
    testSnapshots = await executeRollbackScenarios(testState);

    // Load git info for each snapshot for analysis tests
    for (const snapshot of testSnapshots) {
      const gitDir = path.join(snapshot.directory, ".tadpole", "checkpoints", ".git");
      if (fs.existsSync(gitDir)) {
        snapshot.git = {
          branches: [],
          allShas: getGitShas(gitDir),
          commits: getGitCommits(gitDir),
        };
      }
    }
  });

  // ========================================================================
  // EXECUTION VERIFICATION (from improved-1)
  // ========================================================================

  describe("Execution Verification", () => {
    test("all snapshots were created", () => {
      expect(testSnapshots.length).toBe(4);

      testSnapshots.forEach((snapshot) => {
        console.log(`\nVerifying snapshot: ${snapshot.name}`);
        expect(fs.existsSync(snapshot.directory)).toBe(true);

        const tadpoleDir = path.join(snapshot.directory, ".tadpole");
        expect(fs.existsSync(tadpoleDir)).toBe(true);
      });
    });

    test("snapshots contain expected state transitions", () => {
      expect(testSnapshots.length).toBe(4);

      const snapshot1 = testSnapshots[0];
      expect(snapshot1.name).toBe("1-after-phase2-phase3-skipped");
      expect(snapshot1.state.runs.length).toBe(1);

      const snapshot2 = testSnapshots[1];
      expect(snapshot2.name).toBe("2-after-rollback-to-phase1");
      expect(snapshot2.state.runs.length).toBe(2);

      const snapshot3 = testSnapshots[2];
      expect(snapshot3.name).toBe("3-after-full-completion");
      expect(snapshot3.state.runs.length).toBe(2);

      const snapshot4 = testSnapshots[3];
      expect(snapshot4.name).toBe("4-after-rollback-to-start");
      expect(snapshot4.state.runs.length).toBeGreaterThanOrEqual(2);
    });

    test("checkpoints are created correctly", () => {
      testSnapshots.forEach((snapshot) => {
        expect(snapshot.checkpoints.length).toBeGreaterThan(0);
      });

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
  });

  // ========================================================================
  // PRIORITY 1: Critical Data Integrity & Core Rollback Logic
  // ========================================================================

  describe("Priority 1: Critical Data Integrity & Core Rollback Logic", () => {
    test.each(testSnapshots)("1.1 State File Integrity: $name", (snapshot) => {
      const statePath = path.join(snapshot.directory, ".tadpole", "state.json");
      const backupPath = path.join(snapshot.directory, ".tadpole", "state.json.bak");

      expect(fs.existsSync(statePath)).toBe(true);
      expect(fs.existsSync(backupPath)).toBe(true);

      const stateContent = fs.readFileSync(statePath, "utf-8");
      const backupContent = fs.readFileSync(backupPath, "utf-8");

      const currentState = JSON.parse(stateContent);
      const backupState = JSON.parse(backupContent);

      expect(currentState).toBeDefined();
      expect(backupState).toBeDefined();
      expect(backupState.runs.length).toBeLessThanOrEqual(currentState.runs.length);
    });

    test.each(testSnapshots)("1.2 Git Repository Integrity: $name", (snapshot) => {
      const gitDir = path.join(snapshot.directory, ".tadpole", "checkpoints", ".git");
      expect(fs.existsSync(gitDir)).toBe(true);

      try {
        execSync(`git --git-dir=${gitDir} fsck`);
      } catch (e) {
        throw new Error(`Git fsck failed: ${e}`);
      }
    });

    test.each(testSnapshots)("1.3 Three-Way Consistency: $name", (snapshot) => {
      const allCheckpointShas = new Set<string>();

      snapshot.state.runs.forEach((run: Run) => {
        run.phases.forEach((phase) => {
          if ("completionCheckpoint" in phase && phase.completionCheckpoint)
            allCheckpointShas.add(phase.completionCheckpoint);
          if ("errorCheckpoint" in phase && phase.errorCheckpoint)
            allCheckpointShas.add(phase.errorCheckpoint);
          if ("skipCheckpoint" in phase && phase.skipCheckpoint)
            allCheckpointShas.add(phase.skipCheckpoint);
          if ("workspaceSetupCheckpoint" in phase && phase.workspaceSetupCheckpoint)
            allCheckpointShas.add(phase.workspaceSetupCheckpoint);
        });
      });

      for (const sha of allCheckpointShas) {
        expect(snapshot.git?.allShas.has(sha)).toBe(true);
      }

      snapshot.state.runs.forEach((run) => {
        const runFolder = path.join(snapshot.directory, ".tadpole", "runs", run.runId);
        expect(fs.existsSync(runFolder)).toBe(true);
      });
    });

    test("1.4 Rollback File State Accuracy: Snapshot 1 -> 2", async () => {
      const snapshot1 = testSnapshots[0];
      const snapshot2 = testSnapshots[1];

      const rollbackEvent = snapshot2.events.find(
        (e) => e.type === "rollback.completed",
      ) as RollbackCompletedEvent;

      expect(rollbackEvent).toBeDefined();
      const targetSha = rollbackEvent.data.checkpoint;

      const checkoutDir = path.join(TEST_ROOT, "tests/test-area/temp-checkout");
      if (fs.existsSync(checkoutDir)) {
        fs.rmSync(checkoutDir, { recursive: true, force: true });
      }
      fs.mkdirSync(checkoutDir, { recursive: true });

      const gitDir = path.join(snapshot1.directory, ".tadpole", "checkpoints", ".git");
      execSync(`git --git-dir=${gitDir} --work-tree=${checkoutDir} checkout ${targetSha} -- .`);

      const rolledBackHash = await hashDirectory(snapshot2.directory);
      const checkedOutHash = await hashDirectory(checkoutDir);

      expect(rolledBackHash).toEqual(checkedOutHash);

      fs.rmSync(checkoutDir, { recursive: true, force: true });
    });

    test("1.5 Continuation Run Linkage: Snapshot 2", () => {
      const snapshot = testSnapshots[1];

      expect(snapshot.state.runs.length).toBe(2);

      const lastRun = snapshot.state.runs[0];
      expect(lastRun.startingConditions.type).toBe("continuation");

      if (lastRun.startingConditions.type === "continuation") {
        expect(lastRun.startingConditions.source.runId).toBe(snapshot.state.runs[1].runId);
        expect(lastRun.startingConditions.source.afterPhase).toBe(PhaseId("phase-1"));
      }
    });
  });

  // ========================================================================
  // PRIORITY 2: State Machine, Session & Costing Logic
  // ========================================================================

  describe("Priority 2: State Machine, Session & Costing Logic", () => {
    test("2.1 Phase State Transitions: Skipped phase has correct data", () => {
      const snapshot = testSnapshots[0];
      const run = snapshot.state.runs[0];
      const skippedPhase = run.phases.find((p) => p.phaseId === "phase-3");

      expect(skippedPhase?.status).toBe("skipped");
      if (skippedPhase?.status === "skipped") {
        expect(skippedPhase.assistantMessageCount).toBeGreaterThan(0);
        expect(skippedPhase.skipCheckpoint).toBeDefined();
      }
    });

    test("2.2 Session ID Chaining: Phase 2 continues from Phase 1", () => {
      const snapshot = testSnapshots[0];

      const phase1Start = snapshot.events.find(
        (e) =>
          e.type === "phase.started" && (e.data as PhaseStartedEvent["data"]).phaseId === "phase-1",
      ) as PhaseStartedEvent;

      const phase2Start = snapshot.events.find(
        (e) =>
          e.type === "phase.started" && (e.data as PhaseStartedEvent["data"]).phaseId === "phase-2",
      ) as PhaseStartedEvent;

      expect(phase1Start).toBeDefined();
      expect(phase2Start).toBeDefined();
      expect(phase2Start.data.previousSessionId).toEqual(phase1Start.data.sessionId);
    });

    test("2.3 Cost Tracking Accuracy: Skipped phase cost is zero", () => {
      const snapshot = testSnapshots[0];

      const phase3Completed = snapshot.events.find(
        (e) =>
          e.type === "phase.completed" &&
          (e.data as PhaseCompletedEvent["data"]).phaseId === "phase-3",
      ) as PhaseCompletedEvent;

      expect(phase3Completed.data.cost).toBe(0);
    });

    test("2.4 Event Stream Reconciliation: Events match final state", () => {
      const snapshot = testSnapshots[0];
      const reconstructedPhases = reconstructPhaseStatesFromEvents(snapshot.events);

      const run = snapshot.state.runs[0];
      for (const phase of run.phases) {
        const reconstructed = reconstructedPhases.get(phase.phaseId);
        if (reconstructed) {
          if (phase.status === "skipped") {
            expect(reconstructed.cost).toBe(0);
          } else if (phase.status === "completed") {
            expect(reconstructed.status).toBe("completed");
            expect(reconstructed.cost).toBeGreaterThan(0);
          }
        }
      }
    });

    test("2.5 Cost Calculation Validation: Costs are reasonable", () => {
      const snapshot = testSnapshots[2];
      const run = snapshot.state.runs[0];

      for (const phase of run.phases) {
        if (phase.status === "completed") {
          const expectedCost = calculateCostFromUsage(phase.finalTokens, "sonnet");
          const actualCost = phase.finalCost;

          const variance = Math.abs(actualCost - expectedCost) / expectedCost;
          expect(variance).toBeLessThan(0.2);

          expect(actualCost).toBeGreaterThan(0);
          expect(actualCost).toBeLessThan(1.0);
        }
      }
    });
  });

  // ========================================================================
  // PRIORITY 3: Filesystem & Artifact Validation
  // ========================================================================

  describe("Priority 3: Filesystem & Artifact Validation", () => {
    test("3.1 Phase Output File Presence: Correct files exist in each stage", () => {
      const s1 = testSnapshots[0];
      const s3 = testSnapshots[2];
      const s4 = testSnapshots[3];

      expect(fs.existsSync(path.join(s1.directory, "notes"))).toBe(true);
      expect(fs.existsSync(path.join(s1.directory, "typescript_code"))).toBe(true);

      expect(fs.existsSync(path.join(s3.directory, "notes"))).toBe(true);
      expect(fs.existsSync(path.join(s3.directory, "typescript_code"))).toBe(true);

      expect(fs.existsSync(path.join(s4.directory, "notes"))).toBe(false);
      expect(fs.existsSync(path.join(s4.directory, "typescript_code"))).toBe(false);
    });

    test.each(testSnapshots)("3.2 Orphaned Artifact Check: $name", (snapshot) => {
      const runIdsInState = new Set(snapshot.state.runs.map((r) => r.runId));
      const runDirsOnDisk = fs.readdirSync(path.join(snapshot.directory, ".tadpole", "runs"));

      for (const dir of runDirsOnDisk) {
        expect(runIdsInState.has(RunId(dir))).toBe(true);
      }

      for (const run of snapshot.state.runs) {
        const runDir = path.join(snapshot.directory, ".tadpole", "runs", run.runId);
        expect(fs.existsSync(runDir)).toBe(true);
      }
    });

    test("3.3 Checkpoint Type and Message Content", () => {
      const snapshot = testSnapshots[0];

      if (snapshot.checkpoints.length === 0) {
        const run = snapshot.state.runs[0];

        const phase1 = run.phases.find((p) => p.phaseId === "phase-1");
        expect(phase1?.status).toBe("completed");
        if (phase1?.status === "completed") {
          expect(phase1.completionCheckpoint).toBeDefined();
        }

        const phase3 = run.phases.find((p) => p.phaseId === "phase-3");
        expect(phase3?.status).toBe("skipped");
        if (phase3?.status === "skipped" && "skipCheckpoint" in phase3) {
          expect(phase3.skipCheckpoint).toBeDefined();
        }
        return;
      }

      const p1checkpoints = snapshot.checkpoints.filter((cp) => cp.phaseId === "phase-1");
      const p3checkpoints = snapshot.checkpoints.filter((cp) => cp.phaseId === "phase-3");

      expect(p1checkpoints.some((cp) => cp.checkpointType === "completed")).toBe(true);
      expect(p3checkpoints.some((cp) => cp.checkpointType === "skipped")).toBe(true);

      const aCheckpoint = snapshot.checkpoints[0];
      const gitDir = path.join(snapshot.directory, ".tadpole", "checkpoints", ".git");
      const msg = execSync(`git --git-dir=${gitDir} show -s --format=%B ${aCheckpoint.sha}`, {
        encoding: "utf-8",
      });

      expect(msg).toContain(`Phase: ${aCheckpoint.phaseName}`);
      expect(msg).toContain(`Status: ${aCheckpoint.checkpointType}`);
    });

    test("3.4 Log File Integrity: All phases have log files", () => {
      for (const snapshot of testSnapshots) {
        for (const run of snapshot.state.runs) {
          for (const phase of run.phases) {
            if ("claudeLogPath" in phase && phase.claudeLogPath) {
              const logPath = path.join(snapshot.directory, phase.claudeLogPath);

              if (
                phase.status === "completed" ||
                phase.status === "failed" ||
                phase.status === "skipped"
              ) {
                let actualLogPath = logPath;
                if (!fs.existsSync(logPath)) {
                  const runDir = path.dirname(logPath);
                  const oldPattern = path.join(runDir, `phase-${phase.phaseId}-claude.log`);
                  if (fs.existsSync(oldPattern)) {
                    actualLogPath = oldPattern;
                  } else {
                    throw new Error(
                      `Log file missing for ${phase.phaseId} in ${snapshot.name}: ${phase.claudeLogPath}`,
                    );
                  }
                }

                expect(fs.existsSync(actualLogPath)).toBe(true);
                const stats = fs.statSync(actualLogPath);
                expect(stats.size).toBeGreaterThan(0);
              }
            }
          }
        }
      }
    });
  });

  // ========================================================================
  // PRIORITY 4: Event Stream Analysis
  // ========================================================================

  describe("Priority 4: Event Stream Analysis", () => {
    test("4.1 Event Ordering: Chronologically ordered", () => {
      for (const snapshot of testSnapshots) {
        const timestamps = snapshot.events.map((e) => new Date(e.timestamp).getTime());

        for (let i = 1; i < timestamps.length; i++) {
          expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
        }
      }
    });

    test("4.2 Rollback Event Sequence: Complete event chains", () => {
      for (const snapshot of testSnapshots) {
        const rollbackStartedEvents = snapshot.events.filter(
          (e) => e.type === "rollback.started",
        ) as RollbackStartedEvent[];

        if (rollbackStartedEvents.length === 0) continue;

        for (const startEvent of rollbackStartedEvents) {
          const completedEvent = snapshot.events.find(
            (e) => e.type === "rollback.completed" && e.timestamp >= startEvent.timestamp,
          ) as RollbackCompletedEvent | undefined;

          expect(completedEvent).toBeDefined();
          if (!completedEvent) continue;

          const progressEvents = snapshot.events.filter(
            (e) =>
              e.type === "rollback.progress" &&
              e.timestamp >= startEvent.timestamp &&
              e.timestamp <= completedEvent.timestamp,
          ) as RollbackProgressEvent[];

          const expectedProgressCount = startEvent.data.phasesToProcess.length + 1;
          expect(progressEvents.length).toBe(expectedProgressCount);

          const steps = progressEvents.map((e) => e.data.currentStep);
          expect(steps).toEqual([...Array(expectedProgressCount)].map((_, i) => i + 1));
        }
      }
    });

    test("4.3 Phase Event Completeness: Every started phase completes", () => {
      for (const snapshot of testSnapshots) {
        const startedPhases = snapshot.events
          .filter((e) => e.type === "phase.started")
          .map((e) => (e as PhaseStartedEvent).data.phaseId);

        const completedPhases = snapshot.events
          .filter((e) => e.type === "phase.completed")
          .map((e) => (e as PhaseCompletedEvent).data.phaseId);

        for (const phaseId of startedPhases) {
          expect(completedPhases).toContain(phaseId);
        }
      }
    });

    test("4.4 Timestamp Validity: All ISO 8601", () => {
      for (const snapshot of testSnapshots) {
        for (const event of snapshot.events) {
          expect(isValidISO8601(event.timestamp)).toBe(true);
        }
      }
    });
  });

  // ========================================================================
  // PRIORITY 5: Data Integrity Tests
  // ========================================================================

  describe("Priority 5: Data Integrity Tests", () => {
    test("5.1 State-to-Filesystem Run Integrity", () => {
      for (const snapshot of testSnapshots) {
        for (const run of snapshot.state.runs) {
          const expectedFolder = path.join(snapshot.directory, ".tadpole", "runs", run.runId);
          expect(fs.existsSync(expectedFolder)).toBe(true);
        }
      }
    });

    test("5.2 Checkpoint SHA Uniqueness", () => {
      for (const snapshot of testSnapshots) {
        const allShas = new Set<string>();

        for (const checkpoint of snapshot.checkpoints) {
          expect(allShas.has(checkpoint.sha)).toBe(false);
          allShas.add(checkpoint.sha);
        }
      }
    });

    test("5.3 Session ID Uniqueness", () => {
      for (const snapshot of testSnapshots) {
        const sessionIds = new Set<string>();

        for (const run of snapshot.state.runs) {
          for (const phase of run.phases) {
            if ("claudeSessionId" in phase && phase.claudeSessionId) {
              expect(sessionIds.has(phase.claudeSessionId)).toBe(false);
              sessionIds.add(phase.claudeSessionId);
            }
          }
        }
      }
    });

    test("5.4 Run Status Consistency", () => {
      for (const snapshot of testSnapshots) {
        const runningRuns = snapshot.state.runs.filter((r) => r.status === "running");
        expect(runningRuns.length).toBeLessThanOrEqual(1);

        if (snapshot.state.currentRunId) {
          const currentRun = snapshot.state.runs.find(
            (r) => r.runId === snapshot.state.currentRunId,
          );
          expect(currentRun?.status).toBe("running");
        }
      }
    });
  });

  // ========================================================================
  // PRIORITY 6: Edge Cases and Behavioral Tests
  // ========================================================================

  describe("Priority 6: Edge Cases and Behavioral Tests", () => {
    test("6.1 Skip Behavior Preservation", () => {
      const snapshot = testSnapshots[0];
      const run = snapshot.state.runs[0];
      const skippedPhase = run.phases.find((p) => p.phaseId === "phase-3");

      if (skippedPhase?.status === "skipped") {
        expect("claudeSessionId" in skippedPhase && skippedPhase.claudeSessionId).toBeTruthy();
        expect(skippedPhase.assistantMessageCount).toBeGreaterThan(0);
        expect("partialCost" in skippedPhase).toBe(true);
        expect("partialTokens" in skippedPhase).toBe(true);
      }
    });

    test("6.2 Multiple Rollback Resilience", () => {
      const rollbackSnapshots = [testSnapshots[1], testSnapshots[3]];

      for (const snapshot of rollbackSnapshots) {
        expect(snapshot.state).toBeDefined();
        expect(snapshot.state.runs).toBeDefined();
        expect(Array.isArray(snapshot.state.runs)).toBe(true);
        expect(snapshot.state.runs.length).toBeGreaterThan(0);

        const gitDir = path.join(snapshot.directory, ".tadpole", "checkpoints", ".git");
        expect(fs.existsSync(gitDir)).toBe(true);
      }
    });

    test("6.3 Checkpoint Ordering: Chronological", () => {
      for (const snapshot of testSnapshots) {
        if (snapshot.checkpoints.length > 1) {
          for (let i = 1; i < snapshot.checkpoints.length; i++) {
            const prev = new Date(snapshot.checkpoints[i - 1].timestamp);
            const curr = new Date(snapshot.checkpoints[i].timestamp);
            expect(curr.getTime()).toBeGreaterThanOrEqual(prev.getTime());
          }
        }
      }
    });
  });

  // ========================================================================
  // PRIORITY 7: Additional Validation Tests
  // ========================================================================

  describe("Priority 7: Additional Validation Tests", () => {
    test("7.1 Resource Cleanup: Lock files removed", () => {
      const mainLockFilePath = path.join(EXECUTION_DIR, ".tadpole", "server.lock");
      expect(fs.existsSync(mainLockFilePath)).toBe(false);
    });

    test("7.2 Storage Growth Patterns: Reasonable file sizes", () => {
      const stateSizes: Array<{ name: string; size: number }> = [];

      for (const snapshot of testSnapshots) {
        const statePath = path.join(snapshot.directory, ".tadpole", "state.json");
        if (fs.existsSync(statePath)) {
          const stats = fs.statSync(statePath);
          stateSizes.push({ name: snapshot.name, size: stats.size });
        }
      }

      for (const { name, size } of stateSizes) {
        expect(size).toBeLessThan(100 * 1024);
        expect(size).toBeGreaterThan(100);
        console.log(`State file size for ${name}: ${size} bytes`);
      }
    });

    test("7.3 Configuration Consistency: Phase configs valid", () => {
      const expectedPhases = ["phase-1", "phase-2", "phase-3"];

      for (const snapshot of testSnapshots) {
        for (const run of snapshot.state.runs) {
          const phaseIds = run.phases.map((p) => p.phaseId);
          for (const expectedPhase of expectedPhases) {
            if (phaseIds.includes(PhaseId(expectedPhase))) {
              const phase = run.phases.find((p) => p.phaseId === PhaseId(expectedPhase));
              expect(phase).toBeDefined();
            }
          }
        }
      }
    });

    test("7.4 Workspace Setup Validation", () => {
      const snapshot1 = testSnapshots[0];
      const snapshot3 = testSnapshots[2];
      const snapshot4 = testSnapshots[3];

      const run1 = snapshot1.state.runs[0];
      const phase3_s1 = run1.phases.find((p) => p.phaseId === "phase-3");
      if (phase3_s1?.status === "skipped" && "workspaceSetupCheckpoint" in phase3_s1) {
        expect(phase3_s1.workspaceSetupCheckpoint).toBeDefined();
        expect(fs.existsSync(path.join(snapshot1.directory, "typescript_code"))).toBe(true);
      }

      expect(fs.existsSync(path.join(snapshot3.directory, "notes"))).toBe(true);
      expect(fs.existsSync(path.join(snapshot3.directory, "typescript_code"))).toBe(true);

      expect(fs.existsSync(path.join(snapshot4.directory, "notes"))).toBe(false);
      expect(fs.existsSync(path.join(snapshot4.directory, "typescript_code"))).toBe(false);
    });

    test("7.5 Token Usage Patterns: Reasonable ratios", () => {
      for (const snapshot of testSnapshots) {
        for (const run of snapshot.state.runs) {
          for (const phase of run.phases) {
            if (phase.status === "completed") {
              const tokens = phase.finalTokens;

              expect(tokens.inputTokens).toBeGreaterThan(0);
              expect(tokens.outputTokens).toBeGreaterThan(0);
              expect(tokens.cacheCreationTokens).toBeGreaterThanOrEqual(0);
              expect(tokens.cacheReadTokens).toBeGreaterThanOrEqual(0);

              const totalTokens =
                tokens.inputTokens +
                tokens.outputTokens +
                tokens.cacheCreationTokens +
                tokens.cacheReadTokens;
              expect(totalTokens).toBeLessThan(1_000_000);
            }
          }
        }
      }
    });

    test("7.6 Error Propagation: No unhandled errors", () => {
      for (const snapshot of testSnapshots) {
        const errorEvents = snapshot.events.filter((e) => e.type === "error");

        if (errorEvents.length > 0) {
          console.log(`Found ${errorEvents.length} error events in ${snapshot.name}:`);
          errorEvents.forEach((e, i) => {
            console.log(`  ${i + 1}: ${JSON.stringify(e.data)}`);
          });
        }

        for (const errorEvent of errorEvents) {
          expect(errorEvent.data).toBeDefined();
          expect(typeof errorEvent.data).toBe("object");
          if (errorEvent.data && typeof errorEvent.data === "object") {
            expect("message" in errorEvent.data).toBe(true);
          }
        }
      }
    });

    test("7.7 Content Validation: Wordsworth referenced in content", () => {
      const snapshotsToCheck = [testSnapshots[0], testSnapshots[2]];

      let foundWordsworth = false;

      for (const snapshot of snapshotsToCheck) {
        const assistantMessages = snapshot.events
          .filter((e) => e.type === "assistant.action")
          .map((e) => {
            if (e.type === "assistant.action" && e.data.action === "message") {
              return e.data.content?.toLowerCase() || "";
            }
            return "";
          })
          .filter((content) => content !== "");

        const hasWordsworthInMessages = assistantMessages.some((content) =>
          content.includes("wordsworth"),
        );

        if (hasWordsworthInMessages) {
          foundWordsworth = true;
        }

        const notesDir = path.join(snapshot.directory, "notes");
        if (fs.existsSync(notesDir)) {
          const files = fs.readdirSync(notesDir);
          for (const file of files) {
            if (file.endsWith(".txt") || file.endsWith(".md")) {
              const filePath = path.join(notesDir, file);
              const content = fs.readFileSync(filePath, "utf-8").toLowerCase();
              if (content.includes("wordsworth")) {
                foundWordsworth = true;
                break;
              }
            }
          }
        }

        const tsDir = path.join(snapshot.directory, "typescript_code/src");
        if (fs.existsSync(tsDir)) {
          const files = fs.readdirSync(tsDir);
          for (const file of files) {
            if (file.endsWith(".ts")) {
              const filePath = path.join(tsDir, file);
              const content = fs.readFileSync(filePath, "utf-8").toLowerCase();
              if (content.includes("wordsworth")) {
                foundWordsworth = true;
                break;
              }
            }
          }
        }
      }

      const firstSnapshot = testSnapshots[0];
      const dataSourceInExecution = path.join(
        firstSnapshot.directory,
        "read_only_data_source",
        "poem_guides.txt",
      );
      expect(fs.existsSync(dataSourceInExecution)).toBe(true);

      expect(foundWordsworth).toBe(true);
    });
  });

  // ========================================================================
  // PRIORITY 8: Chronicler Rollback Behavior
  // ========================================================================

  describe("Priority 8: Chronicler Rollback Behavior", () => {
    test("8.1 Chronicler Outputs Persist Across Rollbacks", () => {
      // Chroniclers are observers - their outputs should NOT be rolled back
      // They're observational logs, not part of execution state

      for (const snapshot of testSnapshots) {
        const outputsDir = path.join(snapshot.directory, ".tadpole", "chronicler-outputs");

        if (fs.existsSync(outputsDir)) {
          // If chroniclers exist, their outputs should accumulate, never delete
          const chroniclerDirs = fs.readdirSync(outputsDir);

          for (const chrDir of chroniclerDirs) {
            const chrOutputPath = path.join(outputsDir, chrDir);
            const files = fs.readdirSync(chrOutputPath);

            // Each file should have unique timestamp (no overwriting)
            const timestamps = files
              .map((f) => {
                const match = f.match(/-(\d+)\.(md|ndjson|jsonl|json)$/);
                return match ? match[1] : null;
              })
              .filter((t) => t !== null);

            // All timestamps should be unique
            const uniqueTimestamps = new Set(timestamps);
            expect(uniqueTimestamps.size).toBe(timestamps.length);

            console.log(
              `Chronicler ${chrDir}: ${files.length} output files with unique timestamps`,
            );
          }
        }
      }
    });

    test("8.2 Chronicler State Separated Per Run", () => {
      // Each run should have its own chronicler state entries
      // Rollback creates a new run with fresh chronicler instances

      for (const snapshot of testSnapshots) {
        for (const run of snapshot.state.runs) {
          const phasesWithChroniclers = run.phases.filter(
            (p) =>
              (p.status === "completed" || p.status === "failed" || p.status === "skipped") &&
              p.chroniclers,
          );

          if (phasesWithChroniclers.length > 0) {
            for (const phase of phasesWithChroniclers) {
              if (
                phase.status === "completed" ||
                phase.status === "failed" ||
                phase.status === "skipped"
              ) {
                expect(phase.chroniclers).toBeDefined();
                if (phase.chroniclers) {
                  expect(phase.chroniclers.executed).toBeDefined();
                }

                // Each chronicler state should have unique timestamps for this run
                for (const chrState of phase.chroniclers?.executed ?? []) {
                  expect(chrState.loadedAt).toBeDefined();
                  // Status can be "active" or "unloaded" depending on timing
                  expect(["active", "unloaded"]).toContain(chrState.status);
                  // unloadReason only exists for unloaded chroniclers
                  if (chrState.status === "unloaded") {
                    expect(chrState.unloadReason).toBeDefined();
                  }
                }
              }
            }
          }
        }
      }
    });

    test("8.3 Conversational History Survives Rollback", () => {
      // Conversational chroniclers save history to disk
      // These files should persist across rollbacks

      for (const snapshot of testSnapshots) {
        const chroniclersDir = path.join(snapshot.directory, ".tadpole", "chroniclers");

        if (fs.existsSync(chroniclersDir)) {
          const historyFiles = fs.readdirSync(chroniclersDir).filter((f) => f.endsWith(".json"));

          // History files should exist and be valid JSON
          for (const histFile of historyFiles) {
            const histPath = path.join(chroniclersDir, histFile);
            const content = fs.readFileSync(histPath, "utf-8");

            expect(() => JSON.parse(content)).not.toThrow();

            const history = JSON.parse(content);
            expect(history.messages).toBeDefined();
            expect(Array.isArray(history.messages)).toBe(true);
          }

          console.log(
            `Found ${historyFiles.length} conversational history file(s) in ${snapshot.name}`,
          );
        }
      }
    });

    test("8.4 Chronicler Costs Independent Per Run", () => {
      // Each run's chronicler costs should be separate
      // Costs don't carry over or accumulate across rollbacks

      const runsWithChroniclers = testSnapshots.flatMap((s) =>
        s.state.runs.filter((r) =>
          r.phases.some(
            (p) =>
              (p.status === "completed" || p.status === "failed" || p.status === "skipped") &&
              p.chroniclers,
          ),
        ),
      );

      if (runsWithChroniclers.length > 1) {
        // Verify each run has independent cost tracking
        for (const run of runsWithChroniclers) {
          for (const phase of run.phases) {
            if (
              (phase.status === "completed" ||
                phase.status === "failed" ||
                phase.status === "skipped") &&
              phase.chroniclers
            ) {
              // Chronicler costs should be >= 0 and independent
              expect(phase.chroniclers.totalCost).toBeGreaterThanOrEqual(0);

              // Individual costs should sum to total
              const sum = phase.chroniclers.executed.reduce((acc, chr) => acc + chr.totalCost, 0);
              expect(Math.abs(sum - phase.chroniclers.totalCost)).toBeLessThan(0.000001);
            }
          }
        }
      }
    });

    test("8.5 Chronicler Unload Events on Rollback", () => {
      // When a run completes/fails, chroniclers should unload with phase-complete reason
      // This should happen even during rollback scenarios

      for (const snapshot of testSnapshots) {
        const unloadEvents = snapshot.events.filter((e) => e.type === "chronicler.unloaded");

        if (unloadEvents.length > 0) {
          for (const event of unloadEvents) {
            // Type narrow to ChroniclerUnloadedEvent
            if (event.type === "chronicler.unloaded") {
              const data = event.data;

              // Should have valid unload reason
              expect([
                "phase-complete",
                "fatal-error",
                "consecutive-failures",
                "shutdown",
              ]).toContain(data.reason);

              // Should have final cost and call count
              expect(typeof data.finalCost).toBe("number");
              expect(typeof data.llmCallCount).toBe("number");
            }
          }

          console.log(`${snapshot.name}: ${unloadEvents.length} chronicler unload event(s)`);
        }
      }
    });
  });
});
