import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientCommand } from "../../server/command-schemas.js";
import type { StrandweaveState } from "../../server/types/state-types.js";
import type {
  CodonCompletedEvent,
  CodonStartedEvent,
  HandshakeRequest,
  HandshakeResponse,
  ServerEvent,
} from "../../server/types/types.js";
import { ClientMode } from "../../server/types/types.js";

/**
 * Finds an available TCP port provided by the OS.
 * Useful for running multiple server tests in parallel without collisions.
 */
export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      const port = typeof address === "string" ? 0 : address?.port || 0;
      server.close(() => resolve(port));
    });
  });
}

// -------------
// Colors for terminal output
// -------------
export const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
};

// -------------
// Verdaccio Registry Management
// -------------

export interface VerdaccioRegistry {
  server: http.Server;
  registryURL: string;
  storageDir: string;
  port: number;
}

/**
 * Start a local Verdaccio registry for testing package installation.
 * Does NOT build or publish - caller is responsible for that.
 */
export async function startVerdaccioRegistry(packageName: string): Promise<VerdaccioRegistry> {
  const { runServer } = await import("verdaccio");

  // Create temp storage
  const storageDir = await mkdtemp(path.join(tmpdir(), "strandweave-verdaccio-"));

  // Start Verdaccio
  const server = (await runServer({
    self_path: path.dirname(fileURLToPath(import.meta.url)),
    storage: storageDir,
    web: { title: "Test Registry" },
    max_body_size: "128mb",
    max_users: -1,
    log: { level: "fatal" },
    uplinks: {
      npmjs: {
        url: "https://registry.npmjs.org/",
        maxage: "1d",
        cache: true,
      },
    },
    packages: {
      [packageName]: {
        access: "$all",
        publish: "$all",
      },
      "**": {
        access: "$all",
        publish: "noone",
        proxy: "npmjs",
      },
    },
  })) as http.Server;

  // Wait for server to be ready
  await new Promise<void>((resolve, reject) => {
    server.listen(0, () => resolve());
    server.on("error", reject);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to get Verdaccio server address");
  }

  const registryURL = `http://localhost:${address.port}`;

  console.log(`${colors.green}✓ Verdaccio registry started at ${registryURL}${colors.reset}`);

  return {
    server,
    registryURL,
    storageDir,
    port: address.port,
  };
}

/**
 * Stop a Verdaccio registry and clean up temp storage.
 */
export async function stopVerdaccioRegistry(registry: VerdaccioRegistry): Promise<void> {
  // Close server
  await new Promise<void>((resolve) => {
    registry.server.close(() => resolve());
    registry.server.closeAllConnections();
  });

  // Clean up storage
  await rm(registry.storageDir, { recursive: true, force: true });

  console.log(`${colors.gray}✓ Verdaccio registry stopped${colors.reset}`);
}

/**
 * Create .npmrc file with auth token for Verdaccio.
 * Returns path to created .npmrc file.
 */
export async function createNpmrcForVerdaccio(projectRoot: string, port: number): Promise<string> {
  const npmrcPath = path.join(projectRoot, ".npmrc");
  const npmrcContent = `//localhost:${port}/:_authToken=dummy`;
  await writeFile(npmrcPath, npmrcContent);

  console.log(`${colors.gray}✓ Created .npmrc${colors.reset}`);

  return npmrcPath;
}

/**
 * Remove .npmrc file.
 */
export async function removeNpmrc(npmrcPath: string): Promise<void> {
  await rm(npmrcPath, { force: true });
}

// -------------
// Test WebSocket Client
// -------------

// Re-export for convenience
export { ClientMode } from "../../server/types/types.js";

export class TestWSClient {
  private ws: WebSocket | null = null;
  private events: ServerEvent[] = [];
  private eventPromises = new Map<
    string,
    { resolve: (event: ServerEvent) => void; reject: (error: Error) => void }[]
  >();
  private connected = false;
  private connectionClosed = false;
  private handshakeComplete = false;
  private clientId: string | null = null;
  private grantedMode: ClientMode | null = null;

  async connect(
    port: number,
    options: {
      performHandshake?: boolean;
      mode?: ClientMode;
      timeout?: number;
    } = {},
  ): Promise<void> {
    const { performHandshake = true, mode = ClientMode.READANDWRITE, timeout = 10000 } = options;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error("WebSocket connection timeout"));
      }, timeout);

      this.ws = new WebSocket(`ws://localhost:${port}`);

      this.ws.onopen = () => {
        this.connected = true;
        console.log(`${colors.green}✓ Connected to WebSocket server${colors.reset}`);

        if (performHandshake) {
          this.performHandshake(mode)
            .then(() => {
              clearTimeout(timeoutId);
              resolve();
            })
            .catch((error) => {
              clearTimeout(timeoutId);
              reject(error);
            });
        } else {
          clearTimeout(timeoutId);
          resolve();
        }
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);

          // Handle handshake response separately
          if (data.type === "handshake.response") {
            this.handleHandshakeResponse(data as HandshakeResponse);
            return;
          }

          // Regular server events
          const serverEvent: ServerEvent = data;
          this.events.push(serverEvent);

          // Resolve any waiting promises for this event type
          const waiters = this.eventPromises.get(serverEvent.type);
          if (waiters) {
            waiters.forEach(({ resolve }) => {
              resolve(serverEvent);
            });
          }

          // Also resolve "any" event waiters
          const anyWaiters = this.eventPromises.get("*");
          if (anyWaiters) {
            anyWaiters.forEach(({ resolve }) => resolve(serverEvent));
          }
        } catch (error) {
          console.error("Failed to parse server event:", error);
        }
      };

      this.ws.onerror = (error: Event) => {
        clearTimeout(timeoutId);
        reject(error);
      };

      this.ws.onclose = () => {
        this.connected = false;
        this.connectionClosed = true;
        this.handshakeComplete = false;
        this.clientId = null;
        this.grantedMode = null;
        console.log(`${colors.gray}WebSocket connection closed${colors.reset}`);

        // Resolve any pending connection close waiters
        const closeWaiters = this.eventPromises.get("__connection_closed__");
        if (closeWaiters) {
          closeWaiters.forEach(({ resolve }) =>
            resolve({
              id: "synthetic-connection-close",
              timestamp: new Date().toISOString(),
              type: "__connection_closed__",
              data: {},
            } as unknown as ServerEvent),
          );
          this.eventPromises.delete("__connection_closed__");
        }
      };
    });
  }

  private async performHandshake(mode: ClientMode): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Handshake timeout"));
      }, 5000);

      // Set up temporary handler for handshake response
      const handshakePromise = new Promise<HandshakeResponse>((handshakeResolve) => {
        const originalOnMessage = this.ws?.onmessage || null;

        const handleHandshakeMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "handshake.response") {
              // Restore original message handler
              if (this.ws) {
                this.ws.onmessage = originalOnMessage;
              }
              handshakeResolve(data as HandshakeResponse);
            }
          } catch (error) {
            console.error("Failed to parse handshake response:", error);
          }
        };

        if (this.ws) {
          this.ws.onmessage = handleHandshakeMessage;
        }
      });

      // Send handshake request
      const handshakeRequest: HandshakeRequest = {
        type: "handshake",
        data: { mode },
      };

      if (this.ws) {
        this.ws.send(JSON.stringify(handshakeRequest));
      }

      handshakePromise
        .then((response) => {
          this.handleHandshakeResponse(response);
          clearTimeout(timeout);
          resolve();
        })
        .catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
    });
  }

  private handleHandshakeResponse(response: HandshakeResponse): void {
    this.clientId = response.data.clientId;
    this.grantedMode = response.data.mode;
    this.handshakeComplete = true;

    console.log(
      `${colors.green}✓ Handshake complete - Client ID: ${this.clientId}, Mode: ${this.grantedMode}${colors.reset}`,
    );

    // Add any event history to our events array
    if (response.data.eventHistory && response.data.eventHistory.length > 0) {
      this.events.push(...response.data.eventHistory);
      console.log(
        `${colors.gray}Received ${response.data.eventHistory.length} historical events${colors.reset}`,
      );
    }
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
    onlyAfterTimestamp?: string,
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
        const isAfterTimestamp = !onlyAfterTimestamp || event.timestamp > onlyAfterTimestamp;

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

  async waitForCodonStart(
    codonId: string,
    timeout: number = 10000,
    afterTimestamp?: string,
  ): Promise<CodonStartedEvent> {
    // Use waitForEvent with proper filtering
    const event = await this.waitForEvent(
      "codon.started",
      timeout,
      (e) => (e as CodonStartedEvent).data?.codonId === codonId,
      afterTimestamp,
    );
    return event as CodonStartedEvent;
  }

  async waitForCodonCompletion(
    codonId: string,
    timeout: number = 120000,
    afterTimestamp?: string,
  ): Promise<CodonCompletedEvent> {
    // Use waitForEvent with proper filtering
    const event = await this.waitForEvent(
      "codon.completed",
      timeout,
      (e) => (e as CodonCompletedEvent).data?.codonId === codonId,
      afterTimestamp,
    );
    return event as CodonCompletedEvent;
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

  get isHandshakeComplete(): boolean {
    return this.handshakeComplete;
  }

  get getClientId(): string | null {
    return this.clientId;
  }

  get getGrantedMode(): ClientMode | null {
    return this.grantedMode;
  }

  sendCommand(command: ClientCommand): void {
    if (!this.ws || !this.connected) {
      throw new Error("WebSocket not connected");
    }
    if (!this.handshakeComplete) {
      throw new Error("Handshake not completed - cannot send commands");
    }
    this.ws.send(JSON.stringify(command));
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.handshakeComplete = false;
    this.clientId = null;
    this.grantedMode = null;
  }

  // Convenience methods for ping commands
  sendPing(id?: string): void {
    this.sendCommand({
      id: id || `ping-${Date.now()}`,
      type: "ping",
    });
  }

  sendPingBroadcast(id?: string): void {
    this.sendCommand({
      id: id || `ping-broadcast-${Date.now()}`,
      type: "ping.broadcast",
    });
  }

  async waitForPong(timeout: number = 5000): Promise<ServerEvent> {
    return this.waitForEvent("pong", timeout);
  }
}

// -------------
// File System Utilities
// -------------
export async function rimrafSimple(dirPath: string): Promise<void> {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

// -------------
// Test Process Management
// -------------
const activeServerProcesses: ChildProcess[] = [];
let signalHandlersRegistered = false;

function registerSignalHandlers(): void {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;

  const cleanup = (signal: string) => {
    console.log(
      `\n${colors.yellow}Received ${signal}, cleaning up server processes...${colors.reset}`,
    );

    for (const serverProcess of activeServerProcesses) {
      if (!serverProcess.killed && serverProcess.exitCode === null) {
        console.log(
          `${colors.gray}Attempting graceful shutdown of server process ${serverProcess.pid}...${colors.reset}`,
        );

        // First, try to send graceful shutdown via stdin (if server accepts commands)
        try {
          if (serverProcess.stdin && !serverProcess.stdin.destroyed) {
            // Try to send shutdown command - this is a fallback since we don't have WebSocket here
            serverProcess.stdin.write('{"type":"shutdown"}\n');
            serverProcess.stdin.end();
          }
        } catch (_e) {
          // Stdin might not be available or server might not accept commands
        }

        // Then send SIGTERM to the process group
        try {
          if (serverProcess.pid) {
            // Kill the process group (negative PID)
            process.kill(-serverProcess.pid, "SIGTERM");
          }
        } catch (_e) {
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
            `${colors.red}Force killing server process ${serverProcess.pid}...${colors.reset}`,
          );

          try {
            if (serverProcess.pid) {
              process.kill(-serverProcess.pid, "SIGKILL");
            }
          } catch (_e) {
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
        } catch (_e) {
          // Process might already be dead
        }
      }
    }
  });
}

// -------------
// Test Setup Utilities
// -------------
export interface TestDirectoryConfig {
  testDir: string;
  testResultsDir: string;
  testRunDir: string;
}

export async function setupTestDirectory(config: TestDirectoryConfig): Promise<void> {
  console.log(`${colors.blue}Setting up test directory: ${config.testDir}${colors.reset}`);

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
    `${colors.yellow}Test results will be saved to: ${config.testRunDir}${colors.reset}/`,
  );

  // Clean up the entire test directory for a fresh start
  console.log(`  Cleaning entire test directory...`);
  await rimrafSimple(config.testDir);

  // Recreate the test directory
  fs.mkdirSync(config.testDir, { recursive: true });
  console.log(`  ✓ Test directory recreated`);
}

// -------------
// Server Management
// -------------
export interface TestServerConfig {
  testRunDir: string;
  configFile: string;
  port: number;
  testMode: string;
  cwd: string;
  dataSourceDir?: string; // For execution isolation
  useDataFlag?: boolean; // Whether to use --data flag
  executionDir?: string; // Explicit execution directory
  useExecutionFlag?: boolean; // Whether to use --execution flag
  startNew?: boolean; // Force new execution
  withoutProxy?: boolean; // Run server without proxy
  commandOverride?: {
    // Override the default command (bun server/index.ts)
    command: string; // e.g., "npx", "bunx", "pnpm"
    args: string[]; // e.g., ["strandweave"], ["dlx", "strandweave"]
  };
}

export function startServer(config: TestServerConfig): ChildProcess {
  console.log(`${colors.blue}Starting Strandweave server...${colors.reset}`);

  // Register signal handlers for cleanup
  registerSignalHandlers();

  // Create server log file
  const serverLogPath = path.join(config.testRunDir, "server.log");
  const serverLogStream = fs.createWriteStream(serverLogPath, { flags: "a" });

  // Use provided command or default to bun with local server
  let command: string;
  let baseArgs: string[];

  if (config.commandOverride) {
    // Custom command provided
    command = config.commandOverride.command;
    baseArgs = [...config.commandOverride.args];
  } else {
    // Default: bun with local server path
    const serverPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../server/index.ts",
    );
    command = "bun";
    baseArgs = [serverPath];
  }

  // Build args: baseArgs + config flags
  const args = [...baseArgs, `--config=${config.configFile}`, `--port=${config.port}`];

  // Add optional flags
  if (config.withoutProxy) {
    args.push("--without-proxy");
  }

  if (config.useDataFlag && config.dataSourceDir) {
    args.push(`--data=${config.dataSourceDir}`);
  }

  if (config.useExecutionFlag && config.executionDir) {
    args.push(`--execution=${config.executionDir}`);
  }

  if (config.startNew) {
    args.push("--start-new");
  }

  console.log(`${colors.gray}Command: ${command} ${args.join(" ")}${colors.reset}`);

  const serverProcess = spawn(command, args, {
    cwd: config.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      // Pass registry URL if available (for npx/bunx/pnpm to use)
      ...(process.env.npm_config_registry
        ? {
            npm_config_registry: process.env.npm_config_registry,
          }
        : {}),
    },
  });

  serverProcess.stdout?.on("data", (data) => {
    const message = data.toString();
    // Only log to file by default, let tests decide if they want console output
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
    serverLogStream.end();
  });

  serverProcess.on("exit", (code, signal) => {
    serverLogStream.write(
      `[${new Date().toISOString()}] [EXIT] Process exited with code ${code} and signal ${signal}\n`,
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

// -------------
// Test Result Preservation
// -------------
export interface PreserveResultsConfig {
  testDir: string;
  testRunDir: string;
  events: ServerEvent[];
}

export async function preserveTestResults(config: PreserveResultsConfig): Promise<void> {
  console.log(`\n${colors.blue}Preserving test results...${colors.reset}`);

  // Copy the entire runs directory to preserve Claude logs with proper structure
  const runsDir = path.join(config.testDir, ".strandweave/runs");
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
        } else if (entry.name.match(/^codon-.*-claude\.log$/)) {
          claudeLogCount++;
        }
      }
    };
    countLogs(destRunsDir);
    console.log(`  ✓ Copied runs directory with ${claudeLogCount} Claude log files`);
  }

  // Copy state.json
  const stateFile = path.join(config.testDir, ".strandweave/state.json");
  if (fs.existsSync(stateFile)) {
    fs.copyFileSync(stateFile, path.join(config.testRunDir, "state.json"));
    console.log(`  ✓ Copied state.json`);
  }

  // Copy logs directory (for websocket.log and server.log)
  const logsDir = path.join(config.testDir, ".strandweave/logs");
  if (fs.existsSync(logsDir)) {
    const destLogsDir = path.join(config.testRunDir, "logs");
    copyDirectoryRecursive(logsDir, destLogsDir);
    console.log(`  ✓ Copied logs directory`);
  }

  // Save all WebSocket events for debugging
  const eventsPath = path.join(config.testRunDir, "websocket-events.json");
  fs.writeFileSync(eventsPath, JSON.stringify(config.events, null, 2));

  console.log(`\n${colors.yellow}Test results saved to: ${config.testRunDir}/${colors.reset}`);
  console.log(`${colors.gray}  - Server logs: server.log${colors.reset}`);
  console.log(`${colors.gray}  - State: state.json${colors.reset}`);
  console.log(`${colors.gray}  - Runs directory: runs/${colors.reset}`);
  console.log(`${colors.gray}  - Logs directory: logs/${colors.reset}`);
  console.log(`${colors.gray}  - WebSocket events: websocket-events.json${colors.reset}`);
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

// -------------
// Timestamp Generation
// -------------
export function generateTestTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5); // YYYY-MM-DDTHH-mm-ss
}

// -------------
// Cleanup Utilities
// -------------
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
      console.log(`${colors.gray}Shutting down server gracefully...${colors.reset}`);

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
    if (!config.serverProcess.killed && config.serverProcess.exitCode === null) {
      console.log(`${colors.gray}Sending SIGTERM to server...${colors.reset}`);
      config.serverProcess.kill("SIGTERM");

      const shutdownTimeout = setTimeout(() => {
        if (!config.serverProcess?.killed && config.serverProcess?.exitCode === null) {
          console.log(`${colors.yellow}Force killing server with SIGKILL...${colors.reset}`);
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
        `${colors.gray}Server already exited with code ${config.serverProcess.exitCode}${colors.reset}`,
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
  serverShutdownGracefully: boolean,
): Promise<void> {
  const lockFile = path.join(testDir, ".strandweave/runtime.lock");
  if (fs.existsSync(lockFile)) {
    if (serverShutdownGracefully) {
      console.log(
        `${colors.yellow}⚠ Lock file still exists after graceful shutdown - server should have removed it${colors.reset}`,
      );
    } else {
      console.log(`${colors.gray}Cleaning up orphaned lock file...${colors.reset}`);
    }
    fs.unlinkSync(lockFile);
  }
}

// -------------
// State Inspection Helpers for E2E Tests
// -------------

/**
 * Get the server state by reading from the state file.
 * This is used in e2e tests where we don't have direct access to the server instance.
 */
export async function getServerState(testDir: string): Promise<StrandweaveState> {
  const statePath = path.join(testDir, ".strandweave", "state.json");
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
  timeout = 5000,
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
 * Wait for a codon to reach a specific status.
 */
export async function waitForCodonStatus(
  testDir: string,
  codonId: string,
  status: string,
  timeout = 10000,
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      const state = await getServerState(testDir);
      const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
      if (currentRun) {
        const codon = currentRun.codons.find((p) => p.codonId === codonId);
        if (codon?.status === status) return;
      }
    } catch {
      // State file might not exist yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout waiting for codon ${codonId} to reach status ${status}`);
}

/**
 * Get completed codons from the current or most recent run in state.
 */
export async function getCompletedCodonsFromState(testDir: string): Promise<
  Array<{
    codonId: string;
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

  return run.codons
    .filter((p) => p.status === "completed")
    .map((p) => ({
      codonId: p.codonId,
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
    for (const codon of run.codons) {
      if (codon.status === "completed" && "finalCost" in codon) {
        total += codon.finalCost;
      } else if (codon.status === "failed" && "partialCost" in codon) {
        total += codon.partialCost;
      } else if (codon.status === "running" && "currentCost" in codon) {
        total += codon.currentCost;
      }
    }
  }

  return total;
}

/**
 * Check if a codon exists in the current run.
 */
export async function codonExistsInCurrentRun(testDir: string, codonId: string): Promise<boolean> {
  const state = await getServerState(testDir);
  const currentRun = state.runs.find((r) => r.runId === state.currentRunId);
  if (!currentRun) return false;

  return currentRun.codons.some((p) => p.codonId === codonId);
}

/**
 * Sleep for a given number of milliseconds.
 * @param ms Milliseconds to sleep
 * @returns Promise that resolves after the specified time
 */
export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
