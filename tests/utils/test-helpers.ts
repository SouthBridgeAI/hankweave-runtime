import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ClientCommand,
  ServerEvent,
  PhaseStartedEvent,
  PhaseCompletedEvent,
} from "../../server/types.js";
import type { LangtonServer } from "../../server/langton-server.js";
import type { LangtonState } from "../../server/state-types.js";

// ============================================================================
// Colors for terminal output
// ============================================================================
export const colors = {
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
export class TestWSClient {
  private ws: WebSocket | null = null;
  private events: ServerEvent[] = [];
  private eventPromises = new Map<
    string,
    { resolve: (event: ServerEvent) => void; reject: (error: Error) => void }[]
  >();
  private connected = false;
  private connectionClosed = false;

  async connect(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"));
      }, 10000);

      this.ws = new WebSocket(`ws://localhost:${port}`);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        this.connected = true;
        console.log(
          `${colors.green}✓ Connected to WebSocket server${colors.reset}`
        );
        resolve();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const serverEvent: ServerEvent = JSON.parse(event.data);
          this.events.push(serverEvent);

          // Resolve any waiting promises for this event type
          const waiters = this.eventPromises.get(serverEvent.type);
          if (waiters) {
            // Create a new array to hold waiters that don't match
            const remainingWaiters: typeof waiters = [];

            waiters.forEach(({ resolve }) => {
              // Each waiter's resolve function will check if it matches
              resolve(serverEvent);
            });

            // Don't delete the waiters array - let each waiter remove itself if it matches
          }

          // Also resolve "any" event waiters
          const anyWaiters = this.eventPromises.get("*");
          if (anyWaiters) {
            anyWaiters.forEach(({ resolve }) => resolve(serverEvent));
            // Don't delete - let each waiter remove itself
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
          closeWaiters.forEach(({ resolve }) =>
            resolve({ type: "__connection_closed__" } as any as ServerEvent)
          );
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

  async waitForEvent(
    type: string,
    timeoutMs: number = 30000,
    filter?: (event: ServerEvent) => boolean,
    onlyAfterTimestamp?: string
  ): Promise<ServerEvent> {
    // Check if we already have this event
    let existing: ServerEvent | undefined;

    if (onlyAfterTimestamp) {
      // Option 3: Only return events after the specified timestamp
      existing = this.events.find((e) => {
        const matchesType = type === "*" || e.type === type;
        const isAfterTimestamp = e.timestamp > onlyAfterTimestamp;
        const passesFilter = !filter || filter(e);
        return matchesType && isAfterTimestamp && passesFilter;
      });
    } else {
      // Original behavior with optional filter (Option 2)
      existing = this.events.find((e) => {
        const matchesType = type === "*" || e.type === type;
        const passesFilter = !filter || filter(e);
        return matchesType && passesFilter;
      });
    }

    if (existing) return existing;

    // Wait for future event
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this waiter from the list on timeout
        const waiters = this.eventPromises.get(type) || [];
        const index = waiters.findIndex((w) => w.resolve === waiterResolve);
        if (index > -1) {
          waiters.splice(index, 1);
          if (waiters.length === 0) {
            this.eventPromises.delete(type);
          }
        }
        reject(new Error(`Timeout waiting for event: ${type}`));
      }, timeoutMs);

      let resolved = false;

      const waiterResolve = (event: ServerEvent) => {
        if (resolved) return; // Already resolved

        // Apply the same filtering logic to future events
        const passesFilter = !filter || filter(event);
        const isAfterTimestamp =
          !onlyAfterTimestamp || event.timestamp > onlyAfterTimestamp;

        if (passesFilter && isAfterTimestamp) {
          resolved = true;
          clearTimeout(timer);

          // Remove this waiter from the list
          const waiters = this.eventPromises.get(type) || [];
          const index = waiters.findIndex((w) => w.resolve === waiterResolve);
          if (index > -1) {
            waiters.splice(index, 1);
            if (waiters.length === 0) {
              this.eventPromises.delete(type);
            }
          }

          resolve(event);
        }
        // If event doesn't pass filter, this waiter stays in the list
        // and will be called again for the next matching event type
      };

      const waiters = this.eventPromises.get(type) || [];
      waiters.push({
        resolve: waiterResolve,
        reject,
      });
      this.eventPromises.set(type, waiters);
    });
  }

  async waitForPhaseStart(
    phaseId: string,
    timeout: number = 10000,
    afterTimestamp?: string
  ): Promise<PhaseStartedEvent> {
    // Use waitForEvent with proper filtering
    const event = await this.waitForEvent(
      "phase.started",
      timeout,
      (e) => (e as PhaseStartedEvent).data?.phaseId === phaseId,
      afterTimestamp
    );
    return event as PhaseStartedEvent;
  }

  async waitForPhaseCompletion(
    phaseId: string,
    timeout: number = 120000,
    afterTimestamp?: string
  ): Promise<PhaseCompletedEvent> {
    // Use waitForEvent with proper filtering
    const event = await this.waitForEvent(
      "phase.completed",
      timeout,
      (e) => (e as PhaseCompletedEvent).data?.phaseId === phaseId,
      afterTimestamp
    );
    return event as PhaseCompletedEvent;
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
// File System Utilities
// ============================================================================
export async function rimrafSimple(dirPath: string): Promise<void> {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

// ============================================================================
// Test Process Management
// ============================================================================
let activeServerProcesses: ChildProcess[] = [];
let signalHandlersRegistered = false;

function registerSignalHandlers(): void {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;

  const cleanup = (signal: string) => {
    console.log(
      `\n${colors.yellow}Received ${signal}, cleaning up server processes...${colors.reset}`
    );

    for (const serverProcess of activeServerProcesses) {
      if (!serverProcess.killed && serverProcess.exitCode === null) {
        console.log(
          `${colors.gray}Attempting graceful shutdown of server process ${serverProcess.pid}...${colors.reset}`
        );

        // First, try to send graceful shutdown via stdin (if server accepts commands)
        try {
          if (serverProcess.stdin && !serverProcess.stdin.destroyed) {
            // Try to send shutdown command - this is a fallback since we don't have WebSocket here
            serverProcess.stdin.write('{"type":"shutdown"}\n');
            serverProcess.stdin.end();
          }
        } catch (e) {
          // Stdin might not be available or server might not accept commands
        }

        // Then send SIGTERM to the process group
        try {
          if (serverProcess.pid) {
            // Kill the process group (negative PID)
            process.kill(-serverProcess.pid, "SIGTERM");
          }
        } catch (e) {
          // Fallback to individual process
          serverProcess.kill("SIGTERM");
        }
      }
    }

    // Give processes time to shut down gracefully, then force kill
    setTimeout(() => {
      for (const serverProcess of activeServerProcesses) {
        if (!serverProcess.killed && serverProcess.exitCode === null) {
          console.log(
            `${colors.red}Force killing server process ${serverProcess.pid}...${colors.reset}`
          );

          try {
            if (serverProcess.pid) {
              process.kill(-serverProcess.pid, "SIGKILL");
            }
          } catch (e) {
            serverProcess.kill("SIGKILL");
          }
        }
      }

      setTimeout(() => {
        process.exit(signal === "SIGTERM" ? 0 : 1);
      }, 500);
    }, 3000);
  };

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));

  // Final fallback cleanup on process exit
  process.on("exit", () => {
    for (const serverProcess of activeServerProcesses) {
      if (!serverProcess.killed && serverProcess.exitCode === null) {
        try {
          serverProcess.kill("SIGKILL");
        } catch (e) {
          // Process might already be dead
        }
      }
    }
  });
}

// ============================================================================
// Test Setup Utilities
// ============================================================================
export interface TestDirectoryConfig {
  testDir: string;
  testResultsDir: string;
  testRunDir: string;
}

export async function setupTestDirectory(
  config: TestDirectoryConfig
): Promise<void> {
  console.log(
    `${colors.blue}Setting up test directory: ${config.testDir}${colors.reset}`
  );

  // Create directories if they don't exist
  if (!fs.existsSync(config.testDir)) {
    fs.mkdirSync(config.testDir, { recursive: true });
  }

  if (!fs.existsSync(config.testResultsDir)) {
    fs.mkdirSync(config.testResultsDir, { recursive: true });
  }

  if (!fs.existsSync(config.testRunDir)) {
    fs.mkdirSync(config.testRunDir, { recursive: true });
  }

  console.log(
    `${colors.yellow}Test results will be saved to: ${config.testRunDir}${colors.reset}/`
  );

  // Clean up the entire test directory for a fresh start
  console.log(`  Cleaning entire test directory...`);
  await rimrafSimple(config.testDir);

  // Recreate the test directory
  fs.mkdirSync(config.testDir, { recursive: true });
  console.log(`  ✓ Test directory recreated`);
}

// ============================================================================
// Server Management
// ============================================================================
export interface ServerConfig {
  testRunDir: string;
  phasesConfig: string;
  port: number;
  testMode: string;
  cwd: string;
  dataSourceDir?: string; // For execution isolation
  useDataFlag?: boolean; // Whether to use --data flag
  executionDir?: string; // Explicit execution directory
  useExecutionFlag?: boolean; // Whether to use --execution flag
  startNew?: boolean; // Force new execution
}

export function startServer(config: ServerConfig): ChildProcess {
  console.log(`${colors.blue}Starting Langton server...${colors.reset}`);

  // Register signal handlers for cleanup
  registerSignalHandlers();

  // Create server log file
  const serverLogPath = path.join(config.testRunDir, "server.log");
  const serverLogStream = fs.createWriteStream(serverLogPath, { flags: "a" });

  // Use absolute path to server to ensure it's found regardless of where test is run from
  const serverPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../server/index.ts"
  );

  // Build command arguments
  const args = [
    serverPath,
    `--config=${config.phasesConfig}`,
    `--port=${config.port}`
  ];

  // Add --data flag if using execution isolation
  if (config.useDataFlag && config.dataSourceDir) {
    args.push(`--data=${config.dataSourceDir}`);
  }

  // Add --execution flag if using explicit execution directory
  if (config.useExecutionFlag && config.executionDir) {
    args.push(`--execution=${config.executionDir}`);
  }

  // Add --start-new flag if forcing new execution
  if (config.startNew) {
    args.push('--start-new');
  }

  const serverProcess = spawn(
    "bun",
    args,
    {
      cwd: config.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
      },
    }
  );

  serverProcess.stdout?.on("data", (data) => {
    const message = data.toString();
    // Only log to file by default, let tests decide if they want console output
    serverLogStream.write(`[${new Date().toISOString()}] [STDOUT] ${message}`);
  });

  serverProcess.stderr?.on("data", (data) => {
    const message = data.toString();
    console.error(
      `${colors.red}[SERVER ERROR] ${message.trim()}${colors.reset}`
    );
    serverLogStream.write(`[${new Date().toISOString()}] [STDERR] ${message}`);
  });

  serverProcess.on("error", (error) => {
    const message = `Failed to start server: ${error.message}`;
    console.error(`${colors.red}${message}${colors.reset}`);
    serverLogStream.write(`[${new Date().toISOString()}] [ERROR] ${message}\n`);
    serverLogStream.end();
  });

  serverProcess.on("exit", (code, signal) => {
    serverLogStream.write(
      `[${new Date().toISOString()}] [EXIT] Process exited with code ${code} and signal ${signal}\n`
    );
    serverLogStream.end();

    // Remove from active processes list
    const index = activeServerProcesses.indexOf(serverProcess);
    if (index > -1) {
      activeServerProcesses.splice(index, 1);
    }
  });

  // Add to active processes list for signal handling
  activeServerProcesses.push(serverProcess);

  return serverProcess;
}

// ============================================================================
// Test Result Preservation
// ============================================================================
export interface PreserveResultsConfig {
  testDir: string;
  testRunDir: string;
  events: ServerEvent[];
}

export async function preserveTestResults(
  config: PreserveResultsConfig
): Promise<void> {
  console.log(`\n${colors.blue}Preserving test results...${colors.reset}`);

  // Copy the entire runs directory to preserve Claude logs with proper structure
  const runsDir = path.join(config.testDir, ".langton/runs");
  if (fs.existsSync(runsDir)) {
    const destRunsDir = path.join(config.testRunDir, "runs");
    copyDirectoryRecursive(runsDir, destRunsDir);

    // Count Claude log files for reporting
    let claudeLogCount = 0;
    const countLogs = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          countLogs(fullPath);
        } else if (entry.name.match(/^phase-.*-claude\.log$/)) {
          claudeLogCount++;
        }
      }
    };
    countLogs(destRunsDir);
    console.log(
      `  ✓ Copied runs directory with ${claudeLogCount} Claude log files`
    );
  }

  // Copy state.json
  const stateFile = path.join(config.testDir, ".langton/state.json");
  if (fs.existsSync(stateFile)) {
    fs.copyFileSync(stateFile, path.join(config.testRunDir, "state.json"));
    console.log(`  ✓ Copied state.json`);
  }

  // Copy logs directory (for websocket.log and server.log)
  const logsDir = path.join(config.testDir, ".langton/logs");
  if (fs.existsSync(logsDir)) {
    const destLogsDir = path.join(config.testRunDir, "logs");
    copyDirectoryRecursive(logsDir, destLogsDir);
    console.log(`  ✓ Copied logs directory`);
  }

  // Save all WebSocket events for debugging
  const eventsPath = path.join(config.testRunDir, "websocket-events.json");
  fs.writeFileSync(eventsPath, JSON.stringify(config.events, null, 2));

  console.log(
    `\n${colors.yellow}Test results saved to: ${config.testRunDir}/${colors.reset}`
  );
  console.log(`${colors.gray}  - Server logs: server.log${colors.reset}`);
  console.log(`${colors.gray}  - State: state.json${colors.reset}`);
  console.log(`${colors.gray}  - Runs directory: runs/${colors.reset}`);
  console.log(`${colors.gray}  - Logs directory: logs/${colors.reset}`);
  console.log(
    `${colors.gray}  - WebSocket events: websocket-events.json${colors.reset}`
  );
}

// Helper function to copy directory recursively
function copyDirectoryRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ============================================================================
// Timestamp Generation
// ============================================================================
export function generateTestTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5); // YYYY-MM-DDTHH-mm-ss
}

// ============================================================================
// Cleanup Utilities
// ============================================================================
export interface CleanupConfig {
  testDir: string;
  testRunDir: string;
  serverProcess: ChildProcess | null;
  client: TestWSClient | null;
  events: ServerEvent[];
  gracefulShutdown?: boolean;
}

export async function cleanupTest(config: CleanupConfig): Promise<void> {
  console.log(`\n${colors.blue}Cleaning up...${colors.reset}`);

  // Disconnect client first
  if (config.client) {
    await config.client.disconnect();
  }

  // Handle server shutdown
  if (config.serverProcess) {
    if (config.gracefulShutdown && config.client?.isConnected) {
      console.log(
        `${colors.gray}Shutting down server gracefully...${colors.reset}`
      );

      try {
        const { generateId } = await import("../../server/utils.js");
        config.client.sendCommand({
          id: generateId(),
          type: "server.shutdown",
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (_e) {
        // Client might already be disconnected
      }
    }

    // Force shutdown if still running
    if (
      !config.serverProcess.killed &&
      config.serverProcess.exitCode === null
    ) {
      console.log(`${colors.gray}Sending SIGTERM to server...${colors.reset}`);
      config.serverProcess.kill("SIGTERM");

      const shutdownTimeout = setTimeout(() => {
        if (
          !config.serverProcess?.killed &&
          config.serverProcess?.exitCode === null
        ) {
          console.log(
            `${colors.yellow}Force killing server with SIGKILL...${colors.reset}`
          );
          config.serverProcess.kill("SIGKILL");
        }
      }, 5000);

      await new Promise<void>((resolve) => {
        config.serverProcess?.on("exit", () => {
          clearTimeout(shutdownTimeout);
          resolve();
        });
      });
    } else if (config.serverProcess.exitCode !== null) {
      console.log(
        `${colors.gray}Server already exited with code ${config.serverProcess.exitCode}${colors.reset}`
      );
    }

    console.log(`${colors.green}✓ Server shut down${colors.reset}`);
  }

  // Clean up lock file only if server didn't shut down gracefully
  await cleanupLockFile(config.testDir, config.gracefulShutdown || false);

  console.log(`${colors.green}✓ Cleanup complete${colors.reset}`);

  // Preserve test results
  await preserveTestResults({
    testDir: config.testDir,
    testRunDir: config.testRunDir,
    events: config.events,
  });
}

export async function cleanupLockFile(
  testDir: string,
  serverShutdownGracefully: boolean
): Promise<void> {
  const lockFile = path.join(testDir, ".langton/server.lock");
  if (fs.existsSync(lockFile)) {
    if (serverShutdownGracefully) {
      console.log(
        `${colors.yellow}⚠ Lock file still exists after graceful shutdown - server should have removed it${colors.reset}`
      );
    } else {
      console.log(
        `${colors.gray}Cleaning up orphaned lock file...${colors.reset}`
      );
    }
    fs.unlinkSync(lockFile);
  }
}

// ============================================================================
// State Inspection Helpers for E2E Tests
// ============================================================================

/**
 * Get the server state by reading from the state file.
 * This is used in e2e tests where we don't have direct access to the server instance.
 */
export async function getServerState(testDir: string): Promise<LangtonState> {
  const statePath = path.join(testDir, ".langton", "state.json");
  if (!fs.existsSync(statePath)) {
    throw new Error("State file not found");
  }
  const content = await fs.promises.readFile(statePath, "utf-8");
  return JSON.parse(content);
}

/**
 * Wait for a run to reach a specific status.
 */
export async function waitForRunStatus(
  testDir: string,
  status: "running" | "completed" | "failed" | "crashed",
  timeout = 5000
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      const state = await getServerState(testDir);
      const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
      if (currentRun?.status === status) return;
    } catch {
      // State file might not exist yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout waiting for run status ${status}`);
}

/**
 * Wait for a phase to reach a specific status.
 */
export async function waitForPhaseStatus(
  testDir: string,
  phaseId: string,
  status: string,
  timeout = 10000
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      const state = await getServerState(testDir);
      const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
      if (currentRun) {
        const phase = currentRun.phases.find((p) => p.phaseId === phaseId);
        if (phase?.status === status) return;
      }
    } catch {
      // State file might not exist yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timeout waiting for phase ${phaseId} to reach status ${status}`
  );
}

/**
 * Get completed phases from the current or most recent run in state.
 */
export async function getCompletedPhasesFromState(testDir: string): Promise<
  Array<{
    phaseId: string;
    cost: number;
    sessionId: string;
  }>
> {
  const state = await getServerState(testDir);
  // Try current run first, then fallback to most recent run
  const run =
    state.runs.find((r) => r.runId === state.currentRunId) ||
    (state.runs.length > 0 ? state.runs[0] : null);
  if (!run) return [];

  return run.phases
    .filter((p) => p.status === "completed")
    .map((p) => ({
      phaseId: p.phaseId,
      cost: "finalCost" in p ? p.finalCost : 0,
      sessionId: "claudeSessionId" in p ? p.claudeSessionId : "unknown",
    }));
}

/**
 * Get the total cost from state.
 */
export async function getTotalCostFromState(testDir: string): Promise<number> {
  const state = await getServerState(testDir);
  let total = 0;

  for (const run of state.runs) {
    for (const phase of run.phases) {
      if (phase.status === "completed" && "finalCost" in phase) {
        total += phase.finalCost;
      } else if (phase.status === "failed" && "partialCost" in phase) {
        total += phase.partialCost;
      } else if (phase.status === "running" && "currentCost" in phase) {
        total += phase.currentCost;
      }
    }
  }

  return total;
}

/**
 * Check if a phase exists in the current run.
 */
export async function phaseExistsInCurrentRun(
  testDir: string,
  phaseId: string
): Promise<boolean> {
  const state = await getServerState(testDir);
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  if (!currentRun) return false;

  return currentRun.phases.some((p) => p.phaseId === phaseId);
}
