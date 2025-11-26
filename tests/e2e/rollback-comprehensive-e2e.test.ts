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
import { CodonId, RunId } from "../../server/types/branded-types.js";
import type { Run, StrandweaveState } from "../../server/types/state-types.js";
import type {
  AssistantActionEvent,
  CheckpointListEvent,
  CodonCompletedEvent,
  CodonStartedEvent,
  RollbackCompletedEvent,
  RollbackProgressEvent,
  RollbackStartedEvent,
  ServerEvent,
  ServerIdleEvent,
} from "../../server/types/types.js";
import { generateId } from "../../server/utils.js";
import { getGitCommits, getGitShas } from "../utils/git-test-helpers.js";
import { calculateCostFromUsage } from "../utils/test-data-helpers.js";
import {
  colors,
  generateTestTimestamp,
  getFreePort,
  setupTestDirectory,
  type TestDirectoryConfig,
  TestWSClient,
} from "../utils/test-helpers.js";

// -------------
// TEST CONFIGURATION
// -------------

const TEST_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const EXECUTION_DIR = path.join(TEST_ROOT, "tests/test-area/rollback-comprehensive");
const DATA_SOURCE_FILE = path.join(TEST_ROOT, "tests/config/poem_guides.txt");
const SNAPSHOT_DIR = path.join(TEST_ROOT, "tests/test-area/rollback-comprehensive-snapshots");
const TEST_RESULTS_DIR = path.join(TEST_ROOT, "tests/test-results");
const CODONS_CONFIG = path.join(TEST_ROOT, "tests/config/test-codons.config.json");

const TEST_TIMESTAMP = generateTestTimestamp();
const TEST_RUN_DIR = path.join(TEST_RESULTS_DIR, `rollback-comprehensive-${TEST_TIMESTAMP}`);

const testDirConfig: TestDirectoryConfig = {
  testDir: EXECUTION_DIR,
  testResultsDir: TEST_RESULTS_DIR,
  testRunDir: TEST_RUN_DIR,
};

// -------------
// INTERFACES
// -------------

interface TestSnapshot {
  name: string;
  directory: string;
  state: StrandweaveState;
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

// -------------
// HELPER CLASSES
// -------------

/**
 * Enhanced WebSocket client with session ID tracking
 */
class EnhancedTestWSClient extends TestWSClient {
  private sessionIdMap = new Map<string, string>();

  async waitForCodonStartWithSession(
    codonId: string,
    timeout: number = 30000,
    afterTimestamp?: string,
  ): Promise<CodonStartedEvent> {
    const event = await this.waitForEvent(
      "codon.started",
      timeout,
      (e) => {
        const startedEvent = e as CodonStartedEvent;
        return startedEvent.data?.codonId === codonId;
      },
      afterTimestamp,
    );

    const codonStartedEvent = event as CodonStartedEvent;
    this.sessionIdMap.set(codonId, codonStartedEvent.data.sessionId);
    return codonStartedEvent;
  }

  async waitForCodonCompletionBySession(
    codonId: string,
    timeout: number = 120000,
    afterTimestamp?: string,
  ): Promise<CodonCompletedEvent> {
    const event = await this.waitForEvent(
      "codon.completed",
      timeout,
      (e) => {
        const completedEvent = e as CodonCompletedEvent;
        return completedEvent.data?.codonId === codonId;
      },
      afterTimestamp,
    );

    return event as CodonCompletedEvent;
  }

  getSessionId(codonId: string): string | undefined {
    return this.sessionIdMap.get(codonId);
  }

  clearSessionIds(): void {
    this.sessionIdMap.clear();
  }
}

// -------------
// HELPER FUNCTIONS - File System Operations
// -------------

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
 * Excludes .strandweave, data, and read_only_data_source directories
 */
async function hashDirectory(dir: string): Promise<string> {
  if (!fs.existsSync(dir)) {
    return "directory-does-not-exist";
  }

  const allFilePaths = (await getFilePaths(dir)).sort();
  const filePaths = allFilePaths.filter((filePath) => {
    const relativePath = path.relative(dir, filePath);
    return (
      !relativePath.startsWith(`.strandweave${path.sep}`) &&
      !relativePath.startsWith(".strandweave/") &&
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

// -------------
// HELPER FUNCTIONS - Cost & State Analysis
// -------------

/**
 * Reconstruct codon states from event stream
 */
function reconstructCodonStatesFromEvents(events: ServerEvent[]): Map<
  string,
  {
    codonId: string;
    status: string;
    sessionId?: string;
    previousSessionId?: string;
    cost: number;
    assistantMessageCount: number;
  }
> {
  const codons = new Map();

  for (const event of events) {
    if (event.type === "codon.started") {
      const data = event.data as CodonStartedEvent["data"];
      codons.set(data.codonId, {
        codonId: data.codonId,
        status: "started",
        sessionId: data.sessionId,
        previousSessionId: data.previousSessionId,
        cost: 0,
        assistantMessageCount: 0,
      });
    } else if (event.type === "codon.completed") {
      const data = event.data as CodonCompletedEvent["data"];
      const codon = codons.get(data.codonId);
      if (codon) {
        codon.status = data.success ? "completed" : "failed";
        codon.cost = data.cost;
      }
    } else if (event.type === "assistant.action") {
      const data = event.data as AssistantActionEvent["data"];
      const codon = codons.get(data.codonId);
      if (codon && data.action === "message") {
        codon.assistantMessageCount++;
      }
    }
  }

  return codons;
}

/**
 * Check if a timestamp is valid ISO 8601
 */
function isValidISO8601(timestamp: string): boolean {
  const date = new Date(timestamp);
  return date.toISOString() === timestamp;
}

// -------------
// SNAPSHOT CREATION
// -------------

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
  const statePath = path.join(executionPath, ".strandweave/state.json");
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

// -------------
// MAIN EXECUTION FLOW
// -------------

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

  // Get a free port for this test run
  const SERVER_PORT = await getFreePort();
  console.log(`${colors.blue}Using dynamic port: ${SERVER_PORT}${colors.reset}`);

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
      `--config=${CODONS_CONFIG}`,
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

  // === SCENARIO 1: Run Codon 1-2, Skip Codon 3 ===
  console.log(`\n${colors.blue}${"=".repeat(60)}${colors.reset}`);
  console.log(`${colors.blue}SCENARIO 1: Run Codon 1-2, Skip Codon 3${colors.reset}`);
  console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

  // Run Codon 1
  console.log(`${colors.blue}Starting Codon 1...${colors.reset}`);
  const codon1StartTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "codon.start",
    data: { codonId: CodonId("codon-1") },
  });

  const codon1Started = await (
    testState.client as EnhancedTestWSClient
  ).waitForCodonStartWithSession("codon-1", 30000, codon1StartTime);
  console.log(
    `${colors.green}✓ Codon 1 started (session: ${codon1Started.data.sessionId})${colors.reset}`,
  );

  const codon1Completed = await (
    testState.client as EnhancedTestWSClient
  ).waitForCodonCompletionBySession("codon-1", 60000, codon1StartTime);
  console.log(
    `${colors.green}✓ Codon 1 completed (cost: $${codon1Completed.data.cost.toFixed(6)})${colors.reset}`,
  );

  await testState.client.waitForEvent("server.idle", 10000, (event) => {
    const idleEvent = event as ServerIdleEvent;
    return (
      idleEvent.data?.reason === "codon-completed" && event.timestamp >= codon1Completed.timestamp
    );
  });

  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Run Codon 2
  console.log(`\n${colors.blue}Starting Codon 2...${colors.reset}`);
  const codon2StartTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "codon.start",
    data: { codonId: CodonId("codon-2") },
  });

  const codon2Started = await (
    testState.client as EnhancedTestWSClient
  ).waitForCodonStartWithSession("codon-2", 30000, codon2StartTime);
  console.log(
    `${colors.green}✓ Codon 2 started (session: ${codon2Started.data.sessionId})${colors.reset}`,
  );

  const codon2Completed = await (
    testState.client as EnhancedTestWSClient
  ).waitForCodonCompletionBySession("codon-2", 60000, codon2StartTime);
  console.log(
    `${colors.green}✓ Codon 2 completed (cost: $${codon2Completed.data.cost.toFixed(6)})${colors.reset}`,
  );

  await testState.client.waitForEvent("server.idle", 20000, (event) => {
    const idleEvent = event as ServerIdleEvent;
    return (
      idleEvent.data?.reason === "codon-completed" && event.timestamp >= codon2Completed.timestamp
    );
  });

  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Start Codon 3 and skip it
  console.log(`\n${colors.blue}Starting Codon 3 (will skip)...${colors.reset}`);
  const codon3StartTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "codon.start",
    data: { codonId: CodonId("codon-3") },
  });

  const codon3Started = await (
    testState.client as EnhancedTestWSClient
  ).waitForCodonStartWithSession("codon-3", 30000, codon3StartTime);
  console.log(
    `${colors.green}✓ Codon 3 started (session: ${codon3Started.data.sessionId})${colors.reset}`,
  );

  await testState.client.waitForEvent(
    "assistant.action",
    30000,
    (event) => event.type === "assistant.action",
    codon3StartTime,
  );
  console.log(`${colors.gray}  Claude is active, now skipping codon${colors.reset}`);

  await testState.client.sendCommand({
    id: generateId(),
    type: "codon.skip",
  });

  const codon3Skipped = await (
    testState.client as EnhancedTestWSClient
  ).waitForCodonCompletionBySession("codon-3", 10000, codon3StartTime);
  expect(codon3Skipped.data.success).toBe(false);
  console.log(`${colors.green}✓ Codon 3 skipped${colors.reset}`);

  await testState.client.waitForEvent("server.idle", 10000, (event) => {
    const idleEvent = event as ServerIdleEvent;
    return (
      idleEvent.data?.reason === "codon-completed" && event.timestamp >= codon3Skipped.timestamp
    );
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));

  // SNAPSHOT 1
  if (!testState.executionPath) {
    throw new Error("Execution path not set");
  }
  await createSnapshot(
    "1-after-codon2-codon3-skipped",
    testState.executionPath,
    SNAPSHOT_DIR,
    testState.client,
    testState,
  );

  // === SCENARIO 2: Rollback to Codon 1 ===
  console.log(`\n${colors.blue}${"=".repeat(60)}${colors.reset}`);
  console.log(`${colors.blue}SCENARIO 2: Rollback to Codon 1${colors.reset}`);
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

  console.log(`\n${colors.blue}Rolling back to Codon 1 completion...${colors.reset}`);
  const rollbackCommandTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "rollback.toCodon",
    data: {
      codonId: CodonId("codon-1"),
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
    `${colors.green}✓ Rolled back to ${rollback1.data.codonName} (${rollback1.data.checkpointType})${colors.reset}`,
  );

  // SNAPSHOT 2
  await createSnapshot(
    "2-after-rollback-to-codon1",
    testState.executionPath,
    SNAPSHOT_DIR,
    testState.client,
    testState,
  );

  // === SCENARIO 3: Continue from rollback ===
  console.log(`\n${colors.blue}${"=".repeat(60)}${colors.reset}`);
  console.log(`${colors.blue}SCENARIO 3: Continue from Rollback${colors.reset}`);
  console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

  console.log(`\n${colors.blue}Starting Codon 2 manually...${colors.reset}`);
  const codon2Scenario3StartTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "codon.start",
    data: { codonId: CodonId("codon-2") },
  });

  const codon2Started2 = await (
    testState.client as EnhancedTestWSClient
  ).waitForCodonStartWithSession("codon-2", 30000, codon2Scenario3StartTime);
  console.log(
    `${colors.green}✓ Codon 2 started again (session: ${codon2Started2.data.sessionId})${colors.reset}`,
  );

  const codon2Completed2 = await (
    testState.client as EnhancedTestWSClient
  ).waitForCodonCompletionBySession("codon-2", 60000, codon2Scenario3StartTime);
  console.log(
    `${colors.green}✓ Codon 2 completed (cost: $${codon2Completed2.data.cost.toFixed(6)})${colors.reset}`,
  );

  await testState.client.waitForEvent("server.idle", 10000, (event) => {
    const idleEvent = event as ServerIdleEvent;
    return (
      idleEvent.data?.reason === "codon-completed" && event.timestamp >= codon2Completed2.timestamp
    );
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Run Codon 3 to completion
  console.log(`\n${colors.blue}Starting Codon 3 (full run)...${colors.reset}`);
  const codon3Scenario3StartTime = new Date().toISOString();

  await testState.client.sendCommand({
    id: generateId(),
    type: "codon.start",
    data: { codonId: CodonId("codon-3") },
  });

  const codon3Started2 = await (
    testState.client as EnhancedTestWSClient
  ).waitForCodonStartWithSession("codon-3", 30000, codon3Scenario3StartTime);
  console.log(
    `${colors.green}✓ Codon 3 started (session: ${codon3Started2.data.sessionId})${colors.reset}`,
  );

  const codon3Completed2 = await (
    testState.client as EnhancedTestWSClient
  ).waitForCodonCompletionBySession("codon-3", 60000, codon3Scenario3StartTime);
  console.log(
    `${colors.green}✓ Codon 3 completed (cost: $${codon3Completed2.data.cost.toFixed(6)})${colors.reset}`,
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
    `${colors.gray}  Found first checkpoint: ${firstCheckpoint.codonName} - ${firstCheckpoint.checkpointType}${colors.reset}`,
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
    `${colors.green}✓ Rolled back to ${rollback2.data.codonName} (${rollback2.data.checkpointType})${colors.reset}`,
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

// -------------
// MAIN TEST SUITE
// -------------

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
      const gitDir = path.join(snapshot.directory, ".strandweave", "checkpoints", ".git");
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

        const strandweaveDir = path.join(snapshot.directory, ".strandweave");
        expect(fs.existsSync(strandweaveDir)).toBe(true);
      });
    });

    test("snapshots contain expected state transitions", () => {
      expect(testSnapshots.length).toBe(4);

      const snapshot1 = testSnapshots[0];
      expect(snapshot1.name).toBe("1-after-codon2-codon3-skipped");
      expect(snapshot1.state.runs.length).toBe(1);

      const snapshot2 = testSnapshots[1];
      expect(snapshot2.name).toBe("2-after-rollback-to-codon1");
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
      const hasRigSetup = snapshot1Checkpoints.some((cp) => cp.checkpointType === "rig-setup");
      const hasCompleted = snapshot1Checkpoints.some((cp) => cp.checkpointType === "completed");
      const hasSkipped = snapshot1Checkpoints.some((cp) => cp.checkpointType === "skipped");

      expect(hasRigSetup).toBe(true);
      expect(hasCompleted).toBe(true);
      expect(hasSkipped).toBe(true);
    });
  });

  // ========================================================================
  // PRIORITY 1: Critical Data Integrity & Core Rollback Logic
  // ========================================================================

  describe("Priority 1: Critical Data Integrity & Core Rollback Logic", () => {
    test.each(testSnapshots)("1.1 State File Integrity: $name", (snapshot) => {
      const statePath = path.join(snapshot.directory, ".strandweave", "state.json");
      const backupPath = path.join(snapshot.directory, ".strandweave", "state.json.bak");

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
      const gitDir = path.join(snapshot.directory, ".strandweave", "checkpoints", ".git");
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
        run.codons.forEach((codon) => {
          if ("completionCheckpoint" in codon && codon.completionCheckpoint)
            allCheckpointShas.add(codon.completionCheckpoint);
          if ("errorCheckpoint" in codon && codon.errorCheckpoint)
            allCheckpointShas.add(codon.errorCheckpoint);
          if ("skipCheckpoint" in codon && codon.skipCheckpoint)
            allCheckpointShas.add(codon.skipCheckpoint);
          if ("rigSetupCheckpoint" in codon && codon.rigSetupCheckpoint)
            allCheckpointShas.add(codon.rigSetupCheckpoint);
        });
      });

      for (const sha of allCheckpointShas) {
        expect(snapshot.git?.allShas.has(sha)).toBe(true);
      }

      snapshot.state.runs.forEach((run) => {
        const runFolder = path.join(snapshot.directory, ".strandweave", "runs", run.runId);
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

      const gitDir = path.join(snapshot1.directory, ".strandweave", "checkpoints", ".git");
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
        expect(lastRun.startingConditions.source.afterCodon).toBe(CodonId("codon-1"));
      }
    });
  });

  // ========================================================================
  // PRIORITY 2: State Machine, Session & Costing Logic
  // ========================================================================

  describe("Priority 2: State Machine, Session & Costing Logic", () => {
    test("2.1 Codon State Transitions: Skipped codon has correct data", () => {
      const snapshot = testSnapshots[0];
      const run = snapshot.state.runs[0];
      const skippedCodon = run.codons.find((p) => p.codonId === "codon-3");

      expect(skippedCodon?.status).toBe("skipped");
      if (skippedCodon?.status === "skipped") {
        expect(skippedCodon.assistantMessageCount).toBeGreaterThan(0);
        expect(skippedCodon.skipCheckpoint).toBeDefined();
      }
    });

    test("2.2 Session ID Chaining: Codon 2 continues from Codon 1", () => {
      const snapshot = testSnapshots[0];

      const codon1Start = snapshot.events.find(
        (e) =>
          e.type === "codon.started" && (e.data as CodonStartedEvent["data"]).codonId === "codon-1",
      ) as CodonStartedEvent;

      const codon2Start = snapshot.events.find(
        (e) =>
          e.type === "codon.started" && (e.data as CodonStartedEvent["data"]).codonId === "codon-2",
      ) as CodonStartedEvent;

      expect(codon1Start).toBeDefined();
      expect(codon2Start).toBeDefined();
      expect(codon2Start.data.previousSessionId).toEqual(codon1Start.data.sessionId);
    });

    test("2.3 Cost Tracking Accuracy: Skipped codon cost is zero", () => {
      const snapshot = testSnapshots[0];

      const codon3Completed = snapshot.events.find(
        (e) =>
          e.type === "codon.completed" &&
          (e.data as CodonCompletedEvent["data"]).codonId === "codon-3",
      ) as CodonCompletedEvent;

      expect(codon3Completed.data.cost).toBe(0);
    });

    test("2.4 Event Stream Reconciliation: Events match final state", () => {
      const snapshot = testSnapshots[0];
      const reconstructedCodons = reconstructCodonStatesFromEvents(snapshot.events);

      const run = snapshot.state.runs[0];
      for (const codon of run.codons) {
        const reconstructed = reconstructedCodons.get(codon.codonId);
        if (reconstructed) {
          if (codon.status === "skipped") {
            expect(reconstructed.cost).toBe(0);
          } else if (codon.status === "completed") {
            expect(reconstructed.status).toBe("completed");
            expect(reconstructed.cost).toBeGreaterThan(0);
          }
        }
      }
    });

    test("2.5 Cost Calculation Validation: Costs are reasonable", () => {
      const snapshot = testSnapshots[2];
      const run = snapshot.state.runs[0];

      for (const codon of run.codons) {
        if (codon.status === "completed") {
          const expectedCost = calculateCostFromUsage(codon.finalTokens, "sonnet");
          const actualCost = codon.finalCost;

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
    test("3.1 Codon Output File Presence: Correct files exist in each stage", () => {
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
      const runDirsOnDisk = fs.readdirSync(path.join(snapshot.directory, ".strandweave", "runs"));

      for (const dir of runDirsOnDisk) {
        expect(runIdsInState.has(RunId(dir))).toBe(true);
      }

      for (const run of snapshot.state.runs) {
        const runDir = path.join(snapshot.directory, ".strandweave", "runs", run.runId);
        expect(fs.existsSync(runDir)).toBe(true);
      }
    });

    test("3.3 Checkpoint Type and Message Content", () => {
      const snapshot = testSnapshots[0];

      if (snapshot.checkpoints.length === 0) {
        const run = snapshot.state.runs[0];

        const codon1 = run.codons.find((p) => p.codonId === "codon-1");
        expect(codon1?.status).toBe("completed");
        if (codon1?.status === "completed") {
          expect(codon1.completionCheckpoint).toBeDefined();
        }

        const codon3 = run.codons.find((p) => p.codonId === "codon-3");
        expect(codon3?.status).toBe("skipped");
        if (codon3?.status === "skipped" && "skipCheckpoint" in codon3) {
          expect(codon3.skipCheckpoint).toBeDefined();
        }
        return;
      }

      const p1checkpoints = snapshot.checkpoints.filter((cp) => cp.codonId === "codon-1");
      const p3checkpoints = snapshot.checkpoints.filter((cp) => cp.codonId === "codon-3");

      expect(p1checkpoints.some((cp) => cp.checkpointType === "completed")).toBe(true);
      expect(p3checkpoints.some((cp) => cp.checkpointType === "skipped")).toBe(true);

      const aCheckpoint = snapshot.checkpoints[0];
      const gitDir = path.join(snapshot.directory, ".strandweave", "checkpoints", ".git");
      const msg = execSync(`git --git-dir=${gitDir} show -s --format=%B ${aCheckpoint.sha}`, {
        encoding: "utf-8",
      });

      expect(msg).toContain(`Codon: ${aCheckpoint.codonName}`);
      expect(msg).toContain(`Status: ${aCheckpoint.checkpointType}`);
    });

    test("3.4 Log File Integrity: All codons have log files", () => {
      for (const snapshot of testSnapshots) {
        for (const run of snapshot.state.runs) {
          for (const codon of run.codons) {
            if ("claudeLogPath" in codon && codon.claudeLogPath) {
              const logPath = path.join(snapshot.directory, codon.claudeLogPath);

              if (
                codon.status === "completed" ||
                codon.status === "failed" ||
                codon.status === "skipped"
              ) {
                let actualLogPath = logPath;
                if (!fs.existsSync(logPath)) {
                  const runDir = path.dirname(logPath);
                  const oldPattern = path.join(runDir, `codon-${codon.codonId}-claude.log`);
                  if (fs.existsSync(oldPattern)) {
                    actualLogPath = oldPattern;
                  } else {
                    throw new Error(
                      `Log file missing for ${codon.codonId} in ${snapshot.name}: ${codon.claudeLogPath}`,
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

          const expectedProgressCount = startEvent.data.codonsToProcess.length + 1;
          expect(progressEvents.length).toBe(expectedProgressCount);

          const steps = progressEvents.map((e) => e.data.currentStep);
          expect(steps).toEqual([...Array(expectedProgressCount)].map((_, i) => i + 1));
        }
      }
    });

    test("4.3 Codon Event Completeness: Every started codon completes", () => {
      for (const snapshot of testSnapshots) {
        const startedCodons = snapshot.events
          .filter((e) => e.type === "codon.started")
          .map((e) => (e as CodonStartedEvent).data.codonId);

        const completedCodons = snapshot.events
          .filter((e) => e.type === "codon.completed")
          .map((e) => (e as CodonCompletedEvent).data.codonId);

        for (const codonId of startedCodons) {
          expect(completedCodons).toContain(codonId);
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
          const expectedFolder = path.join(snapshot.directory, ".strandweave", "runs", run.runId);
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
          for (const codon of run.codons) {
            if ("claudeSessionId" in codon && codon.claudeSessionId) {
              expect(sessionIds.has(codon.claudeSessionId)).toBe(false);
              sessionIds.add(codon.claudeSessionId);
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
      const skippedCodon = run.codons.find((p) => p.codonId === "codon-3");

      if (skippedCodon?.status === "skipped") {
        expect("claudeSessionId" in skippedCodon && skippedCodon.claudeSessionId).toBeTruthy();
        expect(skippedCodon.assistantMessageCount).toBeGreaterThan(0);
        expect("partialCost" in skippedCodon).toBe(true);
        expect("partialTokens" in skippedCodon).toBe(true);
      }
    });

    test("6.2 Multiple Rollback Resilience", () => {
      const rollbackSnapshots = [testSnapshots[1], testSnapshots[3]];

      for (const snapshot of rollbackSnapshots) {
        expect(snapshot.state).toBeDefined();
        expect(snapshot.state.runs).toBeDefined();
        expect(Array.isArray(snapshot.state.runs)).toBe(true);
        expect(snapshot.state.runs.length).toBeGreaterThan(0);

        const gitDir = path.join(snapshot.directory, ".strandweave", "checkpoints", ".git");
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
    test("7.1 Resource Cleanup: Lock files removed", async () => {
      const mainLockFilePath = path.join(EXECUTION_DIR, ".strandweave", "runtime.lock");

      // Poll for lock file removal (up to 2 seconds)
      for (let i = 0; i < 20; i++) {
        if (!fs.existsSync(mainLockFilePath)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(fs.existsSync(mainLockFilePath)).toBe(false);
    });

    test("7.2 Storage Growth Patterns: Reasonable file sizes", () => {
      const stateSizes: Array<{ name: string; size: number }> = [];

      for (const snapshot of testSnapshots) {
        const statePath = path.join(snapshot.directory, ".strandweave", "state.json");
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

    test("7.3 Configuration Consistency: Codon configs valid", () => {
      const expectedCodons = ["codon-1", "codon-2", "codon-3"];

      for (const snapshot of testSnapshots) {
        for (const run of snapshot.state.runs) {
          const codonIds = run.codons.map((p) => p.codonId);
          for (const expectedCodon of expectedCodons) {
            if (codonIds.includes(CodonId(expectedCodon))) {
              const codon = run.codons.find((p) => p.codonId === CodonId(expectedCodon));
              expect(codon).toBeDefined();
            }
          }
        }
      }
    });

    test("7.4 Rig Setup Validation", () => {
      const snapshot1 = testSnapshots[0];
      const snapshot3 = testSnapshots[2];
      const snapshot4 = testSnapshots[3];

      const run1 = snapshot1.state.runs[0];
      const codon3_s1 = run1.codons.find((p) => p.codonId === "codon-3");
      if (codon3_s1?.status === "skipped" && "rigSetupCheckpoint" in codon3_s1) {
        expect(codon3_s1.rigSetupCheckpoint).toBeDefined();
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
          for (const codon of run.codons) {
            if (codon.status === "completed") {
              const tokens = codon.finalTokens;

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
  // PRIORITY 8: Sentinel Rollback Behavior
  // ========================================================================

  describe("Priority 8: Sentinel Rollback Behavior", () => {
    test("8.1 Sentinel Outputs Persist Across Rollbacks", () => {
      // Sentinels are observers - their outputs should NOT be rolled back
      // They're observational logs, not part of execution state

      for (const snapshot of testSnapshots) {
        const outputsDir = path.join(snapshot.directory, ".strandweave", "sentinel-outputs");

        if (fs.existsSync(outputsDir)) {
          // If sentinels exist, their outputs should accumulate, never delete
          const sentinelDirs = fs.readdirSync(outputsDir);

          for (const sentinelDir of sentinelDirs) {
            const sentinelOutputPath = path.join(outputsDir, sentinelDir);
            const files = fs.readdirSync(sentinelOutputPath);

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
              `Sentinel ${sentinelDir}: ${files.length} output files with unique timestamps`,
            );
          }
        }
      }
    });

    test("8.2 Sentinel State Separated Per Run", () => {
      // Each run should have its own sentinel state entries
      // Rollback creates a new run with fresh sentinel instances

      for (const snapshot of testSnapshots) {
        for (const run of snapshot.state.runs) {
          const codonsWithSentinels = run.codons.filter(
            (p) =>
              (p.status === "completed" || p.status === "failed" || p.status === "skipped") &&
              p.sentinels,
          );

          if (codonsWithSentinels.length > 0) {
            for (const codon of codonsWithSentinels) {
              if (
                codon.status === "completed" ||
                codon.status === "failed" ||
                codon.status === "skipped"
              ) {
                expect(codon.sentinels).toBeDefined();
                if (codon.sentinels) {
                  expect(codon.sentinels.executed).toBeDefined();
                }

                // Each sentinel state should have unique timestamps for this run
                for (const sentinelState of codon.sentinels?.executed ?? []) {
                  expect(sentinelState.loadedAt).toBeDefined();
                  // Status can be "active" or "unloaded" depending on timing
                  expect(["active", "unloaded"]).toContain(sentinelState.status);
                  // unloadReason only exists for unloaded sentinels
                  if (sentinelState.status === "unloaded") {
                    expect(sentinelState.unloadReason).toBeDefined();
                  }
                }
              }
            }
          }
        }
      }
    });

    test("8.3 Conversational History Survives Rollback", () => {
      // Conversational sentinels save history to disk
      // These files should persist across rollbacks

      for (const snapshot of testSnapshots) {
        const sentinelsDir = path.join(snapshot.directory, ".strandweave", "sentinels");

        if (fs.existsSync(sentinelsDir)) {
          const historyFiles = fs.readdirSync(sentinelsDir).filter((f) => f.endsWith(".json"));

          // History files should exist and be valid JSON
          for (const histFile of historyFiles) {
            const histPath = path.join(sentinelsDir, histFile);
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

    test("8.4 Sentinel Costs Independent Per Run", () => {
      // Each run's sentinel costs should be separate
      // Costs don't carry over or accumulate across rollbacks

      const runsWithSentinels = testSnapshots.flatMap((s) =>
        s.state.runs.filter((r) =>
          r.codons.some(
            (p) =>
              (p.status === "completed" || p.status === "failed" || p.status === "skipped") &&
              p.sentinels,
          ),
        ),
      );

      if (runsWithSentinels.length > 1) {
        // Verify each run has independent cost tracking
        for (const run of runsWithSentinels) {
          for (const codon of run.codons) {
            if (
              (codon.status === "completed" ||
                codon.status === "failed" ||
                codon.status === "skipped") &&
              codon.sentinels
            ) {
              // Sentinel costs should be >= 0 and independent
              expect(codon.sentinels.totalCost).toBeGreaterThanOrEqual(0);

              // Individual costs should sum to total
              const sum = codon.sentinels.executed.reduce((acc, chr) => acc + chr.totalCost, 0);
              expect(Math.abs(sum - codon.sentinels.totalCost)).toBeLessThan(0.000001);
            }
          }
        }
      }
    });

    test("8.5 Sentinel Unload Events on Rollback", () => {
      // When a run completes/fails, sentinels should unload with codon-complete reason
      // This should happen even during rollback scenarios

      for (const snapshot of testSnapshots) {
        const unloadEvents = snapshot.events.filter((e) => e.type === "sentinel.unloaded");

        if (unloadEvents.length > 0) {
          for (const event of unloadEvents) {
            // Type narrow to SentinelUnloadedEvent
            if (event.type === "sentinel.unloaded") {
              const data = event.data;

              // Should have valid unload reason
              expect([
                "codon-complete",
                "fatal-error",
                "consecutive-failures",
                "shutdown",
              ]).toContain(data.reason);

              // Should have final cost and call count
              expect(typeof data.finalCost).toBe("number");
              expect(typeof data.llmCallCount).toBe("number");
            }
          }

          console.log(`${snapshot.name}: ${unloadEvents.length} sentinel unload event(s)`);
        }
      }
    });
  });
});
