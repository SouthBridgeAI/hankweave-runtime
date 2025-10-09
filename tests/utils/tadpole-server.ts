import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  PhaseCompletedEvent,
  PhaseStartedEvent,
  ServerEventType,
} from "../../server/schemas/event-schemas.js";
import type { TadpoleState } from "../../server/types/state-types.js";
import {
  type ClientCommand,
  ClientMode,
  type HandshakeResponse,
  type ServerEvent,
} from "../../server/types/types.js";
import { generateTestTimestamp, setupTestDirectory } from "./test-helpers.js";

// ============================================================================
// WebSocket Client Setup Helpers
// ============================================================================

// Re-export ClientMode for convenience
export { ClientMode };

/**
 * Result of connecting a Tadpole WebSocket client.
 */
export interface ClientSetupResult {
  /** The connected WebSocket client instance */
  client: WebSocket;
  /** The unique client ID assigned by the server */
  clientId: string;
  /** The handshake response from the server, if handshake was performed */
  handshakeResponse?: HandshakeResponse;
}

/**
 * Connects a WebSocket client to a Tadpole server and optionally performs handshake.
 *
 * @param serverUrl - The WebSocket server URL (e.g., "ws://localhost:8889")
 * @param options - Connection options
 * @param options.performHandshake - Whether to perform handshake after connection (default: true)
 * @param options.mode - Client access mode (default: ClientMode.READANDWRITE)
 * @param options.timeout - Connection timeout in milliseconds (default: 5000)
 * @param options.sendPreviousEvents - Whether to request event history in handshake (default: undefined)
 * @returns A promise that resolves with the client setup result
 * @throws {Error} If connection fails or handshake times out
 *
 * @example
 * ```ts
 * // Connect with full access and handshake
 * const { client, clientId } = await connectTadpoleClient("ws://localhost:8889", {
 *   mode: ClientMode.READANDWRITE
 * });
 *
 * // Connect without handshake
 * const { client } = await connectTadpoleClient("ws://localhost:8889", {
 *   performHandshake: false
 * });
 *
 * // Connect and request event history
 * const { client, handshakeResponse } = await connectTadpoleClient("ws://localhost:8889", {
 *   mode: ClientMode.READONLY,
 *   sendPreviousEvents: true
 * });
 * ```
 */
export async function connectTadpoleClient(
  serverUrl: string,
  options: {
    performHandshake?: boolean;
    mode?: ClientMode;
    timeout?: number;
    sendPreviousEvents?: boolean;
  } = {},
): Promise<ClientSetupResult> {
  const {
    performHandshake = true,
    mode = ClientMode.READANDWRITE,
    timeout = 5000,
    sendPreviousEvents,
  } = options;

  // Connect client
  const client = new WebSocket(serverUrl);

  const connected = await new Promise<boolean>((resolve) => {
    client.onopen = () => resolve(true);
    client.onerror = () => resolve(false);
    setTimeout(() => resolve(false), timeout);
  });

  if (!connected) {
    throw new Error("Failed to connect client to server");
  }

  if (!performHandshake) {
    return { client, clientId: "unknown" };
  }

  // Perform handshake
  const handshakePromise = new Promise<HandshakeResponse>((resolve, reject) => {
    client.onmessage = (event: MessageEvent) => {
      const data = JSON.parse(event.data) as HandshakeResponse;
      if (data.type === "handshake.response") {
        resolve(data);
      }
    };
    client.onerror = () => reject(new Error("WebSocket error during handshake"));
    setTimeout(() => reject(new Error("Handshake timeout")), timeout);
  });

  const handshakeData: { mode: ClientMode; sendPreviousEvents?: boolean } = {
    mode,
  };
  if (sendPreviousEvents !== undefined) {
    handshakeData.sendPreviousEvents = sendPreviousEvents;
  }

  client.send(
    JSON.stringify({
      type: "handshake",
      data: handshakeData,
    }),
  );

  const handshakeResponse = await handshakePromise;

  if (!handshakeResponse.data.clientId) {
    throw new Error("Handshake response missing clientId");
  }

  return {
    client,
    clientId: handshakeResponse.data.clientId,
    handshakeResponse,
  };
}

// ============================================================================
// Server Launch Options and Interfaces
// ============================================================================

/**
 * Options for launching a Tadpole server for testing.
 */
export interface LaunchServerOptions {
  /** Working directory for the server process (default: project root) */
  cwd?: string;
  /** Environment variables for the server process */
  env?: NodeJS.ProcessEnv;
  /** Prefix for server log messages (default: "[tadpole-server]") */
  logPrefix?: string;
  /** Server WebSocket port (default: 8889) */
  port?: number;
  /** WebSocket connection timeout in milliseconds (default: 10000) */
  websocketConnectTimeoutMs?: number;
  /** Number of WebSocket connection attempts (default: calculated from timeout) */
  websocketConnectAttempts?: number;
  /** Reuse test directory from previous run without recreating it (default: false) */
  reuseTestDirectory?: boolean;
  /** Request previous events from the server in handshake (default: false) */
  sendPreviousEvents?: boolean;
  /** Number of ping events to generate after server is ready (default: 0) */
  generatePingEvents?: number;
}

/**
 * A launched Tadpole server with a connected WebSocket client and helper methods.
 */
export interface LaunchedServer {
  /** The server child process */
  process: ChildProcess;
  /** The WebSocket server URL */
  websocketServerUrl: string;
  /** The connected WebSocket client */
  client: WebSocket;
  /** The client ID assigned by the server */
  clientId: string;
  /** Array of all server events received */
  events: ServerEvent[];
  /**
   * Sends a command to the server.
   * @param command - The command to send
   * @throws {Error} If WebSocket is not connected
   */
  sendCommand: (command: ClientCommand) => void;
  /**
   * Gets a copy of all events received so far.
   * @returns Array of server events
   */
  getEvents: () => ServerEvent[];
  /**
   * Waits for a specific event type with optional filtering.
   * @param type - Event type to wait for (or "*" for any event)
   * @param timeoutMs - Timeout in milliseconds (default: 30000)
   * @param filter - Optional filter function
   * @param onlyAfterTimestamp - Only match events after this timestamp
   * @returns Promise that resolves with the matching event
   * @throws {Error} If timeout is reached
   */
  waitForEvent: (
    type: ServerEventType,
    timeoutMs?: number,
    filter?: (event: ServerEvent) => boolean,
    onlyAfterTimestamp?: string,
  ) => Promise<ServerEvent>;
  /**
   * Waits for a phase to start.
   * @param phaseId - The phase ID to wait for
   * @param afterTimestamp - Only match events after this timestamp
   * @param timeout - Timeout in milliseconds (default: 10000)
   * @returns Promise that resolves with the phase.started event
   * @throws {Error} If timeout is reached
   */
  waitForPhaseStart: (
    phaseId: string,
    afterTimestamp?: string,
    timeout?: number,
  ) => Promise<ServerEvent>;
  /**
   * Waits for a phase to complete.
   * @param phaseId - The phase ID to wait for
   * @param afterTimestamp - Only match events after this timestamp
   * @param timeout - Timeout in milliseconds (default: 120000)
   * @returns Promise that resolves with the phase.completed event
   * @throws {Error} If timeout is reached
   */
  waitForPhaseCompletion: (
    phaseId: string,
    afterTimestamp?: string,
    timeout?: number,
  ) => Promise<ServerEvent>;
  /**
   * Waits for the WebSocket connection to close.
   * @param timeout - Timeout in milliseconds (default: 10000)
   * @throws {Error} If timeout is reached
   */
  waitForConnectionClose: (timeout?: number) => Promise<void>;
  /**
   * Connects an additional WebSocket client to the server.
   * @param options - Connection options (same as connectTadpoleClient)
   * @returns Promise that resolves with the client setup result
   */
  connectClient: (options?: {
    performHandshake?: boolean;
    mode?: ClientMode;
    timeout?: number;
    sendPreviousEvents?: boolean;
  }) => Promise<ClientSetupResult>;
  /**
   * Disconnects the primary WebSocket client.
   */
  disconnect: () => Promise<void>;
  /**
   * Gracefully stops the server with SIGINT.
   * @param timeoutMs - Timeout in milliseconds (default: 10000)
   * @throws {Error} If server doesn't exit within timeout
   */
  stop: (timeoutMs?: number) => Promise<void>;
  /**
   * Forcefully kills the server with SIGKILL.
   * @param timeoutMs - Timeout in milliseconds (default: 5000)
   * @throws {Error} If server doesn't exit within timeout
   */
  kill: (timeoutMs?: number) => Promise<void>;
  /**
   * Checks if the server lock file exists.
   * @returns True if the lock file exists, false otherwise
   */
  hasLockFile: () => boolean;
  /**
   * Gets the current Tadpole state from state.json.
   * @returns The parsed TadpoleState object
   * @throws {Error} If state.json doesn't exist or cannot be parsed
   */
  getState: () => TadpoleState;
  /**
   * Waits for the state to match a predicate.
   * Polls state.json until predicate returns true or timeout is reached.
   * @param predicate - Optional function to test state (default: state exists)
   * @param timeoutMs - Timeout in milliseconds (default: 10000)
   * @returns Promise that resolves with the matching state
   * @throws {Error} If timeout is reached
   */
  waitForState: (
    predicate?: (state: TadpoleState) => boolean,
    timeoutMs?: number,
  ) => Promise<TadpoleState>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CWD = path.resolve(__dirname, "../..");
const DEFAULT_LOG_PREFIX = "[tadpole-server]";
const DEFAULT_PORT = 8889;
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_WEBSOCKET_CONNECT_DELAY_MS = 250;
const TEST_CONFIG_RELATIVE_PATH = "tests/config/test-phases.config.json";
const TEST_DATA_RELATIVE_PATH = "tests/config/poem_guides.txt";
const TEST_RESULTS_RELATIVE_DIR = "tests/test-results";
const TEST_EXECUTION_RELATIVE_DIR = "tests/test-area/tadpole-basic-server-execution";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Launches a Tadpole server for E2E testing with predefined test configuration.
 *
 * This function:
 * - Spawns a new Tadpole server process with test configuration
 * - Creates an isolated execution directory
 * - Connects a WebSocket client with `ClientMode.READANDWRITE` mode
 * - Sets up event tracking and helper methods
 *
 * The server uses these predefined paths:
 * - Config: `tests/config/test-phases.config.json`
 * - Data: `tests/config/poem_guides.txt`
 * - Execution: `tests/test-area/tadpole-basic-server-execution`
 * - Results: `tests/test-results/basic-server-{timestamp}`
 *
 * @param options - Server launch options
 * @returns A promise that resolves with the launched server and connected client
 * @throws {Error} If server fails to start or WebSocket connection fails
 *
 * @example
 * ```ts
 * const server = await launchTadpole({ port: 8889 });
 * try {
 *   await server.waitForEvent("server.ready", 30_000);
 *   const phase1 = await server.waitForPhaseStart("phase-1", 60_000);
 *   // ... run tests
 * } finally {
 *   await server.stop();
 * }
 * ```
 */
export async function launchTadpole(options: LaunchServerOptions = {}): Promise<LaunchedServer> {
  const cwd = options.cwd ? path.resolve(options.cwd) : DEFAULT_CWD;
  const env = { ...process.env, ...options.env };
  const logPrefix = options.logPrefix ?? DEFAULT_LOG_PREFIX;
  const port = options.port ?? DEFAULT_PORT;
  const websocketTimeout =
    options.websocketConnectTimeoutMs ?? DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS;
  const websocketAttempts =
    options.websocketConnectAttempts ??
    Math.max(1, Math.ceil(websocketTimeout / DEFAULT_WEBSOCKET_CONNECT_DELAY_MS));

  const configPath = path.resolve(cwd, TEST_CONFIG_RELATIVE_PATH);
  const dataSourcePath = path.resolve(cwd, TEST_DATA_RELATIVE_PATH);
  const testResultsDir = path.resolve(cwd, TEST_RESULTS_RELATIVE_DIR);
  const executionDir = path.resolve(cwd, TEST_EXECUTION_RELATIVE_DIR);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Test phases config not found: ${configPath}`);
  }

  if (!fs.existsSync(dataSourcePath)) {
    throw new Error(`Test data source not found: ${dataSourcePath}`);
  }

  // Prepare an isolated execution directory similar to other E2E helpers.
  const testTimestamp = generateTestTimestamp();
  const testRunDir = path.join(testResultsDir, `basic-server-${testTimestamp}`);

  if (!options.reuseTestDirectory) {
    await setupTestDirectory({
      testDir: executionDir,
      testResultsDir,
      testRunDir,
    });
  }

  const serverEntry = path.resolve(cwd, "server/index.ts");
  const spawnArgs = [
    serverEntry,
    "--basic",
    `--config=${configPath}`,
    `--data=${dataSourcePath}`,
    `--execution=${executionDir}`,
    `--port=${port}`,
  ];

  const child = spawn("bun", spawnArgs, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (data) => {
    const text = data.toString();
    text
      .split(/\r?\n/)
      .filter(
        (line: string, index: number, lines: string[]) =>
          line.length > 0 || index < lines.length - 1,
      )
      .forEach((line: string) => {
        console.log(`${logPrefix} ${line}`);
      });
  });

  child.stderr?.on("data", (data) => {
    const text = data.toString();
    text
      .split(/\r?\n/)
      .filter(
        (line: string, index: number, lines: string[]) =>
          line.length > 0 || index < lines.length - 1,
      )
      .forEach((line: string) => {
        console.error(`${logPrefix} ${line}`);
      });
  });

  await once(child, "spawn");

  // Connect and perform handshake using setupClient
  const serverUrl = `ws://localhost:${port}`;
  let lastError: unknown;
  let attempt = 0;
  let serverExited = false;
  let clientSetup: ClientSetupResult | null = null;

  child.once("exit", () => {
    serverExited = true;
  });

  while (attempt < websocketAttempts) {
    if (serverExited || child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Server exited before WebSocket connection could be established");
    }

    try {
      clientSetup = await connectTadpoleClient(serverUrl, {
        performHandshake: true,
        mode: ClientMode.READANDWRITE,
        timeout: 5000,
        sendPreviousEvents: options.sendPreviousEvents,
      });
      console.log(`${logPrefix} WebSocket connected on port ${port}`);
      break;
    } catch (error) {
      lastError = error;
      if (clientSetup?.client) {
        clientSetup.client.close();
      }
      attempt += 1;

      if (attempt >= websocketAttempts) break;

      console.log(
        `${logPrefix} Waiting for WebSocket connection (attempt ${
          attempt + 1
        }/${websocketAttempts})`,
      );

      await sleep(DEFAULT_WEBSOCKET_CONNECT_DELAY_MS);
    }
  }

  if (!clientSetup) {
    const errorMessage =
      lastError instanceof Error
        ? lastError.message
        : lastError
          ? String(lastError)
          : "Unknown error";
    throw new Error(
      `Failed to connect to Tadpole server WebSocket on port ${port} after ${websocketAttempts} attempts: ${errorMessage}`,
    );
  }

  const { client, clientId, handshakeResponse } = clientSetup;
  const events: ServerEvent[] = [];
  const eventPromises = new Map<
    string,
    { resolve: (event: ServerEvent) => void; reject: (error: Error) => void }[]
  >();
  let connectionClosed = false;

  // Add previous events from handshake if they were requested
  if (handshakeResponse?.data?.eventHistory) {
    events.push(...handshakeResponse.data.eventHistory);
  }

  // Set up event tracking
  client.onmessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data);

      // Skip handshake responses
      if (data.type === "handshake.response") {
        return;
      }

      // Regular server events
      const serverEvent: ServerEvent = data;
      events.push(serverEvent);

      // Resolve any waiting promises for this event type
      const waiters = eventPromises.get(serverEvent.type);
      if (waiters) {
        waiters.forEach(({ resolve }) => {
          resolve(serverEvent);
        });
      }

      // Also resolve "any" event waiters
      const anyWaiters = eventPromises.get("*");
      if (anyWaiters) {
        anyWaiters.forEach(({ resolve }) => resolve(serverEvent));
      }
    } catch (error) {
      console.error("Failed to parse server event:", error);
    }
  };

  client.onclose = () => {
    connectionClosed = true;
    console.log(`${logPrefix} WebSocket connection closed`);

    // Resolve any pending connection close waiters
    const closeWaiters = eventPromises.get("__connection_closed__");
    if (closeWaiters) {
      closeWaiters.forEach(({ resolve }) =>
        resolve({
          id: "synthetic-connection-close",
          timestamp: new Date().toISOString(),
          type: "__connection_closed__",
          data: {},
        } as unknown as ServerEvent),
      );
      eventPromises.delete("__connection_closed__");
    }
  };

  async function waitForEvent(
    type: ServerEventType,
    timeoutMs: number = 30000,
    filter?: (event: ServerEvent) => boolean,
    onlyAfterTimestamp?: string,
  ): Promise<ServerEvent> {
    // Check if we already have this event
    let existing: ServerEvent | undefined;

    if (onlyAfterTimestamp) {
      existing = events.find((e) => {
        const matchesType = e.type === type;
        const isAfterTimestamp = e.timestamp > onlyAfterTimestamp;
        const passesFilter = !filter || filter(e);
        return matchesType && isAfterTimestamp && passesFilter;
      });
    } else {
      existing = events.find((e) => {
        const matchesType = e.type === type;
        const passesFilter = !filter || filter(e);
        return matchesType && passesFilter;
      });
    }

    if (existing) return existing;

    // Wait for future event
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove this waiter from the list on timeout
        const waiters = eventPromises.get(type) || [];
        const index = waiters.findIndex((w) => w.resolve === waiterResolve);
        if (index > -1) {
          waiters.splice(index, 1);
          if (waiters.length === 0) {
            eventPromises.delete(type);
          }
        }
        reject(new Error(`Timeout waiting for event: ${type}`));
      }, timeoutMs);

      let resolved = false;

      const waiterResolve = (event: ServerEvent) => {
        if (resolved) return;

        const passesFilter = !filter || filter(event);
        const isAfterTimestamp = !onlyAfterTimestamp || event.timestamp > onlyAfterTimestamp;

        if (passesFilter && isAfterTimestamp) {
          resolved = true;
          clearTimeout(timer);

          const waiters = eventPromises.get(type) || [];
          const index = waiters.findIndex((w) => w.resolve === waiterResolve);
          if (index > -1) {
            waiters.splice(index, 1);
            if (waiters.length === 0) {
              eventPromises.delete(type);
            }
          }

          resolve(event);
        }
      };

      const waiters = eventPromises.get(type) || [];
      waiters.push({
        resolve: waiterResolve,
        reject,
      });
      eventPromises.set(type, waiters);
    });
  }

  async function waitForPhaseStart(
    phaseId: string,
    afterTimestamp?: string,
    timeout: number = 60_000,
  ): Promise<ServerEvent> {
    const event = await waitForEvent(
      "phase.started",
      timeout,
      (e) => (e as PhaseStartedEvent).data?.phaseId === phaseId,
      afterTimestamp,
    );

    // Wait for state to be persisted
    await waitForState((state) => {
      const currentRun = state.runs.find((run) => run.runId === state.currentRunId);
      if (!currentRun) return false;

      const phase = currentRun.phases.find((p) => p.phaseId === phaseId);
      // Phase should exist in state (any status means it's been persisted)
      return phase !== undefined;
    }, timeout);

    return event;
  }

  async function waitForPhaseCompletion(
    phaseId: string,
    afterTimestamp?: string,
    timeout: number = 120000,
  ): Promise<ServerEvent> {
    const event = await waitForEvent(
      "phase.completed",
      timeout,
      (e) => (e as PhaseCompletedEvent).data?.phaseId === phaseId,
      afterTimestamp,
    );

    // Wait for state to be persisted with completed status
    await waitForState((state) => {
      const currentRun = state.runs.find((run) => run.runId === state.currentRunId);
      if (!currentRun) return false;

      const phase = currentRun.phases.find((p) => p.phaseId === phaseId);
      // Phase should exist and have completed status
      return phase !== undefined && phase.status === "completed";
    }, timeout);

    return event;
  }

  async function waitForConnectionClose(timeout: number = 10000): Promise<void> {
    if (connectionClosed) return;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timeout waiting for connection to close"));
      }, timeout);

      const waiters = eventPromises.get("__connection_closed__") || [];
      waiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject,
      });
      eventPromises.set("__connection_closed__", waiters);
    });
  }

  function sendCommand(command: ClientCommand): void {
    if (client.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    client.send(JSON.stringify(command));
  }

  function getEvents(): ServerEvent[] {
    return [...events];
  }

  async function connectNewClient(options?: {
    performHandshake?: boolean;
    mode?: ClientMode;
    timeout?: number;
    sendPreviousEvents?: boolean;
  }): Promise<ClientSetupResult> {
    return connectTadpoleClient(serverUrl, options);
  }

  async function waitForExit(timeoutMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.removeListener("exit", onExit);
        reject(new Error(`Server did not exit within ${timeoutMs}ms`));
      }, timeoutMs);

      const onExit = () => {
        clearTimeout(timer);
        resolve();
      };

      child.once("exit", onExit);
    });
  }

  async function stop(timeoutMs = 10_000): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      await disconnect();
      return;
    }

    const sent = child.kill("SIGINT");
    if (!sent) {
      await disconnect();
      return;
    }

    try {
      await waitForExit(timeoutMs);
    } finally {
      await disconnect();
    }
  }

  async function kill(timeoutMs = 5_000): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      await disconnect();
      return;
    }

    const sent = child.kill("SIGKILL");
    if (!sent) {
      await disconnect();
      return;
    }

    try {
      await waitForExit(timeoutMs);
    } finally {
      await disconnect();
    }
  }

  async function disconnect(): Promise<void> {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close();
    }
  }

  function hasLockFile(): boolean {
    const lockFilePath = path.join(executionDir, ".tadpole/server.lock");
    return fs.existsSync(lockFilePath);
  }

  function getState(): TadpoleState {
    const stateFilePath = path.join(executionDir, ".tadpole/state.json");
    if (!fs.existsSync(stateFilePath)) {
      throw new Error(`State file not found: ${stateFilePath}`);
    }

    try {
      const stateJson = fs.readFileSync(stateFilePath, "utf-8");
      return JSON.parse(stateJson) as TadpoleState;
    } catch (error) {
      throw new Error(
        `Failed to parse state.json: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function waitForState(
    predicate?: (state: TadpoleState) => boolean,
    timeoutMs: number = 10000,
  ): Promise<TadpoleState> {
    const startTime = Date.now();
    const pollInterval = 100; // Poll every 100ms

    while (Date.now() - startTime < timeoutMs) {
      let state: TadpoleState | undefined;

      try {
        state = getState();
      } catch {
        // State file might not exist yet, continue polling
        continue;
      }

      // If no predicate provided, just return the state
      if (!predicate || predicate(state)) {
        return state;
      }

      await sleep(pollInterval);
    }

    throw new Error(`Timeout waiting for state after ${timeoutMs}ms`);
  }

  // Generate ping events if requested
  if (options.generatePingEvents && options.generatePingEvents > 0) {
    console.log(`${logPrefix} Generating ${options.generatePingEvents} ping events...`);
    for (let i = 0; i < options.generatePingEvents; i++) {
      client.send(
        JSON.stringify({
          id: `ping-${i}`,
          type: "ping",
        }),
      );
      // Small delay to allow events to process
      if (i % 10 === 0 && i > 0) {
        await sleep(50);
      }
    }

    // Wait for all ping events to be fully processed and persisted
    console.log(`${logPrefix} Waiting for ping events to be processed...`);
    await sleep(3000);
  }

  return {
    process: child,
    websocketServerUrl: serverUrl,
    client,
    clientId,
    events,
    sendCommand,
    getEvents,
    waitForEvent,
    waitForPhaseStart,
    waitForPhaseCompletion,
    waitForConnectionClose,
    connectClient: connectNewClient,
    disconnect,
    stop,
    kill,
    hasLockFile,
    getState,
    waitForState,
  };
}
