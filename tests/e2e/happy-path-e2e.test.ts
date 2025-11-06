#!/usr/bin/env bun
import { afterAll, describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type CleanupIntegrationResult,
  executeTestCleanup,
  logCleanupResults,
} from "../utils/cleanup-integration.js";
import {
  ClientMode,
  cleanupTest,
  colors,
  generateTestTimestamp,
  getCompletedPhasesFromState,
  getTotalCostFromState,
  type ServerConfig,
  startServer,
  TestWSClient,
} from "../utils/test-helpers.js";
// New test groups
import { runCheckpointExclusionTests } from "./test-groups/checkpoint-exclusion-tests.js";
import { runCheckpointSystemTests } from "./test-groups/checkpoint-system-tests.js";
import { runChroniclerIntegrationTests } from "./test-groups/chronicler-integration-tests.js";
import { runCostPrecisionTests } from "./test-groups/cost-precision-tests.js";
import { runCostTrackingTests } from "./test-groups/cost-tracking-tests.js";
import { runDualIdSystemTests } from "./test-groups/dual-id-system-tests.js";
import { runEarlyPhaseFailureTests } from "./test-groups/early-phase-failure-tests.js";
import { runErrorEventTests } from "./test-groups/error-event-tests.js";
import { runEventIntegrityTests } from "./test-groups/event-integrity-tests.js";
import { runEventJournalTests } from "./test-groups/event-journal-tests.js";
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
import { runToolResultTests } from "./test-groups/tool-result-tests.js";
import { runToolUsageTests } from "./test-groups/tool-usage-tests.js";

// Test configuration
const _TEST_TIMEOUT = 5 * 60 * 1000; // 5 minutes
// Use __dirname to ensure we're always relative to this test file
const TEST_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const DATA_SOURCE_FILE = path.join(TEST_ROOT, "tests/config/poem_guides.txt");
const TEST_RESULTS_DIR = path.join(TEST_ROOT, "tests/test-results");
const SERVER_PORT = parseInt(process.env.tadpole_TEST_PORT || "7780");
const PHASES_CONFIG = path.join(TEST_ROOT, "tests/config/test-phases.config.json");

// Generate timestamp for this test run
const TEST_TIMESTAMP = generateTestTimestamp();
const TEST_RUN_DIR = path.join(TEST_RESULTS_DIR, `run-${TEST_TIMESTAMP}`);

// Import types and utilities from the server
import { type HistoryBatchEvent, isJournaledEvent } from "../../server/schemas/event-schemas.js";
import type {
  ErrorEvent,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
} from "../../server/types/types.js";
// Import connectTadpoleClient for sync client
import { connectTadpoleClient } from "../utils/tadpole-server-test-helpers.js";

// Server configuration - Updated for execution isolation
const serverConfig: ServerConfig = {
  testRunDir: TEST_RUN_DIR,
  phasesConfig: PHASES_CONFIG,
  port: SERVER_PORT,
  testMode: "e2e-happy-path",
  dataSourceDir: DATA_SOURCE_FILE, // New: specify data source file
  cwd: process.cwd(), // Server starts from test runner's CWD
  useDataFlag: true, // New: use --data flag
  startNew: true, // Force new execution for tests
};

const tadpoleResultsDir = path.join(serverConfig.cwd, "tadpole-results/");

// ============================================================================
// Test State - Shared across all tests
// ============================================================================

interface TestState {
  serverProcess: ChildProcess | null;
  client: TestWSClient | null;
  syncClient: WebSocket | null; // Read-only client that starts after delay
  events: ServerEvent[];
  // Server State Events collected from history.sync
  historyEvents: ServerEvent[];
  // Server State Events collected live after history sync completes
  liveEvents: ServerEvent[];
  phase1Started: PhaseStartedEvent | null;
  phase1Completed: PhaseCompletedEvent | null;
  phase2Started: PhaseStartedEvent | null;
  phase2Completed: PhaseCompletedEvent | null;
  phase3Started: PhaseStartedEvent | null;
  phase3Completed: PhaseCompletedEvent | null;
  errorEvents: ErrorEvent[];
  testStartTime: number;
  cleanupResult?: CleanupIntegrationResult;
  executionPath?: string; // New: track where server is executing
  dataPath?: string; // New: track where data is accessible
  checkpointValidation?: {
    checkpointDirExists: boolean;
    gitDirExists: boolean;
    commitMessages: string[];
    branches: string[];
    trackedFiles: string[];
  };
  // State-based fields for new state management
  completedPhases: Array<{
    phaseId: string;
    cost: number;
    sessionId: string;
  }>;
  totalCost: number;
}

const testState: TestState = {
  serverProcess: null,
  client: null,
  syncClient: null,
  events: [],
  // Events collected via sync client using history.sync
  historyEvents: [],
  // Events collected live after history sync completes
  liveEvents: [],
  phase1Started: null,
  phase1Completed: null,
  phase2Started: null,
  phase2Completed: null,
  phase3Started: null,
  phase3Completed: null,
  errorEvents: [],
  testStartTime: 0,
  completedPhases: [],
  totalCost: 0,
};

// ============================================================================
// Setup and Run Phases (Outside of test blocks)
// ============================================================================

async function setupAndRunPhases(): Promise<void> {
  testState.testStartTime = Date.now();

  // Ensure test results directory exists
  if (!fs.existsSync(TEST_RESULTS_DIR)) {
    fs.mkdirSync(TEST_RESULTS_DIR, { recursive: true });
  }
  if (!fs.existsSync(TEST_RUN_DIR)) {
    fs.mkdirSync(TEST_RUN_DIR, { recursive: true });
  }

  // Clean up tadpole-results directory if it exists
  if (fs.existsSync(tadpoleResultsDir)) {
    fs.rmSync(tadpoleResultsDir, { recursive: true, force: true });
  }

  // Start server with execution isolation
  testState.serverProcess = startServer(serverConfig);

  // Give server time to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Connect WebSocket client
  testState.client = new TestWSClient();
  await testState.client.connect(SERVER_PORT);

  // Wait for initial events
  console.log(`${colors.blue}Waiting for server initialization...${colors.reset}`);
  const readyEvent = await testState.client.waitForEvent("server.ready");
  if (readyEvent.type === "server.ready") {
    // Capture execution paths from server
    testState.executionPath = readyEvent.data.executionPath;
    testState.dataPath = readyEvent.data.dataPath;
    console.log(`${colors.green}✓ Server ready${colors.reset}`);
    console.log(`  Execution path: ${testState.executionPath}`);
    console.log(`  Data path: ${testState.dataPath}`);
  }

  // Wait for all phases to complete
  console.log(`${colors.blue}Waiting for all phases to complete...${colors.reset}`);

  // Phase 1
  const phase1StartEvent = await testState.client.waitForEvent("phase.started", 10000);
  if (phase1StartEvent.type !== "phase.started") {
    throw new Error("Expected phase.started event for phase 1");
  }
  testState.phase1Started = phase1StartEvent;
  console.log(`${colors.green}✓ Phase 1 started${colors.reset}`);

  testState.phase1Completed = await testState.client.waitForPhaseCompletion("phase-1", 60000);
  console.log(`${colors.green}✓ Phase 1 completed${colors.reset}`);

  // Start read-only sync client in background after Phase 1 completes
  console.log(`${colors.blue}Starting read-only sync client in background...${colors.reset}`);
  const clientSetup = await connectTadpoleClient(`ws://localhost:${SERVER_PORT}`, {
    performHandshake: true,
    mode: ClientMode.READONLY,
    sendPreviousEvents: true,
  });
  testState.syncClient = clientSetup.client;
  console.log(`${colors.green}✓ Sync client connected${colors.reset}`);

  // Set up background event collection from sync client
  // This runs in parallel with the main execution
  const syncClientEventCollection = (async (): Promise<{
    historyEvents: ServerEvent[];
    liveEvents: ServerEvent[];
  }> => {
    if (!testState.syncClient) {
      throw new Error("Sync client not connected");
    }

    // Collect all events: history from history.sync + live events until RunCompleted
    const eventCollectionPromise = new Promise<{
      historyEvents: ServerEvent[];
      liveEvents: ServerEvent[];
    }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for RunCompleted event")),
        180_000, // 3 minutes - wait for entire run to complete
      );

      if (!testState.syncClient) {
        return reject(new Error("Sync client not connected"));
      }

      const batches: Array<HistoryBatchEvent> = [];
      const collectedLiveEvents: ServerEvent[] = [];
      let historySyncComplete = false;

      // Set up message handler that:
      // 1. Collects history.batch events during sync
      // 2. Collects live events ONLY AFTER history sync is complete
      // 3. Resolves when RunCompleted is received
      testState.syncClient.onmessage = (event: MessageEvent) => {
        const serverEvent = JSON.parse(event.data) as ServerEvent;

        // Handle history.batch events for sync
        if (serverEvent.type === "history.batch") {
          batches.push(serverEvent as HistoryBatchEvent);
          if (!(serverEvent as HistoryBatchEvent).data.hasMore) {
            historySyncComplete = true;
            console.log(
              `${colors.gray}  [Sync Client] History sync complete, now collecting live events...${colors.reset}`,
            );
          }
          return;
        }

        // Only collect live events AFTER history sync is complete
        // This ensures clear separation between historical and live events
        if (historySyncComplete) {
          collectedLiveEvents.push(serverEvent);

          // Check if this is the RunCompleted event - signals end of collection
          if (
            serverEvent.type === "state.transition" &&
            serverEvent.data?.transitionType === "RunCompleted"
          ) {
            clearTimeout(timeout);

            // Extract history events from batches
            const historyEvents: ServerEvent[] = [];
            for (const batch of batches) {
              historyEvents.push(...batch.data.events);
            }

            console.log(
              `${colors.gray}  [Sync Client] Received RunCompleted event - collection complete${colors.reset}`,
            );
            console.log(
              `${colors.gray}  [Sync Client] History: ${historyEvents.length} events, Live: ${collectedLiveEvents.length} events${colors.reset}`,
            );

            resolve({ historyEvents, liveEvents: collectedLiveEvents });
          }
        }
      };
    });

    // Send history.sync command to start collection
    testState.syncClient.send(
      JSON.stringify({
        id: `history-sync-${Date.now()}`,
        type: "history.sync",
      }),
    );

    // Wait for both history and live events to be collected
    return await eventCollectionPromise;
  })();

  // Phase 2
  // Wait for phase 2 to start (it should auto-start after phase 1)
  // We'll poll for the event with a timeout
  const phase2StartTime = Date.now();
  const phase2Timeout = 10000; // 10 seconds

  while (Date.now() - phase2StartTime < phase2Timeout) {
    const phase2StartEvent = testState.client
      .getEvents()
      .find((e) => e.type === "phase.started" && e.data.phaseId === "phase-2");

    if (phase2StartEvent && phase2StartEvent.type === "phase.started") {
      testState.phase2Started = phase2StartEvent;
      console.log(`${colors.green}✓ Phase 2 started${colors.reset}`);
      break;
    }

    // Wait 100ms before checking again
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!testState.phase2Started) {
    console.log(`${colors.red}✗ Phase 2 did not start${colors.reset}`);
  }

  testState.phase2Completed = await testState.client.waitForPhaseCompletion("phase-2", 60000);
  console.log(`${colors.green}✓ Phase 2 completed${colors.reset}`);

  // Phase 3
  // Wait for phase 3 to start (it should auto-start after phase 2)
  // We'll poll for the event with a timeout
  const phase3StartTime = Date.now();
  const phase3Timeout = 10000; // 10 seconds

  while (Date.now() - phase3StartTime < phase3Timeout) {
    const phase3StartEvent = testState.client
      .getEvents()
      .find((e) => e.type === "phase.started" && e.data.phaseId === "phase-3");

    if (phase3StartEvent && phase3StartEvent.type === "phase.started") {
      testState.phase3Started = phase3StartEvent;
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

  // Wait for sync client background collection to complete
  // The promise resolves when RunCompleted is received (after all phases finish)
  if (testState.syncClient) {
    try {
      const { historyEvents, liveEvents } = await syncClientEventCollection;
      testState.historyEvents = historyEvents;
      // Filter out Connection State Events - only keep events that are persisted to journal
      testState.liveEvents = liveEvents.filter(isJournaledEvent);
    } catch (error) {
      console.warn(
        `${colors.yellow}Sync client collection timed out or errored: ${error}${colors.reset}`,
      );
    }
  }

  // Store all events for tests
  testState.events = testState.client.getEvents();

  // Extract error events for specific error testing
  testState.errorEvents = testState.events.filter((e) => e.type === "error") as ErrorEvent[];

  // Run checkpoint validation BEFORE cleanup can happen
  console.log(`\n${colors.blue}Validating checkpoint system...${colors.reset}`);
  await validateCheckpointSystem();

  // Populate state-based fields from state.json in execution directory
  console.log(`\n${colors.blue}Reading state from state.json...${colors.reset}`);
  try {
    if (testState.executionPath) {
      testState.completedPhases = await getCompletedPhasesFromState(testState.executionPath);
      testState.totalCost = await getTotalCostFromState(testState.executionPath);
      console.log(`${colors.green}✓ State data loaded from state.json${colors.reset}`);
      console.log(`  - Completed phases: ${testState.completedPhases.length}`);
      console.log(`  - Total cost: $${testState.totalCost.toFixed(6)}`);
    }
  } catch (error) {
    console.error(`${colors.red}Failed to load state data: ${error}${colors.reset}`);
  }
}

// Validate checkpoint system while it still exists
async function validateCheckpointSystem(): Promise<void> {
  if (!testState.executionPath) {
    console.error(
      `${colors.red}No execution path available for checkpoint validation${colors.reset}`,
    );
    return;
  }

  const checkpointDir = path.join(testState.executionPath, ".tadpole/checkpoints");
  const gitDir = path.join(checkpointDir, ".git");

  // Store validation results for tests
  testState.checkpointValidation = {
    checkpointDirExists: fs.existsSync(checkpointDir),
    gitDirExists: fs.existsSync(gitDir),
    commitMessages: [],
    branches: [],
    trackedFiles: [],
  };

  if (testState.checkpointValidation.gitDirExists) {
    const { execSync } = await import("node:child_process");

    try {
      // Get commit messages
      const gitLog = execSync("git log --pretty=format:%s", {
        cwd: testState.executionPath,
        env: {
          ...process.env,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: testState.executionPath,
        },
        encoding: "utf-8",
      });
      testState.checkpointValidation.commitMessages = gitLog
        .trim()
        .split("\n")
        .filter((msg) => msg);
    } catch (error) {
      console.error(`Git log failed: ${error}`);
    }

    try {
      // Get branches
      const gitBranches = execSync("git branch", {
        cwd: testState.executionPath,
        env: {
          ...process.env,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: testState.executionPath,
        },
        encoding: "utf-8",
      });
      testState.checkpointValidation.branches = gitBranches
        .trim()
        .split("\n")
        .map((b) => b.trim());
    } catch (error) {
      console.error(`Git branch failed: ${error}`);
    }

    try {
      // Get tracked files - but exclude read_only_data_source directory
      const gitFiles = execSync("git ls-files", {
        cwd: testState.executionPath,
        env: {
          ...process.env,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: testState.executionPath,
        },
        encoding: "utf-8",
      });
      testState.checkpointValidation.trackedFiles = gitFiles.trim()
        ? gitFiles
            .trim()
            .split("\n")
            .filter((f) => f && !f.startsWith("read_only_data_source/"))
        : [];
    } catch (error) {
      console.error(`Git ls-files failed: ${error}`);
    }
  }

  console.log(`${colors.green}✓ Checkpoint validation complete${colors.reset}`);
}

// ============================================================================
// Cleanup Functions - Updated for execution isolation
// ============================================================================

// This function only shuts down the server and saves results
async function shutdownServer(): Promise<void> {
  // Disconnect sync client if connected
  if (
    testState.syncClient &&
    (testState.syncClient.readyState === WebSocket.OPEN ||
      testState.syncClient.readyState === WebSocket.CONNECTING)
  ) {
    testState.syncClient.close();
    console.log(`${colors.gray}✓ Sync client disconnected${colors.reset}`);
  }

  // Only shutdown if not already done
  if (testState.serverProcess || testState.client?.isConnected) {
    await cleanupTest({
      testDir: testState.executionPath || path.dirname(DATA_SOURCE_FILE),
      testRunDir: TEST_RUN_DIR,
      serverProcess: testState.serverProcess,
      client: testState.client,
      events: testState.events,
      gracefulShutdown: true,
    });
  }
}

// This function runs the full cleanup (removes execution directory)
async function runFullCleanup(): Promise<void> {
  // First ensure server is shut down
  await shutdownServer();

  // Use the cleanup integration to clean execution directory
  console.log(`\n${colors.blue}Running cleanup integration...${colors.reset}`);

  // Clean up tadpole-results directory if it exists
  if (fs.existsSync(tadpoleResultsDir)) {
    fs.rmSync(tadpoleResultsDir, { recursive: true, force: true });
  }

  const cleanupResult = await executeTestCleanup({
    executionPath: testState.executionPath,
    dataSourcePath: DATA_SOURCE_FILE,
    // Don't clean up data source file - we need to verify it
    skipConfirmation: true,
    force: true, // Force cleanup even if there are errors
  });

  logCleanupResults(cleanupResult, true); // Verbose output for tests

  // Store cleanup result for verification
  testState.cleanupResult = cleanupResult;
}

// ============================================================================
// Run setup before tests
// ============================================================================

console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}`);
console.log(
  `${colors.blue}Tadpole Server End-to-End Test (with Execution Isolation)${colors.reset}`,
);
console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

// This runs before any tests
await setupAndRunPhases();

// ============================================================================
// Now run the actual tests using Bun's test framework
// NOTE: Many test groups need updates to use testState.executionPath
// ============================================================================

describe("Tadpole E2E Test", () => {
  describe("Phase Execution", () => {
    runPhaseExecutionTests(testState);
  });

  describe("Tadpole results", () => {
    it("should contain favorite_poem.txt", () => {
      expect(fs.existsSync(path.join(tadpoleResultsDir, "notes", "favorite_poem.txt"))).toBe(true);
    });

    it("should NOT contain second_favorite_poem.txt because beforeCopy fails", () => {
      expect(fs.existsSync(path.join(tadpoleResultsDir, "notes", "second_favorite_poem.txt"))).toBe(
        false,
      );
    });

    it("should have executed beforeCopy command for phase-1", () => {
      if (!testState.executionPath) {
        throw new Error("Execution path not available");
      }

      // Check that the beforeCopy command created the log file in the execution directory
      const beforeCopyLogPath = path.join(testState.executionPath, "notes", "beforecopy_log.txt");
      expect(fs.existsSync(beforeCopyLogPath)).toBe(true);

      // Check the content of the log file
      const logContent = fs.readFileSync(beforeCopyLogPath, "utf-8");
      expect(logContent).toContain("Before copy command executed for phase-1");
    });
  });

  describe("Wordsworth Content Validation", () => {
    describe("should find Wordsworth references in generated content", () => {
      it("should find 'wordsworth' in assistant messages", () => {
        const assistantMessages = testState.events
          .filter((e) => e.type === "assistant.action")
          .map((e) => e.data.content?.toLowerCase() || "");

        const hasWordsworth = assistantMessages.some((content) => content.includes("wordsworth"));

        expect(hasWordsworth).toBe(true);
      });

      it("should find 'wordsworth' in generated poem files", async () => {
        if (!testState.executionPath) {
          throw new Error("Execution path not available");
        }

        const notesDir = path.join(testState.executionPath, "notes");
        expect(fs.existsSync(notesDir)).toBe(true);

        // Check for poem files in notes directory
        const files = fs.readdirSync(notesDir);
        const poemFiles = files.filter((f) => f.endsWith(".txt") || f.endsWith(".md"));

        expect(poemFiles.length).toBeGreaterThan(0);

        let foundWordsworth = false;
        for (const file of poemFiles) {
          const filePath = path.join(notesDir, file);
          const content = fs.readFileSync(filePath, "utf-8").toLowerCase();
          if (content.includes("wordsworth")) {
            foundWordsworth = true;
            break;
          }
        }

        expect(foundWordsworth).toBe(true);
      });

      it("should find 'wordsworth' in TypeScript code files", async () => {
        if (!testState.executionPath) {
          throw new Error("Execution path not available");
        }

        const tsCodeDir = path.join(testState.executionPath, "typescript_code/src");
        if (fs.existsSync(tsCodeDir)) {
          const files = fs.readdirSync(tsCodeDir);
          const tsFiles = files.filter((f) => f.endsWith(".ts"));

          if (tsFiles.length > 0) {
            let foundWordsworth = false;
            for (const file of tsFiles) {
              const filePath = path.join(tsCodeDir, file);
              const content = fs.readFileSync(filePath, "utf-8").toLowerCase();
              if (content.includes("wordsworth")) {
                foundWordsworth = true;
                break;
              }
            }

            expect(foundWordsworth).toBe(true);
          }
        }
      });

      it("should verify data source file is accessible in execution", async () => {
        if (!testState.executionPath) {
          throw new Error("Execution path not available");
        }

        // Check that the poem_guides.txt file is accessible in read_only_data_source
        const dataSourcePath = path.join(
          testState.executionPath,
          "read_only_data_source",
          "poem_guides.txt",
        );
        expect(fs.existsSync(dataSourcePath)).toBe(true);

        const content = fs.readFileSync(dataSourcePath, "utf-8").toLowerCase();
        expect(content).toContain("she dwelt among the untrodden ways");
        expect(content).toContain("lucy");
      });
    });
  });

  describe("File System State", () => {
    // Pass execution path instead of data source path
    runFileSystemTests(testState, testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("Log Files", () => {
    runLogFilesTests(testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("Event Journal", () => {
    runEventJournalTests(testState);
  });

  describe("History Sync", () => {
    it("should start with RunStarted state transition", () => {
      expect(testState.historyEvents.length).toBeGreaterThan(0);

      const firstEvent = testState.historyEvents[0];
      expect(firstEvent.type).toBe("state.transition");
      if (firstEvent.type === "state.transition") {
        expect(firstEvent.data.transitionType).toBe("RunStarted");
      }
    });

    it("should have phase-1 completion as last history event", () => {
      // The sync client was started after Phase 1 completed
      // So the last history event should be phase-1's completion
      expect(testState.historyEvents.length).toBeGreaterThan(0);

      const lastHistoryEvent = testState.historyEvents[testState.historyEvents.length - 1];
      expect(lastHistoryEvent.type).toBe("phase.completed");
      if (lastHistoryEvent.type === "phase.completed") {
        expect(lastHistoryEvent.data.phaseId).toBe("phase-1");
      }
    });
  });

  describe("Cost Tracking", () => {
    runCostTrackingTests(testState, testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("Token Usage", () => {
    runTokenUsageTests(testState, testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("File Content", () => {
    runFileContentTests(testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("File Watching", () => {
    runFileWatchingTests(testState);
  });

  describe("Phase Timing", () => {
    runPhaseTimingTests(testState);
  });

  describe("Session Continuity", () => {
    runSessionContinuityTests(testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("File Tree", () => {
    runFileTreeTests(testState, testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("Info Events", () => {
    runInfoEventsTests(testState);
  });

  describe("Pre-start Commands", () => {
    runPreStartCommandsTests(testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("Tool Usage", () => {
    runToolUsageTests(testState, testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("Tool Results", () => {
    runToolResultTests(testState);
  });

  describe("State Snapshot", () => {
    runStateSnapshotTests(testState);
  });

  describe("Server State", () => {
    runServerStateTests(testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("JSONL Schema", () => {
    runJSONLSchemaTests(testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("Path Consistency", () => {
    runPathConsistencyTests(testState);
  });

  describe("Checkpoint System", () => {
    runCheckpointSystemTests(testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("Message Ordering", () => {
    runMessageOrderingTests(testState);
  });

  // New test groups
  describe("Checkpoint Exclusion", () => {
    runCheckpointExclusionTests(testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("File Watching - Negative Cases", () => {
    runFileWatchingNegativeTests(testState);
  });

  describe("Resource Cleanup", () => {
    runResourceCleanupTests(testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("Event Integrity", () => {
    runEventIntegrityTests(testState);
  });

  describe("State Consistency", () => {
    runStateConsistencyTests(testState);
  });

  describe("Dual ID System", () => {
    runDualIdSystemTests(testState);
  });

  describe("Early Phase Failures", () => {
    runEarlyPhaseFailureTests(testState);
  });

  describe("Log Ordering", () => {
    runLogOrderingTests(testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("Security Validation", () => {
    runSecurityValidationTests(
      testState,
      testState.executionPath || path.dirname(DATA_SOURCE_FILE),
    );
  });

  describe("Performance", () => {
    runPerformanceTests(testState);
  });

  describe("Cost Precision", () => {
    runCostPrecisionTests(testState);
  });

  describe("File System Edge Cases", () => {
    runFileSystemEdgeCasesTests(
      testState,
      testState.executionPath || path.dirname(DATA_SOURCE_FILE),
    );
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
    runLockFileTests(testState, testState.executionPath || path.dirname(DATA_SOURCE_FILE));
  });

  describe("Error Event Metadata", () => {
    runErrorEventTests(testState);
  });

  describe("Chronicler Integration", () => {
    runChroniclerIntegrationTests(testState);
  });

  // Cleanup after all tests - Updated for execution isolation
  afterAll(async () => {
    // First shutdown the server if needed
    if (!testState.cleanupResult) {
      await shutdownServer();
    }

    // Now run the full cleanup and verify it worked
    console.log(`\n${colors.blue}Running final cleanup...${colors.reset}`);

    if (!testState.cleanupResult) {
      await runFullCleanup();
    }

    // Verify cleanup worked correctly
    if (testState.cleanupResult) {
      console.log(`\n${colors.blue}Verifying cleanup results...${colors.reset}`);

      // Check if cleanup was successful
      expect(testState.cleanupResult.success).toBe(true);

      // Verify directories were removed
      expect(testState.cleanupResult.directoriesRemoved.length).toBeGreaterThan(0);

      // Should have removed execution directory
      if (testState.executionPath) {
        const executionBasename = path.basename(testState.executionPath);
        expect(
          testState.cleanupResult.directoriesRemoved.some((d) => d.includes(executionBasename)),
        ).toBe(true);
      }

      // With execution isolation, the data source file remains untouched
      // All files are created in the execution directory, not the data source
      // So we just verify the data source file still exists (untouched)
      if (fs.existsSync(DATA_SOURCE_FILE)) {
        // Data source file should exist
        const dataSourceStats = fs.statSync(DATA_SOURCE_FILE);
        expect(dataSourceStats.isFile()).toBe(true);
      }

      // Verify execution directory is gone
      if (testState.executionPath) {
        expect(fs.existsSync(testState.executionPath)).toBe(false);
      }

      console.log(`${colors.green}✓ Cleanup verification complete${colors.reset}`);
    }
  });
});
