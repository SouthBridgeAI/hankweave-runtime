import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ClaudeLogParser } from "./claude-log-parser.js";
import { ensureCodexAvailable } from "./codex-runtime-extractor.js";
import { TIMEOUTS } from "./config.js";
import { PromptBuilder } from "./prompt-builder.js";
import { type ProcessEvents, TypedEventEmitter } from "./typed-event-emitter.js";
import { type Codon, isContextExceeded, type ShimSelfTestResult } from "./types/types.js";
import { escapeShellArg, type Logger } from "./utils.js";

/**
 * Manages shim subprocess lifecycle, including spawning, monitoring, and cleanup.
 * Handles log stream creation and process argument building.
 * Works with any shim that supports the standardized argument interface.
 */
export class ShimProcessManager extends TypedEventEmitter<ProcessEvents> {
  private process: ChildProcess | undefined;
  private logStream: fs.WriteStream | undefined;
  private killed = false;
  private promptBuilder: PromptBuilder;

  constructor(
    private executionPath: string,
    private agentRootPath: string,
    private logger: Logger,
    private logParser: ClaudeLogParser,
    private anthropicBaseUrl?: string,
    private globalSystemPrompt?: string | null,
    private defaultShimIdleTimeout?: number,
  ) {
    super();
    this.promptBuilder = new PromptBuilder(agentRootPath, logger, globalSystemPrompt);
  }

  /** Frontmatter metadata from the prompt file (if any) */
  get promptFrontmatter(): import("./prompt-frontmatter.js").PromptFrontmatter | undefined {
    return this.promptBuilder.getLastFrontmatter();
  }

  /**
   * Spawn a shim process for the given codon configuration.
   * Sets up logging, environment, and process monitoring.
   *
   * This unified method handles both normal codon execution and exhaustion extensions.
   * From the shim's perspective, both are identical: resume a session with a new prompt.
   * The difference is only where the prompt comes from.
   *
   * @param command - Command to execute (e.g., ["claude"] or ["bun", "run", "shims/gemini/dist/index.mjs"])
   * @param codon - Codon configuration (not Loop - loops must be expanded first)
   * @param sessionToResume - Session ID to resume (if any)
   * @param options - Optional spawn configuration
   * @param options.logPath - Custom log file path (defaults to .hankweave/logs/)
   * @param options.exhaustionPrompt - If provided, activates exhaustion mode: uses this prompt
   *                                   instead of codon config, appends to log.
   */
  async spawn(
    command: string[],
    codon: Codon,
    sessionToResume: string | null,
    options?: {
      logPath?: string;
      exhaustionPrompt?: string;
    },
  ): Promise<string> {
    if (this.process) {
      throw new Error("Process already running");
    }

    const { logPath, exhaustionPrompt } = options ?? {};
    const isExhaustionMode = !!exhaustionPrompt;

    // Use provided logPath or default to .hankweave/logs/
    const actualLogPath =
      logPath || path.join(this.executionPath, `.hankweave/logs/log-${codon.id}.jsonl`);

    // Ensure log directory exists
    const logsDir = path.dirname(actualLogPath);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Create log stream - append mode for exhaustion (extensions continue the same log)
    this.logStream = fs.createWriteStream(
      actualLogPath,
      isExhaustionMode ? { flags: "a" } : undefined,
    );

    // Build shim arguments
    // In exhaustion mode, always resume regardless of continuationMode
    const args = this.buildShimArgs(codon, sessionToResume, isExhaustionMode);

    // Set up environment
    const env = this.buildEnvironment(codon);

    // For OpenAI/Codex models, ensure codex binary is available
    // and set CODEX_PATH_OVERRIDE to point to it
    if (codon.model.providerId.toLowerCase() === "openai") {
      try {
        this.logger.log("Ensuring codex binary is available for OpenAI model...");
        const codexInfo = await ensureCodexAvailable();
        env.CODEX_PATH_OVERRIDE = codexInfo.path;
        this.logger.log(`Set CODEX_PATH_OVERRIDE to: ${codexInfo.path}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.log(`Failed to ensure codex binary: ${errorMsg}`, "error");
        throw new Error(`Cannot spawn codex shim: ${errorMsg}`);
      }
    }

    // Combine shim command with shim flags
    // Example: ["bun", "run", "shim.ts"] + ["--model", "gemini...", "-p", "..."]
    const [bin, ...binArgs] = command;
    const finalArgs = [...binArgs, ...args];

    // Log the exact command being run
    const fullCommand = `${bin} ${finalArgs.join(" ")}`;
    this.logger.log(`Executing Agent: ${fullCommand}`);
    this.logger.log(`Working directory: ${this.agentRootPath}`);
    this.logger.log(`Session to resume: ${sessionToResume || "none"}`);

    // Additional debugging
    this.logger.log(`Current process.cwd(): ${process.cwd()}`);
    this.logger.log(`Absolute agentRootPath: ${path.resolve(this.agentRootPath)}`);
    this.logger.log(`Agent root path exists: ${fs.existsSync(this.agentRootPath)}`);
    this.logger.log(
      `Agent root path is directory: ${
        fs.existsSync(this.agentRootPath) && fs.statSync(this.agentRootPath).isDirectory()
      }`,
    );

    // Spawn process - agents work in agentRootPath (not executionPath)
    this.process = spawn(bin, finalArgs, {
      cwd: this.agentRootPath,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    this.killed = false;

    // Pipe stdout to log file with error handling
    if (this.process.stdout) {
      this.process.stdout.pipe(this.logStream);

      // Handle pipe errors
      this.process.stdout.on("error", (error) => {
        this.logger.log(`Stdout pipe error: ${error.message}`, "error");
      });

      this.logStream.on("error", (error) => {
        this.logger.log(`Log stream error: ${error.message}`, "error");
      });
    }

    // Set up event handlers
    this.setupProcessHandlers();

    // Feed prompt to stdin
    const promptContent = this.promptBuilder.buildPromptForExecution(codon, exhaustionPrompt);
    if (this.process.stdin) {
      this.process.stdin.write(promptContent);
      this.process.stdin.end();
    }
    this.logger.log(`Fed prompt to shim (${promptContent.length} chars)`);
    this.logger.log(`Prompt content:\n${promptContent}`);

    this.logger.log(`Shim process started for codon ${codon.id} (PID: ${this.process.pid})`);

    return actualLogPath;
  }

  /**
   * Build environment variables for the shim process.
   */
  private buildEnvironment(codon: Codon): NodeJS.ProcessEnv {
    const env = { ...process.env }; // Start with server's environment

    // Pass through HANKWEAVE_ prefixed variables from server environment
    // Exclude HANKWEAVE_RUNTIME_* (server config) and HANKWEAVE_SENTINEL_* (sentinel API keys)
    for (const key in process.env) {
      if (
        key.startsWith("HANKWEAVE_") &&
        !key.startsWith("HANKWEAVE_RUNTIME_") &&
        !key.startsWith("HANKWEAVE_SENTINEL_")
      ) {
        const newKey = key.substring("HANKWEAVE_".length);
        env[newKey] = process.env[key];
        this.logger.log(`Passing through env var: ${newKey}`);
      }
    }

    if (this.anthropicBaseUrl) {
      env.ANTHROPIC_BASE_URL = this.anthropicBaseUrl;
      this.logger.log(`Using custom Anthropic base URL: ${this.anthropicBaseUrl}`);
    }

    // Add codon-specific environment variables from config
    // These will override any existing variables with the same name
    if (codon.env) {
      this.logger.log("Applying codon-specific environment variables...");
      Object.assign(env, codon.env);
    }

    return env;
  }

  /**
   * Build command line arguments for shim.
   * Only includes arguments supported by all shims.
   *
   * @param codon - Codon configuration
   * @param previousSessionId - Session ID to resume (if any)
   * @param isExhaustionMode - True if this is an extension (exhaustion mode)
   */
  private buildShimArgs(
    codon: Codon,
    previousSessionId: string | null,
    isExhaustionMode = false,
  ): string[] {
    // Model override is already applied in loadCodonSequence(), so just use codon.model
    const modelInfo = codon.model;
    const modelId = modelInfo.modelId;

    const args = ["--model", modelId, "-p"];

    // Resume session if:
    // 1. We're in extension mode (exhaustion), OR
    // 2. Codon has continue-previous mode
    // This ensures extensions always resume regardless of codon's continuationMode
    if (previousSessionId && (isExhaustionMode || codon.continuationMode === "continue-previous")) {
      args.push("--resume", previousSessionId);
    }

    // Handle system prompt if provided
    const systemPrompt = this.promptBuilder.buildSystemPrompt(codon);
    if (systemPrompt) {
      args.push("--append-system-prompt", escapeShellArg(systemPrompt));
      this.logger.log(`Added system prompt to shim (${systemPrompt.length} chars)`);
      this.logger.log(`System prompt content:\n${systemPrompt}`);
    }

    // Use shared shim debug directory for all codons
    // Sessions are stored by UUID, preventing collisions
    const shimDebugDir = path.join(this.executionPath, ".hankweave/logs/shim-debug");
    args.push("--debug-dir", shimDebugDir);
    this.logger.log(`Using shim debug directory: ${shimDebugDir}`);

    // Pass resolved shim idle timeout as CLI arg (primary mechanism)
    const shimIdleTimeout = codon.shimIdleTimeout ?? this.defaultShimIdleTimeout;
    if (shimIdleTimeout !== undefined) {
      args.push("--idle-timeout", String(shimIdleTimeout));
      this.logger.log(`Using shim idle timeout: ${shimIdleTimeout}s`);
    }

    return args;
  }

  /**
   * Set up process event handlers.
   */
  private setupProcessHandlers(): void {
    if (!this.process) return;

    this.process.on("exit", (code, signal) => {
      this.logger.log(`Shim process exited with code: ${code}, signal: ${signal}`);

      // Parse final log entries to ensure we have all messages
      this.logParser.parseNow();

      // Check all messages for context exceeded indicators
      const allMessages = this.logParser.getAllMessages();
      const contextExceeded = allMessages.some((msg) => isContextExceeded(msg));

      if (contextExceeded) {
        this.logger.log("Context exceeded detected in log messages");
      }

      this.cleanup();
      this.emit("exit", code || 0, contextExceeded);
    });

    this.process.on("error", (error) => {
      this.logger.log(`Shim process error: ${error.message}`, "error");
      this.cleanup();
      this.emit("error", error);
    });

    this.process.stdout?.on("data", (data) => {
      this.emit("stdout", data.toString());
    });

    this.process.stderr?.on("data", (data) => {
      const errorMessage = data.toString().trim();
      this.logger.log(`Shim stderr: ${errorMessage}`, "error");

      // Write to log file as JSON entry (matching server behavior)
      if (this.logStream && !this.logStream.destroyed) {
        this.logStream.write(
          `{"type":"stderr","timestamp":"${new Date().toISOString()}","message":${JSON.stringify(
            errorMessage,
          )}}\n`,
        );
      }

      this.emit("stderr", errorMessage);
    });
  }

  /**
   * Kill the shim process gracefully.
   * Sends SIGTERM and waits up to PROCESS_KILL_GRACE_MS for the process to exit.
   * If the process doesn't exit in time, escalates to SIGKILL.
   */
  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.process || this.killed) return;

    this.killed = true;
    this.logger.log(`Killing shim process with ${signal}`);

    // Force an immediate parse of the log file to capture any final messages
    // This ensures we don't lose token counts or other important data when killing
    this.logParser.parseNow();

    // Give the log parser a moment to process any final messages
    await new Promise((resolve) => setTimeout(resolve, 100));

    this.process.kill(signal);

    // Wait for the process to actually exit, with SIGKILL escalation.
    //
    // Important: we check `!this.process` (cleared by cleanup() when the 'exit'
    // event fires) rather than `this.process.killed`. The `.killed` property only
    // indicates that a signal was SENT, not that the process actually DIED — it
    // becomes true immediately after our .kill() call above, which would cause
    // the interval to resolve on the first tick regardless of whether the child
    // actually exited.
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.process) {
          clearInterval(checkInterval);
          resolve();
        }
      }, TIMEOUTS.LOG_PARSER_DELAY_MS);

      setTimeout(() => {
        clearInterval(checkInterval);
        if (this.process) {
          this.logger.log("Force killing shim process with SIGKILL");
          try {
            this.process.kill("SIGKILL");
          } catch {
            // Process may have already exited between our check and kill
          }
        }
        // Brief delay for SIGKILL to take effect before resolving
        setTimeout(resolve, 200);
      }, TIMEOUTS.PROCESS_KILL_GRACE_MS);
    });
  }

  /**
   * Force-kill the shim process immediately with SIGKILL.
   * Used by forceShutdown() when the user presses q/Ctrl+C a second time.
   */
  async forceKill(): Promise<void> {
    if (!this.process) return;

    this.killed = true;
    this.logger.log("Force killing shim process with SIGKILL");
    try {
      this.process.kill("SIGKILL");
    } catch {
      // Process may have already exited
    }

    // Brief wait for SIGKILL to take effect
    await new Promise((resolve) => setTimeout(resolve, 200));
    this.cleanup();
  }

  /**
   * Clean up resources.
   */
  private cleanup(): void {
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.end();
      this.logStream = undefined;
    }

    if (this.process) {
      this.process.removeAllListeners();
      this.process = undefined;
    }
  }

  /**
   * Check if process is running.
   */
  isRunning(): boolean {
    return this.process !== undefined && !this.process.killed;
  }

  /**
   * Get process PID.
   */
  getPid(): number | undefined {
    return this.process?.pid;
  }

  /**
   * Close log stream explicitly (for external cleanup).
   */
  async closeLogStream(): Promise<void> {
    if (this.logStream && !this.logStream.destroyed) {
      await new Promise<void>((resolve) => {
        this.logStream?.end(() => resolve());
      });
      this.logStream = undefined;
    }
  }

  /**
   * Run the shim's self-test to verify environment setup.
   * Executes the shim with --self-test flag and returns the results.
   *
   * @param command - Command to execute shim (e.g., ["bun", "shims/gemini/index.js"])
   * @param providerId - Optional provider ID (e.g., "openai", "google") to set up provider-specific requirements
   * @returns Promise resolving to self-test results
   * @throws Error if self-test execution fails or returns invalid JSON
   */
  async runSelfTest(command: string[], providerId?: string): Promise<ShimSelfTestResult> {
    this.logger.log("Running shim self-test...");

    const [bin, ...binArgs] = command;
    const args = [...binArgs, "--self-test"];

    const fullCommand = `${bin} ${args.join(" ")}`;
    this.logger.log(`Executing self-test: ${fullCommand}`);

    // Set up environment variables
    const env = { ...process.env };

    // For OpenAI models, ensure codex binary is available
    if (providerId?.toLowerCase() === "openai") {
      try {
        const codexInfo = await ensureCodexAvailable();
        env.CODEX_PATH_OVERRIDE = codexInfo.path;
        this.logger.log(`Set CODEX_PATH_OVERRIDE for self-test: ${codexInfo.path}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.log(`Failed to ensure codex binary for self-test: ${errorMsg}`, "error");
        // Continue with self-test anyway - it should fail gracefully with a clear message
      }
    }

    return new Promise((resolve, reject) => {
      const childProcess = spawn(bin, args, {
        cwd: this.executionPath,
        stdio: ["ignore", "pipe", "pipe"], // No stdin, capture stdout/stderr
        env,
      });

      let stdout = "";
      let stderr = "";

      childProcess.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      childProcess.stderr?.on("data", (data) => {
        const chunk = data.toString();
        stderr += chunk;
        this.logger.log(`Self-test stderr: ${chunk}`, "debug");
      });

      const timeout = setTimeout(async () => {
        childProcess.kill("SIGTERM");

        // Wait for process to terminate and release file handles (Windows)
        // This mirrors the grace period pattern in the stop() method
        await new Promise<void>((resolve) => {
          const checkInterval = setInterval(() => {
            if (childProcess.killed || childProcess.exitCode !== null) {
              clearInterval(checkInterval);
              resolve();
            }
          }, TIMEOUTS.LOG_PARSER_DELAY_MS);

          // Force kill after grace period if still running
          setTimeout(() => {
            clearInterval(checkInterval);
            if (!childProcess.killed && childProcess.exitCode === null) {
              this.logger.log("Force killing self-test process with SIGKILL", "debug");
              childProcess.kill("SIGKILL");
            }
            resolve();
          }, TIMEOUTS.PROCESS_KILL_GRACE_MS);
        });

        reject(
          new Error(`Self-test timed out after ${TIMEOUTS.SELF_TEST_TIMEOUT_MS / 1000} seconds`),
        );
      }, TIMEOUTS.SELF_TEST_TIMEOUT_MS);

      childProcess.on("close", (code) => {
        clearTimeout(timeout);

        if (code !== 0) {
          this.logger.log(`Self-test failed with exit code ${code}`, "error");
          if (stderr) {
            this.logger.log(`Stderr: ${stderr}`, "error");
          }
        }

        try {
          const result = JSON.parse(stdout) as ShimSelfTestResult;
          this.logger.log(
            `Self-test completed: ${result.overall.passed ? "PASSED" : "FAILED"}`,
            result.overall.passed ? "info" : "error",
          );
          resolve(result);
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : "Unknown error parsing JSON";
          reject(new Error(`Failed to parse self-test output: ${errorMsg}\nOutput: ${stdout}`));
        }
      });

      childProcess.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}
