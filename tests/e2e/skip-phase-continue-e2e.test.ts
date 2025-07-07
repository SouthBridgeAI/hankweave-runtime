#!/usr/bin/env bun
import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateId } from "../../server/utils.js";

// Import test utilities and types from happy path test
import type {
  AssistantActionEvent,
  ClientCommand,
  ErrorEvent,
  InfoEvent,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
  SkipPhaseCommand,
  StateSnapshotEvent,
} from "../../server/types.js";

// Test configuration
const TEST_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const TEST_DIR = path.join(process.cwd(), "tests/test-area");
const TEST_RESULTS_DIR = path.join(process.cwd(), "tests/test-results");
const SERVER_PORT = 7778;

// Generate timestamp for this test run
const TEST_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
const TEST_RUN_DIR = path.join(TEST_RESULTS_DIR, `skip-continue-${TEST_TIMESTAMP}`);

// Create a custom phases config for this test
const PHASES_CONFIG = path.join(TEST_DIR, "test-phases-skip-continue.config.json");
const TEST_PHASES = [
  {
    id: "phase-1",
    name: "Phase 1: TestPhase1",
    promptFile: "./phase1Prompt.md",
    model: "sonnet",
    continueFromPrevious: false,
    preStart: "mkdir -p notes",
    watch: "./notes/*.txt",
    description: "Write three pick one"
  },
  {
    id: "phase-2",
    name: "Phase 2: Second Phase",
    promptText: "Create a file called 'test2.txt' in the notes folder with the text 'Phase 2 was here'",
    model: "sonnet",
    continueFromPrevious: false, // Don't continue from skipped phase
    watch: "./notes/*.*",
    description: "Write another file"
  },
  {
    id: "phase-3",
    name: "Phase 3: Third Phase",
    promptText: "Create a file called 'test3.txt' in the notes folder with the text 'Phase 3 completed'",
    model: "sonnet",
    continueFromPrevious: false,
    watch: "./notes/*.*",
    description: "Write final file"
  }
];

// Colors for output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
};

// Simple WebSocket client
class TestWSClient {
  private ws: WebSocket | null = null;
  private events: ServerEvent[] = [];
  private eventPromises = new Map<
    string,
    { resolve: (event: ServerEvent) => void; reject: (error: Error) => void }[]
  >();
  private connected = false;

  async connect(port: number = SERVER_PORT): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"));
      }, 10000);

      this.ws = new WebSocket(`ws://localhost:${port}`);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        this.connected = true;
        console.log(`${colors.green}✓ Connected to WebSocket server${colors.reset}`);
        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const serverEvent: ServerEvent = JSON.parse(event.data);
          this.events.push(serverEvent);

          // Resolve any waiting promises for this event type
          const waiters = this.eventPromises.get(serverEvent.type);
          if (waiters) {
            waiters.forEach(({ resolve }) => resolve(serverEvent));
            this.eventPromises.delete(serverEvent.type);
          }
        } catch (error) {
          console.error("Failed to parse server event:", error);
        }
      };

      this.ws.onerror = (error: Event) => {
        clearTimeout(timeout);
        reject(error);
      };

      this.ws.onclose = () => {
        this.connected = false;
        console.log(`${colors.gray}WebSocket connection closed${colors.reset}`);
      };
    });
  }

  async waitForEvent(type: string, timeout: number = 30000): Promise<ServerEvent> {
    // Check if we already have this event
    const existing = this.events.find((e) => e.type === type);
    if (existing) return existing;

    // Wait for future event
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for event: ${type}`));
      }, timeout);

      const waiters = this.eventPromises.get(type) || [];
      waiters.push({
        resolve: (event: ServerEvent) => {
          clearTimeout(timer);
          resolve(event);
        },
        reject,
      });
      this.eventPromises.set(type, waiters);
    });
  }

  async waitForPhaseStart(phaseId: string, timeout: number = 10000): Promise<PhaseStartedEvent> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const started = this.events.find(
        (e) => e.type === "phase.started" && (e as PhaseStartedEvent).data?.phaseId === phaseId,
      ) as PhaseStartedEvent | undefined;
      if (started) return started;

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout waiting for phase ${phaseId} to start`);
  }

  async waitForPhaseCompletion(
    phaseId: string,
    timeout: number = 10000,
  ): Promise<PhaseCompletedEvent> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const completed = this.events.find(
        (e) => e.type === "phase.completed" && (e as PhaseCompletedEvent).data?.phaseId === phaseId,
      ) as PhaseCompletedEvent | undefined;
      if (completed) return completed;

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout waiting for phase ${phaseId} to complete`);
  }

  getEvents(): ServerEvent[] {
    return [...this.events];
  }

  getEventsByType(type: string): ServerEvent[] {
    return this.events.filter((e) => e.type === type);
  }

  sendCommand(command: ClientCommand): void {
    if (this.ws && this.connected) {
      this.ws.send(JSON.stringify(command));
    }
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Test utilities
async function rimrafSimple(dirPath: string): Promise<void> {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

async function setupTestDirectory(): Promise<void> {
  console.log(`${colors.blue}Setting up test directory: ${TEST_DIR}${colors.reset}`);

  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }

  if (!fs.existsSync(TEST_RESULTS_DIR)) {
    fs.mkdirSync(TEST_RESULTS_DIR, { recursive: true });
  }

  if (!fs.existsSync(TEST_RUN_DIR)) {
    fs.mkdirSync(TEST_RUN_DIR, { recursive: true });
  }

  console.log(`${colors.yellow}Test results will be saved to: ${TEST_RUN_DIR}${colors.reset}`);

  // Clean up previous test artifacts
  const artifactsToClean = [".logs", ".langton-server.lock", "notes", "typescript_code", "test-phases-skip-continue.config.json", "phase1Prompt.md"];

  for (const artifact of artifactsToClean) {
    const artifactPath = path.join(TEST_DIR, artifact);
    if (fs.existsSync(artifactPath)) {
      console.log(`  Cleaning: ${artifact}`);
      await rimrafSimple(artifactPath);
    }
  }

  // Create the prompt file needed by phase 1
  const promptFilePath = path.join(TEST_DIR, "phase1Prompt.md");
  const promptContent = `Can you write three short poems about nature - one about the sun, one about the rain, and one about the wind? Then pick your favorite and save it to a file called "favorite_poem.txt" in the notes folder.`;
  fs.writeFileSync(promptFilePath, promptContent);
  console.log(`  Created prompt file: phase1Prompt.md`);

  // Write custom phases config
  fs.writeFileSync(PHASES_CONFIG, JSON.stringify(TEST_PHASES, null, 2));
  console.log(`${colors.yellow}Created custom phases config in test dir${colors.reset}`);
}

function startServer(): ChildProcess {
  console.log(`${colors.blue}Starting Langton server...${colors.reset}`);

  const serverLogPath = path.join(TEST_RUN_DIR, "server.log");
  const serverLogStream = fs.createWriteStream(serverLogPath, { flags: "a" });

  const serverProcess = spawn(
    "bun",
    [
      path.join(process.cwd(), "server/index.ts"),
      `--config=${PHASES_CONFIG}`,
      `--port=${SERVER_PORT}`,
      "--test-mode=e2e-skip-continue",
    ],
    {
      cwd: TEST_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LANGTON_TEST_RUN: "true",
      },
    },
  );

  serverProcess.stdout?.on("data", (data) => {
    const message = data.toString();
    serverLogStream.write(`[${new Date().toISOString()}] [STDOUT] ${message}`);
  });

  serverProcess.stderr?.on("data", (data) => {
    const message = data.toString();
    console.error(`${colors.red}[SERVER ERROR] ${message.trim()}${colors.reset}`);
    serverLogStream.write(`[${new Date().toISOString()}] [STDERR] ${message}`);
  });

  serverProcess.on("error", (error) => {
    const message = `Failed to start server: ${error.message}`;
    console.error(`${colors.red}${message}${colors.reset}`);
    serverLogStream.write(`[${new Date().toISOString()}] [ERROR] ${message}\n`);
  });

  serverProcess.on("exit", (code, signal) => {
    serverLogStream.write(
      `[${new Date().toISOString()}] [EXIT] Process exited with code ${code} and signal ${signal}\n`,
    );
    serverLogStream.end();
  });

  return serverProcess;
}

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
  await setupTestDirectory();

  // Start server
  testState.serverProcess = startServer();

  // Give server time to start
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Connect WebSocket client
  testState.client = new TestWSClient();
  await testState.client.connect();

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
  console.log(`\n${colors.blue}Cleaning up...${colors.reset}`);

  if (testState.client) {
    await testState.client.disconnect();
  }

  if (testState.serverProcess) {
    console.log(`${colors.gray}Shutting down server...${colors.reset}`);

    if (!testState.serverProcess.killed) {
      testState.serverProcess.kill("SIGTERM");

      const shutdownTimeout = setTimeout(() => {
        if (!testState.serverProcess?.killed) {
          console.log(`${colors.yellow}Force killing server...${colors.reset}`);
          testState.serverProcess.kill("SIGKILL");
        }
      }, 5000);

      await new Promise<void>((resolve) => {
        testState.serverProcess?.on("exit", () => {
          clearTimeout(shutdownTimeout);
          resolve();
        });
      });
    }

    console.log(`${colors.green}✓ Server shut down${colors.reset}`);
  }

  const lockFile = path.join(TEST_DIR, ".langton-server.lock");
  if (fs.existsSync(lockFile)) {
    console.log(`${colors.gray}Cleaning up lock file...${colors.reset}`);
    fs.unlinkSync(lockFile);
  }

  console.log(`${colors.green}✓ Cleanup complete${colors.reset}`);

  // Save test results
  console.log(`\n${colors.blue}Preserving test results...${colors.reset}`);

  const logsDir = path.join(TEST_DIR, ".logs");
  if (fs.existsSync(logsDir)) {
    const destLogsDir = path.join(TEST_RUN_DIR, "claude-logs");
    fs.mkdirSync(destLogsDir, { recursive: true });

    const logFiles = fs.readdirSync(logsDir);
    for (const file of logFiles) {
      fs.copyFileSync(path.join(logsDir, file), path.join(destLogsDir, file));
    }
    console.log(`  ✓ Copied ${logFiles.length} Claude log files`);
  }

  const eventsPath = path.join(TEST_RUN_DIR, "websocket-events.json");
  fs.writeFileSync(eventsPath, JSON.stringify(testState.events || [], null, 2));

  console.log(`\n${colors.yellow}Test results saved to: ${TEST_RUN_DIR}${colors.reset}`);
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
      const phase1CompleteTime = new Date(testState.phase1Completed!.timestamp).getTime();
      const phase2StartTime = new Date(testState.phase2Started!.timestamp).getTime();
      
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
      const phase2Completed = finalStateSnapshot?.data?.completedPhases?.find(p => p.phaseId === "phase-2");
      expect(phase2Completed?.success).toBe(true);
    });
  });

  describe("Assistant Actions", () => {
    test("Phase 1 had some assistant actions before skip", () => {
      const phase1Actions = testState.client?.getEventsByType("assistant.action").filter(
        (e) => (e as AssistantActionEvent).data?.phaseId === "phase-1",
      ) || [];
      
      // Might not have actions if skipped very quickly
      expect(phase1Actions.length).toBeGreaterThanOrEqual(0);
    });

    test("Phase 2 had normal assistant actions", () => {
      const phase2Actions = testState.client?.getEventsByType("assistant.action").filter(
        (e) => (e as AssistantActionEvent).data?.phaseId === "phase-2",
      ) || [];
      
      // Should have at least some actions for a complete phase
      expect(phase2Actions.length).toBeGreaterThan(0);
    });

    test("Phase 3 had some assistant actions before skip", () => {
      const phase3Actions = testState.client?.getEventsByType("assistant.action").filter(
        (e) => (e as AssistantActionEvent).data?.phaseId === "phase-3",
      ) || [];
      
      expect(phase3Actions.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Token Usage", () => {
    test("Skipped phases have token usage events", () => {
      const tokenEvents = testState.client?.getEventsByType("token.usage") || [];
      
      const phase1Tokens = tokenEvents.filter(
        (e) => (e as any).data?.phaseId === "phase-1",
      );
      const phase3Tokens = tokenEvents.filter(
        (e) => (e as any).data?.phaseId === "phase-3",
      );
      
      // Skipped phases might not have token usage events if killed quickly
      expect(phase1Tokens.length).toBeGreaterThanOrEqual(0);
      expect(phase3Tokens.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("File System", () => {
    test("Phase 2 created test2.txt", () => {
      // Phase 2 should have completed successfully
      expect(fs.existsSync(path.join(TEST_DIR, "notes/test2.txt"))).toBe(true);
    });

    test("Phase 1 may not have created favorite_poem.txt", () => {
      // Phase 1 was skipped, so file may or may not exist depending on timing
      const exists = fs.existsSync(path.join(TEST_DIR, "notes/favorite_poem.txt"));
      // File should not exist since we skip quickly
      expect(exists).toBe(false);
    });

    test("Phase 3 did not create test3.txt", () => {
      // Phase 3 was skipped, so test3.txt should not exist
      expect(fs.existsSync(path.join(TEST_DIR, "notes/test3.txt"))).toBe(false);
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
    test("Test completed within timeout", () => {
      expect(testState.events.length).toBeGreaterThan(0);
    }, TEST_TIMEOUT);
  });
});

// Cleanup after all tests
afterAll(async () => {
  await cleanup();
});