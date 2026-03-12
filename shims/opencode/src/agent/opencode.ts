import { withAdaptiveTimeout } from "@shims/common";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SandboxLevel } from "@shims/common";
import type { OpencodeEvent } from "../types.js";
import { buildInstructionFileContents } from "../utils/prompt.js";
import { errorMessage, verboseLog } from "../utils/output.js";

export interface ChildExitStatus {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface SpawnOpencodeOptions {
  prompt: string;
  model: string;
  cwd: string;
  nativeSessionId?: string;
  appendSystemPrompt?: string;
  verbose: boolean;
  debugDir?: string;
  sandbox: SandboxLevel;
  shimSessionId: string;
  idleTimeoutMs: number;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface OpencodeRunHandle {
  readonly binaryPath: string;
  readonly events: AsyncIterable<OpencodeEvent>;
  waitForExit(): Promise<ChildExitStatus>;
  kill(signal?: NodeJS.Signals): void;
  getStderr(): string;
}

interface TemporaryInstructionContext {
  envConfigContent: string;
  cleanup(): void;
}

export async function ensureOpencodeAvailable(): Promise<string> {
  const envPath = process.env.OPENCODE_BIN?.trim();
  const candidates = [
    envPath,
    path.join(os.homedir(), ".opencode", "bin", process.platform === "win32" ? "opencode.cmd" : "opencode"),
    path.join(os.homedir(), ".opencode", "bin", "opencode"),
    "opencode",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (candidate.includes(path.sep) || candidate.startsWith(".")) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      continue;
    }

    const resolved = await findOnPath(candidate);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error("OpenCode CLI not found. Set OPENCODE_BIN or install opencode.");
}

async function findOnPath(command: string): Promise<string | undefined> {
  const locator = process.platform === "win32" ? "where" : "which";
  const isWindows = process.platform === "win32";

  return await new Promise<string | undefined>((resolve) => {
    const proc = spawn(locator, [command], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: isWindows,
    });

    let output = "";
    proc.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        const first = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        resolve(first);
        return;
      }

      resolve(undefined);
    });

    proc.on("error", () => resolve(undefined));
  });
}

async function runOpencodeCommand(binaryPath: string, args: string[]): Promise<CommandResult> {
  const isWindows = process.platform === "win32";

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

export async function findSessionIdByTitle(title: string): Promise<string | undefined> {
  const binaryPath = await ensureOpencodeAvailable();
  const result = await runOpencodeCommand(binaryPath, ["session", "list"]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "Failed to list OpenCode sessions.");
  }

  const normalizedTitle = title.trim();
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("ses_")) continue;

    const match = line.match(/^(ses_[A-Za-z0-9]+)\s+(.*)$/);
    if (!match) continue;

    const [, nativeSessionId, remainder] = match;
    if (remainder.includes(normalizedTitle)) {
      return nativeSessionId;
    }
  }

  return undefined;
}

export async function deleteSessionById(sessionId: string): Promise<void> {
  const binaryPath = await ensureOpencodeAvailable();
  const result = await runOpencodeCommand(binaryPath, ["session", "delete", sessionId]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `Failed to delete OpenCode session ${sessionId}.`);
  }
}

function createTemporaryInstructionContext(options: SpawnOpencodeOptions): TemporaryInstructionContext {
  const config: Record<string, unknown> = {
    permission: "allow",
  };

  const baseDir = options.debugDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "opencode-shim-"));
  fs.mkdirSync(baseDir, { recursive: true });

  const instructionPath = path.join(baseDir, `system-prompt-${options.shimSessionId}.md`);
  fs.writeFileSync(
    instructionPath,
    `${buildInstructionFileContents({ cwd: options.cwd, appendSystemPrompt: options.appendSystemPrompt })}\n`,
    "utf8",
  );
  config.instructions = [instructionPath];

  return {
    envConfigContent: JSON.stringify(config),
    cleanup() {
      try {
        fs.rmSync(instructionPath, { force: true });
      } catch {
        // ignore cleanup failure
      }
      if (!options.debugDir) {
        try {
          fs.rmSync(baseDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup failure
        }
      }
    },
  };
}

function createDebugWriters(debugDir: string | undefined, shimSessionId: string): {
  rawJsonlPath?: string;
  rawStderrPath?: string;
} {
  if (!debugDir) {
    return {};
  }

  fs.mkdirSync(debugDir, { recursive: true });
  return {
    rawJsonlPath: path.join(debugDir, `session-${shimSessionId}.raw.jsonl`),
    rawStderrPath: path.join(debugDir, `session-${shimSessionId}.raw.log`),
  };
}

function appendDebug(pathname: string | undefined, chunk: string): void {
  if (!pathname) return;
  fs.appendFileSync(pathname, chunk, "utf8");
}

export async function spawnOpencodeRun(options: SpawnOpencodeOptions): Promise<OpencodeRunHandle> {
  const binaryPath = await ensureOpencodeAvailable();
  const tempInstructionContext = createTemporaryInstructionContext(options);
  const debugWriters = createDebugWriters(options.debugDir, options.shimSessionId);
  const isWindows = process.platform === "win32";

  if (options.sandbox !== "none") {
    verboseLog(
      options.verbose,
      `OpenCode CLI has no documented sandbox flag for run mode; ignoring --sandbox=${options.sandbox}`,
    );
  }

  const args = [
    "run",
    "--format",
    "json",
    "--model",
    options.model,
    "--dir",
    options.cwd,
  ];

  if (options.nativeSessionId) {
    args.push("--session", options.nativeSessionId);
  } else {
    args.push("--title", options.shimSessionId);
  }

  const child = spawn(binaryPath, args, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: isWindows,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: tempInstructionContext.envConfigContent,
    },
  }) as ChildProcessWithoutNullStreams;

  child.stdin.write(options.prompt);
  child.stdin.end();

  let stderrBuffer = "";
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrBuffer += text;
    appendDebug(debugWriters.rawStderrPath, text);
  });

  const events = createEventStream(
    child,
    debugWriters.rawJsonlPath,
    options.verbose,
    options.idleTimeoutMs,
  );

  const exitPromise = new Promise<ChildExitStatus>((resolve, reject) => {
    child.once("error", (error) => reject(error));
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => {
    tempInstructionContext.cleanup();
  });

  return {
    binaryPath,
    events,
    async waitForExit() {
      return exitPromise;
    },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      if (!child.killed) {
        try {
          child.kill(signal);
        } catch {
          // ignore kill failures
        }
      }
    },
    getStderr() {
      return stderrBuffer;
    },
  };
}

function computeBusyTimeoutMs(idleTimeoutMs: number): number {
  return Math.max(300_000, Math.min(900_000, idleTimeoutMs * 5));
}

function createEventStream(
  child: ChildProcessWithoutNullStreams,
  rawJsonlPath: string | undefined,
  verbose: boolean,
  idleTimeoutMs: number,
): AsyncIterable<OpencodeEvent> {
  const lineStream = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  const parsedEvents = (async function* (): AsyncGenerator<OpencodeEvent> {
    for await (const rawLine of lineStream) {
      const line = rawLine.trim();
      if (!line) continue;
      appendDebug(rawJsonlPath, `${line}\n`);

      try {
        yield JSON.parse(line) as OpencodeEvent;
      } catch (error) {
        verboseLog(verbose, "Skipping non-JSON stdout line", {
          line,
          error: errorMessage(error),
        });
      }
    }
  })();

  return withAdaptiveTimeout(parsedEvents, {
    idleTimeoutMs,
    busyTimeoutMs: computeBusyTimeoutMs(idleTimeoutMs),
    onEvent(event, controller) {
      if (event.type === "step_start") {
        controller.markBusy();
        return;
      }

      if (event.type === "step_finish" || event.type === "error") {
        controller.markIdle();
      }
    },
  });
}

export { computeBusyTimeoutMs };

export function filterDiagnosticStderr(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      try {
        const parsed = JSON.parse(trimmed) as { type?: string };
        return typeof parsed?.type !== "string";
      } catch {
        return true;
      }
    })
    .join("\n")
    .trim();
}
