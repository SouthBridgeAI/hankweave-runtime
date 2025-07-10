#!/usr/bin/env bun
import { afterAll, describe, expect } from "bun:test";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { isErrorEvent, isPhaseStartedEvent } from "../../server/type-guards.js";
import {
  type CleanupIntegrationResult,
  executeTestCleanup,
  logCleanupResults,
} from "../utils/cleanup-integration.js";
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
import { runDualIdSystemTests } from "./test-groups/dual-id-system-tests.js";
import { runEarlyPhaseFailureTests } from "./test-groups/early-phase-failure-tests.js";
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
// Use __dirname to ensure we're always relative to this test file
const TEST_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const TEST_DIR = path.join(TEST_ROOT, "tests/test-area/happy-path");
const TEST_RESULTS_DIR = path.join(TEST_ROOT, "tests/test-results");
const SERVER_PORT = parseInt(process.env.LANGTON_TEST_PORT || "7780");
const PHASES_CONFIG = path.join(TEST_ROOT, "tests/config/test-phases.config.json");

// Generate timestamp for this test run
const TEST_TIMESTAMP = generateTestTimestamp();
const TEST_RUN_DIR = path.join(TEST_RESULTS_DIR, `run-${TEST_TIMESTAMP}`);

// Import types from the server
import type {
  ErrorEvent,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
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
  errorEvents: ErrorEvent[];
  testStartTime: number;
  cleanupResult?: CleanupIntegrationResult;
  checkpointValidation?: {
    checkpointDirExists: boolean;
    gitDirExists: boolean;
    commitMessages: string[];
    branches: string[];
    trackedFiles: string[];
  };
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
  errorEvents: [],
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
  const phase1StartEvent = await testState.client.waitForEvent("phase.started", 10000);
  if (!isPhaseStartedEvent(phase1StartEvent)) {
    throw new Error("Expected phase.started event for phase 1");
  }
  testState.phase1Started = phase1StartEvent;
  console.log(`${colors.green}✓ Phase 1 started${colors.reset}`);

  testState.phase1Completed = await testState.client.waitForPhaseCompletion("phase-1", 60000);
  console.log(`${colors.green}✓ Phase 1 completed${colors.reset}`);

  // Phase 2
  // Wait a moment for phase 2 to auto-start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const phase2StartEvent = testState.client
    .getEvents()
    .find((e) => isPhaseStartedEvent(e) && e.data.phaseId === "phase-2");

  if (!phase2StartEvent || !isPhaseStartedEvent(phase2StartEvent)) {
    console.log(`${colors.red}✗ Phase 2 did not start${colors.reset}`);
    testState.phase2Started = null;
  } else {
    testState.phase2Started = phase2StartEvent;
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
    const phase3StartEvent = testState.client
      .getEvents()
      .find((e) => isPhaseStartedEvent(e) && e.data.phaseId === "phase-3");

    if (phase3StartEvent && isPhaseStartedEvent(phase3StartEvent)) {
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

  // Give a moment for final events
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Store all events for tests
  testState.events = testState.client.getEvents();

  // Extract error events for specific error testing
  testState.errorEvents = testState.events.filter((e) => isErrorEvent(e));

  // Run checkpoint validation BEFORE cleanup can happen
  console.log(`\n${colors.blue}Validating checkpoint system...${colors.reset}`);
  await validateCheckpointSystem();
}

// Validate checkpoint system while it still exists
// IMPORTANT: This function captures git repository data before cleanup runs.
//
// ## Why this pattern exists:
//
// We discovered that Bun's test execution order isn't guaranteed between describe
// blocks, so the cleanup in afterAll() could run before the checkpoint tests,
// causing failures. By capturing the data here and storing it in testState, we
// ensure tests can validate the git repository state even after cleanup has
// removed the actual .langton directory.
//
// ## Pattern for other tests:
//
// 1. Create a validation function that captures state into testState
// 2. Call it at the end of test execution (before afterAll)
// 3. Tests can then safely use testState.validationData
// 4. This works because describe() blocks run after the main test code
async function validateCheckpointSystem(): Promise<void> {
  const checkpointDir = path.join(TEST_DIR, ".langton/checkpoints");
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
        cwd: TEST_DIR,
        env: {
          ...process.env,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: TEST_DIR,
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
        cwd: TEST_DIR,
        env: {
          ...process.env,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: TEST_DIR,
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
      // Get tracked files
      const gitFiles = execSync("git ls-files", {
        cwd: TEST_DIR,
        env: {
          ...process.env,
          GIT_DIR: gitDir,
          GIT_WORK_TREE: TEST_DIR,
        },
        encoding: "utf-8",
      });
      testState.checkpointValidation.trackedFiles = gitFiles.trim()
        ? gitFiles
            .trim()
            .split("\n")
            .filter((f) => f)
        : [];
    } catch (error) {
      console.error(`Git ls-files failed: ${error}`);
    }
  }

  console.log(`${colors.green}✓ Checkpoint validation complete${colors.reset}`);
}

// ============================================================================
// Cleanup Functions - Separated for proper test execution order
// ============================================================================
//
// IMPORTANT: Test cleanup follows a specific pattern to avoid race conditions:
//
// 1. Server shutdown and file cleanup are SEPARATED
//    - shutdownServer() only stops the server process
//    - runFullCleanup() removes files and directories
//    - This prevents "file not found" errors during test assertions
//
// 2. Cleanup runs in afterAll(), not in the main test flow
//    - Ensures tests can verify files before they're deleted
//    - Guarantees cleanup even if tests fail
//
// 3. Force mode is used for e2e tests
//    - If CleanupCommand fails (e.g., git issues), falls back to manual cleanup
//    - Ensures test isolation even in error scenarios
//
// 4. Test directories are isolated
//    - Each test uses its own subdirectory (e.g., test-area/happy-path)
//    - Prevents conflicts when tests run in parallel
// ============================================================================

// This function only shuts down the server and saves results
async function shutdownServer(): Promise<void> {
  // Only shutdown if not already done
  if (testState.serverProcess || testState.client?.isConnected) {
    await cleanupTest({
      testDir: TEST_DIR,
      testRunDir: TEST_RUN_DIR,
      serverProcess: testState.serverProcess,
      client: testState.client,
      events: testState.events,
      gracefulShutdown: true,
    });
  }
}

// This function runs the full cleanup (removes files)
async function runFullCleanup(): Promise<void> {
  // First ensure server is shut down
  await shutdownServer();

  // Use the cleanup integration to clean test artifacts
  console.log(`\n${colors.blue}Running cleanup integration...${colors.reset}`);

  const cleanupResult = await executeTestCleanup({
    testDir: TEST_DIR,
    phasesConfig: PHASES_CONFIG,
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

  describe("Dual ID System", () => {
    runDualIdSystemTests(testState);
  });

  describe("Early Phase Failures", () => {
    runEarlyPhaseFailureTests(testState);
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
//
// ## Cleanup Integration Pattern
//
// This afterAll() block demonstrates the standard cleanup pattern for e2e tests:
//
// 1. **Conditional execution**: Only runs if not already done
// 2. **Two-phase cleanup**: Server shutdown, then file removal
// 3. **Force mode**: Uses force=true to handle git failures
// 4. **Verification**: Tests that cleanup actually worked
//
// ## What gets verified:
//
// - Cleanup success (allowing for git errors with force mode)
// - Expected directories were removed (typescript_code, .langton)
// - Only expected files remain (notes/, maybe untracked.txt)
// - No .langton directory remains
//
// ## Edge cases handled:
//
// - untracked.txt: Created by checkpoint exclusion tests
// - notes/: Created by command, not workspace setup, so preserved
// - Git failures: Force mode ensures cleanup continues
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
    if (testState.cleanupResult.errors.length === 0) {
      expect(testState.cleanupResult.success).toBe(true);
    }

    // Verify directories were removed
    expect(testState.cleanupResult.directoriesRemoved.length).toBeGreaterThan(0);
    const removedDirs = testState.cleanupResult.directoriesRemoved;
    expect(removedDirs.some((d) => d === "typescript_code" || d.includes("typescript_code"))).toBe(
      true,
    );
    expect(removedDirs.some((d) => d === ".langton" || d.includes(".langton"))).toBe(true);

    // Verify test directory state
    const testDirContents = fs.readdirSync(TEST_DIR);
    const visibleFiles = testDirContents.filter((f) => !f.startsWith("."));
    // Should only have 'notes' directory (created by command, not workspace setup)
    // and possibly 'untracked.txt' from checkpoint exclusion tests
    const expectedFiles = ["notes"];
    if (visibleFiles.includes("untracked.txt")) {
      expectedFiles.push("untracked.txt");
    }
    expect(visibleFiles.sort()).toEqual(expectedFiles.sort());

    // Verify .langton directory is gone
    const langtonDir = path.join(TEST_DIR, ".langton");
    expect(fs.existsSync(langtonDir)).toBe(false);

    console.log(`${colors.green}✓ Cleanup verification complete${colors.reset}`);
  }
});
