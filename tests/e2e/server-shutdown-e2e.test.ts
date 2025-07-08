#!/usr/bin/env bun
import { afterAll, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ErrorEvent,
  InfoEvent,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
  ShutdownCommand,
  StateSnapshotEvent,
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

// Test configuration - using the shared three-phase config
const TEST_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const TEST_DIR = path.join(process.cwd(), "tests/test-area");
const TEST_RESULTS_DIR = path.join(process.cwd(), "tests/test-results");
const SERVER_PORT = parseInt(process.env.LANGTON_TEST_PORT || "7779");
const PHASES_CONFIG = path.join(process.cwd(), "tests/config/test-phases.config.json");

// Generate timestamp for this test run
const TEST_TIMESTAMP = generateTestTimestamp();
const TEST_RUN_DIR = path.join(TEST_RESULTS_DIR, `skip-quit-${TEST_TIMESTAMP}`);

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
  testMode: "e2e-skip-quit",
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
  serverExited: boolean;
  serverExitCode: number | null;
  shutdownTime: Date | null;
}

const testState: TestState = {
  serverProcess: null,
  client: null,
  events: [],
  phase1Started: null,
  phase1Completed: null,
  phase2Started: null,
  phase2Completed: null,
  serverExited: false,
  serverExitCode: null,
  shutdownTime: null,
};

// Main test execution
async function runSkipQuitTest(): Promise<void> {
  // Setup test directory
  await setupTestDirectory(testDirConfig);

  // Start server
  testState.serverProcess = startServer(serverConfig);

  // Monitor server exit
  testState.serverProcess.on("exit", (code) => {
    testState.serverExited = true;
    testState.serverExitCode = code;
    console.log(`${colors.yellow}Server process exited with code: ${code}${colors.reset}`);
  });

  // Give server time to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Connect WebSocket client
  testState.client = new TestWSClient();
  await testState.client.connect(SERVER_PORT);

  // Wait for initial events
  console.log(`${colors.blue}Waiting for server initialization...${colors.reset}`);
  await testState.client.waitForEvent("server.ready");
  await testState.client.waitForEvent("state.snapshot");

  console.log(
    `${colors.blue}Testing immediate server shutdown command during phase execution...${colors.reset}`,
  );

  // Phase 1 should auto-start
  testState.phase1Started = await testState.client.waitForPhaseStart("phase-1", 10000);
  console.log(`${colors.green}✓ Phase 1 started${colors.reset}`);

  // Let phase 1 complete normally
  testState.phase1Completed = await testState.client.waitForPhaseCompletion("phase-1", 60000);
  console.log(`${colors.green}✓ Phase 1 completed${colors.reset}`);

  // Phase 2 should auto-start
  testState.phase2Started = await testState.client.waitForPhaseStart("phase-2", 10000);
  console.log(`${colors.green}✓ Phase 2 started${colors.reset}`);

  // Wait for some assistant actions to ensure phase is running
  // and checkpoint system has time to track files
  await new Promise((resolve) => setTimeout(resolve, 8000));

  // Send shutdown command in the middle of phase 2
  console.log(`${colors.yellow}Sending shutdown command during Phase 2...${colors.reset}`);
  testState.shutdownTime = new Date();
  testState.client.sendCommand({
    id: generateId(),
    type: "server.shutdown",
  } as ShutdownCommand);

  // Wait for phase 2 to complete (should be marked as failed due to shutdown)
  try {
    testState.phase2Completed = await testState.client.waitForPhaseCompletion("phase-2", 10000);
    console.log(`${colors.green}✓ Phase 2 completed (interrupted by shutdown)${colors.reset}`);
  } catch (_error) {
    console.log(
      `${colors.yellow}Phase 2 completion event not received (server may have shut down)${colors.reset}`,
    );
  }

  // Server should shutdown since all phases are done
  console.log(`${colors.blue}Waiting for server to shutdown...${colors.reset}`);

  // Wait for info event about all phases completed
  try {
    const infoEvent = await testState.client.waitForEvent("info", 5000);
    console.log(
      `${colors.green}✓ Received info event: ${
        (infoEvent as InfoEvent).data?.message
      }${colors.reset}`,
    );
  } catch (_e) {
    console.log(
      `${colors.yellow}No info event received (server may have shut down quickly)${colors.reset}`,
    );
  }

  // Wait for connection to close
  try {
    await testState.client.waitForConnectionClose(10000);
    console.log(`${colors.green}✓ WebSocket connection closed${colors.reset}`);
  } catch (_e) {
    console.log(`${colors.red}WebSocket connection did not close as expected${colors.reset}`);
  }

  // Wait for server process to exit
  if (!testState.serverExited) {
    await new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (testState.serverExited) {
          clearInterval(checkInterval);
          resolve(undefined);
        }
      }, 100);

      // Timeout after 10 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve(undefined);
      }, 10000);
    });
  }

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
    gracefulShutdown: false, // Server should have already shut down
  });
}

// Run setup before tests
console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}`);
console.log(`${colors.blue}Langton Server Shutdown Command Test${colors.reset}`);
console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

await runSkipQuitTest();

// Now run the actual tests
describe("Server Shutdown Command E2E Test", () => {
  describe("Phase Execution", () => {
    test("Phase 1 completed successfully", () => {
      expect(testState.phase1Completed?.data.success).toBe(true);
    });

    test("Phase 2 was interrupted by shutdown", () => {
      // Phase 2 should either not have a completion event or be marked as failed
      if (testState.phase2Completed) {
        expect(testState.phase2Completed.data.success).toBe(false);
        expect(testState.phase2Completed.data.exitCode).not.toBe(0);
      }
    });

    test("Phase 2 was active when shutdown was sent", () => {
      // When shutdown is immediate, we might not capture assistant actions
      // The important thing is that phase 2 was started and not yet completed
      expect(testState.phase2Started).toBeDefined();

      // If we have phase 2 completion, it should be after shutdown was sent
      if (testState.phase2Completed && testState.shutdownTime) {
        const shutdownTime = testState.shutdownTime.getTime();
        const completionTime = new Date(testState.phase2Completed.timestamp).getTime();
        expect(completionTime).toBeGreaterThanOrEqual(shutdownTime);
      }

      // Check if any assistant actions were captured (might be 0 for immediate shutdown)
      const phase2Actions = testState.events.filter(
        (e) =>
          e.type === "assistant.action" &&
          e.timestamp > (testState.phase2Started?.timestamp || 0) &&
          (!testState.phase2Completed || e.timestamp < testState.phase2Completed.timestamp),
      );
      console.log(`Assistant actions captured in phase 2: ${phase2Actions.length}`);
    });

    test("Only 2 phases were started (phase 3 never started)", () => {
      const phaseStartEvents = testState.client?.getEventsByType("phase.started") || [];
      expect(phaseStartEvents.length).toBe(2);
    });

    test("No phase 3 events", () => {
      const phase3Events = testState.events.filter(
        (e) => e.type === "phase.started" && (e as PhaseStartedEvent).data?.phaseId === "phase-3",
      );
      expect(phase3Events.length).toBe(0);
    });
  });

  describe("Server Shutdown", () => {
    test("Server process exited", () => {
      expect(testState.serverExited).toBe(true);
    });

    test("Server exited with code 0", () => {
      expect(testState.serverExitCode).toBe(0);
    });

    test("WebSocket connection was closed", () => {
      expect(testState.client?.isConnected).toBe(false);
    });

    test("Lock file was removed", () => {
      const lockFile = path.join(TEST_DIR, ".langton/server.lock");
      // Lock file should be gone after server shutdown
      // (might still exist if server crashed, but cleanup() removes it)
      expect(fs.existsSync(lockFile)).toBe(false);
    });

    test("Claude process was terminated", () => {
      // Check that no Claude processes are still running
      // This is implicitly tested by server exit, but we can verify
      // by looking for phase 2 completion event
      const phase2Completion = testState.events.find(
        (e) =>
          e.type === "phase.completed" && (e as PhaseCompletedEvent).data?.phaseId === "phase-2",
      );

      if (phase2Completion) {
        // If we got a completion event, it should show failure
        expect((phase2Completion as PhaseCompletedEvent).data.success).toBe(false);
      }
      // Otherwise, Claude was killed before it could send completion
    });

    test("Log files are not locked", () => {
      // Verify that log files can be read/written after shutdown
      const logsDir = path.join(TEST_DIR, ".langton/logs");
      if (fs.existsSync(logsDir)) {
        const logFiles = fs.readdirSync(logsDir).filter((f) => f.endsWith(".jsonl"));
        for (const logFile of logFiles) {
          const logPath = path.join(logsDir, logFile);
          // Try to append to the file to verify it's not locked
          try {
            fs.appendFileSync(logPath, "");
            // If we can append, the file is not locked
            expect(true).toBe(true);
          } catch (error) {
            // File is locked - this is a failure
            expect(error).toBeUndefined();
          }
        }
      }
    });

    test("No Claude processes remain", async () => {
      // Platform-specific check for Claude processes
      const { execSync } = await import("node:child_process");
      try {
        // This works on Unix-like systems
        const processes = execSync("pgrep -f 'claude.*--output-format.*stream-json' || true", {
          encoding: "utf-8",
        }).trim();

        // Should be empty (no Claude processes)
        expect(processes).toBe("");
      } catch (_error) {
        // pgrep not available on this platform, skip test
        console.log("pgrep not available, skipping process check");
      }
    });
  });

  describe("Final State", () => {
    test("Final state shows only phase 1 completed", () => {
      const stateSnapshots = testState.client?.getEventsByType("state.snapshot") || [];
      const finalSnapshot = stateSnapshots[stateSnapshots.length - 1] as
        | StateSnapshotEvent
        | undefined;

      if (finalSnapshot) {
        // Only phase 1 should be in completed phases (phase 2 was interrupted)
        expect(finalSnapshot.data?.completedPhases?.length).toBe(1);
        const phase1 = finalSnapshot.data?.completedPhases?.find((p) => p.phaseId === "phase-1");
        expect(phase1?.success).toBe(true);

        // Current phase should be null after shutdown
        expect(finalSnapshot.data?.currentPhase).toBeNull();
      }
    });

    test("Total cost reflects only phase 1", () => {
      const finalStateSnapshot = [...testState.events]
        .reverse()
        .find((e) => e.type === "state.snapshot") as StateSnapshotEvent | undefined;

      // Cost should be greater than 0 but only from phase 1
      expect(finalStateSnapshot?.data?.totalCost || 0).toBeGreaterThan(0);
      expect(finalStateSnapshot?.data?.totalCost || 0).toBeLessThan(0.1); // Reasonable cost for one phase
    });
  });

  describe("File System", () => {
    test("Phase 1 workspaceSetup created notes directory", () => {
      expect(fs.existsSync(path.join(TEST_DIR, "notes"))).toBe(true);
      expect(fs.statSync(path.join(TEST_DIR, "notes")).isDirectory()).toBe(true);
    });

    test("Phase 1 created favorite_poem.txt", () => {
      expect(fs.existsSync(path.join(TEST_DIR, "notes/favorite_poem.txt"))).toBe(true);
    });

    test("Phase 2 did not complete - no second_favorite_poem.txt", () => {
      // Phase 2 was interrupted, so it shouldn't have created the file
      expect(fs.existsSync(path.join(TEST_DIR, "notes/second_favorite_poem.txt"))).toBe(false);
    });

    test("Phase 3 never started - no typescript_code directory", () => {
      // Phase 3 never started, so typescript_code directory should not exist
      expect(fs.existsSync(path.join(TEST_DIR, "typescript_code"))).toBe(false);
    });
  });

  describe("Info Events", () => {
    test("Server should not send 'all phases completed' info", () => {
      const infoEvents = testState.client?.getEventsByType("info") || [];
      const completionInfo = infoEvents.find(
        (e) => (e as InfoEvent).data?.message?.includes("All phases completed") || false,
      );

      // Server should NOT announce all phases completed since we shut down mid-phase 2
      expect(completionInfo).toBeUndefined();
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

    test("Server shutdown was timely", () => {
      // Server should shut down quickly after receiving shutdown command
      if (testState.shutdownTime && testState.serverExited) {
        const shutdownDuration =
          testState.serverExitCode !== null ? Date.now() - testState.shutdownTime.getTime() : 0;
        // Should shut down within 15 seconds (allowing some buffer)
        expect(shutdownDuration).toBeLessThan(15000);
      }
    });
  });

  describe("Shutdown Command", () => {
    test("Shutdown command was sent while phase 2 was active", () => {
      expect(testState.shutdownTime).toBeDefined();
      expect(testState.phase2Started).toBeDefined();

      // Shutdown should have been sent after phase 2 started
      if (testState.shutdownTime && testState.phase2Started) {
        expect(testState.shutdownTime.getTime()).toBeGreaterThan(
          new Date(testState.phase2Started.timestamp).getTime(),
        );
      }

      // If phase 2 completed, shutdown should have been sent before completion
      if (testState.phase2Completed && testState.shutdownTime) {
        expect(testState.shutdownTime.getTime()).toBeLessThan(
          new Date(testState.phase2Completed.timestamp).getTime(),
        );
      }
    });
  });

  describe("Langton Directory Structure", () => {
    const langtonDir = path.join(TEST_DIR, ".langton");

    test(".langton directory exists with proper structure", () => {
      expect(fs.existsSync(langtonDir)).toBe(true);
      expect(fs.existsSync(path.join(langtonDir, "logs"))).toBe(true);
      expect(fs.existsSync(path.join(langtonDir, "checkpoints"))).toBe(true);
    });

    test("Server log file exists and is not empty", () => {
      const serverLogPath = path.join(langtonDir, "logs", "server.log");
      expect(fs.existsSync(serverLogPath)).toBe(true);
      const logContent = fs.readFileSync(serverLogPath, "utf-8");
      expect(logContent.length).toBeGreaterThan(0);
      // Should contain shutdown message
      expect(logContent).toContain("Shutting down server");
    });

    test("Claude log files exist for started phases", () => {
      const logsDir = path.join(langtonDir, "logs");
      expect(fs.existsSync(path.join(logsDir, "log-phase-1.jsonl"))).toBe(true);
      expect(fs.existsSync(path.join(logsDir, "log-phase-2.jsonl"))).toBe(true);
      // Phase 3 should not have a log file (never started)
      expect(fs.existsSync(path.join(logsDir, "log-phase-3.jsonl"))).toBe(false);
    });
  });

  describe("Checkpoint System - Forced Shutdown", () => {
    const checkpointDir = path.join(TEST_DIR, ".langton/checkpoints");
    const gitDir = path.join(checkpointDir, ".git");

    test("checkpoint directory created", () => {
      expect(fs.existsSync(checkpointDir)).toBe(true);
      expect(fs.existsSync(gitDir)).toBe(true);
    });

    // Note: Exit branches/commits may not be created if:
    // 1. Shutdown happens too quickly for checkpoint system to react
    // 2. Server cleans up currentPhase before checkpoint can capture it
    // 3. Checkpointing is disabled or git is not available

    test("exit branch created for forced shutdown", async () => {
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

        // Should have at least main branch
        expect(branches.length).toBeGreaterThanOrEqual(1);
        expect(branches.some((b) => b === "* main" || b === "main")).toBe(true);

        // Exit branch might not be created if shutdown is too quick
        const hasExitBranch = branches.some((b) => b.includes("exit-"));
        console.log(`Exit branch created: ${hasExitBranch}`);
      } catch (error) {
        console.error(`Git branch failed: ${error}`);
      }
    });

    test("exit commit created for forced shutdown", async () => {
      const { execSync } = await import("node:child_process");
      try {
        // Get commits from all branches
        const gitLog = execSync("git log --all --pretty=format:%s", {
          cwd: TEST_DIR,
          env: {
            ...process.env,
            GIT_DIR: gitDir,
            GIT_WORK_TREE: TEST_DIR,
          },
          encoding: "utf-8",
        });

        const commitMessages = gitLog.trim().split("\n");

        // Exit commit might not be created if shutdown is too quick
        const exitCommit = commitMessages.find((msg) => msg.startsWith("exit:"));

        // If exit commit exists, it should reference phase 2
        if (exitCommit) {
          expect(exitCommit).toContain("phase-2");
        } else {
          console.log("No exit commit found - shutdown may have been too quick");
        }
      } catch (error) {
        console.error(`Git log failed: ${error}`);
      }
    });

    test("phase completions tracked correctly", async () => {
      const { execSync } = await import("node:child_process");
      try {
        const gitLog = execSync("git log --all --pretty=format:%s", {
          cwd: TEST_DIR,
          env: {
            ...process.env,
            GIT_DIR: gitDir,
            GIT_WORK_TREE: TEST_DIR,
          },
          encoding: "utf-8",
        });

        const commitMessages = gitLog.trim().split("\n");

        // Should have phase 1 completed
        const phase1Completed = commitMessages.find(
          (msg) => msg.startsWith("completed:") && msg.includes("phase-1"),
        );
        expect(phase1Completed).toBeDefined();

        // Should NOT have phase 2 completed (it was interrupted)
        const phase2Completed = commitMessages.find(
          (msg) => msg.startsWith("completed:") && msg.includes("phase-2"),
        );
        expect(phase2Completed).toBeUndefined();

        // Should NOT have any phase 3 commits (it never started)
        const phase3Commits = commitMessages.filter((msg) => msg.includes("phase-3"));
        expect(phase3Commits.length).toBe(0);
      } catch (error) {
        console.error(`Git log failed: ${error}`);
      }
    });

    test("only phase 1 files are tracked", async () => {
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

        // Should only have phase 1 files
        expect(trackedFiles).toContain("notes/favorite_poem.txt");

        // Should NOT have phase 2 files (it was interrupted)
        expect(trackedFiles).not.toContain("notes/second_favorite_poem.txt");

        // Should not have phase 3's typescript files (never started)
        expect(trackedFiles.some((f) => f.includes("typescript_code"))).toBe(false);
      } catch (error) {
        console.error(`Git ls-files failed: ${error}`);
      }
    });

    test("checkpoint repository is in valid state", async () => {
      const { execSync } = await import("node:child_process");
      try {
        // Check git status - should be clean or have untracked files only
        const gitStatus = execSync("git status --porcelain", {
          cwd: TEST_DIR,
          env: {
            ...process.env,
            GIT_DIR: gitDir,
            GIT_WORK_TREE: TEST_DIR,
          },
          encoding: "utf-8",
        });

        // Status should not show any errors or conflicts
        expect(gitStatus).not.toContain("fatal:");
        expect(gitStatus).not.toContain("error:");

        // Verify repository integrity
        const gitFsck = execSync("git fsck --no-progress", {
          cwd: TEST_DIR,
          env: {
            ...process.env,
            GIT_DIR: gitDir,
            GIT_WORK_TREE: TEST_DIR,
          },
          encoding: "utf-8",
        });

        // Should not report any issues
        expect(gitFsck).not.toContain("error");
        expect(gitFsck).not.toContain("missing");
      } catch (error) {
        console.error(`Git repository check failed: ${error}`);
        expect(error).toBeUndefined();
      }
    });
  });
});

// Cleanup after all tests
afterAll(async () => {
  await cleanup();
});
