import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ClientCommand,
  ServerEvent,
  PhaseStartedEvent,
  PhaseCompletedEvent,
} from "../../server/types.js";

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
          closeWaiters.forEach(({ resolve }) =>
            resolve({ type: "__connection_closed__" } as ServerEvent)
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
    timeout: number = 30000
  ): Promise<ServerEvent> {
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
        resolve: (event: ServerEvent) => {
          clearTimeout(timer);
          resolve(event);
        },
        reject,
      });
      this.eventPromises.set(type, waiters);
    });
  }

  async waitForPhaseStart(
    phaseId: string,
    timeout: number = 10000
  ): Promise<PhaseStartedEvent> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const started = this.events.find(
        (e) =>
          e.type === "phase.started" &&
          (e as PhaseStartedEvent).data?.phaseId === phaseId
      ) as PhaseStartedEvent | undefined;
      if (started) return started;

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Timeout waiting for phase ${phaseId} to start`);
  }

  async waitForPhaseCompletion(
    phaseId: string,
    timeout: number = 120000
  ): Promise<PhaseCompletedEvent> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const completed = this.events.find(
        (e) =>
          e.type === "phase.completed" &&
          (e as PhaseCompletedEvent).data?.phaseId === phaseId
      ) as PhaseCompletedEvent | undefined;
      if (completed) return completed;

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
}

export function startServer(config: ServerConfig): ChildProcess {
  console.log(`${colors.blue}Starting Langton server...${colors.reset}`);

  // Register signal handlers for cleanup
  registerSignalHandlers();

  // Create server log file
  const serverLogPath = path.join(config.testRunDir, "server.log");
  const serverLogStream = fs.createWriteStream(serverLogPath, { flags: "a" });

  // Use absolute path to server to ensure it's found regardless of where test is run from
  const serverPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../server/index.ts");
  
  const serverProcess = spawn(
    "bun",
    [
      serverPath,
      `--config=${config.phasesConfig}`,
      `--port=${config.port}`,
      `--test-mode=${config.testMode}`,
    ],
    {
      cwd: config.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LANGTON_TEST_RUN: "true",
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

  // Copy Claude logs
  const logsDir = path.join(config.testDir, ".langton/logs");
  if (fs.existsSync(logsDir)) {
    const destLogsDir = path.join(config.testRunDir, "claude-logs");
    fs.mkdirSync(destLogsDir, { recursive: true });

    const logFiles = fs.readdirSync(logsDir);
    for (const file of logFiles) {
      fs.copyFileSync(path.join(logsDir, file), path.join(destLogsDir, file));
    }
    console.log(`  ✓ Copied ${logFiles.length} Claude log files`);
  }

  // Save all WebSocket events for debugging
  const eventsPath = path.join(config.testRunDir, "websocket-events.json");
  fs.writeFileSync(eventsPath, JSON.stringify(config.events, null, 2));

  console.log(
    `\n${colors.yellow}Test results saved to: ${config.testRunDir}/${colors.reset}`
  );
  console.log(`${colors.gray}  - Server logs: server.log${colors.reset}`);
  console.log(`${colors.gray}  - Claude logs: claude-logs/${colors.reset}`);
  console.log(
    `${colors.gray}  - WebSocket events: websocket-events.json${colors.reset}`
  );
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
