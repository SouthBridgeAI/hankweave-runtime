import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { generateTestTimestamp, setupTestDirectory } from "./test-helpers.js";

export interface LaunchServerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  logPrefix?: string;
  args?: string[];
}

export interface LaunchedServer {
  process: ChildProcess;
  stop: (timeoutMs?: number) => Promise<void>;
  kill: (timeoutMs?: number) => Promise<void>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_CWD = path.resolve(__dirname, "../..");
const DEFAULT_LOG_PREFIX = "[tadpole-server]";
const TEST_CONFIG_RELATIVE_PATH = "tests/config/test-phases.config.json";
const TEST_DATA_RELATIVE_PATH = "tests/config/poem_guides.txt";
const TEST_RESULTS_RELATIVE_DIR = "tests/test-results";
const TEST_EXECUTION_RELATIVE_DIR = "tests/test-area/tadpole-basic-server-execution";

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

  const disallowedArgPrefixes = ["--config=", "--data=", "--execution="];
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
    `--port=${8889}`,
  ];

  const child = spawn("bun", args, {
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
    if (child.exitCode !== null || child.signalCode !== null) return;

    const sent = child.kill("SIGINT");
    if (!sent) return;
    await waitForExit(timeoutMs);
  }

  async function kill(timeoutMs = 5_000): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;

    const sent = child.kill("SIGKILL");
    if (!sent) return;
    await waitForExit(timeoutMs);
  }

  return {
    process: child,
    stop,
    kill,
  };
}
