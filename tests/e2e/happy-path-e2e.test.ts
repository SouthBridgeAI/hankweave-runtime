#!/usr/bin/env bun
import { afterAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  extractPathsFromTree,
  type FileNode,
  findInTree,
  parseJSONL,
} from "../utils/test-data-helpers.js";
import {
  cleanupTest,
  colors,
  generateTestTimestamp,
  type ServerConfig,
  setupTestDirectory,
  startServer,
  type TestDirectoryConfig,
  TestWSClient,
} from "../utils/test-helpers.js";
// New test groups
import { runCheckpointExclusionTests } from "./test-groups/checkpoint-exclusion-tests.js";
import { runCheckpointSystemTests } from "./test-groups/checkpoint-system-tests.js";
import { runCostPrecisionTests } from "./test-groups/cost-precision-tests.js";
import { runCostTrackingTests } from "./test-groups/cost-tracking-tests.js";
import { runErrorEventTests } from "./test-groups/error-event-tests.js";
import { runEventIntegrityTests } from "./test-groups/event-integrity-tests.js";
import { runFileContentTests } from "./test-groups/file-content-tests.js";
import { runFileSystemEdgeCasesTests } from "./test-groups/file-system-edge-cases-tests.js";
import { runFileSystemTests } from "./test-groups/file-system-tests.js";
import { runFileTreeTests } from "./test-groups/file-tree-tests.js";
import { runFileWatchingNegativeTests } from "./test-groups/file-watching-negative-tests.js";
import { runFileWatchingTests } from "./test-groups/file-watching-tests.js";
import { runInfoEventsTests } from "./test-groups/info-events-tests.js";
import { runJSONLSchemaTests } from "./test-groups/jsonl-schema-tests.js";
import { runLockFileTests } from "./test-groups/lock-file-tests.js";
import { runLogFilesTests } from "./test-groups/log-files-tests.js";
import { runLogOrderingTests } from "./test-groups/log-ordering-tests.js";
import { runMessageOrderingTests } from "./test-groups/message-ordering-tests.js";
import { runMultiFilePromptTests } from "./test-groups/multi-file-prompt-tests.js";
import { runPathConsistencyTests } from "./test-groups/path-consistency-tests.js";
import { runPerformanceTests } from "./test-groups/performance-tests.js";
import { runPhaseExecutionTests } from "./test-groups/phase-execution-tests.js";
import { runPhaseTimingTests } from "./test-groups/phase-timing-tests.js";
import { runPreStartCommandsTests } from "./test-groups/pre-start-commands-tests.js";
import { runProcessLifecycleTests } from "./test-groups/process-lifecycle-tests.js";
import { runRaceConditionTests } from "./test-groups/race-condition-tests.js";
import { runResourceCleanupTests } from "./test-groups/resource-cleanup-tests.js";
import { runSecurityValidationTests } from "./test-groups/security-validation-tests.js";
import { runServerStateTests } from "./test-groups/server-state-tests.js";
import { runSessionContinuityTests } from "./test-groups/session-continuity-tests.js";
import { runStateConsistencyTests } from "./test-groups/state-consistency-tests.js";
import { runStateSnapshotTests } from "./test-groups/state-snapshot-tests.js";
import { runTemplateVariableTests } from "./test-groups/template-variable-tests.js";
import { runTokenUsageTests } from "./test-groups/token-usage-tests.js";
import { runToolUsageTests } from "./test-groups/tool-usage-tests.js";
import { runWebSocketEventsTests } from "./test-groups/websocket-events-tests.js";

// Test configuration
const _TEST_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const TEST_DIR = path.join(process.cwd(), "tests/test-area");
const TEST_RESULTS_DIR = path.join(process.cwd(), "tests/test-results");
const SERVER_PORT = parseInt(process.env.LANGTON_TEST_PORT || "7780");
const PHASES_CONFIG = path.join(process.cwd(), "tests/config/test-phases.config.json");

// Generate timestamp for this test run
const TEST_TIMESTAMP = generateTestTimestamp();
const TEST_RUN_DIR = path.join(TEST_RESULTS_DIR, `run-${TEST_TIMESTAMP}`);

// Import types from the server
import type {
  AssistantActionEvent,
  ErrorEvent,
  FileTreeUpdatedEvent,
  FileUpdatedEvent,
  InfoEvent,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
  StateSnapshotEvent,
  TokenUsageEvent,
} from "../../server/types.js";

// Test directory configuration
const testDirConfig: TestDirectoryConfig = {
  testDir: TEST_DIR,
  testResultsDir: TEST_RESULTS_DIR,
  testRunDir: TEST_RUN_DIR,
};

// Server configuration
const serverConfig: ServerConfig = {
  testRunDir: TEST_RUN_DIR,
  phasesConfig: PHASES_CONFIG,
  port: SERVER_PORT,
  testMode: "e2e-happy-path",
  cwd: TEST_DIR,
};

// ============================================================================
// Test State - Shared across all tests
// ============================================================================

interface TestState {
  serverProcess: ChildProcess | null;
  client: TestWSClient | null;
  events: ServerEvent[];
  phase1Started: PhaseStartedEvent | null;
  phase1Completed: PhaseCompletedEvent | null;
  phase2Started: PhaseStartedEvent | null;
  phase2Completed: PhaseCompletedEvent | null;
  phase3Started: PhaseStartedEvent | null;
  phase3Completed: PhaseCompletedEvent | null;
  testStartTime: number;
}

const testState: TestState = {
  serverProcess: null,
  client: null,
  events: [],
  phase1Started: null,
  phase1Completed: null,
  phase2Started: null,
  phase2Completed: null,
  phase3Started: null,
  phase3Completed: null,
  testStartTime: 0,
};

// ============================================================================
// Setup and Run Phases (Outside of test blocks)
// ============================================================================

async function setupAndRunPhases(): Promise<void> {
  testState.testStartTime = Date.now();

  // Setup test directory
  await setupTestDirectory(testDirConfig);

  // Start server
  testState.serverProcess = startServer(serverConfig);

  // Give server time to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Connect WebSocket client
  testState.client = new TestWSClient();
  await testState.client.connect(SERVER_PORT);

  // Wait for initial events
  console.log(`${colors.blue}Waiting for server initialization...${colors.reset}`);
  await testState.client.waitForEvent("server.ready");
  await testState.client.waitForEvent("state.snapshot");

  // Wait for all phases to complete
  console.log(`${colors.blue}Waiting for all phases to complete...${colors.reset}`);

  // Phase 1
  testState.phase1Started = (await testState.client.waitForEvent(
    "phase.started",
    10000,
  )) as PhaseStartedEvent;
  console.log(`${colors.green}✓ Phase 1 started${colors.reset}`);

  testState.phase1Completed = await testState.client.waitForPhaseCompletion("phase-1", 60000);
  console.log(`${colors.green}✓ Phase 1 completed${colors.reset}`);

  // Phase 2
  // Wait a moment for phase 2 to auto-start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  testState.phase2Started =
    (testState.client
      .getEvents()
      .find(
        (e) => e.type === "phase.started" && (e as PhaseStartedEvent).data.phaseId === "phase-2",
      ) as PhaseStartedEvent | undefined) || null;

  if (!testState.phase2Started) {
    console.log(`${colors.red}✗ Phase 2 did not start${colors.reset}`);
  } else {
    console.log(`${colors.green}✓ Phase 2 started${colors.reset}`);
  }

  testState.phase2Completed = await testState.client.waitForPhaseCompletion("phase-2", 60000);
  console.log(`${colors.green}✓ Phase 2 completed${colors.reset}`);

  // Phase 3
  // Wait for phase 3 to start (it should auto-start after phase 2)
  // We'll poll for the event with a timeout
  const phase3StartTime = Date.now();
  const phase3Timeout = 10000; // 10 seconds

  while (Date.now() - phase3StartTime < phase3Timeout) {
    testState.phase3Started =
      (testState.client
        .getEvents()
        .find(
          (e) => e.type === "phase.started" && (e as PhaseStartedEvent).data.phaseId === "phase-3",
        ) as PhaseStartedEvent | undefined) || null;

    if (testState.phase3Started) {
      console.log(`${colors.green}✓ Phase 3 started${colors.reset}`);
      break;
    }

    // Wait 100ms before checking again
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!testState.phase3Started) {
    console.log(`${colors.red}✗ Phase 3 did not start${colors.reset}`);
  }

  testState.phase3Completed = await testState.client.waitForPhaseCompletion("phase-3", 60000);
  console.log(`${colors.green}✓ Phase 3 completed${colors.reset}`);

  // Give a moment for final events
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Store all events for tests
  testState.events = testState.client.getEvents();
}

// ============================================================================
// Cleanup Function
// ============================================================================

async function cleanup(): Promise<void> {
  await cleanupTest({
    testDir: TEST_DIR,
    testRunDir: TEST_RUN_DIR,
    serverProcess: testState.serverProcess,
    client: testState.client,
    events: testState.events,
    gracefulShutdown: true,
  });
}

// ============================================================================
// Run setup before tests
// ============================================================================

console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}`);
console.log(`${colors.blue}Langton Server End-to-End Test${colors.reset}`);
console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

// This runs before any tests
await setupAndRunPhases();

// ============================================================================
// Now run the actual tests using Bun's test framework
// ============================================================================

describe("Langton E2E Test", () => {
  describe("Phase Execution", () => {
    runPhaseExecutionTests(testState);
  });

  describe("File System State", () => {
    runFileSystemTests(testState, TEST_DIR);
  });

  describe("Log Files", () => {
    runLogFilesTests(TEST_DIR);
  });

  describe("WebSocket Events", () => {
    runWebSocketEventsTests(testState);
  });

  describe("Cost Tracking", () => {
    runCostTrackingTests(testState, TEST_DIR);
  });

  describe("Token Usage", () => {
    runTokenUsageTests(testState, TEST_DIR);
  });

  describe("File Content", () => {
    runFileContentTests(TEST_DIR);
  });

  describe("File Watching", () => {
    runFileWatchingTests(testState);
  });

  describe("Phase Timing", () => {
    runPhaseTimingTests(testState);
  });

  describe("Session Continuity", () => {
    runSessionContinuityTests(TEST_DIR);
  });

  describe("File Tree", () => {
    runFileTreeTests(testState, TEST_DIR);
  });

  describe("Info Events", () => {
    runInfoEventsTests(testState);
  });

  describe("Pre-start Commands", () => {
    runPreStartCommandsTests(TEST_DIR);
  });

  describe("Tool Usage", () => {
    runToolUsageTests(testState, TEST_DIR);
  });

  describe("State Snapshot", () => {
    runStateSnapshotTests(testState);
  });

  describe("Server State", () => {
    runServerStateTests(TEST_DIR);
  });

  describe("JSONL Schema", () => {
    runJSONLSchemaTests(TEST_DIR);
  });

  describe("Path Consistency", () => {
    runPathConsistencyTests(testState);
  });

  describe("Checkpoint System", () => {
    runCheckpointSystemTests(TEST_DIR);
  });

  describe("Message Ordering", () => {
    runMessageOrderingTests(testState);
  });

  // New test groups
  describe("Checkpoint Exclusion", () => {
    runCheckpointExclusionTests(TEST_DIR);
  });

  describe("File Watching - Negative Cases", () => {
    runFileWatchingNegativeTests(testState);
  });

  describe("Resource Cleanup", () => {
    runResourceCleanupTests(TEST_DIR);
  });

  describe("Event Integrity", () => {
    runEventIntegrityTests(testState);
  });

  describe("State Consistency", () => {
    runStateConsistencyTests(testState);
  });

  describe("Log Ordering", () => {
    runLogOrderingTests(TEST_DIR);
  });

  describe("Security Validation", () => {
    runSecurityValidationTests(testState, TEST_DIR);
  });

  describe("Performance", () => {
    runPerformanceTests(testState);
  });

  describe("Cost Precision", () => {
    runCostPrecisionTests(testState);
  });

  describe("File System Edge Cases", () => {
    runFileSystemEdgeCasesTests(testState, TEST_DIR);
  });

  describe("Template Variables", () => {
    runTemplateVariableTests(testState);
  });

  describe("Race Condition Detection", () => {
    runRaceConditionTests(testState);
  });

  describe("Process Lifecycle", () => {
    runProcessLifecycleTests(testState);
  });

  describe("Multi-file Prompts", () => {
    runMultiFilePromptTests(testState, PHASES_CONFIG);
  });

  describe("Lock File Integrity", () => {
    runLockFileTests(testState, TEST_DIR);
  });

  describe("Error Event Metadata", () => {
    runErrorEventTests(testState);
  });
});

// Cleanup after all tests
afterAll(async () => {
  await cleanup();
});
