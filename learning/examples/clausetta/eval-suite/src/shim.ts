import { spawn, type Subprocess } from "bun";
import type { ShimConfig, RunOptions, RunResult, ShimMessage } from "./types.js";
import { parseJsonl } from "./utils/parsing.js";
import { WorkspaceManager } from "./workspace.js";

/**
 * Run a shim with the given options and return structured results
 */
export async function runShim(
  config: ShimConfig,
  options: RunOptions,
  workspace: WorkspaceManager,
  testName: string
): Promise<RunResult> {
  const startTime = Date.now();

  // Create workspace directory
  const workspaceDir = await workspace.createTestWorkspace(testName);

  // Set up fixtures if provided
  if (options.fixtures) {
    await workspace.createFixtures(workspaceDir, options.fixtures);
  }

  // Build command arguments
  const args = [...config.baseArgs];

  // Add -p flag
  args.push("-p");

  // Add model
  args.push("--model", options.model || config.model);

  // Add debug-dir (shims should store debug logs here, not in arbitrary locations)
  // Skip for Claude CLI which is the reference implementation and doesn't need this flag
  const isClaudeCli = config.command === "claude" || config.command.endsWith("/claude");
  if (!isClaudeCli) {
    if (config.debugDir) {
      args.push("--debug-dir", config.debugDir);
    } else {
      // Default to a subdirectory within the test workspace
      const debugPath = `${workspaceDir}/.shim-debug`;
      args.push("--debug-dir", debugPath);
    }
  }

  // Add any additional args
  if (options.args) {
    args.push(...options.args);
  }

  const timeout = options.timeout ?? config.timeout;

  // Split command if it contains spaces (e.g., "node /path/to/script.js")
  const cmdParts = config.command.includes(" ")
    ? config.command.split(" ").filter(s => s.length > 0)
    : [config.command];

  // Spawn the process
  const proc = spawn({
    cmd: [...cmdParts, ...args],
    cwd: options.cwd || workspaceDir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // Ensure we don't interfere with shim operation
      FORCE_COLOR: "0",
    },
  });

  // Write prompt to stdin and close
  const promptBytes = new TextEncoder().encode(options.prompt);
  proc.stdin.write(promptBytes);
  proc.stdin.end();

  // Set up timeout and signal handling
  let signaled = false;
  let timeoutId: Timer | undefined;
  let signalTimeoutId: Timer | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Shim timed out after ${timeout}ms`));
    }, timeout);
  });

  // Set up signal to send during execution (for testing signal handling)
  if (options.signal) {
    signalTimeoutId = setTimeout(() => {
      signaled = true;
      proc.kill(options.signal!.type);
    }, options.signal.afterMs);
  }

  try {
    // Wait for process to complete or timeout
    const result = await Promise.race([
      (async () => {
        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        return { exitCode, stdout, stderr };
      })(),
      timeoutPromise,
    ]);

    clearTimeout(timeoutId);
    if (signalTimeoutId) clearTimeout(signalTimeoutId);

    const duration = Date.now() - startTime;

    // Parse JSONL output
    const { messages, parseErrors } = parseJsonl(result.stdout);

    // Save artifacts
    await workspace.writeTestArtifacts(testName, {
      input: options.prompt,
      output: result.stdout,
      stderr: result.stderr,
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      messages,
      parseErrors,
      duration,
      workspace: workspaceDir,
      signaled,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (signalTimeoutId) clearTimeout(signalTimeoutId);

    // Kill the process if still running
    try {
      proc.kill("SIGKILL");
    } catch {
      // Process might already be dead
    }

    throw error;
  }
}

/**
 * Run a shim without workspace management (for simple validation tests)
 */
export async function runShimSimple(
  config: ShimConfig,
  prompt: string,
  extraArgs: string[] = [],
  timeout?: number,
  debugDir?: string
): Promise<{ exitCode: number; stdout: string; stderr: string; messages: ShimMessage[] }> {
  const args = [...config.baseArgs, "-p", "--model", config.model];

  // Add debug-dir if provided (skip for Claude CLI)
  const isClaudeCli = config.command === "claude" || config.command.endsWith("/claude");
  if (!isClaudeCli && (debugDir || config.debugDir)) {
    args.push("--debug-dir", debugDir || config.debugDir!);
  }

  args.push(...extraArgs);

  // Split command if it contains spaces
  const cmdParts = config.command.includes(" ")
    ? config.command.split(" ").filter(s => s.length > 0)
    : [config.command];

  const proc = spawn({
    cmd: [...cmdParts, ...args],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
    },
  });

  proc.stdin.write(new TextEncoder().encode(prompt));
  proc.stdin.end();

  const actualTimeout = timeout ?? config.timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Shim timed out after ${actualTimeout}ms`));
    }, actualTimeout);
  });

  const result = await Promise.race([
    (async () => {
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { exitCode, stdout, stderr };
    })(),
    timeoutPromise,
  ]);

  const { messages } = parseJsonl(result.stdout);
  return { ...result, messages };
}

/**
 * Run a shim without -p flag (for testing error handling)
 */
export async function runShimWithoutPFlag(
  config: ShimConfig,
  prompt: string,
  timeout?: number,
  debugDir?: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Build args without -p
  const args = [...config.baseArgs, "--model", config.model];

  // Add debug-dir if provided (skip for Claude CLI)
  const isClaudeCli = config.command === "claude" || config.command.endsWith("/claude");
  if (!isClaudeCli && (debugDir || config.debugDir)) {
    args.push("--debug-dir", debugDir || config.debugDir!);
  }

  // Split command if it contains spaces
  const cmdParts = config.command.includes(" ")
    ? config.command.split(" ").filter(s => s.length > 0)
    : [config.command];

  const proc = spawn({
    cmd: [...cmdParts, ...args],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
    },
  });

  proc.stdin.write(new TextEncoder().encode(prompt));
  proc.stdin.end();

  const actualTimeout = timeout ?? config.timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Shim timed out after ${actualTimeout}ms`));
    }, actualTimeout);
  });

  return Promise.race([
    (async () => {
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { exitCode, stdout, stderr };
    })(),
    timeoutPromise,
  ]);
}

/**
 * Run a shim with empty stdin (for testing empty prompt handling)
 */
export async function runShimWithEmptyStdin(
  config: ShimConfig,
  timeout?: number,
  debugDir?: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const args = [...config.baseArgs, "-p", "--model", config.model];

  // Add debug-dir if provided (skip for Claude CLI)
  const isClaudeCli = config.command === "claude" || config.command.endsWith("/claude");
  if (!isClaudeCli && (debugDir || config.debugDir)) {
    args.push("--debug-dir", debugDir || config.debugDir!);
  }

  // Split command if it contains spaces
  const cmdParts = config.command.includes(" ")
    ? config.command.split(" ").filter(s => s.length > 0)
    : [config.command];

  const proc = spawn({
    cmd: [...cmdParts, ...args],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
    },
  });

  // Write empty/whitespace stdin
  proc.stdin.write(new TextEncoder().encode("   \n  "));
  proc.stdin.end();

  const actualTimeout = timeout ?? config.timeout;

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Shim timed out after ${actualTimeout}ms`));
    }, actualTimeout);
  });

  return Promise.race([
    (async () => {
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      return { exitCode, stdout, stderr };
    })(),
    timeoutPromise,
  ]);
}

