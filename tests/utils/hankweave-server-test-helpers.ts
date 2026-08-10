// Collection of test helpers and utilities for launching and interacting with a Hankweave server.
// Used for writing tests

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CodonCompletedEvent,
  CodonStartedEvent,
  ServerEventType,
  ServerReadyEvent,
} from "../../server/schemas/event-schemas.js";
import type { HankweaveState } from "../../server/types/state-types.js";
import {
  type ClientCommand,
  ClientMode,
  type HandshakeResponse,
  type InfoEvent,
  type ServerEvent,
} from "../../server/types/types.js";
import { WebSocket } from "../../server/utils.js";
import { generateTestTimestamp, getFreePort, setupTestDirectory } from "./test-helpers.js";

// -------------
// Error Types
// -------------

/**
 * Thrown when the hankweave server process exits before a WebSocket connection
 * can be established (e.g. validation errors, config errors).
 * Carries the process exit code and captured stderr for test assertions.
 */
export class ServerLaunchError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "ServerLaunchError";
  }
}

// -------------
// WebSocket Client Setup Helpers
// -------------

// Re-export ClientMode for convenience
export { ClientMode };

/**
 * Result of connecting a Hankweave WebSocket client.
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
 * Connects a WebSocket client to a Hankweave server and optionally performs handshake.
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
 * const { client, clientId } = await connectHankweaveClient("ws://localhost:8889", {
 *   mode: ClientMode.READANDWRITE
 * });
 *
 * // Connect without handshake
 * const { client } = await connectHankweaveClient("ws://localhost:8889", {
 *   performHandshake: false
 * });
 *
 * // Connect and request event history
 * const { client, handshakeResponse } = await connectHankweaveClient("ws://localhost:8889", {
 *   mode: ClientMode.READONLY,
 *   sendPreviousEvents: true
 * });
 * ```
 */
export async function connectHankweaveClient(
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

// -------------
// Server Launch Options and Interfaces
// -------------

/**
 * Options for launching a Hankweave server for testing.
 */
export interface LaunchServerOptions {
  /** Working directory for the server process (default: project root) */
  cwd?: string;
  /** Environment variables for the server process */
  env?: NodeJS.ProcessEnv;
  /** Prefix for server log messages (default: "[hankweave-server]") */
  logPrefix?: string;
  /**
   * Server WebSocket port. REQUIRED: a fallback constant here means two
   * concurrent suites that both omit `port` silently share one number — and
   * `connectWithRetry` against the wrong server SUCCEEDS. Take a fresh
   * `getFreePort()` immediately before calling.
   */
  port: number;
  /** WebSocket connection timeout in milliseconds (default: 10000) */
  websocketConnectTimeoutMs?: number;
  /** Number of WebSocket connection attempts (default: calculated from timeout) */
  websocketConnectAttempts?: number;
  /** Reuse test directory from previous run without recreating it (default: false) */
  reuseTestDirectory?: boolean;
  /**
   * Request event history in the handshake (default: `false`).
   *
   * Turn this on for any test that counts events from the *start* of a run. The
   * server only broadcasts to clients that have completed a handshake, and
   * autostart routinely wins that race — in `--headless` it always does, since
   * the run begins the moment the socket binds, with zero clients attached. The
   * client then never learns codon 1 started. Measured on a replay fixture: 3 of
   * 5 runs in TUI mode, 5 of 5 headless.
   *
   * **Not safe as a blanket default, and deliberately not one.** `--replay`
   * copies the whole source execution directory, `.hankweave/events/` included,
   * so a checked-in fixture arrives carrying the original recording's journal —
   * `tests/fixtures/plan-gen-execution` ships 6467 events and 17 `codon.started`.
   * Backfill would hand a replay client those foreign events alongside the live
   * ones. Only enable this against a fixture built by `buildReplayFixture`,
   * which starts with an empty journal.
   *
   * Backfill is capped at `handshakeHistoryLimit` (50 events).
   */
  sendPreviousEvents?: boolean;
  /** Number of ping events to generate after server is ready (default: 0) */
  generatePingEvents?: number;
  /** Custom config path (default: tests/config/test-codons.config.json) */
  configPath?: string;
  /** Explicit execution directory path (default: auto-generated tests/test-area/execution-{timestamp}) */
  executionDir?: string;
  /** Custom data directory path (default: tests/config/poem_guides.txt) */
  dataDir?: string;
  /** Command override for binary/package manager testing (e.g., binary path, npx, bunx, pnpm dlx) */
  commandOverride?: {
    command: string;
    args: string[];
  };
  /** Replay directory path - replays LLM logs instead of making real API calls */
  replayDir?: string;
  /** Additional CLI args to append to the server command */
  extraArgs?: string[];
  /**
   * Environment variables to remove from the child's environment entirely.
   *
   * `env` can only ever *set* a value, and some checks in the runtime key off a
   * variable merely existing (CI detection, for one). Blanking those to `""`
   * leaves them defined and the check still fires, so a test that needs a
   * variable genuinely absent has to say so here.
   */
  unsetEnv?: string[];
}

/**
 * A launched Hankweave server with a connected WebSocket client and helper methods.
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
  /** The execution directory path used by the server */
  executionDir: string;
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
   * Waits for a codon to start.
   * @param codonId - The codon ID to wait for
   * @param afterTimestamp - Only match events after this timestamp
   * @param timeout - Timeout in milliseconds (default: 10000)
   * @returns Promise that resolves with the codon.started event
   * @throws {Error} If timeout is reached
   */
  waitForCodonStart: (
    codonId: string,
    afterTimestamp?: string,
    timeout?: number,
  ) => Promise<ServerEvent>;
  /**
   * Waits for a codon to complete.
   * @param codonId - The codon ID to wait for
   * @param afterTimestamp - Only match events after this timestamp
   * @param timeout - Timeout in milliseconds (default: 120000)
   * @returns Promise that resolves with the codon.completed event
   * @throws {Error} If timeout is reached
   */
  waitForCodonCompletion: (
    codonId: string,
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
   * Waits for the server process to exit WITHOUT sending it any signal, and
   * returns how it exited. Use when the process's own exit code is the value
   * under test (e.g. headless runs that must exit non-zero on failure) —
   * `stop()`/`kill()` terminate the process themselves, so their exit codes
   * reflect the signal, not the server's verdict.
   * @param timeoutMs - Timeout in milliseconds (default: 120000)
   * @throws {Error} If the process is still running after the timeout
   */
  waitForExit: (timeoutMs?: number) => Promise<{
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  }>;
  /**
   * Waits for the current run to complete.
   * @param timeout - Timeout in milliseconds (default: 120000)
   * @returns Promise that resolves when the run completes
   * @throws {Error} If timeout is reached
   */
  waitForRunToComplete: (timeout?: number) => Promise<void>;
  /**
   * Waits for the current run to fail.
   * @param timeout - Timeout in milliseconds (default: 120000)
   * @returns Promise that resolves when the run fails
   * @throws {Error} If timeout is reached
   */
  waitForRunToFail: (timeout?: number) => Promise<void>;
  /**
   * Waits for the runtime to emit the "Retrying codon <id> (attempt N/M)" info
   * event — i.e. a retriable failure was routed back into a retry. Useful for
   * retriable failure-policy scenarios where the second replay attempt stalls,
   * so the run never reaches a terminal state.
   * @param codonId - The codon ID to wait for a retry of
   * @param timeoutMs - Timeout in milliseconds (default: 30000)
   * @returns Promise that resolves with the matching info event
   * @throws {Error} If timeout is reached
   */
  waitForCodonRetry: (codonId: string, timeoutMs?: number) => Promise<ServerEvent>;
  /**
   * Returns all "Retrying codon <id> (attempt N/M)" info events seen so far for
   * the given codon. Empty when no retry was attempted (e.g. permanent failure).
   * @param codonId - The codon ID to filter retries for
   */
  getCodonRetries: (codonId: string) => ServerEvent[];
  /**
   * Returns the `codon.completed` event for the given codon, or undefined if it
   * has not completed yet.
   * @param codonId - The codon ID to look up
   */
  getCodonCompletion: (codonId: string) => CodonCompletedEvent | undefined;
  /**
   * True if a `codon.started` event has been seen for the given codon.
   * @param codonId - The codon ID to check
   */
  hasCodonStarted: (codonId: string) => boolean;
  /**
   * Connects an additional WebSocket client to the server.
   * @param options - Connection options (same as connectHankweaveClient)
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
   * Kills the server with the given signal (default: SIGKILL).
   * SIGKILL terminates immediately with no cleanup; SIGTERM/SIGINT go through
   * graceful shutdown and allow exit handlers to run.
   * @param timeoutMs - Timeout in milliseconds (default: 5000)
   * @param signal - Signal to send (default: "SIGKILL")
   * @throws {Error} If server doesn't exit within timeout
   */
  kill: (timeoutMs?: number, signal?: NodeJS.Signals) => Promise<void>;
  /**
   * Checks if the server lock file exists.
   * @returns True if the lock file exists, false otherwise
   */
  hasLockFile: () => boolean;
  /**
   * Gets the current Hankweave state from state.json.
   * @returns The parsed HankweaveState object
   * @throws {Error} If state.json doesn't exist or cannot be parsed
   */
  getState: () => HankweaveState;
  /**
   * Waits for the state to match a predicate.
   * Polls state.json until predicate returns true or timeout is reached.
   * @param predicate - Optional function to test state (default: state exists)
   * @param timeoutMs - Timeout in milliseconds (default: 10000)
   * @returns Promise that resolves with the matching state
   * @throws {Error} If timeout is reached
   */
  waitForState: (
    predicate?: (state: HankweaveState) => boolean,
    timeoutMs?: number,
  ) => Promise<HankweaveState>;
  /**
   * The absolute path to the server log file.
   */
  serverLogFilePath: string;
  /**
   * Reads and returns the content of the server log file.
   * @returns The server log file content as a string
   * @throws {Error} If the log file doesn't exist or cannot be read
   */
  serverLogFile: () => string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CWD = path.resolve(__dirname, "../..");
const DEFAULT_LOG_PREFIX = "[hankweave-server]";
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 60_000; // 60 seconds to allow for slow self-tests on Windows
// Boot-poll granularity. At 250ms, 36 boots per free-tier run wasted ~4.5s in
// pure quantization (interval/2 per boot) and hid boot-latency variance behind
// the rounding; 50ms costs a few extra no-op connect attempts and nothing else.
const DEFAULT_WEBSOCKET_CONNECT_DELAY_MS = 50;
const TEST_CONFIG_RELATIVE_PATH = "tests/config/test-codons.config.json";
const TEST_DATA_RELATIVE_PATH = "tests/config/poem_guides.txt";
const TEST_RESULTS_RELATIVE_DIR = "tests/test-results";
const TEST_AREA_RELATIVE_DIR = "tests/test-area";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True if `e` is the "Retrying codon <id> (attempt N/M)" info event the runtime
 * emits when resolveFailurePolicy routes a retriable failure back to a retry.
 */
function isCodonRetryInfo(e: ServerEvent, codonId: string): boolean {
  return (
    e.type === "info" &&
    typeof (e as InfoEvent).data.message === "string" &&
    new RegExp(`Retrying codon ${codonId} \\(attempt \\d+/\\d+\\)`).test(
      (e as InfoEvent).data.message,
    )
  );
}

/**
 * Launches a Hankweave server for E2E testing with predefined test configuration.
 *
 * This function:
 * - Spawns a new Hankweave server process with test configuration
 * - Creates an isolated execution directory
 * - Connects a WebSocket client with `ClientMode.READANDWRITE` mode
 * - Sets up event tracking and helper methods
 *
 * The server uses these default paths (customizable via options):
 * - Config: `tests/config/test-codons.config.json` (or custom via `configPath`)
 * - Data: `tests/config/poem_guides.txt` (or custom via `dataDir`)
 * - Execution: `tests/test-area/execution-{timestamp}` (or custom via `executionDir`)
 * - Results: `tests/test-results/basic-server-{timestamp}`
 *
 * @param options - Server launch options
 * @returns A promise that resolves with the launched server and connected client
 * @throws {Error} If server fails to start or WebSocket connection fails
 *
 * @example
 * ```ts
 * const server = await launchHankweave({ port: 8889 });
 * try {
 *   await server.waitForEvent("server.ready", 30_000);
 *   const codon1 = await server.waitForCodonStart("codon-1", 60_000);
 *   // ... run tests
 * } finally {
 *   await server.stop();
 * }
 * ```
 *
 * @example
 * ```ts
 * // Using custom data directory
 * const server = await launchHankweave({
 *   dataDir: "path/to/custom/data",
 *   configPath: "path/to/custom/config.json",
 * });
 * ```
 *
 * @example
 * ```ts
 * // Reusing execution directory for server recovery tests
 * const server = await launchHankweave();
 * const execDir = server.executionDir; // Save for reuse
 * await server.kill();
 *
 * // Relaunch with same execution directory (fresh port, taken immediately
 * // before the launch — getFreePort is a handle, not a reservation)
 * const server2 = await launchHankweave({
 *   port: await getFreePort(),
 *   executionDir: execDir,
 *   reuseTestDirectory: true,
 * });
 * ```
 */
export async function launchHankweave(options: LaunchServerOptions): Promise<LaunchedServer> {
  const cwd = options.cwd ? path.resolve(options.cwd) : DEFAULT_CWD;
  // Always show costs in tests to aid debugging when inspecting TUI output
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HANKWEAVE_RUNTIME_SHOW_COSTS: "1",
    ...options.env,
  };
  for (const key of options.unsetEnv ?? []) delete env[key];
  const logPrefix = options.logPrefix ?? DEFAULT_LOG_PREFIX;
  const port = options.port;
  const websocketTimeout =
    options.websocketConnectTimeoutMs ?? DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS;
  const websocketAttempts =
    options.websocketConnectAttempts ??
    Math.max(1, Math.ceil(websocketTimeout / DEFAULT_WEBSOCKET_CONNECT_DELAY_MS));

  const configPath = options.configPath
    ? path.resolve(cwd, options.configPath)
    : path.resolve(cwd, TEST_CONFIG_RELATIVE_PATH);
  const dataSourcePath = options.dataDir
    ? path.resolve(cwd, options.dataDir)
    : path.resolve(cwd, TEST_DATA_RELATIVE_PATH);
  const testResultsDir = path.resolve(cwd, TEST_RESULTS_RELATIVE_DIR);
  const testAreaDir = path.resolve(cwd, TEST_AREA_RELATIVE_DIR);

  if (!fs.existsSync(configPath)) {
    throw new Error(`Test codons config not found: ${configPath}`);
  }

  if (!fs.existsSync(dataSourcePath)) {
    throw new Error(`Test data source not found: ${dataSourcePath}`);
  }

  // Prepare an isolated execution directory similar to other E2E helpers.
  const testTimestamp = generateTestTimestamp();
  let executionDir = options.executionDir
    ? path.resolve(cwd, options.executionDir)
    : path.join(testAreaDir, `execution-${testTimestamp}`);
  const testRunDir = path.join(testResultsDir, `basic-server-${testTimestamp}`);

  if (!options.reuseTestDirectory && !options.replayDir) {
    await setupTestDirectory({
      testDir: executionDir,
      testResultsDir,
      testRunDir,
    });
  }

  // ── Spawn + connect, with bounded bind-retry ─────────────────────────
  // getFreePort() is a handle, not a reservation: the window between its
  // close() and this server's listen() belongs to nobody, and under the
  // runner's parallel default (~80 boots per sweep, 4 suites at once) the
  // collision is a WHEN, not an IF — first observed live as "Is port 52631
  // in use?" killing an e2e-budget boot. Port-last discipline narrows the
  // window; this loop absorbs what discipline cannot: a bind failure gets a
  // FRESH port and a clean respawn, bounded so a genuinely wedged port
  // range still fails loudly.
  const BIND_RETRY_ATTEMPTS = 3;
  const isBindFailure = (err: unknown): err is ServerLaunchError =>
    err instanceof ServerLaunchError && /Is port \d+ in use\?/.test(err.stderr);

  let activePort = port;
  let child: ReturnType<typeof spawn>;
  let clientSetup: ClientSetupResult | null = null;
  let stderrBuffer = "";
  let serverUrl = "";

  for (let bindAttempt = 1; ; bindAttempt++) {
    // Determine command and args - priority: binary > commandOverride > default bun
    let command: string;
    let spawnArgs: string[];
    let needsShell = false;

    // Use space-separated syntax (not --flag=value which is deprecated)
    // Skip --execution when --replay is set (replay mode auto-copies the execution dir)
    const serverArgs = [
      "--config",
      configPath,
      "--data",
      dataSourcePath,
      ...(options.replayDir ? [] : ["--execution", executionDir]),
      "--port",
      String(activePort),
      ...(options.replayDir ? ["--replay", path.resolve(cwd, options.replayDir)] : []),
      ...(options.extraArgs ?? []),
    ];

    if (options.commandOverride) {
      // Use command override (binary, npx, bunx, pnpm dlx, etc.)
      command = options.commandOverride.command;
      spawnArgs = [...options.commandOverride.args, ...serverArgs];
      // On Windows, package managers need shell=true (but not binaries)
      needsShell = process.platform === "win32" && ["npx", "bunx", "pnpm", "npm"].includes(command);
    } else {
      // Default: Use bun with source files
      const serverEntry = path.resolve(DEFAULT_CWD, "server/index.ts");
      command = "bun";
      spawnArgs = [serverEntry, ...serverArgs];
    }

    child = spawn(command, spawnArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: needsShell,
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

    stderrBuffer = "";
    child.stderr?.on("data", (data) => {
      const text = data.toString();
      stderrBuffer += text;
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
    serverUrl = `ws://localhost:${activePort}`;
    let lastError: unknown;
    let attempt = 0;
    let serverExited = false;
    clientSetup = null;

    child.once("exit", () => {
      serverExited = true;
    });

    try {
      while (attempt < websocketAttempts) {
        if (serverExited || child.exitCode !== null || child.signalCode !== null) {
          throw new ServerLaunchError(
            "Server exited before WebSocket connection could be established",
            child.exitCode,
            stderrBuffer,
          );
        }

        try {
          clientSetup = await connectHankweaveClient(serverUrl, {
            performHandshake: true,
            mode: ClientMode.READANDWRITE,
            timeout: 5000,
            sendPreviousEvents: options.sendPreviousEvents,
          });
          console.log(`${logPrefix} WebSocket connected on port ${activePort}`);
          break;
        } catch (error) {
          lastError = error;
          if (clientSetup?.client) {
            clientSetup.client.close();
          }
          attempt += 1;

          if (attempt >= websocketAttempts) break;

          // At 50ms granularity a per-attempt line is pure noise — log once a second.
          if (attempt === 1 || attempt % 20 === 0) {
            console.log(
              `${logPrefix} Waiting for WebSocket connection (attempt ${
                attempt + 1
              }/${websocketAttempts})`,
            );
          }

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
        // Include the server's stderr tail: when this throw happens inside a
        // beforeAll hook, bun's junit records only `(unnamed)` with a bodyless
        // <failure/> — this message is the only diagnostic that survives. A
        // 120.6s double-failure once produced four junit rows with no clue at all.
        const stderrTail = stderrBuffer.split("\n").slice(-15).join("\n").trim();
        throw new Error(
          `Failed to connect to Hankweave server WebSocket on port ${activePort} after ${websocketAttempts} attempts: ${errorMessage}` +
            (stderrTail ? `\nServer stderr (tail):\n${stderrTail}` : ""),
        );
      }
      break; // connected — leave the bind-retry loop
    } catch (error) {
      if (isBindFailure(error) && bindAttempt < BIND_RETRY_ATTEMPTS) {
        console.log(
          `${logPrefix} Port ${activePort} was taken inside the bind window ` +
            `(attempt ${bindAttempt}/${BIND_RETRY_ATTEMPTS}) — retrying on a fresh port`,
        );
        activePort = await getFreePort();
        continue;
      }
      throw error;
    }
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

      // Update executionDir from server.ready event (needed for replay mode
      // where the server copies the execution dir to a temp location)
      if (serverEvent.type === "server.ready") {
        executionDir = (serverEvent as ServerReadyEvent).data.executionPath;
      }

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

  async function waitForCodonStart(
    codonId: string,
    afterTimestamp?: string,
    timeout: number = 60_000,
  ): Promise<ServerEvent> {
    const event = await waitForEvent(
      "codon.started",
      timeout,
      (e) => (e as CodonStartedEvent).data?.codonId === codonId,
      afterTimestamp,
    );

    // Wait for state to be persisted
    await waitForState((state) => {
      const currentRun = state.runs.find((run) => run.runId === state.currentRunId);
      if (!currentRun) return false;

      const codon = currentRun.codons.find((p) => p.codonId === codonId);
      // Codon should exist in state (any status means it's been persisted)
      return codon !== undefined;
    }, timeout);

    return event;
  }

  async function waitForCodonCompletion(
    codonId: string,
    afterTimestamp?: string,
    timeout: number = 120000,
  ): Promise<ServerEvent> {
    const event = await waitForEvent(
      "codon.completed",
      timeout,
      (e) => (e as CodonCompletedEvent).data?.codonId === codonId,
      afterTimestamp,
    );

    // Wait for state to be persisted with completed status
    await waitForState((state) => {
      const currentRun = state.runs.find((run) => run.runId === state.currentRunId);
      if (!currentRun) return false;

      const codon = currentRun.codons.find((p) => p.codonId === codonId);
      // Codon should exist and have completed status
      return codon !== undefined && codon.status === "completed";
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

  async function waitForRunToComplete(timeout: number = 120_000): Promise<void> {
    await waitForEvent("state.transition", timeout, (e: ServerEvent) => {
      const event = e as {
        type: string;
        data?: { runId: string; transitionType?: string };
      };
      if (event.data?.transitionType !== "RunCompleted") return false;
      // XX: cannot use currentRunId here because it is likely null at this point as
      // we are looking for the RunCompleted event.
      // The predicate can fire while the server is still BOOTING (state.json
      // not yet written — seen under the runner's 4-way concurrency, where a
      // slow boot let the first poll outrun the file). A missing/unreadable
      // state file simply means "no run has completed yet", never an error.
      let latestRunId: string | undefined;
      try {
        latestRunId = getState().runs[0]?.runId;
      } catch {
        return false;
      }
      return event.data?.runId === latestRunId;
    });

    // Verify the run actually completed successfully by checking state

    const finalState = getState();

    if (finalState.runs.length === 0) {
      throw new Error("No runs found in state after RunCompleted event");
    }

    // Check the LAST run (most recent)
    const lastRun = finalState.runs[0];
    if (lastRun.status !== "completed") {
      throw new Error(
        `Last run (${lastRun.runId}) status is "${lastRun.status}", expected "completed"`,
      );
    }
  }

  async function waitForRunToFail(timeout: number = 120_000): Promise<void> {
    await waitForEvent("state.transition", timeout, (e: ServerEvent) => {
      const event = e as {
        type: string;
        data?: { runId: string; transitionType?: string };
      };
      if (event.data?.transitionType !== "RunFailed") return false;
      // Same early-boot tolerance as waitForRunToComplete: a state.transition
      // can arrive over the socket before state.json's first write.
      let latestRunId: string | undefined;
      try {
        latestRunId = getState().runs[0]?.runId;
      } catch {
        return false;
      }
      return event.data?.runId === latestRunId;
    });

    // Verify the run actually failed by checking state

    const finalState = getState();

    if (finalState.runs.length === 0) {
      throw new Error("No runs found in state after RunFailed event");
    }

    // Check the LAST run (most recent)
    const lastRun = finalState.runs[0];
    if (lastRun.status !== "failed") {
      throw new Error(
        `Last run (${lastRun.runId}) status is "${lastRun.status}", expected "failed"`,
      );
    }
  }

  async function waitForCodonRetry(
    codonId: string,
    timeoutMs: number = 30_000,
  ): Promise<ServerEvent> {
    return waitForEvent("info", timeoutMs, (e) => isCodonRetryInfo(e, codonId));
  }

  function getCodonRetries(codonId: string): ServerEvent[] {
    return events.filter((e) => isCodonRetryInfo(e, codonId));
  }

  function getCodonCompletion(codonId: string): CodonCompletedEvent | undefined {
    return events.find(
      (e) => e.type === "codon.completed" && (e as CodonCompletedEvent).data.codonId === codonId,
    ) as CodonCompletedEvent | undefined;
  }

  function hasCodonStarted(codonId: string): boolean {
    return events.some(
      (e) => e.type === "codon.started" && (e as CodonStartedEvent).data.codonId === codonId,
    );
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
    return connectHankweaveClient(serverUrl, options);
  }

  async function waitForExit(timeoutMs = 120_000): Promise<{
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  }> {
    if (child.exitCode === null && child.signalCode === null) {
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

    return { exitCode: child.exitCode, signalCode: child.signalCode };
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

  async function kill(timeoutMs = 5_000, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      await disconnect();
      return;
    }

    const sent = child.kill(signal);
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
    const lockFilePath = path.join(executionDir, ".hankweave/runtime.lock");
    return fs.existsSync(lockFilePath);
  }

  function getState(): HankweaveState {
    const stateFilePath = path.join(executionDir, ".hankweave/state.json");
    if (!fs.existsSync(stateFilePath)) {
      throw new Error(`State file not found: ${stateFilePath}`);
    }

    try {
      const stateJson = fs.readFileSync(stateFilePath, "utf-8");
      return JSON.parse(stateJson) as HankweaveState;
    } catch (error) {
      throw new Error(
        `Failed to parse state.json: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function waitForState(
    predicate?: (state: HankweaveState) => boolean,
    timeoutMs: number = 10000,
  ): Promise<HankweaveState> {
    const startTime = Date.now();
    const pollInterval = 100; // Poll every 100ms

    while (Date.now() - startTime < timeoutMs) {
      let state: HankweaveState | undefined;

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

  function getServerLogFilePath(): string {
    return path.join(executionDir, ".hankweave/logs/server.log");
  }

  function getServerLogFile(): string {
    const logPath = getServerLogFilePath();
    if (!fs.existsSync(logPath)) {
      throw new Error(`Server log file not found: ${logPath}`);
    }

    try {
      return fs.readFileSync(logPath, "utf-8");
    } catch (error) {
      throw new Error(
        `Failed to read server log file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    get executionDir() {
      return executionDir;
    },
    sendCommand,
    getEvents,
    waitForEvent,
    waitForCodonStart,
    waitForCodonCompletion,
    waitForConnectionClose,
    waitForExit,
    waitForRunToComplete,
    waitForRunToFail,
    waitForCodonRetry,
    getCodonRetries,
    getCodonCompletion,
    hasCodonStarted,
    connectClient: connectNewClient,
    disconnect,
    stop,
    kill,
    hasLockFile,
    getState,
    waitForState,
    get serverLogFilePath() {
      return getServerLogFilePath();
    },
    serverLogFile: getServerLogFile,
  };
}
