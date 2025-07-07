#!/usr/bin/env bun
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { generateId } from "../../server/utils.js";

// Install rimraf if needed: bun add -d rimraf @types/rimraf
// For now, use a simple recursive delete
async function rimrafSimple(dirPath: string): Promise<void> {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

// Test configuration
const TEST_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const TEST_DIR = path.join(process.cwd(), "tests/test-area");
const TEST_RESULTS_DIR = path.join(process.cwd(), "tests/test-results");
const SERVER_PORT = 7777;
const PHASES_CONFIG = path.join(process.cwd(), "tests/config/test-phases.config.json");

// Generate timestamp for this test run
const TEST_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5); // YYYY-MM-DDTHH-mm-ss
const TEST_RUN_DIR = path.join(TEST_RESULTS_DIR, `run-${TEST_TIMESTAMP}`);

// Colors for output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
};

// ============================================================================
// Test WebSocket Client
// ============================================================================

// Import types from the server
import type {
  ClientCommand,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEvent,
} from "../../server/types.js";

// Re-export for convenience
// type AnyServerEvent = ServerEvent;

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

      this.ws.onmessage = (event) => {
        try {
          const serverEvent = JSON.parse(event.data) as ServerEvent;
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

      this.ws.onerror = (error) => {
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
    const existing = this.events.find((e) => type === "*" || e.type === type);
    if (existing) return existing;

    // Wait for future event
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for event: ${type}`));
      }, timeout);

      const waiters = this.eventPromises.get(type) || [];
      waiters.push({
        resolve: (event) => {
          clearTimeout(timer);
          resolve(event);
        },
        reject,
      });
      this.eventPromises.set(type, waiters);
    });
  }

  async waitForPhaseCompletion(
    phaseId: string,
    timeout: number = 120000,
  ): Promise<PhaseCompletedEvent> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const completed = this.events.find(
        (e) => e.type === "phase.completed" && (e as PhaseCompletedEvent).data?.phaseId === phaseId,
      );
      if (completed) return completed as PhaseCompletedEvent;

      // Wait a bit before checking again
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

// ============================================================================
// Test Utilities
// ============================================================================

async function setupTestDirectory(): Promise<void> {
  console.log(`${colors.blue}Setting up test directory: ${TEST_DIR}${colors.reset}`);

  // Create test directory if it doesn't exist
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }

  // Create test results directory
  if (!fs.existsSync(TEST_RESULTS_DIR)) {
    fs.mkdirSync(TEST_RESULTS_DIR, { recursive: true });
  }

  // Create directory for this test run
  if (!fs.existsSync(TEST_RUN_DIR)) {
    fs.mkdirSync(TEST_RUN_DIR, { recursive: true });
  }

  console.log(`${colors.yellow}Test results will be saved to: ${TEST_RUN_DIR}${colors.reset}`);

  // Clean up previous test artifacts (but not the entire directory)
  const artifactsToClean = [".logs", ".langton-server.lock", "notes", "typescript_code"];

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

  // Create server log file
  const serverLogPath = path.join(TEST_RUN_DIR, "server.log");
  const serverLogStream = fs.createWriteStream(serverLogPath, { flags: "a" });

  const serverProcess = spawn(
    "bun",
    [
      path.join(process.cwd(), "server/index.ts"),
      `--config=${PHASES_CONFIG}`,
      // Add a unique identifier for test processes
      "--test-mode=e2e-happy-path",
    ],
    {
      cwd: TEST_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LANGTON_TEST_RUN: "true", // Another way to identify test processes
      },
    },
  );

  serverProcess.stdout?.on("data", (data) => {
    const message = data.toString();
    console.log(`${colors.gray}[SERVER] ${message.trim()}${colors.reset}`);
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

function parseJSONL(content: string): Record<string, unknown>[] {
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((item): item is Record<string, unknown> => item !== null);
}

interface UsageData {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

function calculateCostFromUsage(usage: UsageData): number {
  // Default costs per million tokens (matching server defaults)
  const costs = {
    input: 3.0,
    inputCache: 3.75,
    cacheRead: 0.3,
    output: 15.0,
  };

  const inputCost = ((usage.input_tokens || 0) / 1_000_000) * costs.input;
  const cacheCreationCost =
    ((usage.cache_creation_input_tokens || 0) / 1_000_000) * costs.inputCache;
  const cacheReadCost = ((usage.cache_read_input_tokens || 0) / 1_000_000) * costs.cacheRead;
  const outputCost = ((usage.output_tokens || 0) / 1_000_000) * costs.output;

  return inputCost + cacheCreationCost + cacheReadCost + outputCost;
}

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

function findInTree(tree: FileNode[], name: string): FileNode | undefined {
  for (const node of tree) {
    if (node.name === name) return node;
    if (node.children) {
      const found = findInTree(node.children, name);
      if (found) return found;
    }
  }
  return undefined;
}

function extractPathsFromTree(tree: FileNode[]): string[] {
  const paths: string[] = [];

  function traverse(nodes: FileNode[]) {
    for (const node of nodes) {
      paths.push(node.path);
      if (node.children) {
        traverse(node.children);
      }
    }
  }

  traverse(tree);
  return paths;
}

// ============================================================================
// Test Assertions
// ============================================================================

class TestRunner {
  private failures: string[] = [];
  private successes: string[] = [];

  assert(condition: boolean, message: string): void {
    if (condition) {
      this.successes.push(message);
      console.log(`${colors.green}  ✓ ${message}${colors.reset}`);
    } else {
      this.failures.push(message);
      console.log(`${colors.red}  ✗ ${message}${colors.reset}`);
    }
  }

  async assertFileExists(filePath: string, description?: string): Promise<void> {
    const exists = fs.existsSync(filePath);
    const message = description || `File exists: ${path.basename(filePath)}`;
    this.assert(exists, message);
  }

  async assertFileContains(filePath: string, content: string, description?: string): Promise<void> {
    if (!fs.existsSync(filePath)) {
      this.assert(false, `File not found: ${filePath}`);
      return;
    }

    const fileContent = fs.readFileSync(filePath, "utf-8");
    const contains = fileContent.includes(content);
    const message = description || `File ${path.basename(filePath)} contains expected content`;
    this.assert(contains, message);
  }

  assertEventSequence(events: ServerEvent[], expectedSequence: string[]): void {
    const actualSequence = events.map((e) => e.type);
    let sequenceIndex = 0;

    for (const eventType of actualSequence) {
      if (
        sequenceIndex < expectedSequence.length &&
        eventType === expectedSequence[sequenceIndex]
      ) {
        sequenceIndex++;
      }
    }

    const sequenceFound = sequenceIndex === expectedSequence.length;
    this.assert(sequenceFound, `Event sequence contains: ${expectedSequence.join(" → ")}`);
  }

  printSummary(): boolean {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`${colors.blue}Test Summary${colors.reset}`);
    console.log("=".repeat(60));
    console.log(`${colors.green}Passed: ${this.successes.length}${colors.reset}`);
    console.log(`${colors.red}Failed: ${this.failures.length}${colors.reset}`);

    if (this.failures.length > 0) {
      console.log(`\n${colors.red}Failed assertions:${colors.reset}`);
      this.failures.forEach((failure) => {
        console.log(`  - ${failure}`);
      });
    }

    return this.failures.length === 0;
  }
}

// ============================================================================
// Main Test Runner
// ============================================================================

async function runE2ETest(): Promise<boolean> {
  const testRunner = new TestRunner();
  let serverProcess: ChildProcess | null = null;
  let client: TestWSClient | null = null;
  let testTimeout: NodeJS.Timeout;
  const testStartTime = Date.now();

  try {
    // Set up test timeout
    testTimeout = setTimeout(() => {
      console.error(`${colors.red}Test timeout after 5 minutes!${colors.reset}`);
      process.exit(1);
    }, TEST_TIMEOUT);

    // Setup test directory
    await setupTestDirectory();

    // Start server
    serverProcess = startServer();

    // Give server time to start
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Connect WebSocket client
    client = new TestWSClient();
    await client.connect();

    // Wait for initial events
    console.log(`${colors.blue}Waiting for server initialization...${colors.reset}`);
    await client.waitForEvent("server.ready");
    await client.waitForEvent("state.snapshot");

    // Wait for all phases to complete
    console.log(`${colors.blue}Waiting for all phases to complete...${colors.reset}`);

    // Phase 1
    const phase1Started = (await client.waitForEvent("phase.started", 10000)) as PhaseStartedEvent;
    testRunner.assert(phase1Started.data.phaseId === "phase-1", "Phase 1 started");

    const phase1Completed = (await client.waitForPhaseCompletion(
      "phase-1",
      60000,
    )) as PhaseCompletedEvent;
    testRunner.assert(phase1Completed.data.success === true, "Phase 1 completed successfully");

    // Phase 2
    const phase2Completed = (await client.waitForPhaseCompletion(
      "phase-2",
      60000,
    )) as PhaseCompletedEvent;
    testRunner.assert(phase2Completed.data.success === true, "Phase 2 completed successfully");

    // Check continuation
    const phase2StartedEvent = client
      .getEvents()
      .find(
        (e) => e.type === "phase.started" && (e as PhaseStartedEvent).data.phaseId === "phase-2",
      );
    testRunner.assert(
      (phase2StartedEvent as PhaseStartedEvent)?.data.previousSessionId !== undefined,
      "Phase 2 continued from Phase 1",
    );

    // Phase 3
    const phase3Completed = (await client.waitForPhaseCompletion(
      "phase-3",
      60000,
    )) as PhaseCompletedEvent;
    testRunner.assert(phase3Completed.data.success === true, "Phase 3 completed successfully");

    // Give a moment for final events
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // ========================================================================
    // Verify File System State
    // ========================================================================
    console.log(`\n${colors.blue}Verifying file system state...${colors.reset}`);

    // Check notes folder
    await testRunner.assertFileExists(
      path.join(TEST_DIR, "notes/favorite_poem.txt"),
      "Phase 1 created favorite_poem.txt",
    );

    await testRunner.assertFileExists(
      path.join(TEST_DIR, "notes/second_favorite_poem.txt"),
      "Phase 2 created second_favorite_poem.txt",
    );

    // Check TypeScript files
    await testRunner.assertFileExists(
      path.join(TEST_DIR, "typescript_code/src/poem1.ts"),
      "Phase 3 created poem1.ts",
    );

    await testRunner.assertFileExists(
      path.join(TEST_DIR, "typescript_code/src/poem2.ts"),
      "Phase 3 created poem2.ts",
    );

    // Check TypeScript project setup
    await testRunner.assertFileExists(
      path.join(TEST_DIR, "typescript_code/package.json"),
      "Pre-start command created package.json",
    );

    // ========================================================================
    // Verify Log Files
    // ========================================================================
    console.log(`\n${colors.blue}Verifying log files...${colors.reset}`);

    for (const phaseId of ["phase-1", "phase-2", "phase-3"]) {
      const logPath = path.join(TEST_DIR, `.logs/log-${phaseId}.jsonl`);
      await testRunner.assertFileExists(logPath, `Log file exists for ${phaseId}`);

      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, "utf-8");
        const logEntries = parseJSONL(logContent);

        // Check for essential log entries
        const hasInit = logEntries.some((e) => e.type === "system" && e.subtype === "init");
        testRunner.assert(hasInit, `${phaseId} log contains init message`);

        const hasResult = logEntries.some((e) => e.type === "result");
        testRunner.assert(hasResult, `${phaseId} log contains result message`);

        // Extract session ID from logs
        const initEntry = logEntries.find((e) => e.type === "system" && e.subtype === "init");
        const sessionId = initEntry?.session_id;

        // Match with WebSocket events
        const phaseStartEvent = client
          ?.getEvents()
          .find((e) => e.type === "phase.started" && e.data.phaseId === phaseId);

        if (sessionId && phaseStartEvent) {
          // The sessionId in the event is initially generated by the server,
          // but gets updated when Claude sends the init message
          // So we check info events for the actual session ID update
          const infoEvents = client?.getEventsByType("info");
          const sessionUpdateEvent = infoEvents.find((e) =>
            e.data.message.includes(`Claude started with session ID: ${sessionId}`),
          );
          testRunner.assert(
            sessionUpdateEvent !== undefined,
            `Session ID ${sessionId} reported in info event for ${phaseId}`,
          );
        }
      }
    }

    // ========================================================================
    // Verify WebSocket Events
    // ========================================================================
    console.log(`\n${colors.blue}Verifying WebSocket events...${colors.reset}`);

    const allEvents = client.getEvents();

    // Check event sequence
    testRunner.assertEventSequence(allEvents, [
      "server.ready",
      "state.snapshot",
      "phase.started",
      "phase.completed",
      "phase.started",
      "phase.completed",
      "phase.started",
      "phase.completed",
    ]);

    // Check for assistant actions
    const assistantActions = client.getEventsByType("assistant.action");
    testRunner.assert(assistantActions.length > 0, "Received assistant action events");

    // Check for token usage
    const tokenUsageEventsInitial = client.getEventsByType("token.usage");
    testRunner.assert(tokenUsageEventsInitial.length > 0, "Received token usage events");

    // Verify file update events for watched files
    const fileUpdateEventsInitial = client.getEventsByType("file.updated");
    const createdFiles = fileUpdateEventsInitial.filter((e) => e.data.action === "created");
    testRunner.assert(createdFiles.length >= 2, "Received file creation events");

    // ========================================================================
    // Verify Cost Tracking
    // ========================================================================
    console.log(`\n${colors.blue}Verifying cost tracking...${colors.reset}`);

    const finalStateSnapshot = [...allEvents].reverse().find((e) => e.type === "state.snapshot");
    if (finalStateSnapshot) {
      testRunner.assert(
        finalStateSnapshot.data.totalCost > 0,
        `Total cost tracked: ${finalStateSnapshot.data.totalCost.toFixed(4)}`,
      );

      testRunner.assert(
        finalStateSnapshot.data.completedPhases.length === 3,
        "All 3 phases marked as completed",
      );
    }

    // ========================================================================
    // Deep Verification: Cost Reconciliation
    // ========================================================================
    console.log(`\n${colors.blue}Verifying cost reconciliation...${colors.reset}`);

    // Calculate costs from JSONL logs
    let logCalculatedCost = 0;
    const phaseLogCosts: Record<string, number> = {};

    for (const phaseId of ["phase-1", "phase-2", "phase-3"]) {
      const logPath = path.join(TEST_DIR, `.logs/log-${phaseId}.jsonl`);
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, "utf-8");
        const logEntries = parseJSONL(logContent);

        // Find all assistant messages with usage
        const assistantMessages = logEntries.filter(
          (e) => e.type === "assistant" && e.message?.usage,
        );

        // Get the last assistant message (Claude reports cumulative usage)
        const lastMessage = assistantMessages[assistantMessages.length - 1];
        if (lastMessage?.message?.usage) {
          const usage = lastMessage.message.usage;
          const cost = calculateCostFromUsage(usage);
          phaseLogCosts[phaseId] = cost;
          logCalculatedCost += cost;
        }
      }
    }

    // Compare with WebSocket reported costs
    const phaseCompletedEvents = client?.getEventsByType("phase.completed");
    let wsReportedCost = 0;

    for (const event of phaseCompletedEvents) {
      if (event.data.success) {
        wsReportedCost += event.data.cost;

        // Compare individual phase costs
        const logCost = phaseLogCosts[event.data.phaseId] || 0;
        testRunner.assert(
          Math.abs(event.data.cost - logCost) < 0.0001,
          `Phase ${event.data.phaseId} cost matches: WS=${event.data.cost.toFixed(
            4,
          )} vs Log=${logCost.toFixed(4)}`,
        );
      }
    }

    testRunner.assert(
      Math.abs(wsReportedCost - logCalculatedCost) < 0.0001,
      `Total costs match: WS=${wsReportedCost.toFixed(4)} vs Logs=${logCalculatedCost.toFixed(4)}`,
    );

    // ========================================================================
    // Deep Verification: Token Usage Reconciliation
    // ========================================================================
    console.log(`\n${colors.blue}Verifying token usage reconciliation...${colors.reset}`);

    const tokenUsageEvents = client?.getEventsByType("token.usage");

    for (const phaseId of ["phase-1", "phase-2", "phase-3"]) {
      const logPath = path.join(TEST_DIR, `.logs/log-${phaseId}.jsonl`);
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, "utf-8");
        const logEntries = parseJSONL(logContent);

        // Get last assistant message with usage for this phase
        const assistantMessages = logEntries.filter(
          (e) => e.type === "assistant" && e.message?.usage,
        );
        const lastMessage = assistantMessages[assistantMessages.length - 1];

        if (lastMessage?.message?.usage) {
          // Find corresponding final token usage event for this phase
          const phaseTokenEvents = tokenUsageEvents.filter((e) => e.data.phaseId === phaseId);
          const lastTokenEvent = phaseTokenEvents[phaseTokenEvents.length - 1];

          if (lastTokenEvent) {
            const logUsage = lastMessage.message.usage;
            testRunner.assert(
              lastTokenEvent.data.inputTokens === (logUsage.input_tokens || 0),
              `${phaseId} input tokens match`,
            );
            testRunner.assert(
              lastTokenEvent.data.outputTokens === (logUsage.output_tokens || 0),
              `${phaseId} output tokens match`,
            );
          }
        }
      }
    }

    // ========================================================================
    // Deep Verification: Assistant Message Correlation
    // ========================================================================
    console.log(`\n${colors.blue}Verifying assistant message correlation...${colors.reset}`);

    const assistantActionEvents = client?.getEventsByType("assistant.action");

    for (const phaseId of ["phase-1", "phase-2", "phase-3"]) {
      const logPath = path.join(TEST_DIR, `.logs/log-${phaseId}.jsonl`);
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, "utf-8");
        const logEntries = parseJSONL(logContent);

        // Count assistant messages in logs
        const logAssistantMessages = logEntries.filter((e) => e.type === "assistant");
        const logToolUses = logAssistantMessages.filter((e) =>
          e.message?.content?.some((c: { type?: string }) => c.type === "tool_use"),
        ).length;

        // Count WebSocket events for this phase
        const phaseActions = assistantActionEvents.filter((e) => e.data.phaseId === phaseId);
        const wsToolUses = phaseActions.filter((e) => e.data.action === "tool_use").length;

        testRunner.assert(
          wsToolUses >= logToolUses,
          `${phaseId} tool uses reported via WebSocket (${wsToolUses} >= ${logToolUses})`,
        );
      }
    }

    // ========================================================================
    // Deep Verification: File Content Validation
    // ========================================================================
    console.log(`\n${colors.blue}Verifying file content...${colors.reset}`);

    // Check that poems contain expected structure
    const poem1Path = path.join(TEST_DIR, "notes/favorite_poem.txt");
    if (fs.existsSync(poem1Path)) {
      const content = fs.readFileSync(poem1Path, "utf-8");
      testRunner.assert(
        content.includes("\n") && content.trim().split("\n").length >= 2,
        "Favorite poem has multiple lines",
      );
    }

    // Check TypeScript files have proper structure
    const ts1Path = path.join(TEST_DIR, "typescript_code/src/poem1.ts");
    if (fs.existsSync(ts1Path)) {
      await testRunner.assertFileContains(ts1Path, "export", "poem1.ts contains exports");
      await testRunner.assertFileContains(ts1Path, "title:", "poem1.ts has title property");
      await testRunner.assertFileContains(ts1Path, "lines:", "poem1.ts has lines property");
    }

    // Check package.json has expected dependencies
    const packagePath = path.join(TEST_DIR, "typescript_code/package.json");
    if (fs.existsSync(packagePath)) {
      const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
      testRunner.assert(
        packageJson.dependencies?.papaparse !== undefined,
        "package.json contains papaparse dependency",
      );
      testRunner.assert(
        packageJson.dependencies?.lodash !== undefined,
        "package.json contains lodash dependency",
      );
    }

    // ========================================================================
    // Deep Verification: File Watching Events
    // ========================================================================
    console.log(`\n${colors.blue}Verifying file watching events...${colors.reset}`);

    const fileUpdateEvents = client?.getEventsByType("file.updated");

    // Phase 1 should create favorite_poem.txt
    const phase1FileEvents = fileUpdateEvents.filter(
      (e) => e.data.path === "notes/favorite_poem.txt" && e.data.action === "created",
    );
    testRunner.assert(phase1FileEvents.length >= 1, "File event for favorite_poem.txt creation");

    // Phase 2 should create second_favorite_poem.txt
    const phase2FileEvents = fileUpdateEvents.filter(
      (e) => e.data.path === "notes/second_favorite_poem.txt" && e.data.action === "created",
    );
    testRunner.assert(
      phase2FileEvents.length >= 1,
      "File event for second_favorite_poem.txt creation",
    );

    // File events should contain actual content
    if (phase1FileEvents.length > 0) {
      testRunner.assert(
        phase1FileEvents[0].data.content.length > 0,
        "File event contains poem content",
      );
    }

    // ========================================================================
    // Deep Verification: Timing and Duration
    // ========================================================================
    console.log(`\n${colors.blue}Verifying timing and duration...${colors.reset}`);

    for (const completed of phaseCompletedEvents) {
      testRunner.assert(
        completed.data.duration > 0,
        `Phase ${completed.data.phaseId} has positive duration: ${(
          completed.data.duration / 1000
        ).toFixed(1)}s`,
      );

      testRunner.assert(
        completed.data.duration < 120000, // 2 minutes max per phase
        `Phase ${completed.data.phaseId} completed within reasonable time`,
      );
    }

    // Verify events are in chronological order
    let lastTimestamp = 0;
    let chronologicalOrder = true;

    for (const event of allEvents) {
      const timestamp = new Date(event.timestamp).getTime();
      if (timestamp < lastTimestamp) {
        chronologicalOrder = false;
        break;
      }
      lastTimestamp = timestamp;
    }

    testRunner.assert(chronologicalOrder, "All events are in chronological order");

    // ========================================================================
    // Deep Verification: Session Continuity
    // ========================================================================
    console.log(`\n${colors.blue}Verifying session continuity...${colors.reset}`);

    // Phase 2 should continue from Phase 1's session
    const phase1Log = path.join(TEST_DIR, ".logs/log-phase-1.jsonl");
    const phase2Log = path.join(TEST_DIR, ".logs/log-phase-2.jsonl");

    if (fs.existsSync(phase1Log) && fs.existsSync(phase2Log)) {
      const phase1Entries = parseJSONL(fs.readFileSync(phase1Log, "utf-8"));
      const phase2Entries = parseJSONL(fs.readFileSync(phase2Log, "utf-8"));

      const phase1SessionId = phase1Entries.find(
        (e) => e.type === "system" && e.subtype === "init",
      )?.session_id;
      const phase2Resume = phase2Entries.find((e) => e.type === "system" && e.subtype === "info");

      if (phase2Resume?.message) {
        testRunner.assert(
          phase2Resume.message.includes(phase1SessionId),
          "Phase 2 log shows continuation from Phase 1 session",
        );
      }
    }

    // ========================================================================
    // Deep Verification: Error State
    // ========================================================================
    console.log(`\n${colors.blue}Verifying error state...${colors.reset}`);

    const errorEvents = client?.getEventsByType("error");
    testRunner.assert(
      errorEvents.filter((e) => e.data.fatal).length === 0,
      "No fatal errors occurred",
    );

    // Check that all result messages in logs are success
    for (const phaseId of ["phase-1", "phase-2", "phase-3"]) {
      const logPath = path.join(TEST_DIR, `.logs/log-${phaseId}.jsonl`);
      if (fs.existsSync(logPath)) {
        const logEntries = parseJSONL(fs.readFileSync(logPath, "utf-8"));
        const resultEntry = logEntries.find((e) => e.type === "result");
        testRunner.assert(
          resultEntry?.subtype === "success",
          `${phaseId} log shows success result`,
        );
      }
    }

    // ========================================================================
    // Deep Verification: File Tree Structure
    // ========================================================================
    console.log(`\n${colors.blue}Verifying file tree structure...${colors.reset}`);

    const fileTreeEvents = client?.getEventsByType("filetree.updated");
    testRunner.assert(fileTreeEvents.length > 0, "File tree update events received");

    // Check final file tree structure
    const lastFileTree = fileTreeEvents[fileTreeEvents.length - 1];
    if (lastFileTree) {
      const tree = lastFileTree.data.tree;

      // Should have notes directory with files
      const notesDir = findInTree(tree, "notes");
      testRunner.assert(notesDir?.isDirectory === true, "File tree contains notes directory");
      testRunner.assert(
        notesDir?.children?.some((f) => f.name === "favorite_poem.txt") === true,
        "File tree shows favorite_poem.txt in notes",
      );

      // For phase 3, should have typescript_code/src structure
      const tsDir = findInTree(tree, "typescript_code");
      if (tsDir) {
        const srcDir = tsDir.children?.find((f) => f.name === "src");
        testRunner.assert(srcDir?.isDirectory === true, "File tree contains src directory");
        testRunner.assert(srcDir?.children?.length === 2, "src directory contains 2 poem files");
      }
    }

    // ========================================================================
    // Deep Verification: Watch Pattern Compliance
    // ========================================================================
    console.log(`\n${colors.blue}Verifying watch pattern compliance...${colors.reset}`);

    // Phase 1 watches "./notes/*.txt" and creates .txt files
    const phase1WatchedEvents = fileUpdateEvents.filter((e) => {
      const timestamp = new Date(e.timestamp).getTime();
      const phase1Start = phase1Started.timestamp;
      const phase1End = phase1Completed.timestamp;
      return (
        timestamp >= new Date(phase1Start).getTime() && timestamp <= new Date(phase1End).getTime()
      );
    });

    // Phase 1 watches *.txt and creates *.txt, so we should see the .txt file events
    testRunner.assert(
      phase1WatchedEvents.some((e) => e.data.path.endsWith(".txt")),
      "Phase 1 file events match *.txt watch pattern",
    );

    // Phase 2 watches "./notes/*.*" so should see the .txt files
    const phase2Started = client
      ?.getEvents()
      .find((e) => e.type === "phase.started" && e.data.phaseId === "phase-2");
    if (phase2Started) {
      // Should see existing favorite_poem.txt at phase start
      const phase2InitialFiles = fileUpdateEvents.filter((e) => {
        const timestamp = new Date(e.timestamp).getTime();
        const startTime = new Date(phase2Started.timestamp).getTime();
        return timestamp >= startTime && timestamp <= startTime + 2000; // Within 2 seconds of start
      });

      testRunner.assert(
        phase2InitialFiles.some((e) => e.data.path === "notes/favorite_poem.txt"),
        "Phase 2 receives initial file state for watched files",
      );
    }

    // ========================================================================
    // Deep Verification: Info Events
    // ========================================================================
    console.log(`\n${colors.blue}Verifying info events...${colors.reset}`);

    const infoEvents = client?.getEventsByType("info");

    // Should have info about continuation
    testRunner.assert(
      infoEvents.some((e) => e.data.message.includes("Continuing from previous session")),
      "Info event for phase continuation",
    );

    // Should have info about Claude session IDs
    testRunner.assert(
      infoEvents.filter((e) => e.data.message.includes("Claude started with session ID")).length ===
        3,
      "Info events for all 3 Claude session starts",
    );

    // Should have completion message
    testRunner.assert(
      infoEvents.some((e) => e.data.message.includes("All phases completed")),
      "Info event for all phases completed",
    );

    // ========================================================================
    // Deep Verification: Pre-start Command Execution
    // ========================================================================
    console.log(`\n${colors.blue}Verifying pre-start command execution...${colors.reset}`);

    // Phase 1 pre-start creates notes directory
    const notesCreatedBeforePhase1 = fs.existsSync(path.join(TEST_DIR, "notes"));
    testRunner.assert(notesCreatedBeforePhase1, "Pre-start command created notes directory");

    // Phase 3 pre-start runs bun init and installs packages
    const bunLockFile = path.join(TEST_DIR, "typescript_code/bun.lockb");
    await testRunner.assertFileExists(bunLockFile, "Pre-start command ran bun install");

    // Check node_modules was created (indicates successful install)
    const nodeModulesExists = fs.existsSync(path.join(TEST_DIR, "typescript_code/node_modules"));
    testRunner.assert(nodeModulesExists, "Pre-start command installed dependencies");

    // ========================================================================
    // Deep Verification: Tool Use Patterns
    // ========================================================================
    console.log(`\n${colors.blue}Verifying tool use patterns...${colors.reset}`);

    const toolUseActions = assistantActionEvents.filter((e) => e.data.action === "tool_use");

    // Count tool types used
    const toolCounts: Record<string, number> = {};
    for (const action of toolUseActions) {
      const toolName = action.data.toolName || "unknown";
      toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
    }

    testRunner.assert(toolCounts.Write >= 4, "At least 4 Write tool uses (2 poems + 2 TS files)");
    testRunner.assert(toolCounts.LS >= 1, "At least 1 LS tool use");
    testRunner.assert(toolCounts.Read >= 2, "At least 2 Read tool uses (reading poems)");

    // ========================================================================
    // Deep Verification: Lock File and Server State
    // ========================================================================
    console.log(`\n${colors.blue}Verifying lock file and server state...${colors.reset}`);

    const lockFilePath = path.join(TEST_DIR, ".langton-server.lock");
    await testRunner.assertFileExists(lockFilePath, "Server lock file exists");

    if (fs.existsSync(lockFilePath)) {
      const lockPid = fs.readFileSync(lockFilePath, "utf-8").trim();
      testRunner.assert(/^\d+$/.test(lockPid), `Lock file contains valid PID: ${lockPid}`);
    }

    // ========================================================================
    // Deep Verification: JSONL Schema Validation
    // ========================================================================
    console.log(`\n${colors.blue}Verifying JSONL schema compliance...${colors.reset}`);

    for (const phaseId of ["phase-1", "phase-2", "phase-3"]) {
      const logPath = path.join(TEST_DIR, `.logs/log-${phaseId}.jsonl`);
      if (fs.existsSync(logPath)) {
        const logContent = fs.readFileSync(logPath, "utf-8");
        const lines = logContent.split("\n").filter((l) => l.trim());

        let validLines = 0;
        let invalidLines = 0;

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);

            // Basic schema validation
            if (entry.type && entry.timestamp) {
              if (entry.type === "system" && entry.subtype) validLines++;
              else if (entry.type === "assistant" && entry.message) validLines++;
              else if (entry.type === "result" && entry.subtype) validLines++;
              else invalidLines++;
            } else {
              invalidLines++;
            }
          } catch {
            invalidLines++;
          }
        }

        testRunner.assert(
          invalidLines === 0,
          `${phaseId} JSONL has valid schema (${validLines} valid, ${invalidLines} invalid)`,
        );
      }
    }

    // ========================================================================
    // Deep Verification: Path Consistency
    // ========================================================================
    console.log(`\n${colors.blue}Verifying path consistency...${colors.reset}`);

    // All file paths in events should be relative
    const allFilePaths = [
      ...fileUpdateEvents.map((e) => e.data.path),
      ...fileTreeEvents.flatMap((e) => extractPathsFromTree(e.data.tree)),
    ];

    const absolutePaths = allFilePaths.filter((p) => p.startsWith("/") || p.includes(":"));
    testRunner.assert(
      absolutePaths.length === 0,
      "All file paths are relative (no absolute paths)",
    );

    // ========================================================================
    // Deep Verification: Message Ordering Within Phases
    // ========================================================================
    console.log(`\n${colors.blue}Verifying message ordering within phases...${colors.reset}`);

    for (const phaseId of ["phase-1", "phase-2", "phase-3"]) {
      const phaseStart = client
        ?.getEvents()
        .find((e) => e.type === "phase.started" && e.data.phaseId === phaseId);
      const phaseComplete = client
        ?.getEvents()
        .find((e) => e.type === "phase.completed" && e.data.phaseId === phaseId);

      if (phaseStart && phaseComplete) {
        const startIdx = allEvents.indexOf(phaseStart);
        const endIdx = allEvents.indexOf(phaseComplete);

        const phaseEvents = allEvents.slice(startIdx, endIdx + 1);

        // Token usage should come after assistant actions
        let lastAssistantAction = -1;
        let firstTokenUsage = -1;

        for (let i = 0; i < phaseEvents.length; i++) {
          if (phaseEvents[i].type === "assistant.action") {
            lastAssistantAction = i;
          } else if (phaseEvents[i].type === "token.usage" && firstTokenUsage === -1) {
            firstTokenUsage = i;
          }
        }

        if (lastAssistantAction >= 0 && firstTokenUsage >= 0) {
          testRunner.assert(
            firstTokenUsage >= lastAssistantAction,
            `${phaseId}: Token usage events come after assistant actions`,
          );
        }
      }
    }

    // ========================================================================
    // Deep Verification: Resource Cleanup Between Phases
    // ========================================================================
    console.log(`\n${colors.blue}Verifying resource cleanup...${colors.reset}`);

    // Check that file watchers are cleaned up by looking at file events
    // Phase 3 watches TypeScript files, so after Phase 1 & 2, we shouldn't see TS file events
    const phase1And2Events = allEvents.slice(
      0,
      allEvents.findIndex((e) => e.type === "phase.started" && e.data.phaseId === "phase-3"),
    );

    const unexpectedTsEvents = phase1And2Events.filter(
      (e) => e.type === "file.updated" && e.data?.path?.includes("typescript_code"),
    );

    testRunner.assert(
      unexpectedTsEvents.length === 0,
      "No TypeScript file events before Phase 3 (proper watcher cleanup)",
    );

    // Clear timeout since we finished successfully
    if (testTimeout) clearTimeout(testTimeout);

    return testRunner.printSummary();
  } catch (error) {
    console.error(`${colors.red}Test error: ${error}${colors.reset}`);
    return false;
  } finally {
    // Cleanup
    console.log(`\n${colors.blue}Cleaning up...${colors.reset}`);

    // Disconnect client first
    if (client) {
      await client.disconnect();
    }

    // Gracefully shutdown server
    if (serverProcess) {
      console.log(`${colors.gray}Shutting down server gracefully...${colors.reset}`);

      // First try sending shutdown command if client is still connected
      if (client?.isConnected) {
        try {
          client.sendCommand({
            id: generateId(),
            type: "server.shutdown",
          });
          // Give it a moment to shutdown gracefully
          await new Promise((resolve) => setTimeout(resolve, 1000));
        } catch (_e) {
          // Client might already be disconnected
        }
      }

      // Check if process is still running
      if (!serverProcess.killed) {
        console.log(`${colors.gray}Sending SIGTERM to server...${colors.reset}`);
        serverProcess.kill("SIGTERM");

        // Wait up to 5 seconds for graceful shutdown
        const shutdownTimeout = setTimeout(() => {
          if (!serverProcess.killed) {
            console.log(`${colors.yellow}Force killing server with SIGKILL...${colors.reset}`);
            serverProcess.kill("SIGKILL");
          }
        }, 5000);

        // Wait for process to exit
        await new Promise<void>((resolve) => {
          serverProcess.on("exit", () => {
            clearTimeout(shutdownTimeout);
            resolve();
          });
        });
      }

      console.log(`${colors.green}✓ Server shut down${colors.reset}`);
    }

    // Clean up lock file if it still exists (race condition fix)
    const lockFile = path.join(TEST_DIR, ".langton-server.lock");
    if (fs.existsSync(lockFile)) {
      console.log(`${colors.gray}Cleaning up lock file...${colors.reset}`);
      fs.unlinkSync(lockFile);
    }

    console.log(`${colors.green}✓ Cleanup complete${colors.reset}`);

    // Copy test artifacts to results directory
    console.log(`\n${colors.blue}Preserving test results...${colors.reset}`);

    // Copy Claude logs
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

    // Save test summary with detailed results
    const summaryPath = path.join(TEST_RUN_DIR, "test-summary.json");
    const summary = {
      timestamp: TEST_TIMESTAMP,
      duration: Date.now() - testStartTime,
      passed: testRunner.successes.length,
      failed: testRunner.failures.length,
      successes: testRunner.successes,
      failures: testRunner.failures,
      events: client?.getEvents().length || 0,
    };
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

    // Save all WebSocket events for debugging
    const eventsPath = path.join(TEST_RUN_DIR, "websocket-events.json");
    fs.writeFileSync(eventsPath, JSON.stringify(client?.getEvents() || [], null, 2));

    console.log(`\n${colors.yellow}Test results saved to: ${TEST_RUN_DIR}${colors.reset}`);
    console.log(`${colors.gray}  - Server logs: server.log${colors.reset}`);
    console.log(`${colors.gray}  - Claude logs: claude-logs/${colors.reset}`);
    console.log(`${colors.gray}  - Test summary: test-summary.json${colors.reset}`);
    console.log(`${colors.gray}  - WebSocket events: websocket-events.json${colors.reset}`);
  }
}

// ============================================================================
// Entry Point
// ============================================================================

console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}`);
console.log(`${colors.blue}Langton Server End-to-End Test${colors.reset}`);
console.log(`${colors.blue}${"=".repeat(60)}${colors.reset}\n`);

runE2ETest().then((success) => {
  process.exit(success ? 0 : 1);
});
