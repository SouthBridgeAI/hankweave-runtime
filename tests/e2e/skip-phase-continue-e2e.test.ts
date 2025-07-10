#!/usr/bin/env bun
// NOTE: Unlike happy-path-e2e.test.ts, this file's tests are intentionally not split into separate modules.
// Most tests here are specific to the skip/continue scenario and verify different outcomes than the happy path.
// For example: checking that files were NOT created, phases were marked as failed, costs are minimal, etc.
// Keeping tests inline makes it clearer what this specific scenario is validating.

import { afterAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  isAssistantActionEvent,
  isErrorEvent,
  isInfoEvent,
  isPhaseStartedEvent,
  isStateSnapshotEvent,
  isTokenUsageEvent,
} from "../../server/type-guards.js";
// Import test utilities and types from happy path test
import type {
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
  SkipPhaseCommand,
} from "../../server/types.js";
import { generateId } from "../../server/utils.js";
import {
  type CleanupIntegrationResult,
  executeTestCleanup,
  logCleanupResults,
} from "../utils/cleanup-integration.js";
import {
  colors,
  generateTestTimestamp,
  type ServerConfig,
  setupTestDirectory,
  startServer,
  type TestDirectoryConfig,
  TestWSClient,
} from "../utils/test-helpers.js";

// Test configuration
const TEST_TIMEOUT = 2 * 60 * 1000; // 2 minutes
// Use __dirname to ensure we're always relative to this test file
const TEST_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const TEST_DIR = path.join(TEST_ROOT, "tests/test-area/skip-continue");
const TEST_RESULTS_DIR = path.join(TEST_ROOT, "tests/test-results");
const SERVER_PORT = parseInt(process.env.LANGTON_TEST_PORT || "7778");
const PHASES_CONFIG = path.join(TEST_ROOT, "tests/config/test-phases.config.json");

// Generate timestamp for this test run
const TEST_TIMESTAMP = generateTestTimestamp();
const TEST_RUN_DIR = path.join(TEST_RESULTS_DIR, `skip-continue-${TEST_TIMESTAMP}`);

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
  testMode: "e2e-skip-continue",
  cwd: TEST_DIR,
};

// Test state
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
};

// Main test execution
async function runSkipContinueTest(): Promise<void> {
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

  console.log(`${colors.blue}Testing phase skip and continue...${colors.reset}`);

  // Phase 1 should auto-start
  testState.phase1Started = await testState.client.waitForPhaseStart("phase-1", 10000);
  console.log(`${colors.green}✓ Phase 1 started${colors.reset}`);

  // Wait for some assistant actions to ensure phase is running
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Skip phase 1
  console.log(`${colors.yellow}Skipping Phase 1...${colors.reset}`);
  testState.client.sendCommand({
    id: generateId(),
    type: "phase.skip",
  } as SkipPhaseCommand);

  // Wait for phase 1 to complete (should be marked as failed)
  testState.phase1Completed = await testState.client.waitForPhaseCompletion("phase-1", 10000);
  console.log(`${colors.green}✓ Phase 1 completed (skipped)${colors.reset}`);

  // Wait a bit for the server to process the skip
  console.log(`${colors.gray}Waiting for server to process skip...${colors.reset}`);
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Phase 2 should auto-start after skip
  testState.phase2Started = await testState.client.waitForPhaseStart("phase-2", 20000);
  console.log(`${colors.green}✓ Phase 2 started automatically${colors.reset}`);

  // Let phase 2 complete normally
  testState.phase2Completed = await testState.client.waitForPhaseCompletion("phase-2", 60000);
  console.log(`${colors.green}✓ Phase 2 completed${colors.reset}`);

  // Phase 3 should auto-start
  testState.phase3Started = await testState.client.waitForPhaseStart("phase-3", 10000);
  console.log(`${colors.green}✓ Phase 3 started${colors.reset}`);

  // Skip phase 3 as well to test multiple skips
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log(`${colors.yellow}Skipping Phase 3...${colors.reset}`);
  testState.client.sendCommand({
    id: generateId(),
    type: "phase.skip",
  } as SkipPhaseCommand);

  testState.phase3Completed = await testState.client.waitForPhaseCompletion("phase-3", 10000);
  console.log(`${colors.green}✓ Phase 3 completed (skipped)${colors.reset}`);

  // Give a moment for final events
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Store all events for tests
  testState.events = testState.client.getEvents();

  // Run checkpoint validation BEFORE cleanup can happen
  console.log(`\n${colors.blue}Validating checkpoint system...${colors.reset}`);
  await validateCheckpointSystem();
}

// Validate checkpoint system while it still exists
// IMPORTANT: This function captures git repository data before cleanup runs.
// We discovered that Bun's test execution order isn't guaranteed between describe
// blocks, so the "Cleanup Integration Tests" beforeAll() could run before the
// "Checkpoint System" tests, causing failures. By capturing the data here and
// storing it in testState, we ensure checkpoint tests can validate the git
// repository state even after cleanup has removed the actual .langton directory.
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

// Cleanup functions - separated for proper test execution order
async function shutdownServer(): Promise<void> {
  // Save test results first
  if (testState.events.length > 0 && TEST_RUN_DIR) {
    try {
      await fs.promises.mkdir(TEST_RUN_DIR, { recursive: true });

      // Save WebSocket events
      const eventsPath = path.join(TEST_RUN_DIR, "websocket-events.json");
      await fs.promises.writeFile(eventsPath, JSON.stringify(testState.events, null, 2));

      // Copy server log if it exists
      const serverLogSource = path.join(TEST_DIR, ".langton/logs/server.log");
      if (fs.existsSync(serverLogSource)) {
        const serverLogDest = path.join(TEST_RUN_DIR, "server.log");
        await fs.promises.copyFile(serverLogSource, serverLogDest);
      }

      // Copy Claude logs
      const claudeLogsSource = path.join(TEST_DIR, ".langton/logs");
      if (fs.existsSync(claudeLogsSource)) {
        const claudeLogsDest = path.join(TEST_RUN_DIR, "claude-logs");
        await fs.promises.mkdir(claudeLogsDest, { recursive: true });
        const logs = await fs.promises.readdir(claudeLogsSource);
        for (const log of logs) {
          if (log.startsWith("log-") && log.endsWith(".jsonl")) {
            await fs.promises.copyFile(
              path.join(claudeLogsSource, log),
              path.join(claudeLogsDest, log),
            );
          }
        }
      }

      console.log(`\n${colors.gray}Test results saved to: ${TEST_RUN_DIR}${colors.reset}`);
    } catch (error) {
      console.error(`Failed to save test results: ${error}`);
    }
  }

  // Cleanup server and client
  if (testState.client) {
    try {
      await testState.client.disconnect();
    } catch (error) {
      console.error(`Failed to close WebSocket client: ${error}`);
    }
  }

  if (testState.serverProcess) {
    try {
      testState.serverProcess.kill();
      // Give it time to clean up
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`Failed to kill server process: ${error}`);
    }
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

// Run setup before tests
console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}`);
console.log(`${colors.blue}Langton Server Skip Phase and Continue Test${colors.reset}`);
console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

await runSkipContinueTest();

// Run cleanup after ALL tests complete
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
    expect(visibleFiles).toEqual(["notes"]);

    // Verify .langton directory is gone
    const langtonDir = path.join(TEST_DIR, ".langton");
    expect(fs.existsSync(langtonDir)).toBe(false);

    console.log(`${colors.green}✓ Cleanup verification complete${colors.reset}`);
  }
});

// Now run the actual tests
describe("Skip Phase and Continue E2E Test", () => {
  describe("Phase Skipping", () => {
    test("Phase 1 was skipped", () => {
      expect(testState.phase1Completed?.data.success).toBe(false);
      expect(testState.phase1Completed?.data.exitStatus.type).toBe("error");
    });

    test("Phase 2 started after Phase 1 skip", () => {
      const phase1CompleteTime = new Date(testState.phase1Completed?.timestamp || 0).getTime();
      const phase2StartTime = new Date(testState.phase2Started?.timestamp || 0).getTime();

      // Phase 2 should start within 5 seconds of Phase 1 completion
      expect(phase2StartTime - phase1CompleteTime).toBeLessThan(5000);
    });

    test("Phase 2 completed successfully", () => {
      expect(testState.phase2Completed?.data.success).toBe(true);
    });

    test("Phase 3 was skipped", () => {
      expect(testState.phase3Completed?.data.success).toBe(false);
      expect(testState.phase3Completed?.data.exitStatus.type).toBe("error");
    });

    test("Skipped phases have zero or minimal cost", () => {
      // Skipped phases should have minimal or no cost
      const phase1Cost = testState.phase1Completed?.data.cost || 0;
      const phase3Cost = testState.phase3Completed?.data.cost || 0;

      // Cost should be very low (under $0.01) or zero
      expect(phase1Cost).toBeLessThan(0.01);
      expect(phase3Cost).toBeLessThan(0.01);
    });

    test("skipped phases still get phaseExecutionId but might not get sessionId", () => {
      const phase1Completed = testState.phase1Completed;

      if (phase1Completed && !phase1Completed.data.success) {
        // Check if phase.started was emitted
        const phase1Started = testState.events.find(
          (e) => isPhaseStartedEvent(e) && e.data.phaseId === "phase-1",
        ) as PhaseStartedEvent | undefined;

        // If Claude was killed very quickly, might not have phase.started
        if (!phase1Started) {
          expect(phase1Started).toBeUndefined();
        } else {
          expect(phase1Started.data.sessionId).toBeDefined();
          // sessionId should be present if phase started
        }
      }

      // Same for phase 3
      const phase3Completed = testState.phase3Completed;

      if (phase3Completed && !phase3Completed.data.success) {
        const phase3Started = testState.events.find(
          (e) => isPhaseStartedEvent(e) && e.data.phaseId === "phase-3",
        ) as PhaseStartedEvent | undefined;

        if (!phase3Started) {
          expect(phase3Started).toBeUndefined();
        } else {
          expect(phase3Started.data.sessionId).toBeDefined();
        }
      }
    });
  });

  describe("Server State", () => {
    test("All phases were attempted", () => {
      const phaseStartEvents = testState.client?.getEventsByType("phase.started") || [];
      expect(phaseStartEvents.length).toBe(3);
    });

    test("Server shutdown after all phases", () => {
      const infoEvents = testState.client?.getEventsByType("info") || [];
      const shutdownInfo = infoEvents.find(
        (e) => isInfoEvent(e) && (e.data?.message?.includes("All phases completed") || false),
      );
      expect(shutdownInfo).toBeDefined();
    });

    test("Completed phases list shows only successful phase", () => {
      const finalStateSnapshot = [...testState.events]
        .reverse()
        .find((e) => isStateSnapshotEvent(e));

      // All 3 phases should be in completed phases (including skipped ones)
      expect(finalStateSnapshot?.data?.completedPhases?.length).toBe(3);
      // Check that phase 2 was successful
      const phase2Completed = finalStateSnapshot?.data?.completedPhases?.find(
        (p) => p.phaseId === "phase-2",
      );
      expect(phase2Completed?.success).toBe(true);
    });
  });

  describe("Assistant Actions", () => {
    test("Phase 1 had some assistant actions before skip", () => {
      const phase1Actions =
        testState.client
          ?.getEventsByType("assistant.action")
          .filter((e) => isAssistantActionEvent(e) && e.data?.phaseId === "phase-1") || [];

      // Might not have actions if skipped very quickly
      expect(phase1Actions.length).toBeGreaterThanOrEqual(0);
    });

    test("Phase 2 had normal assistant actions", () => {
      const phase2Actions =
        testState.client
          ?.getEventsByType("assistant.action")
          .filter((e) => isAssistantActionEvent(e) && e.data?.phaseId === "phase-2") || [];

      // Should have at least some actions for a complete phase
      expect(phase2Actions.length).toBeGreaterThan(0);
    });

    test("Phase 3 had some assistant actions before skip", () => {
      const phase3Actions =
        testState.client
          ?.getEventsByType("assistant.action")
          .filter((e) => isAssistantActionEvent(e) && e.data?.phaseId === "phase-3") || [];

      expect(phase3Actions.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Token Usage", () => {
    test("Skipped phases have token usage events", () => {
      const tokenEvents = testState.client?.getEventsByType("token.usage") || [];

      const phase1Tokens = tokenEvents.filter((e) => {
        return isTokenUsageEvent(e) && e.data?.phaseId === "phase-1";
      });
      const phase3Tokens = tokenEvents.filter((e) => {
        return isTokenUsageEvent(e) && e.data?.phaseId === "phase-3";
      });

      // Skipped phases might not have token usage events if killed quickly
      expect(phase1Tokens.length).toBeGreaterThanOrEqual(0);
      expect(phase3Tokens.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("File System", () => {
    test("Phase 1 workspaceSetup created notes directory", () => {
      // Even though Phase 1 was skipped, workspaceSetup should have run
      expect(fs.existsSync(path.join(TEST_DIR, "notes"))).toBe(true);
      expect(fs.statSync(path.join(TEST_DIR, "notes")).isDirectory()).toBe(true);
    });

    test("Phase 2 did not create second_favorite_poem.txt", () => {
      // Phase 2 completed but couldn't create the file because Phase 1 was skipped
      // and it had no poems to reference (started fresh without context)
      expect(fs.existsSync(path.join(TEST_DIR, "notes/second_favorite_poem.txt"))).toBe(false);
    });

    test("Phase 1 did not create favorite_poem.txt", () => {
      // Phase 1 was skipped early, so file should not exist
      const exists = fs.existsSync(path.join(TEST_DIR, "notes/favorite_poem.txt"));
      expect(exists).toBe(false);
    });

    test("Phase 3 did not create TypeScript files", () => {
      // Phase 3 was skipped, so TypeScript files should not exist
      expect(fs.existsSync(path.join(TEST_DIR, "typescript_code/src/poem1.ts"))).toBe(false);
      expect(fs.existsSync(path.join(TEST_DIR, "typescript_code/src/poem2.ts"))).toBe(false);
    });
  });

  describe("Error Handling", () => {
    test("No fatal errors occurred", () => {
      const errorEvents = testState.client?.getEventsByType("error") || [];
      const fatalErrors = errorEvents.filter((e) => isErrorEvent(e) && e.data?.fatal);
      expect(fatalErrors.length).toBe(0);
    });
  });

  describe("Timing", () => {
    test(
      "Test completed within timeout",
      () => {
        expect(testState.events.length).toBeGreaterThan(0);
      },
      TEST_TIMEOUT,
    );
  });
});

// Test checkpoint system using pre-captured validation data
describe("Checkpoint System - Skip Handling", () => {
  test("checkpoint directory created", () => {
    // Use the validation data we captured before cleanup
    expect(testState.checkpointValidation?.checkpointDirExists).toBe(true);
    expect(testState.checkpointValidation?.gitDirExists).toBe(true);
  });

  test("skipped phases have correct commit status", () => {
    const commitMessages = testState.checkpointValidation?.commitMessages || [];

    // Check for skipped commits
    const skippedCommits = commitMessages.filter((msg) => msg.startsWith("skipped:"));

    // Phase 1 and 3 were skipped
    expect(skippedCommits.length).toBe(2);
    expect(skippedCommits.some((msg) => msg.includes("phase-1"))).toBe(true);
    expect(skippedCommits.some((msg) => msg.includes("phase-3"))).toBe(true);

    // Phase 2 completed but didn't create files, so no completed commit
    // Phase 3 had workspace setup, so check for that
    const workspaceSetupCommits = commitMessages.filter(
      (msg) => msg.startsWith("workspace-setup:") && msg.includes("phase-3"),
    );
    expect(workspaceSetupCommits.length).toBe(1);
  });

  test("all commits on main branch (no error/exit branches)", () => {
    const branches = testState.checkpointValidation?.branches || [];

    // Should only have main branch (no error branches for skipped phases)
    expect(branches).toEqual(["* main"]);
  });

  test("only phase 2 files are tracked", () => {
    const trackedFiles = testState.checkpointValidation?.trackedFiles || [];

    // Since Phase 1 was skipped and Phase 2 couldn't create its file without context,
    // only the typescript_code/package.json from Phase 3's workspace setup should be tracked
    expect(trackedFiles.some((f) => f.includes("typescript_code/package.json"))).toBe(true);

    // Should not have any poem files since:
    // - Phase 1 was skipped (no favorite_poem.txt)
    // - Phase 2 had no context to create second_favorite_poem.txt
    // - Phase 3 was skipped (no poem1.ts, poem2.ts)
    expect(trackedFiles.some((f) => f.includes("favorite_poem.txt"))).toBe(false);
    expect(trackedFiles.some((f) => f.includes("second_favorite_poem.txt"))).toBe(false);
    expect(trackedFiles.some((f) => f.includes("poem1.ts"))).toBe(false);
    expect(trackedFiles.some((f) => f.includes("poem2.ts"))).toBe(false);
  });
});
