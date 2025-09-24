import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * Launches the tadpole server in basic mode using the same command as `bun run server:basic`.
 */
export async function launchBasicServer(
  options: LaunchServerOptions = {},
): Promise<LaunchedServer> {
  const cwd = options.cwd ?? DEFAULT_CWD;
  const env = { ...process.env, ...options.env };
  const logPrefix = options.logPrefix ?? DEFAULT_LOG_PREFIX;
  const args = ["server/index.ts", "--basic", "--port=8889", ...(options.args ?? [])];
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
