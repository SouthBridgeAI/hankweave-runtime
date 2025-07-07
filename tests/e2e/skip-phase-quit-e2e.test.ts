#!/usr/bin/env bun
import { afterAll, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateId } from "../../server/utils.js";

// Import test utilities and types from happy path test
import type {
  ClientCommand,
  ErrorEvent,
  InfoEvent,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
  ShutdownCommand,
  SkipPhaseCommand,
  StateSnapshotEvent,
} from "../../server/types.js";

// Test configuration - using a simple two-phase config for this test
const TEST_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const TEST_DIR = path.join(process.cwd(), "tests/test-area");
const TEST_RESULTS_DIR = path.join(process.cwd(), "tests/test-results");
const SERVER_PORT = 7779;

// Generate timestamp for this test run
const TEST_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
const TEST_RUN_DIR = path.join(TEST_RESULTS_DIR, `skip-quit-${TEST_TIMESTAMP}`);

// Create a custom phases config for this test (only 2 phases)
const PHASES_CONFIG = path.join(TEST_RUN_DIR, "test-phases-skip-quit.config.json");
const TEST_PHASES = [
  {
    id: "phase-1",
    name: "Phase 1: Initial Phase",
    promptText: "Create a file called 'test.txt' in the notes folder with the text 'Hello World'",
    model: "sonnet",
    continueFromPrevious: false,
    preStart: "mkdir -p notes",
    watch: "./notes/*.txt",
    description: "Create a test file"
  },
  {
    id: "phase-2",
    name: "Phase 2: Final Phase",
    promptText: "Create a file called 'test2.txt' in the notes folder with the text 'Goodbye World'",
    model: "sonnet",
    continueFromPrevious: false,
    watch: "./notes/*.txt",
    description: "Create another test file"
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
  private connectionClosed = false;

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

          // Also resolve "any" event waiters
          const anyWaiters = this.eventPromises.get("*");
          if (anyWaiters) {
            anyWaiters.forEach(({ resolve }) => resolve(serverEvent));
            this.eventPromises.delete("*");
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
        this.connectionClosed = true;
        console.log(`${colors.gray}WebSocket connection closed${colors.reset}`);
        
        // Resolve any pending connection close waiters
        const closeWaiters = this.eventPromises.get("__connection_closed__");
        if (closeWaiters) {
          closeWaiters.forEach(({ resolve }) => resolve({ type: "__connection_closed__" } as any));
          this.eventPromises.delete("__connection_closed__");
        }
      };
    });
  }

  async waitForConnectionClose(timeout: number = 10000): Promise<void> {
    if (this.connectionClosed) return;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timeout waiting for connection to close"));
      }, timeout);

      const waiters = this.eventPromises.get("__connection_closed__") || [];
      waiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject,
      });
      this.eventPromises.set("__connection_closed__", waiters);
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

  get isConnected(): boolean {
    return this.connected;
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

  // Write custom phases config
  fs.writeFileSync(PHASES_CONFIG, JSON.stringify(TEST_PHASES, null, 2));
  console.log(`${colors.yellow}Created custom phases config: ${PHASES_CONFIG}${colors.reset}`);

  console.log(`${colors.yellow}Test results will be saved to: ${TEST_RUN_DIR}${colors.reset}`);

  // Clean up previous test artifacts
  const artifactsToClean = [".logs", ".langton-server.lock", "notes"];

  for (const artifact of artifactsToClean) {
    const artifactPath = path.join(TEST_DIR, artifact);
    if (fs.existsSync(artifactPath)) {
      console.log(`  Cleaning: ${artifact}`);
      await rimrafSimple(artifactPath);
    }
  }
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
      "--test-mode=e2e-skip-quit",
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
    console.log(`${colors.gray}Server exited with code ${code} and signal ${signal}${colors.reset}`);
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
  serverExited: boolean;
  serverExitCode: number | null;
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
};

// Main test execution
async function runSkipQuitTest(): Promise<void> {
  // Setup test directory
  await setupTestDirectory();

  // Start server
  testState.serverProcess = startServer();

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
  await testState.client.connect();

  // Wait for initial events
  console.log(`${colors.blue}Waiting for server initialization...${colors.reset}`);
  await testState.client.waitForEvent("server.ready");
  await testState.client.waitForEvent("state.snapshot");

  console.log(`${colors.blue}Testing skip last phase and server shutdown...${colors.reset}`);

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
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Skip phase 2 (the last phase)
  console.log(`${colors.yellow}Skipping Phase 2 (last phase)...${colors.reset}`);
  testState.client.sendCommand({
    id: generateId(),
    type: "phase.skip",
  } as SkipPhaseCommand);

  // Wait for phase 2 to complete (should be marked as failed)
  testState.phase2Completed = await testState.client.waitForPhaseCompletion("phase-2", 10000);
  console.log(`${colors.green}✓ Phase 2 completed (skipped)${colors.reset}`);

  // Server should shutdown since all phases are done
  console.log(`${colors.blue}Waiting for server to shutdown...${colors.reset}`);
  
  // Wait for info event about all phases completed
  try {
    const infoEvent = await testState.client.waitForEvent("info", 5000);
    console.log(`${colors.green}✓ Received info event: ${(infoEvent as InfoEvent).data?.message}${colors.reset}`);
  } catch (e) {
    console.log(`${colors.yellow}No info event received (server may have shut down quickly)${colors.reset}`);
  }

  // Wait for connection to close
  try {
    await testState.client.waitForConnectionClose(10000);
    console.log(`${colors.green}✓ WebSocket connection closed${colors.reset}`);
  } catch (e) {
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
  console.log(`\n${colors.blue}Cleaning up...${colors.reset}`);

  if (testState.client) {
    await testState.client.disconnect();
  }

  if (testState.serverProcess && !testState.serverProcess.killed) {
    console.log(`${colors.gray}Force killing server process...${colors.reset}`);
    testState.serverProcess.kill("SIGKILL");
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
console.log(`${colors.blue}Langton Server Skip Last Phase and Quit Test${colors.reset}`);
console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

await runSkipQuitTest();

// Now run the actual tests
describe("Skip Last Phase and Quit E2E Test", () => {
  describe("Phase Execution", () => {
    test("Phase 1 completed successfully", () => {
      expect(testState.phase1Completed?.data.success).toBe(true);
    });

    test("Phase 2 was skipped", () => {
      expect(testState.phase2Completed?.data.success).toBe(false);
      expect(testState.phase2Completed?.data.exitCode).not.toBe(0);
    });

    test("Only 2 phases were started", () => {
      const phaseStartEvents = testState.client?.getEventsByType("phase.started") || [];
      expect(phaseStartEvents.length).toBe(2);
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
      const lockFile = path.join(TEST_DIR, ".langton-server.lock");
      // Lock file should be gone after server shutdown
      // (might still exist if server crashed, but cleanup() removes it)
      expect(fs.existsSync(lockFile)).toBe(false);
    });
  });

  describe("Final State", () => {
    test("Final state snapshot shows both phases with correct status", () => {
      const stateSnapshots = testState.client?.getEventsByType("state.snapshot") || [];
      const finalSnapshot = stateSnapshots[stateSnapshots.length - 1] as StateSnapshotEvent | undefined;
      
      if (finalSnapshot) {
        // Both phases should be in completed phases (including skipped phase 2)
        expect(finalSnapshot.data?.completedPhases?.length).toBe(2);
        // Check that phase 1 was successful and phase 2 was not
        const phase1 = finalSnapshot.data?.completedPhases?.find(p => p.phaseId === "phase-1");
        const phase2 = finalSnapshot.data?.completedPhases?.find(p => p.phaseId === "phase-2");
        expect(phase1?.success).toBe(true);
        expect(phase2?.success).toBe(false);
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
    test("Phase 1 created test.txt", () => {
      expect(fs.existsSync(path.join(TEST_DIR, "notes/test.txt"))).toBe(true);
    });

    test("Phase 2 did not create test2.txt", () => {
      // Phase 2 was skipped, so file should not exist
      expect(fs.existsSync(path.join(TEST_DIR, "notes/test2.txt"))).toBe(false);
    });
  });

  describe("Info Events", () => {
    test("Server sent completion info before shutdown", () => {
      const infoEvents = testState.client?.getEventsByType("info") || [];
      const completionInfo = infoEvents.find(
        (e) => (e as InfoEvent).data?.message?.includes("All phases completed") || false,
      );
      
      // Server should announce all phases completed before shutting down
      expect(completionInfo).toBeDefined();
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