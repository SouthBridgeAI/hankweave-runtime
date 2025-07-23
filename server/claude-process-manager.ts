import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ClaudeLogParser } from "./claude-log-parser.js";
import { TIMEOUTS } from "./config.js";
import { type ProcessEvents, TypedEventEmitter } from "./typed-event-emitter.js";
import type { PhaseConfig } from "./types.js";
import { escapeShellArg, type Logger } from "./utils.js";

/**
 * Manages Claude subprocess lifecycle, including spawning, monitoring, and cleanup.
 * Handles log stream creation and process argument building.
 */
export class ClaudeProcessManager extends TypedEventEmitter<ProcessEvents> {
  private process: ChildProcess | undefined;
  private logStream: fs.WriteStream | undefined;
  private killed = false;

  constructor(
    private projectPath: string,
    private logger: Logger,
    private logParser: ClaudeLogParser,
    private anthropicBaseURL?: string,
  ) {
    super();
  }

  /**
   * Spawn a Claude process for the given phase configuration.
   * Sets up logging, environment, and process monitoring.
   *
   * @param phase - Phase configuration
   * @param previousSessionId - Session ID to continue from (if any)
   * @param logPath - Custom log file path (optional, defaults to .langton/logs/)
   */
  async spawn(
    phase: PhaseConfig,
    previousSessionId: string | null,
    logPath?: string,
  ): Promise<string> {
    if (this.process) {
      throw new Error("Process already running");
    }

    // Use provided logPath or default to .langton/logs/
    const actualLogPath =
      logPath || path.join(this.projectPath, `.langton/logs/log-${phase.id}.jsonl`);

    // Ensure log directory exists
    const logsDir = path.dirname(actualLogPath);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Create log stream
    this.logStream = fs.createWriteStream(actualLogPath);

    // Build Claude arguments
    const args = this.buildClaudeArgs(phase, previousSessionId);

    // Set up environment
    const env = { ...process.env }; // Start with server's environment

    // Pass through TADPOLE_ prefixed variables from server environment
    for (const key in process.env) {
      if (key.startsWith("TADPOLE_")) {
        const newKey = key.substring("TADPOLE_".length);
        env[newKey] = process.env[key];
        this.logger.log(`Passing through env var: ${newKey}`);
      }
    }

    if (this.anthropicBaseURL) {
      env.ANTHROPIC_BASE_URL = this.anthropicBaseURL;
      this.logger.log(`Using custom Anthropic base URL: ${this.anthropicBaseURL}`);
    }

    // Add phase-specific environment variables from config
    // These will override any existing variables with the same name
    if (phase.env) {
      this.logger.log("Applying phase-specific environment variables...");
      Object.assign(env, phase.env);
    }

    // Log the exact command being run
    const fullCommand = `claude ${args.join(" ")}`;
    this.logger.log(`Executing Claude command: ${fullCommand}`);
    this.logger.log(`Working directory: ${this.projectPath}`);

    // Additional debugging
    this.logger.log(`Current process.cwd(): ${process.cwd()}`);
    this.logger.log(`Absolute projectPath: ${path.resolve(this.projectPath)}`);
    this.logger.log(`Project path exists: ${fs.existsSync(this.projectPath)}`);
    this.logger.log(
      `Project path is directory: ${
        fs.existsSync(this.projectPath) && fs.statSync(this.projectPath).isDirectory()
      }`,
    );

    // Spawn process
    this.process = spawn("claude", args, {
      cwd: this.projectPath,
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
    await this.feedPrompt(phase);

    this.logger.log(`Claude process started for phase ${phase.id} (PID: ${this.process.pid})`);

    return actualLogPath;
  }

  /**
   * Build command line arguments for Claude CLI.
   */
  private buildClaudeArgs(phase: PhaseConfig, previousSessionId: string | null): string[] {
    const args = [
      "--verbose",
      "--dangerously-skip-permissions",
      "--model",
      phase.model,
      "--permission-mode",
      "bypassPermissions",
      "-p",
      "--output-format",
      "stream-json",
    ];

    if (phase.continuationMode === "continue-previous" && previousSessionId) {
      args.push("-c", "--resume", previousSessionId);
    }

    // Handle system prompt if provided
    const systemPrompt = this.buildSystemPrompt(phase);
    if (systemPrompt) {
      args.push("--append-system-prompt", escapeShellArg(systemPrompt));
      this.logger.log(`Added system prompt to Claude (${systemPrompt.length} chars)`);
      this.logger.log(`System prompt content:\n${systemPrompt}`);
    }

    return args;
  }

  /**
   * Build system prompt from file or text.
   */
  private buildSystemPrompt(phase: PhaseConfig): string | null {
    let content: string | null = null;

    if (phase.appendSystemPromptFile) {
      const files = Array.isArray(phase.appendSystemPromptFile)
        ? phase.appendSystemPromptFile
        : [phase.appendSystemPromptFile];

      const parts: string[] = [];
      for (const file of files) {
        parts.push(fs.readFileSync(file, "utf-8"));
      }
      content = parts.join("\n\n");
    } else if (phase.appendSystemPromptText) {
      content = phase.appendSystemPromptText;
    }

    if (content) {
      // Replace template variables
      return content.replace(/<%PROJECT_DIR%>/g, this.projectPath);
    }

    return null;
  }

  /**
   * Feed prompt content to Claude's stdin.
   */
  private async feedPrompt(phase: PhaseConfig): Promise<void> {
    if (!this.process?.stdin) {
      throw new Error("Process stdin not available");
    }

    let promptContent: string;

    if (phase.promptFile) {
      const files = Array.isArray(phase.promptFile) ? phase.promptFile : [phase.promptFile];
      const parts: string[] = [];
      for (const file of files) {
        parts.push(fs.readFileSync(file, "utf-8"));
      }
      promptContent = parts.join("\n\n");
    } else if (phase.promptText) {
      promptContent = phase.promptText;
    } else {
      throw new Error("No prompt file or text provided");
    }

    const processedContent = promptContent.replace(/<%PROJECT_DIR%>/g, this.projectPath);

    this.process.stdin.write(processedContent);
    this.process.stdin.end();

    this.logger.log(`Fed prompt to Claude (${processedContent.length} chars)`);
    this.logger.log(`Prompt content:\n${processedContent}`);
  }

  /**
   * Set up process event handlers.
   */
  private setupProcessHandlers(): void {
    if (!this.process) return;

    this.process.on("exit", (code, signal) => {
      this.logger.log(`Claude process exited with code: ${code}, signal: ${signal}`);
      this.cleanup();
      this.emit("exit", code || 0);
    });

    this.process.on("error", (error) => {
      this.logger.log(`Claude process error: ${error.message}`, "error");
      this.cleanup();
      this.emit("error", error);
    });

    this.process.stdout?.on("data", (data) => {
      this.emit("stdout", data.toString());
    });

    this.process.stderr?.on("data", (data) => {
      const errorMessage = data.toString().trim();
      this.logger.log(`Claude stderr: ${errorMessage}`, "error");

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
   * Kill the Claude process.
   */
  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.process || this.killed) return;

    this.killed = true;
    this.logger.log(`Killing Claude process with ${signal}`);

    // Force an immediate parse of the log file to capture any final messages
    // This ensures we don't lose token counts or other important data when killing
    this.logParser.parseNow();

    // Give the log parser a moment to process any final messages
    await new Promise((resolve) => setTimeout(resolve, 100));

    this.process.kill(signal);

    // Give it 5 seconds to die gracefully
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.process || this.process.killed) {
          clearInterval(checkInterval);
          resolve();
        }
      }, TIMEOUTS.LOG_PARSER_DELAY_MS);

      setTimeout(() => {
        clearInterval(checkInterval);
        if (this.process && !this.process.killed) {
          this.logger.log("Force killing Claude process with SIGKILL");
          this.process.kill("SIGKILL");
        }
        resolve();
      }, TIMEOUTS.PROCESS_KILL_GRACE_MS);
    });
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
}
