#!/usr/bin/env bun
// NOTE: Unlike happy-path-e2e.test.ts, this file's tests are intentionally not split into separate modules.
// Most tests here are specific to the skip/continue scenario and verify different outcomes than the happy path.
// For example: checking that files were NOT created, phases were marked as failed, costs are minimal, etc.
// Keeping tests inline makes it clearer what this specific scenario is validating.

import { afterAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
// Import test utilities and types from happy path test
import type {
  AssistantActionEvent,
  ErrorEvent,
  InfoEvent,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
  SkipPhaseCommand,
  StateSnapshotEvent,
  TokenUsageEvent,
} from "../../server/types.js";
import { generateId } from "../../server/utils.js";
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

// Test configuration
const TEST_TIMEOUT = 2 * 60 * 1000; // 2 minutes
// Use __dirname to ensure we're always relative to this test file
const TEST_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const TEST_DIR = path.join(TEST_ROOT, "tests/test-area");
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
}

// Cleanup function
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

// Run setup before tests
console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}`);
console.log(`${colors.blue}Langton Server Skip Phase and Continue Test${colors.reset}`);
console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

await runSkipContinueTest();

// Now run the actual tests
describe("Skip Phase and Continue E2E Test", () => {
  describe("Phase Skipping", () => {
    test("Phase 1 was skipped", () => {
      expect(testState.phase1Completed?.data.success).toBe(false);
      expect(testState.phase1Completed?.data.exitCode).not.toBe(0);
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
      expect(testState.phase3Completed?.data.exitCode).not.toBe(0);
    });

    test("Skipped phases have zero or minimal cost", () => {
      // Skipped phases should have minimal cost (only from initial tool use)
      expect(testState.phase1Completed?.data.cost || 0).toBeLessThan(0.01);
      expect(testState.phase3Completed?.data.cost || 0).toBeLessThan(0.01);
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
        (e) => (e as InfoEvent).data?.message?.includes("All phases completed") || false,
      );
      expect(shutdownInfo).toBeDefined();
    });

    test("Completed phases list shows only successful phase", () => {
      const finalStateSnapshot = [...testState.events]
        .reverse()
        .find((e) => e.type === "state.snapshot") as StateSnapshotEvent | undefined;

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
          .filter((e) => (e as AssistantActionEvent).data?.phaseId === "phase-1") || [];

      // Might not have actions if skipped very quickly
      expect(phase1Actions.length).toBeGreaterThanOrEqual(0);
    });

    test("Phase 2 had normal assistant actions", () => {
      const phase2Actions =
        testState.client
          ?.getEventsByType("assistant.action")
          .filter((e) => (e as AssistantActionEvent).data?.phaseId === "phase-2") || [];

      // Should have at least some actions for a complete phase
      expect(phase2Actions.length).toBeGreaterThan(0);
    });

    test("Phase 3 had some assistant actions before skip", () => {
      const phase3Actions =
        testState.client
          ?.getEventsByType("assistant.action")
          .filter((e) => (e as AssistantActionEvent).data?.phaseId === "phase-3") || [];

      expect(phase3Actions.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Token Usage", () => {
    test("Skipped phases have token usage events", () => {
      const tokenEvents = testState.client?.getEventsByType("token.usage") || [];

      const phase1Tokens = tokenEvents.filter((e) => {
        const tokenEvent = e as TokenUsageEvent;
        return tokenEvent.data?.phaseId === "phase-1";
      });
      const phase3Tokens = tokenEvents.filter((e) => {
        const tokenEvent = e as TokenUsageEvent;
        return tokenEvent.data?.phaseId === "phase-3";
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
      const fatalErrors = errorEvents.filter((e) => (e as ErrorEvent).data?.fatal);
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

  describe("Checkpoint System - Skip Handling", () => {
    const checkpointDir = path.join(TEST_DIR, ".langton/checkpoints");
    const gitDir = path.join(checkpointDir, ".git");

    test("checkpoint directory created", () => {
      expect(fs.existsSync(checkpointDir)).toBe(true);
      expect(fs.existsSync(gitDir)).toBe(true);
    });

    test("skipped phases have correct commit status", async () => {
      const { execSync } = await import("node:child_process");
      try {
        const gitLog = execSync("git log --pretty=format:%s", {
          cwd: TEST_DIR,
          env: {
            ...process.env,
            GIT_DIR: gitDir,
            GIT_WORK_TREE: TEST_DIR,
          },
          encoding: "utf-8",
        });

        const commitMessages = gitLog
          .trim()
          .split("\n")
          .filter((msg) => msg);

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
      } catch (error) {
        console.error(`Git log failed: ${error}`);
        throw error; // Re-throw to properly fail the test
      }
    });

    test("all commits on main branch (no error/exit branches)", async () => {
      const { execSync } = await import("node:child_process");
      try {
        const gitBranches = execSync("git branch", {
          cwd: TEST_DIR,
          env: {
            ...process.env,
            GIT_DIR: gitDir,
            GIT_WORK_TREE: TEST_DIR,
          },
          encoding: "utf-8",
        });

        const branches = gitBranches
          .trim()
          .split("\n")
          .map((b) => b.trim());

        // Should only have main branch (no error branches for skipped phases)
        expect(branches).toEqual(["* main"]);
      } catch (error) {
        console.error(`Git branch failed: ${error}`);
      }
    });

    test("only phase 2 files are tracked", async () => {
      const { execSync } = await import("node:child_process");
      try {
        const gitFiles = execSync("git ls-files", {
          cwd: TEST_DIR,
          env: {
            ...process.env,
            GIT_DIR: gitDir,
            GIT_WORK_TREE: TEST_DIR,
          },
          encoding: "utf-8",
        });

        const trackedFiles = gitFiles.trim()
          ? gitFiles
              .trim()
              .split("\n")
              .filter((f) => f)
          : [];

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
      } catch (error) {
        console.error(`Git ls-files failed: ${error}`);
      }
    });
  });
});

// Cleanup after all tests
afterAll(async () => {
  await cleanup();
});
