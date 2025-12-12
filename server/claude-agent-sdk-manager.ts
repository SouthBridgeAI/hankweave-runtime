import fs from "node:fs";
import path from "node:path";
import { type Options, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeLogParser } from "./claude-log-parser.js";
import { type ProcessEvents, TypedEventEmitter } from "./typed-event-emitter.js";
import type { Codon } from "./types/types.js";
import type { Logger } from "./utils.js";

/**
 * Manages Claude Agent SDK lifecycle, mimicking the ClaudeProcessManager API.
 * Handles log stream creation and converts SDK messages to JSONL format.
 */
export class ClaudeAgentSDKManager extends TypedEventEmitter<ProcessEvents> {
  private abortController: AbortController | undefined;
  private logStream: fs.WriteStream | undefined;
  private killed = false;
  private sessionId: string | undefined;
  private syntheticPid: number | undefined;

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
   * Spawn a Claude Agent SDK session for the given codon configuration.
   * Sets up logging, environment, and message handling.
   *
   * @param codon - Codon configuration (not Loop - loops must be expanded first)
   * @param previousSessionId - Session ID to continue from (if any)
   * @param logPath - Custom log file path (optional, defaults to .strandweave/logs/)
   */
  async spawn(codon: Codon, previousSessionId: string | null, logPath?: string): Promise<string> {
    if (this.abortController) {
      throw new Error("Session already running");
    }

    // Use provided logPath or default to .strandweave/logs/
    const actualLogPath =
      logPath || path.join(this.executionPath, `.strandweave/logs/log-${codon.id}-sdk.jsonl`);

    // Ensure log directory exists
    const logsDir = path.dirname(actualLogPath);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    // Create log stream
    this.logStream = fs.createWriteStream(actualLogPath);

    // Build Claude Agent SDK options
    const options = this.buildSDKOptions(codon, previousSessionId);

    // Build prompt content
    const promptContent = this.buildPrompt(codon);

    this.logger.log(`Starting Claude Agent SDK for codon ${codon.id}`);
    this.logger.log(`Working directory: ${this.executionPath}`);
    this.logger.log(`Prompt content (${promptContent.length} chars):\n${promptContent}`);

    // Create abort controller
    this.abortController = new AbortController();
    this.killed = false;

    // Generate synthetic PID for compatibility with ClaudeProcessManager API
    // Use a high range (900000+) to avoid conflicts with real PIDs
    this.syntheticPid = 900000 + Math.floor(Math.random() * 99999);
    this.logger.log(`Generated synthetic PID: ${this.syntheticPid} for SDK session`);

    // Start the query in the background
    this.runQuery(promptContent, options, codon.id).catch((error) => {
      this.logger.log(`Query error: ${error.message}`, "error");
      this.cleanup();
      this.emit("error", error);
    });

    return actualLogPath;
  }

  /**
   * Build SDK options from codon configuration.
   */
  private buildSDKOptions(codon: Codon, previousSessionId: string | null): Options {
    // Use model override if provided, otherwise use codon model
    const model = this.modelOverride || codon.model;

    const options: Options = {
      model: this.mapModelName(model),
      cwd: this.executionPath,
      permissionMode: "bypassPermissions",
      abortController: this.abortController,
      settingSources: ["user"],
    };

    // Handle continuation
    if (codon.continuationMode === "continue-previous" && previousSessionId) {
      options.continue = true;
      options.resume = previousSessionId;
    }

    // Handle system prompt if provided
    const systemPrompt = this.buildSystemPrompt(codon);
    if (systemPrompt) {
      options.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: systemPrompt,
      };
      this.logger.log(`Added system prompt to Claude (${systemPrompt.length} chars)`);
      this.logger.log(`System prompt content:\n${systemPrompt}`);
    }

    // Handle environment variables
    if (codon.env) {
      this.logger.log("Applying codon-specific environment variables...");
      options.env = codon.env;
    }

    // Initialize env object if not already set
    if (!options.env) options.env = {};

    // Add STRANDWEAVE_ prefixed variables from server environment
    for (const key in process.env) {
      if (key.startsWith("STRANDWEAVE_")) {
        const newKey = key.substring("STRANDWEAVE_".length);
        options.env[newKey] = process.env[key];
        this.logger.log(`Passing through env var: ${newKey}`);
      }
    }

    // Pass through authentication-related environment variables
    const authEnvVars = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"];
    for (const key of authEnvVars) {
      if (process.env[key]) {
        options.env[key] = process.env[key];
        this.logger.log(`Passing through auth env var: ${key}`);
      }
    }

    // Log model usage
    if (this.modelOverride) {
      this.logger.log(`Using model override: ${model} (codon config specified: ${codon.model})`);
    }

    return options;
  }

  /**
   * Map our model names to SDK model names.
   */
  private mapModelName(model: string): string {
    // Map short names to full model names
    const modelMap: Record<string, string> = {
      sonnet: "claude-sonnet-4-5-20250929",
      opus: "claude-opus-4-5-20251101",
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
   * Build prompt content from file or text.
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

    return promptContent
      .replace(/<%PROJECT_DIR%>/g, this.executionPath) // Legacy support
      .replace(/<%EXECUTION_DIR%>/g, this.executionPath)
      .replace(/<%DATA_DIR%>/g, path.join(this.executionPath, "read_only_data_source"));
  }

  /**
   * Run the query and process messages.
   */
  private async runQuery(promptContent: string, options: Options, _codonId: string): Promise<void> {
    try {
      const queryGenerator = query({ prompt: promptContent, options });

      for await (const message of queryGenerator) {
        if (this.killed) break;

        // Store session ID from first message
        if (!this.sessionId) {
          this.sessionId = message.session_id;
        }

        // Convert SDK message to JSONL format and write to log
        const jsonlMessage = this.convertSDKMessageToJSONL(message);
        if (jsonlMessage) {
          this.writeToLog(jsonlMessage);
        }

        // Emit events similar to process manager
        if (message.type === "assistant") {
          this.emit("stdout", JSON.stringify(jsonlMessage));
        }
      }

      // Parse final log entries
      this.logParser.parseNow();

      // Check for context exceeded
      const allMessages = this.logParser.getAllMessages();
      const contextExceeded = allMessages.some((msg) => {
        if (msg.type === "result" && msg.subtype === "error") {
          return msg.result?.includes("context") || false;
        }
        return false;
      });

      this.cleanup();
      this.emit("exit", 0, contextExceeded);
    } catch (error) {
      this.logger.log(`Query execution error: ${(error as Error).message}`, "error");
      this.cleanup();
      throw error;
    }
  }

  /**
   * Convert SDK message to JSONL format matching claude-session-schema.
   */
  private convertSDKMessageToJSONL(message: SDKMessage): Record<string, unknown> | null {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          return {
            type: "system",
            subtype: "init",
            cwd: message.cwd,
            session_id: message.session_id,
            tools: message.tools,
            mcp_servers: message.mcp_servers || [],
            model: message.model,
            permissionMode: message.permissionMode,
            apiKeySource: message.apiKeySource || "none",
            // Include additional fields from SDK
            uuid: message.uuid,
            claude_code_version: message.claude_code_version,
            output_style: message.output_style,
            agents: message.agents || [],
            skills: message.skills || [],
            plugins: message.plugins || [],
            slash_commands: message.slash_commands || [],
            betas: message.betas || [],
          };
        } else if (message.subtype === "hook_response") {
          // Include hook response messages
          return {
            type: "system",
            subtype: "hook_response",
            session_id: message.session_id,
            uuid: message.uuid,
            hook_name: message.hook_name,
            hook_event: message.hook_event,
            stdout: message.stdout,
            stderr: message.stderr,
            exit_code: message.exit_code,
          };
        } else if (message.subtype === "compact_boundary") {
          return {
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: message.compact_metadata,
            uuid: message.uuid,
            session_id: message.session_id,
          };
        } else if (message.subtype === "status") {
          return {
            type: "system",
            subtype: "status",
            status: message.status,
            uuid: message.uuid,
            session_id: message.session_id,
          };
        }
        // Skip unknown system message subtypes
        return null;

      case "assistant":
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
          parent_tool_use_id: message.parent_tool_use_id,
          session_id: message.session_id,
          uuid: message.uuid,
        };

      case "user":
        // Skip replay messages to avoid duplicates
        if ("isReplay" in message && message.isReplay) {
          return null;
        }
        return {
          type: "user",
          message: {
            role: "user",
            content: message.message.content,
          },
          parent_tool_use_id: message.parent_tool_use_id,
          session_id: message.session_id,
          uuid: message.uuid,
        };

      case "result":
        return {
          type: "result",
          subtype: message.subtype,
          is_error: message.is_error,
          duration_ms: message.duration_ms,
          duration_api_ms: message.duration_api_ms,
          num_turns: message.num_turns,
          result: message.subtype === "success" ? message.result : "",
          session_id: message.session_id,
          total_cost_usd: message.total_cost_usd,
          usage: message.usage,
          uuid: message.uuid,
        };

      case "stream_event":
        // Skip streaming events for now - they're not in the JSONL schema
        return null;

      case "tool_progress":
        // Skip tool progress messages
        return null;

      case "auth_status":
        // Skip auth status messages
        return null;

      default:
        this.logger.log(`Unknown message type: ${(message as SDKMessage).type}`, "error");
        return null;
    }
  }

  /**
   * Write a message to the log file.
   */
  private writeToLog(message: Record<string, unknown>): void {
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.write(`${JSON.stringify(message)}\n`);
    }
  }

  /**
   * Kill the Claude Agent SDK session.
   */
  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (!this.abortController || this.killed) return;

    this.killed = true;
    this.logger.log(`Killing Claude Agent SDK session with ${signal}`);

    // Force an immediate parse of the log file to capture any final messages
    this.logParser.parseNow();

    // Abort the query
    this.abortController.abort();

    // Give it a moment to clean up
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  /**
   * Clean up resources.
   */
  private cleanup(): void {
    if (this.logStream && !this.logStream.destroyed) {
      this.logStream.end();
      this.logStream = undefined;
    }

    if (this.abortController) {
      this.abortController = undefined;
    }

    this.syntheticPid = undefined;
  }

  /**
   * Check if session is running.
   */
  isRunning(): boolean {
    return this.abortController !== undefined && !this.killed;
  }

  /**
   * Get session ID.
   */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Get synthetic PID (for compatibility with ClaudeProcessManager API).
   * Note: This is not a real process ID since SDK runs in-process.
   */
  getPid(): number | undefined {
    return this.syntheticPid;
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
