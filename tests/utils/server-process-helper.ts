import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientCommand, ServerEvent } from "../../server/types/types.js";
import { generateTestTimestamp, setupTestDirectory, TestWSClient } from "./test-helpers.js";

export interface LaunchServerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logPrefix?: string;
  args?: string[];
  port?: number;
  websocketConnectTimeoutMs?: number;
  websocketConnectAttempts?: number;
}

export interface LaunchedServer {
  process: ChildProcess;
  client: TestWSClient;
  sendCommand: (command: ClientCommand) => void;
  getEvents: () => ServerEvent[];
  waitForEvent: (
    ...args: Parameters<TestWSClient["waitForEvent"]>
  ) => ReturnType<TestWSClient["waitForEvent"]>;
  waitForPhaseStart: (
    ...args: Parameters<TestWSClient["waitForPhaseStart"]>
  ) => ReturnType<TestWSClient["waitForPhaseStart"]>;
  waitForPhaseCompletion: (
    ...args: Parameters<TestWSClient["waitForPhaseCompletion"]>
  ) => ReturnType<TestWSClient["waitForPhaseCompletion"]>;
  waitForConnectionClose: (
    ...args: Parameters<TestWSClient["waitForConnectionClose"]>
  ) => ReturnType<TestWSClient["waitForConnectionClose"]>;
  disconnect: () => Promise<void>;
  stop: (timeoutMs?: number) => Promise<void>;
  kill: (timeoutMs?: number) => Promise<void>;
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

async function connectWebSocketClient({
  port,
  attempts,
  logPrefix,
  child,
}: {
  port: number;
  attempts: number;
  logPrefix: string;
  child: ChildProcess;
}): Promise<TestWSClient> {
  let lastError: unknown;
  let attempt = 0;
  let serverExited = false;

  child.once("exit", () => {
    serverExited = true;
  });

  while (attempt < attempts) {
    if (serverExited || child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Server exited before WebSocket connection could be established");
    }

    const client = new TestWSClient();
    try {
      await client.connect(port);
      console.log(`${logPrefix} WebSocket connected on port ${port}`);
      return client;
    } catch (error) {
      lastError = error;
      await client.disconnect().catch(() => undefined);
      attempt += 1;

      if (attempt >= attempts) break;

      console.log(
        `${logPrefix} Waiting for WebSocket connection (attempt ${attempt + 1}/${attempts})`,
      );

      await sleep(DEFAULT_WEBSOCKET_CONNECT_DELAY_MS);
    }
  }

  const errorMessage =
    lastError instanceof Error ? lastError.message : lastError ? String(lastError) : "Unknown error";
  throw new Error(
    `Failed to connect to Tadpole server WebSocket on port ${port} after ${attempts} attempts: ${errorMessage}`,
  );
}

/**
 * Launches the Tadpole server with the dedicated test configuration, data source,
 * and execution directory used by the E2E helpers.
 */
export async function launchBasicServer(
  options: LaunchServerOptions = {},
): Promise<LaunchedServer> {
  const cwd = options.cwd ? path.resolve(options.cwd) : DEFAULT_CWD;
  const env = { ...process.env, ...options.env };
  const logPrefix = options.logPrefix ?? DEFAULT_LOG_PREFIX;
  const port = options.port ?? DEFAULT_PORT;
  const websocketAttempts =
    options.websocketConnectAttempts ??
    Math.max(
      1,
      Math.ceil(
        (options.websocketConnectTimeoutMs ?? DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS) /
          DEFAULT_WEBSOCKET_CONNECT_DELAY_MS,
      ),
    );

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
  await setupTestDirectory({
    testDir: executionDir,
    testResultsDir,
    testRunDir,
  });

  const disallowedArgPrefixes = ["--config=", "--data=", "--execution=", "--port="];
  if (options.args?.some((arg) => disallowedArgPrefixes.some((prefix) => arg.startsWith(prefix)))) {
    throw new Error(
      "launchBasicServer manages --config, --data, and --execution flags; please remove them from args.",
    );
  }

  const serverEntry = path.resolve(cwd, "server/index.ts");
  const args = [
    serverEntry,
    "--basic",
    `--config=${configPath}`,
    `--data=${dataSourcePath}`,
    `--execution=${executionDir}`,
    `--port=${port}`,
  ];

  const spawnArgs = [...args, ...(options.args ?? [])];

  const child = spawn("bun", spawnArgs, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (data) => {
    const text = data.toString();
    text
      .split(/\r?\n/)
      .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
      .forEach((line) => {
        console.log(`${logPrefix} ${line}`);
      });
  });

  child.stderr?.on("data", (data) => {
    const text = data.toString();
    text
      .split(/\r?\n/)
      .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
      .forEach((line) => {
        console.error(`${logPrefix} ${line}`);
      });
  });

  await once(child, "spawn");

  const client = await connectWebSocketClient({
    port,
    attempts: websocketAttempts,
    logPrefix,
    child,
  });

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
    if (client.isConnected) {
      await client.disconnect();
    }
  }

  return {
    process: child,
    client,
    sendCommand: (command: ClientCommand) => {
      client.sendCommand(command);
    },
    getEvents: () => client.getEvents(),
    waitForEvent: (...args) => client.waitForEvent(...args),
    waitForPhaseStart: (...args) => client.waitForPhaseStart(...args),
    waitForPhaseCompletion: (...args) => client.waitForPhaseCompletion(...args),
    waitForConnectionClose: (...args) => client.waitForConnectionClose(...args),
    disconnect,
    stop,
    kill,
  };
}
