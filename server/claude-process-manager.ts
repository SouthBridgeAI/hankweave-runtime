import fs from "node:fs";
import path from "node:path";
import {
  type Query,
  query,
  type SDKMessage,
  type SettingSource,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeLogParser } from "./claude-log-parser.js";
import { TIMEOUTS } from "./config.js";
import { type ProcessEvents, TypedEventEmitter } from "./typed-event-emitter.js";
import { type Codon, isContextExceeded } from "./types/types.js";
import type { Logger } from "./utils.js";

/**
 * Manages Claude SDK query lifecycle, including spawning, monitoring, and cleanup.
 * Handles log stream creation and message processing.
 */
export class ClaudeProcessManager extends TypedEventEmitter<ProcessEvents> {
  private queryInstance: Query | undefined;
  private logStream: fs.WriteStream | undefined;
  private killed = false;
  private isActive = false;
  private messageIterationPromise: Promise<void> | undefined;

  constructor(
    private executionPath: string,
    private logger: Logger,
    private logParser: ClaudeLogParser,
    private anthropicBaseURL?: string,
    private modelOverride?: import("./types/types.js").ModelName,
  ) {
    super();
  }

  /**
   * Spawn a Claude SDK query for the given codon configuration.
   * Sets up logging, environment, and message processing.
   *
   * @param codon - Codon configuration (not Loop - loops must be expanded first)
   * @param previousSessionId - Session ID to continue from (if any)
   * @param logPath - Custom log file path (optional, defaults to .strandweave/logs/)
   */
  async spawn(codon: Codon, previousSessionId: string | null, logPath?: string): Promise<string> {
    if (this.queryInstance) {
      throw new Error("Query already running");
    }

    // Use provided logPath or default to .strandweave/logs/
    const actualLogPath =
      logPath || path.join(this.executionPath, `.strandweave/logs/log-${codon.id}.jsonl`);

    // Ensure log directory exists
    const logsDir = path.dirname(actualLogPath);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Create log stream
    this.logStream = fs.createWriteStream(actualLogPath);

    // Handle log stream errors
    this.logStream.on("error", (error) => {
      this.logger.log(`Log stream error: ${error.message}`, "error");
    });

    // Build prompt content
    const promptContent = this.buildPrompt(codon);

    // Build system prompt
    const systemPrompt = this.buildSystemPrompt(codon);

    // Set up environment
    const env = { ...process.env }; // Start with server's environment

    // Pass through STRANDWEAVE_ prefixed variables from server environment
    for (const key in process.env) {
      if (key.startsWith("STRANDWEAVE_")) {
        const newKey = key.substring("STRANDWEAVE_".length);
        env[newKey] = process.env[key];
        this.logger.log(`Passing through env var: ${newKey}`);
      }
    }

    if (this.anthropicBaseURL) {
      env.ANTHROPIC_BASE_URL = this.anthropicBaseURL;
      this.logger.log(`Using custom Anthropic base URL: ${this.anthropicBaseURL}`);
    }

    // Add codon-specific environment variables from config
    if (codon.env) {
      this.logger.log("Applying codon-specific environment variables...");
      Object.assign(env, codon.env);
    }

    // Map model names
    const model = this.modelOverride || codon.model;
    const sdkModel = this.mapModelName(model);

    // Build SDK options
    const options = {
      model: sdkModel,
      cwd: this.executionPath,
      env,
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      settingSources: ["user"] as SettingSource[], // Use user settings - empty array causes CLI parsing errors
      stderr: (data: string) => {
        // Capture stderr from SDK subprocess
        this.logger.log(`Claude SDK stderr: ${data}`, "error");
        this.emit("stderr", data);
      },
      systemPrompt: systemPrompt
        ? {
            type: "preset" as const,
            preset: "claude_code" as const,
            append: systemPrompt,
          }
        : {
            type: "preset" as const,
            preset: "claude_code" as const,
          },
    };

    // Add continuation/resume options
    if (codon.continuationMode === "continue-previous" && previousSessionId) {
      // Use resume for continuing from previous session
      Object.assign(options, { resume: previousSessionId });
    }

    this.logger.log(`Starting Claude SDK query for codon ${codon.id}`);
    this.logger.log(`Model: ${sdkModel}`);
    this.logger.log(`Working directory: ${this.executionPath}`);
    this.logger.log(`Prompt length: ${promptContent.length} chars`);
    if (systemPrompt) {
      this.logger.log(`System prompt length: ${systemPrompt.length} chars`);
    }

    this.killed = false;
    this.isActive = true;

    // Create the query
    this.queryInstance = query({ prompt: promptContent, options });

    // NOTE: Don't start iteration here - let caller start it after state transitions
    // to avoid race conditions with state machine
    // this.messageIterationPromise = this.iterateMessages();

    return actualLogPath;
  }

  /**
   * Start processing messages from the SDK query.
   * Should be called after transitioning to 'initializing' state to avoid race conditions.
   */
  startMessageIteration(): void {
    if (!this.queryInstance) {
      throw new Error("No query instance - call spawn() first");
    }
    if (this.messageIterationPromise) {
      this.logger.log("Message iteration already started", "info");
      return;
    }

    this.logger.log("Starting message iteration");
    this.messageIterationPromise = this.iterateMessages();
  }

  /**
   * Build prompt content from codon configuration.
   */
  private buildPrompt(codon: Codon): string {
    let promptContent: string;

    if (codon.promptFile) {
      const files = Array.isArray(codon.promptFile) ? codon.promptFile : [codon.promptFile];
      const parts: string[] = [];
      for (const file of files) {
        parts.push(fs.readFileSync(file, "utf-8"));
      }
      promptContent = parts.join("\n\n");
    } else if (codon.promptText) {
      promptContent = codon.promptText;
    } else {
      throw new Error("No prompt file or text provided");
    }

    // Replace template variables
    return promptContent
      .replace(/<%PROJECT_DIR%>/g, this.executionPath) // Legacy support
      .replace(/<%EXECUTION_DIR%>/g, this.executionPath)
      .replace(/<%DATA_DIR%>/g, path.join(this.executionPath, "read_only_data_source"));
  }

  /**
   * Map model name from Codon config to SDK model identifier.
   */
  private mapModelName(model: string): string {
    // Map short names to full SDK model identifiers
    const modelMap: Record<string, string> = {
      sonnet: "claude-sonnet-4-5-20250929",
      opus: "claude-opus-4-20250514",
    };

    return modelMap[model] || model;
  }

  /**
   * Build system prompt from file or text.
   */
  private buildSystemPrompt(codon: Codon): string | null {
    let content: string | null = null;

    if (codon.appendSystemPromptFile) {
      const files = Array.isArray(codon.appendSystemPromptFile)
        ? codon.appendSystemPromptFile
        : [codon.appendSystemPromptFile];

      const parts: string[] = [];
      for (const file of files) {
        parts.push(fs.readFileSync(file, "utf-8"));
      }
      content = parts.join("\n\n");
    } else if (codon.appendSystemPromptText) {
      content = codon.appendSystemPromptText;
    }

    if (content) {
      // Replace template variables
      return content
        .replace(/<%PROJECT_DIR%>/g, this.executionPath) // Legacy support
        .replace(/<%EXECUTION_DIR%>/g, this.executionPath)
        .replace(/<%DATA_DIR%>/g, path.join(this.executionPath, "read_only_data_source"));
    }

    return null;
  }

  /**
   * Iterate over SDK messages and write them to log file.
   * Also emits events for compatibility with existing code.
   */
  private async iterateMessages(): Promise<void> {
    if (!this.queryInstance) {
      throw new Error("No query instance available");
    }

    try {
      for await (const message of this.queryInstance) {
        if (this.killed) break;

        // Transform SDK message to CLI format and write to log
        const cliMessage = this.transformMessageToCLIFormat(message);
        if (cliMessage) {
          this.writeToLog(cliMessage);

          // Emit stdout event for compatibility
          this.emit("stdout", JSON.stringify(cliMessage));
        }

        // Handle result message (end of execution)
        if (message.type === "result") {
          this.logger.log("Query completed with result message");

          // Parse final log entries
          this.logParser.parseNow();

          // Check for context exceeded
          const allMessages = this.logParser.getAllMessages();
          const contextExceeded = allMessages.some((msg) => isContextExceeded(msg));

          if (contextExceeded) {
            this.logger.log("Context exceeded detected in log messages");
          }

          // Determine exit code from result
          const exitCode = message.is_error ? 1 : 0;

          this.cleanup();
          this.emit("exit", exitCode, contextExceeded);
          break;
        }
      }
    } catch (error) {
      this.logger.log(
        `Query iteration error: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );

      // Parse final log entries
      this.logParser.parseNow();

      this.cleanup();
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.isActive = false;
    }
  }

  /**
   * Transform SDK message to CLI format for log file compatibility.
   */
  private transformMessageToCLIFormat(message: SDKMessage): unknown {
    // System messages (init)
    if (message.type === "system" && message.subtype === "init") {
      return {
        type: "system",
        subtype: "init",
        cwd: message.cwd,
        session_id: message.session_id,
        tools: message.tools,
        mcp_servers: message.mcp_servers,
        model: message.model,
        permissionMode: message.permissionMode,
        apiKeySource: message.apiKeySource,
      };
    }

    // Assistant messages
    if (message.type === "assistant") {
      return {
        type: "assistant",
        message: {
          id: message.message.id,
          type: "message",
          role: "assistant",
          model: message.message.model,
          content: message.message.content,
          usage: message.message.usage,
          stop_reason: message.message.stop_reason,
          stop_sequence: message.message.stop_sequence,
        },
      };
    }

    // User messages (tool results)
    if (message.type === "user" && !("isReplay" in message)) {
      return {
        type: "user",
        message: message.message,
        parent_tool_use_id: message.parent_tool_use_id,
      };
    }

    // Result messages
    if (message.type === "result") {
      return {
        type: "result",
        subtype: message.subtype,
        duration_ms: message.duration_ms,
        duration_api_ms: message.duration_api_ms,
        is_error: message.is_error,
        num_turns: message.num_turns,
        result: "result" in message ? message.result : undefined,
        total_cost_usd: message.total_cost_usd,
        usage: message.usage,
        modelUsage: message.modelUsage,
        permission_denials: message.permission_denials,
        structured_output: "structured_output" in message ? message.structured_output : undefined,
        errors: "errors" in message ? message.errors : undefined,
      };
    }

    // Skip stream events and other message types we don't need to log
    return null;
  }

  /**
   * Write a message to the log file.
   */
  private writeToLog(message: unknown): void {
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.write(`${JSON.stringify(message)}\n`);
    }
  }

  /**
   * Kill the Claude query.
   */
  async kill(_signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.queryInstance || this.killed) return;

    this.killed = true;
    this.logger.log("Interrupting Claude query");

    // Force an immediate parse of the log file to capture any final messages
    this.logParser.parseNow();

    // Give the log parser a moment to process any final messages
    await new Promise((resolve) => setTimeout(resolve, 100));

    try {
      // Interrupt the query
      await this.queryInstance.interrupt();
      this.logger.log("Query interrupted successfully");
    } catch (error) {
      this.logger.log(
        `Error interrupting query: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }

    // Wait for message iteration to complete
    if (this.messageIterationPromise) {
      try {
        await Promise.race([
          this.messageIterationPromise,
          new Promise((resolve) => setTimeout(resolve, TIMEOUTS.PROCESS_KILL_GRACE_MS)),
        ]);
      } catch (error) {
        this.logger.log(
          `Error waiting for iteration to complete: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    }

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

    if (this.queryInstance) {
      this.queryInstance = undefined;
    }

    this.isActive = false;
  }

  /**
   * Check if query is running.
   */
  isRunning(): boolean {
    return this.isActive && !this.killed;
  }

  /**
   * Get process PID (returns undefined for SDK queries as there's no child process).
   */
  getPid(): number | undefined {
    // SDK queries don't have a PID since they run in the same process
    // Return undefined for compatibility
    return undefined;
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
