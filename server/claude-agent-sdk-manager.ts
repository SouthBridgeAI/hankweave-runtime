import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Options, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeLogParser } from "./claude-log-parser.js";
import {
  extractClaudeSdkFiles,
  getExtractedCliPath,
  isCompiledExecutable,
  needsExtraction,
} from "./claude-runtime-extractor.js";
import type { ModelInfo } from "./llm/models-dev-schema.js";
import { type ProcessEvents, TypedEventEmitter } from "./typed-event-emitter.js";
import type { Codon, ShimSelfTestResult } from "./types/types.js";
import type { Logger } from "./utils.js";
import { toError } from "./utils.js";

/**
 * Error thrown when Claude executable cannot be found.
 * This allows callers to handle this specific case.
 */
export class ClaudeExecutableNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeExecutableNotFoundError";
  }
}

/**
 * Detect an installed Claude executable.
 * Checks common installation locations and falls back to `which claude`.
 *
 * @returns Path to Claude executable, or null if not found
 */
export function detectClaudeExecutable(): string | null {
  const possiblePaths = [
    // Installed via curl installer (cline)
    path.join(os.homedir(), ".cline/cli/bin/claude"),
    // Installed via claude installer
    path.join(os.homedir(), ".claude/local/claude"),
    // Homebrew installation (macOS)
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];

  // Check known paths
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Try `which claude` as fallback
  try {
    const whichResult = execSync("which claude", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (whichResult && fs.existsSync(whichResult)) {
      return whichResult;
    }
  } catch {
    // which claude failed, that's okay
  }

  return null;
}

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
    private anthropicBaseUrl?: string,
    private model?: ModelInfo,
  ) {
    super();
  }

  /**
   * Ensure Claude SDK files are available, extracting if necessary.
   *
   * This static method should be called at application startup before creating
   * any ClaudeAgentSDKManager instances. It handles:
   * - Detecting if running from compiled executable or source
   * - Extracting embedded SDK files for compiled mode
   * - Verifying extracted files exist
   * - Setting CLAUDE_PATH_TO_CLAUDE_EXECUTABLE environment variable
   *
   * @returns Path to cli.js if compiled (and sets env var), or null if running from source
   * @throws Error if extraction fails or extracted file doesn't exist
   */
  static async ensureSdkAvailable(): Promise<string | null> {
    try {
      const isCompiled = isCompiledExecutable();

      // If we're not compiled, return null to use normal detection
      if (!isCompiled) {
        console.log("📦 Running from source, using node_modules SDK");
        return null;
      }

      // Check if we already have extracted files
      let cliPath: string;
      if (!needsExtraction()) {
        cliPath = getExtractedCliPath();
        console.log(`📦 Using cached Claude SDK: ${cliPath}`);
      } else {
        // Need to extract
        cliPath = await extractClaudeSdkFiles();
      }

      // Verify the extracted file actually exists
      if (!fs.existsSync(cliPath)) {
        throw new Error(
          `Extracted Claude CLI not found at: ${cliPath}\nThis indicates a problem with the compilation or extraction process.`,
        );
      }

      // Set environment variable so SDK knows where to find the CLI
      process.env.CLAUDE_PATH_TO_CLAUDE_EXECUTABLE = cliPath;

      return cliPath;
    } catch (error) {
      console.error(`❌ Claude SDK extraction failed: ${(error as Error).message}`);
      if ((error as Error).stack) {
        console.error(`   Stack: ${(error as Error).stack}`);
      }
      throw error;
    }
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
    this.logger.log(`[SPAWN-DEBUG] About to call runQuery`, "debug");

    const queryPromise = this.runQuery(promptContent, options, codon.id);
    this.logger.log(`[SPAWN-DEBUG] runQuery called, promise returned`, "debug");

    queryPromise.catch((error) => {
      this.logger.log(`Query error: ${error.message}`, "error");
      this.cleanup();
      this.emit("error", error);
    });

    this.logger.log(
      `[SPAWN-DEBUG] Returning from spawn(), actualLogPath: ${actualLogPath}`,
      "debug",
    );
    return actualLogPath;
  }

  /**
   * Build SDK options from codon configuration.
   */
  private buildSDKOptions(codon: Codon, previousSessionId: string | null): Options {
    // Use model override if provided, otherwise use codon model
    const modelInfo = this.model || codon.model;

    const options: Options = {
      model: modelInfo.modelId,
      cwd: this.executionPath,
      permissionMode: "bypassPermissions",
      abortController: this.abortController,
      settingSources: ["user"],
    };

    // Use custom Claude Code executable path if provided
    if (process.env.CLAUDE_PATH_TO_CLAUDE_EXECUTABLE) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_PATH_TO_CLAUDE_EXECUTABLE;
      this.logger.log(
        `Using custom Claude Code executable: ${process.env.CLAUDE_PATH_TO_CLAUDE_EXECUTABLE}`,
      );
    }

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

    // Initialize env object (SDK doesn't inherit all process.env, only what we explicitly pass)
    if (!options.env) options.env = {};

    // Pass through essential system environment variables that Claude Code SDK needs
    const essentialVars = ["PATH", "HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL"];
    for (const key of essentialVars) {
      if (process.env[key]) {
        options.env[key] = process.env[key];
      }
    }

    // Pass through critical environment variables that Claude Code SDK needs
    for (const key in process.env) {
      // Pass through CLAUDE_CODE_* variables (OAuth authentication, etc.)
      if (key.startsWith("CLAUDE_CODE_")) {
        options.env[key] = process.env[key];
        this.logger.log(`Passing through Claude Code env var: ${key}`);
      }
      // Pass through specific ANTHROPIC_* variables that won't conflict with OAuth
      // Exclude ANTHROPIC_API_KEY to avoid conflicts with CLAUDE_CODE_OAUTH_TOKEN
      else if (key.startsWith("ANTHROPIC_") && key !== "ANTHROPIC_API_KEY") {
        options.env[key] = process.env[key];
        this.logger.log(`Passing through Anthropic env var: ${key}`);
      }
      // Pass through STRANDWEAVE_* variables (with prefix stripped)
      // Exclude STRANDWEAVE_RUNTIME_* (server config) and STRANDWEAVE_SENTINEL_* (sentinel API keys)
      else if (
        key.startsWith("STRANDWEAVE_") &&
        !key.startsWith("STRANDWEAVE_RUNTIME_") &&
        !key.startsWith("STRANDWEAVE_SENTINEL_")
      ) {
        const newKey = key.substring("STRANDWEAVE_".length);
        options.env[newKey] = process.env[key];
        this.logger.log(`Passing through env var: ${newKey}`);
      }
    }

    // Apply anthropicBaseUrl if provided (overrides any ANTHROPIC_BASE_URL from env)
    if (this.anthropicBaseUrl) {
      options.env.ANTHROPIC_BASE_URL = this.anthropicBaseUrl;
      this.logger.log(`Using custom Anthropic base URL: ${this.anthropicBaseUrl}`);
    }

    // Add codon-specific environment variables from config
    // These will override any existing variables with the same name
    if (codon.env) {
      this.logger.log("Applying codon-specific environment variables...");
      Object.assign(options.env, codon.env);
    }

    // Log model usage
    if (this.model) {
      this.logger.log(
        `Using model override: ${modelInfo.modelId} (codon config specified: ${codon.model.modelId})`,
      );
    }

    return options;
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
  private async runQuery(promptContent: string, options: Options, codonId: string): Promise<void> {
    this.logger.log(
      `[SDK-runQuery] ======= ENTERED runQuery function for codon ${codonId} =======`,
      "info",
    );
    this.logger.log(`[SDK-runQuery] Starting query for codon ${codonId}`, "debug");
    this.logger.log(
      `[SDK-runQuery] Options: model=${options.model}, cwd=${
        options.cwd
      }, continue=${options.continue || false}, resume=${options.resume || "none"}`,
      "debug",
    );
    this.logger.log(`[SDK-runQuery] Prompt length: ${promptContent.length} chars`, "debug");

    try {
      this.logger.log(`[SDK-runQuery] Creating query generator`, "debug");
      this.logger.log(`[SDK-runQuery] About to call query() from SDK...`, "info");
      const queryGenerator = query({ prompt: promptContent, options });
      this.logger.log(`[SDK-runQuery] query() returned, generator created`, "info");
      this.logger.log(`[SDK-runQuery] Query generator created, entering message loop`, "debug");

      let messageCount = 0;
      for await (const message of queryGenerator) {
        messageCount++;
        this.logger.log(
          `[SDK-runQuery] Received message ${messageCount}: type=${message.type}`,
          "debug",
        );

        if (this.killed) {
          this.logger.log(`[SDK-runQuery] Killed flag set, breaking loop`, "debug");
          break;
        }

        // Store session ID from first message
        if (!this.sessionId) {
          this.sessionId = message.session_id;
          this.logger.log(`[SDK-runQuery] Session ID: ${this.sessionId}`, "debug");
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

      this.logger.log(
        `[SDK-runQuery] Message loop completed, received ${messageCount} message(s)`,
        "info",
      );

      // Parse final log entries
      this.logger.log(`[SDK-runQuery] Parsing final log entries`, "debug");
      this.logParser.parseNow();

      // Check for context exceeded
      const allMessages = this.logParser.getAllMessages();
      this.logger.log(`[SDK-runQuery] Got ${allMessages.length} messages from log parser`, "debug");
      const contextExceeded = allMessages.some((msg) => {
        if (msg.type === "result" && msg.subtype === "error") {
          return msg.result?.includes("context") || false;
        }
        return false;
      });

      this.logger.log(
        `[SDK-runQuery] Query complete, contextExceeded=${contextExceeded}, calling cleanup and emitting exit`,
        "info",
      );
      this.cleanup();
      this.logger.log(`[SDK-runQuery] About to emit exit event`, "info");
      this.emit("exit", 0, contextExceeded);
      this.logger.log(`[SDK-runQuery] Exit event emitted`, "info");
    } catch (error) {
      this.logger.log(`[SDK-runQuery] CAUGHT ERROR: ${toError(error).message}`, "error");
      this.logger.log(`[SDK-runQuery] Error stack: ${toError(error).stack}`, "error");
      const errorDetails = this.extractErrorDetails(error as Error, codonId);
      this.logger.log(errorDetails, "error");
      this.cleanup();
      throw error;
    }
  }

  /**
   * Extract detailed error information from the error and log file.
   */
  private extractErrorDetails(error: Error, codonId: string): string {
    const lines: string[] = [];

    lines.push(`Query execution failed for codon ${codonId}`);
    lines.push(`Session ID: ${this.sessionId || "N/A"}`);
    lines.push(`Working directory: ${this.executionPath}`);
    lines.push(`Error type: ${error.name}`);
    lines.push(`Error message: ${error.message}`);

    // Add stack trace if available
    if (error.stack) {
      lines.push(`Stack trace:\n${error.stack}`);
    }

    // Parse log file to extract error details
    try {
      this.logParser.parseNow();
      const allMessages = this.logParser.getAllMessages();

      // Look for result messages with errors
      const resultErrors = allMessages.filter(
        (msg) => msg.type === "result" && msg.subtype === "error",
      );

      if (resultErrors.length > 0) {
        lines.push("\nLog file analysis:");
        for (const msg of resultErrors) {
          if (msg.type === "result") {
            lines.push(`- Result error: ${msg.result || "No details available"}`);
            if (msg.usage) {
              lines.push(`  Usage: ${JSON.stringify(msg.usage)}`);
            }
          }
        }
      }

      // Get last few assistant messages for context
      const assistantMessages = allMessages.filter((msg) => msg.type === "assistant");
      if (assistantMessages.length > 0) {
        const lastMessage = assistantMessages[assistantMessages.length - 1];
        if (lastMessage.type === "assistant") {
          lines.push("\nLast assistant message:");
          const content = lastMessage.message.content;
          if (Array.isArray(content)) {
            for (const block of content.slice(-3)) {
              if (block.type === "text") {
                // Truncate long messages
                const text =
                  block.text.length > 500 ? `${block.text.slice(0, 500)}...` : block.text;
                lines.push(`  ${text}`);
              } else if (block.type === "tool_use") {
                lines.push(`  [Tool use: ${block.name}]`);
              }
            }
          }
        }
      }
    } catch (parseError) {
      lines.push(`\nFailed to parse log file: ${(parseError as Error).message}`);
    }

    return lines.join("\n");
  }

  /**
   * Convert SDK message to JSONL format matching claude-session-schema.
   * SDK messages already have the correct structure, so we mostly just filter out
   * unwanted message types and handle edge cases.
   */
  private convertSDKMessageToJSONL(message: SDKMessage): Record<string, unknown> | null {
    // Filter out message types not supported by the JSONL schema
    if (
      message.type === "stream_event" ||
      message.type === "tool_progress" ||
      message.type === "auth_status"
    ) {
      return null;
    }

    // Filter out replay user messages (already in the conversation history)
    if (message.type === "user" && "isReplay" in message && message.isReplay) {
      return null;
    }

    // Filter out unknown system message subtypes
    if (
      message.type === "system" &&
      !["init", "hook_response", "compact_boundary", "status"].includes(message.subtype)
    ) {
      return null;
    }

    // Handle result messages: error subtypes don't have a 'result' field in SDK,
    // but our schema requires it, so we provide an empty string
    if (message.type === "result" && message.subtype !== "success") {
      return {
        ...message,
        result: "",
      };
    }

    // Pass through the message as-is (SDK format already matches our schema)
    return message as Record<string, unknown>;
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
    this.logger.log(`[CLEANUP-DEBUG] cleanup() called`, "info");
    this.logger.log(`[CLEANUP-DEBUG] Stack trace:\n${new Error().stack}`, "debug");

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

  /**
   * Run self-test to verify Claude Agent SDK environment setup.
   * Checks for API authentication (API key or OAuth token) and SDK availability.
   *
   * @returns Promise resolving to self-test results
   */
  async runSelfTest(): Promise<ShimSelfTestResult> {
    this.logger.log("Running Claude Agent SDK self-test...");

    const checks: ShimSelfTestResult["checks"] = [];

    // Check 1: Verify SDK is installed (by trying to import it)
    let sdkFound = false;
    let sdkVersion = "unknown";
    try {
      // SDK is already imported, so if we got this far, it's available
      sdkFound = true;
      // Try to get version from package.json
      try {
        const sdkPackageJsonPath = path.join(
          path.dirname(require.resolve("@anthropic-ai/claude-agent-sdk")),
          "../package.json",
        );
        const sdkPackageJson = JSON.parse(fs.readFileSync(sdkPackageJsonPath, "utf-8"));
        sdkVersion = sdkPackageJson.version || "unknown";
      } catch {
        // If we can't read the version, that's ok
        sdkVersion = "installed";
      }

      checks.push({
        name: "sdk_installed",
        passed: true,
        message: `Claude Agent SDK found (version ${sdkVersion})`,
      });
    } catch (error) {
      checks.push({
        name: "sdk_installed",
        passed: false,
        message:
          "Claude Agent SDK not found or failed to load: " +
          (error instanceof Error ? error.message : "Unknown error"),
      });
    }

    // Check 2: Verify Claude CLI executable is available
    const customCliPath = process.env.CLAUDE_PATH_TO_CLAUDE_EXECUTABLE;
    if (customCliPath) {
      // User explicitly set a path - verify it exists
      const cliExists = fs.existsSync(customCliPath);
      checks.push({
        name: "claude_cli_executable",
        passed: cliExists,
        message: cliExists
          ? `Claude CLI found at: ${customCliPath}`
          : `Claude CLI not found at specified path: ${customCliPath}`,
      });
    } else {
      // Try to detect Claude CLI in standard locations
      const detectedPath = detectClaudeExecutable();
      if (detectedPath) {
        checks.push({
          name: "claude_cli_executable",
          passed: true,
          message: `Claude CLI detected at: ${detectedPath}`,
        });
      } else {
        // No CLI found, but SDK will handle it internally
        checks.push({
          name: "claude_cli_executable",
          passed: true,
          message: "Claude CLI not detected, SDK will use internal CLI resolution",
        });
      }
    }

    // Check 3: Verify authentication (API key or OAuth token)
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
    const hasOAuthToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const hasAuth = hasApiKey || hasOAuthToken;

    const authMethod = hasOAuthToken
      ? "CLAUDE_CODE_OAUTH_TOKEN"
      : hasApiKey
        ? "ANTHROPIC_API_KEY"
        : "none";

    checks.push({
      name: "authentication",
      passed: hasAuth,
      message: hasAuth
        ? `Authentication configured via ${authMethod}`
        : "No authentication found (set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)",
    });

    // Check 4: Verify custom base URL if set
    if (this.anthropicBaseUrl) {
      checks.push({
        name: "custom_base_url",
        passed: true,
        message: `Using custom Anthropic base URL: ${this.anthropicBaseUrl}`,
      });
    }

    // Overall result
    const allPassed = checks.every((check) => check.passed);

    const result: ShimSelfTestResult = {
      shim: {
        name: "claude-agent-sdk-manager",
        version: sdkVersion,
      },
      agent: {
        name: "claude-agent-sdk",
        version: sdkVersion,
        found: sdkFound,
      },
      checks,
      overall: {
        passed: allPassed,
        message: allPassed ? "All checks passed" : "Some checks failed",
      },
    };

    this.logger.log(
      `Self-test completed: ${result.overall.passed ? "PASSED" : "FAILED"}`,
      result.overall.passed ? "info" : "error",
    );

    return result;
  }
}
