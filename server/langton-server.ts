import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { minimatch } from "minimatch";
import type {
  AssistantMessage,
  ResultMessage,
  SystemMessage,
  TextContent,
  ThinkingContent,
  ToolUseContent,
} from "../types/claude-session-schema.js";
import { ClaudeLogParser, loadPhaseStateFromLog } from "./claude-log-parser.js";
import { calculateCost, DEFAULT_CONFIG } from "./config.js";
import type {
  AssistantActionEvent,
  ClientCommand,
  CompletedPhase,
  ErrorEvent,
  FileTreeUpdatedEvent,
  FileUpdatedEvent,
  IncompletePhaseEvent,
  InfoEvent,
  PhaseCompletedEvent,
  PhaseConfig,
  PhaseStartedEvent,
  PhaseState,
  ServerConfig,
  ServerEvent,
  ServerReadyEvent,
  StartPhaseCommand,
  StateSnapshotEvent,
  TokenUsage,
  TokenUsageEvent,
} from "./types.js";
import {
  buildFileTree,
  escapeShellArg,
  extractSessionIdFromLog,
  generateId,
  Logger,
  scanWatchedFiles,
} from "./utils.js";

/**
 * Main server class that orchestrates Claude phases.
 *
 * Responsibilities:
 * - WebSocket server management (single client)
 * - Phase execution and lifecycle
 * - Claude process management
 * - File watching and change detection
 * - State persistence and recovery
 * - Cost tracking and reporting
 * - Event streaming to clients
 */
export class LangtonServer extends EventEmitter {
  private server: Server | null = null;
  private client: ServerWebSocket<unknown> | null = null;
  public readonly config: ServerConfig;
  private logger: Logger;
  private currentPhase: PhaseState | null = null;
  private completedPhases: CompletedPhase[] = [];
  private watchedPattern: string | null = null;
  private recentFileAccess: {
    path: string;
    content: string;
    timestamp: Date;
  } | null = null;
  private claudeProcess: ChildProcess | null = null;
  private totalCost = 0;
  private serverStartTime: Date;
  private isShuttingDown = false;
  private isSkippingPhase = false;
  private logParser: ClaudeLogParser | null = null;

  constructor(
    config: Partial<ServerConfig> & {
      projectPath: string;
      phases: PhaseConfig[];
    },
  ) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.logger = new Logger(this.config.serverLogFile);
    this.serverStartTime = new Date();
  }

  /**
   * Initialize and start the WebSocket server.
   *
   * Steps:
   * 1. Check for existing lock file (prevent multiple instances)
   * 2. Create lock file with current PID
   * 3. Load previous session state from logs
   * 4. Start WebSocket server on configured port
   * 5. Set up process termination handlers
   *
   * @throws Error if server is already running
   */
  async start(): Promise<void> {
    this.logger.log(
      `Starting Langton Server v${this.config.version} in ${this.config.projectPath}`,
    );

    // Check for existing lock file
    if (fs.existsSync(this.config.lockFile)) {
      const lockData = fs.readFileSync(this.config.lockFile, "utf-8");
      throw new Error(
        `Server already running (PID: ${lockData}). Remove ${this.config.lockFile} if this is incorrect.`,
      );
    }

    // Create lock file
    fs.writeFileSync(this.config.lockFile, process.pid.toString());

    // Load previous state from logs
    await this.loadPreviousState();

    // Start Bun WebSocket server
    this.server = Bun.serve({
      port: this.config.port,
      websocket: {
        open: (ws) => this.handleConnection(ws),
        message: (ws, message) => this.handleMessage(ws, message),
        close: (ws) => this.handleClose(ws),
      },
      fetch(req, server) {
        // Upgrade to WebSocket
        if (server.upgrade(req)) {
          return;
        }
        return new Response("WebSocket server only", { status: 400 });
      },
    });

    this.logger.log(`WebSocket server listening on port ${this.config.port}`);

    // Handle process termination
    process.on("SIGINT", () => this.shutdown("SIGINT"));
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
    process.on("uncaughtException", (error) => {
      this.logger.log(`Uncaught exception: ${error.message}`, "error");
      this.shutdown("uncaughtException");
    });
  }

  private handleConnection(ws: ServerWebSocket<unknown>): void {
    if (this.client) {
      this.logger.log("Rejecting connection - already have a client");
      ws.close(1008, "Server already has a client");
      return;
    }

    this.logger.log("Client connected");
    this.client = ws;

    // Send initial state
    this.sendEvent({
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: "server.ready",
      data: {
        serverVersion: this.config.version,
        projectPath: this.config.projectPath,
      },
    } as ServerReadyEvent);

    this.sendStateSnapshot();

    // Check for incomplete phases
    this.checkIncompletePhases();

    // Auto-start the next available phase
    this.autoStartNextPhase();
  }

  private handleMessage(_ws: ServerWebSocket<unknown>, message: string | Buffer): void {
    try {
      const command = JSON.parse(message.toString()) as ClientCommand;
      this.logger.logSocketTraffic(this.config.socketLogFile, "in", command);
      this.handleCommand(command);
    } catch (error) {
      this.logger.log(
        `Error parsing command: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  }

  private handleClose(_ws: ServerWebSocket<unknown>): void {
    this.logger.log("Client disconnected - shutting down server");
    this.shutdown("client disconnect");
  }

  async handleCommand(command: ClientCommand): Promise<void> {
    this.logger.log(`Handling command: ${command.type}`);

    switch (command.type) {
      case "phase.start": {
        const startCmd = command as StartPhaseCommand;
        await this.startPhase(startCmd.data.phaseId, startCmd.data.skipPreCommands);
        break;
      }

      case "phase.next":
        await this.startNextPhase();
        break;

      case "phase.skip":
        await this.skipCurrentPhase();
        break;

      case "phase.redo":
        await this.redoCurrentPhase();
        break;

      case "server.shutdown":
        await this.shutdown("client request");
        break;

      default:
        this.logger.log(`Unknown command type: ${command.type}`, "error");
    }
  }

  private sendEvent(event: ServerEvent): void {
    if (!this.client) return;

    this.logger.logSocketTraffic(this.config.socketLogFile, "out", event);
    this.client.send(JSON.stringify(event));

    // Emit for tests and basic TUI
    this.emit("event", event);
  }

  private sendStateSnapshot(): void {
    const totalTime = Date.now() - this.serverStartTime.getTime();

    this.sendEvent({
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: "state.snapshot",
      data: {
        currentPhase: this.currentPhase,
        completedPhases: this.completedPhases,
        fileTree: [],
        totalCost: this.totalCost,
        totalTime: totalTime,
        recentFileAccess: this.recentFileAccess,
      },
    } as StateSnapshotEvent);
  }

  /**
   * Load state from previous sessions by parsing Claude log files.
   *
   * For each phase:
   * 1. Check if log file exists
   * 2. Extract session ID, success status, and token usage
   * 3. Calculate costs from token usage
   * 4. Add to completedPhases if successful
   *
   * This allows the server to resume where it left off after restarts.
   */
  private async loadPreviousState(): Promise<void> {
    this.logger.log("Loading previous state from logs");

    for (const phase of this.config.phases) {
      const logPath = path.join(this.config.projectPath, `.logs/log-${phase.id}.jsonl`);

      const { sessionId, success, cost } = loadPhaseStateFromLog(logPath, this.config.costsPerMTok);

      if (sessionId && success) {
        this.completedPhases.push({
          phaseId: phase.id,
          sessionId,
          success: true,
          cost,
          duration: 0,
          completedAt: new Date(),
        });

        this.logger.log(
          `Loaded completed phase ${phase.id}: cost=$${cost.toFixed(4)}, session=${sessionId}`,
        );
      }
    }

    // Calculate total cost from loaded phases
    this.totalCost = this.completedPhases.reduce((sum, phase) => sum + phase.cost, 0);

    this.logger.log(
      `Loaded ${
        this.completedPhases.length
      } completed phases, total cost: $${this.totalCost.toFixed(4)}`,
    );
  }

  /**
   * Start execution of a specific phase.
   *
   * @param phaseId - ID of the phase to start
   * @param skipPreCommands - Skip pre-start commands (useful for retries)
   *
   * Process:
   * 1. Validate phase exists and no phase is currently running
   * 2. Run pre-start command if specified
   * 3. Get previous session ID if continuing
   * 4. Initialize phase state
   * 5. Start file watching if configured
   * 6. Send phase.started event
   * 7. Spawn Claude process with prompt
   */
  private async startPhase(phaseId: string, skipPreCommands?: boolean): Promise<void> {
    const phase = this.config.phases.find((p) => p.id === phaseId);
    if (!phase) {
      this.sendError(`Unknown phase: ${phaseId}`, false);
      return;
    }

    if (this.currentPhase) {
      this.sendError(`Phase already running: ${this.currentPhase.phase.id}`, false);
      return;
    }

    this.logger.log(`Starting phase: ${phase.name}`);

    // Run pre-start command
    if (!skipPreCommands && phase.preStart) {
      this.logger.log(`Running pre-start command: ${phase.preStart}`);
      try {
        await this.runCommand(phase.preStart);
      } catch (error) {
        this.sendError(
          `Pre-start command failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
        await this.shutdown("pre-start command failure");
        return;
      }
    }

    // Get previous session ID if needed
    const sessionId = generateId();
    let previousSessionId: string | null = null;

    if (phase.continueFromPrevious) {
      previousSessionId = this.getPreviousSessionId(phase.id);
      if (!previousSessionId) {
        this.sendError(`Cannot continue from previous phase - no session ID found`, true);
        await this.shutdown("missing previous session");
        return;
      }
      this.logger.log(
        `Phase ${phase.id} will continue from previous session: ${previousSessionId}`,
      );

      // Send info event about continuation
      this.sendEvent({
        id: generateId(),
        timestamp: new Date().toISOString(),
        type: "info",
        data: {
          message: `Continuing from previous session: ${previousSessionId}`,
        },
      } as InfoEvent);
    }

    // Create phase state
    this.currentPhase = {
      phase,
      sessionId,
      isRunning: true,
      startTime: new Date(),
      phaseCost: 0,
      phaseTokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };

    // Store watch pattern for tool-based tracking
    if (phase.watch) {
      this.watchedPattern = phase.watch;
      this.logger.log(`Watching pattern: ${phase.watch}`);
    }

    // Send phase started event
    this.sendEvent({
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: "phase.started",
      data: {
        phaseId: phase.id,
        phaseName: phase.name,
        phaseDescription: phase.description,
        sessionId: this.currentPhase.sessionId,
        previousSessionId: previousSessionId || undefined,
        startTime: this.currentPhase.startTime.toISOString(),
      },
    } as PhaseStartedEvent);

    // Send initial file states if any exist
    if (phase.watch) {
      const files = await scanWatchedFiles(this.config.projectPath, phase.watch);

      // Only send events if we have files
      if (files.length > 0) {
        for (const file of files) {
          this.sendEvent({
            id: generateId(),
            timestamp: new Date().toISOString(),
            type: "file.updated",
            data: {
              path: file.path,
              filename: path.basename(file.path),
              content: file.content,
              action: "created",
            },
          } as FileUpdatedEvent);
        }

        // Store most recent file
        const mostRecent = files.reduce((latest, file) =>
          new Date(file.lastModified) > new Date(latest.lastModified) ? file : latest,
        );
        this.recentFileAccess = {
          path: mostRecent.path,
          content: mostRecent.content,
          timestamp: new Date(mostRecent.lastModified),
        };

        // Send file tree update
        await this.sendFileTreeUpdate();
      }
    }

    // Start Claude process
    await this.startClaudeProcess(phase, this.currentPhase.sessionId, previousSessionId);
  }

  private getPreviousSessionId(currentPhaseId: string): string | null {
    const currentIndex = this.config.phases.findIndex((p) => p.id === currentPhaseId);
    if (currentIndex <= 0) return null;

    const previousPhase = this.config.phases[currentIndex - 1];

    const completed = this.completedPhases.find((p) => p.phaseId === previousPhase.id);
    if (completed) return completed.sessionId;

    const logPath = path.join(this.config.projectPath, `.logs/log-${previousPhase.id}.jsonl`);
    return extractSessionIdFromLog(logPath);
  }

  /**
   * Spawn Claude CLI process for a phase.
   *
   * @param phase - Phase configuration
   * @param _sessionId - Current session ID (unused but kept for API)
   * @param previousSessionId - Session to continue from (if any)
   *
   * Handles:
   * - Creating log directory and streams
   * - Building Claude CLI arguments
   * - Setting up log parsing
   * - Feeding prompt to stdin
   * - Monitoring process lifecycle
   */
  private async startClaudeProcess(
    phase: PhaseConfig,
    _sessionId: string,
    previousSessionId: string | null,
  ): Promise<void> {
    const logPath = path.join(this.config.projectPath, `.logs/log-${phase.id}.jsonl`);

    const logsDir = path.dirname(logPath);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

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

    if (phase.continueFromPrevious && previousSessionId) {
      args.push("-c", "--resume", previousSessionId);
    }

    // Handle system prompt if provided
    if (phase.appendSystemPromptFile || phase.appendSystemPromptText) {
      let systemPromptContent: string;

      try {
        if (phase.appendSystemPromptFile) {
          // Handle array of files
          const systemPromptFiles = Array.isArray(phase.appendSystemPromptFile)
            ? phase.appendSystemPromptFile
            : [phase.appendSystemPromptFile];

          const systemPromptParts: string[] = [];
          for (const file of systemPromptFiles) {
            systemPromptParts.push(fs.readFileSync(file, "utf-8"));
          }
          systemPromptContent = systemPromptParts.join("\n\n");
        } else if (phase.appendSystemPromptText) {
          systemPromptContent = phase.appendSystemPromptText;
        } else {
          throw new Error("No system prompt file or text provided");
        }

        // Replace PROJECT_DIR placeholders in system prompt
        const processedSystemPrompt = systemPromptContent.replace(
          /<%PROJECT_DIR%>/g,
          this.config.projectPath,
        );

        // Escape and add system prompt argument
        args.push("--append-system-prompt", escapeShellArg(processedSystemPrompt));

        this.logger.log(`Added system prompt to Claude (${processedSystemPrompt.length} chars)`);
      } catch (error) {
        this.sendError(
          `Failed to process system prompt: ${
            error instanceof Error ? error.message : String(error)
          }`,
          true,
        );
        this.shutdown("system prompt error");
        return;
      }
    }

    // Set up environment variables for Claude process
    const env = { ...process.env };
    if (this.config.anthropicBaseURL) {
      env.ANTHROPIC_BASE_URL = this.config.anthropicBaseURL;
      this.logger.log(`Using custom Anthropic base URL: ${this.config.anthropicBaseURL}`);
    }

    this.claudeProcess = spawn("claude", args, {
      cwd: this.config.projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    const logStream = fs.createWriteStream(logPath);
    this.claudeProcess.stdout?.pipe(logStream);

    this.setupLogParsing(logPath, phase.id);

    this.claudeProcess.on("exit", (code) => {
      this.logger.log(`Claude process exited with code: ${code}`);
      this.handlePhaseComplete(code || 0);
    });

    this.claudeProcess.on("error", (error) => {
      this.logger.log(`Claude process error: ${error.message}`, "error");
      this.sendError(`Claude process error: ${error.message}`, true);
      this.shutdown("claude process error");
    });

    try {
      let promptContent: string;

      if (phase.promptFile) {
        // Handle array of files
        const promptFiles = Array.isArray(phase.promptFile) ? phase.promptFile : [phase.promptFile];

        const promptParts: string[] = [];
        for (const file of promptFiles) {
          promptParts.push(fs.readFileSync(file, "utf-8"));
        }
        promptContent = promptParts.join("\n\n");
      } else if (phase.promptText) {
        promptContent = phase.promptText;
      } else {
        throw new Error("No prompt file or text provided");
      }

      const processedContent = promptContent.replace(/<%PROJECT_DIR%>/g, this.config.projectPath);

      this.claudeProcess.stdin?.write(processedContent);
      this.claudeProcess.stdin?.end();

      this.logger.log(`Fed prompt to Claude (${processedContent.length} chars)`);
    } catch (error) {
      this.sendError(
        `Failed to process prompt: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
      this.shutdown("prompt error");
    }
  }

  private setupLogParsing(logPath: string, phaseId: string): void {
    this.logParser = new ClaudeLogParser({
      logPath,
      phaseId,
      parsingInterval: this.config.logParsingInterval,
      onSystemMessage: (msg) => this.handleSystemMessage(msg, phaseId),
      onAssistantMessage: (msg) => this.handleAssistantMessage(msg, phaseId),
      onResultMessage: (msg) => this.handleResultMessage(msg, phaseId),
    });

    this.logParser.start();
  }

  private handleSystemMessage(msg: SystemMessage, phaseId: string): void {
    if (msg.subtype === "init" && msg.session_id && this.currentPhase) {
      const oldSessionId = this.currentPhase.sessionId;
      this.currentPhase.sessionId = msg.session_id;
      this.logger.log(
        `Updated session ID for phase ${phaseId}: ${msg.session_id} (was: ${oldSessionId})`,
      );

      // Send info event about actual session ID
      this.sendEvent({
        id: generateId(),
        timestamp: new Date().toISOString(),
        type: "info",
        data: {
          message: `Claude started with session ID: ${msg.session_id}`,
        },
      } as InfoEvent);
    }
  }

  private handleAssistantMessage(msg: AssistantMessage, phaseId: string): void {
    if (msg.message.usage) {
      const usage: TokenUsage = {
        inputTokens: msg.message.usage.input_tokens || 0,
        outputTokens: msg.message.usage.output_tokens || 0,
        cacheCreationTokens: msg.message.usage.cache_creation_input_tokens || 0,
        cacheReadTokens: msg.message.usage.cache_read_input_tokens || 0,
      };

      const messageCost = calculateCost(usage, this.config.costsPerMTok);

      if (this.currentPhase) {
        // Store the latest cumulative usage - Claude reports cumulative totals
        this.currentPhase.phaseTokens = usage;
        this.currentPhase.phaseCost = messageCost;

        this.logger.log(
          `Phase ${phaseId} token update - Total cost: $${messageCost.toFixed(4)} ` +
            `(${usage.inputTokens} in, ${usage.outputTokens} out, ` +
            `${usage.cacheCreationTokens} cache create, ${usage.cacheReadTokens} cache read)`,
        );
      }

      this.sendEvent({
        id: generateId(),
        timestamp: new Date().toISOString(),
        type: "token.usage",
        data: {
          phaseId,
          ...usage,
          totalCost: messageCost,
        },
      } as TokenUsageEvent);
    }

    const content = msg.message.content;
    const contentArray = Array.isArray(content)
      ? content
      : [{ type: "text" as const, text: content }];

    for (const item of contentArray) {
      if ("text" in item && item.type === "text") {
        const textItem = item as TextContent;
        this.sendEvent({
          id: generateId(),
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: {
            phaseId,
            action: "message",
            content: textItem.text,
          },
        } as AssistantActionEvent);
      } else if ("thinking" in item && item.type === "thinking") {
        const thinkingItem = item as ThinkingContent;
        this.sendEvent({
          id: generateId(),
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: {
            phaseId,
            action: "thinking",
            content: thinkingItem.thinking,
          },
        } as AssistantActionEvent);
      } else if (item.type === "tool_use") {
        const toolItem = item as ToolUseContent;

        // Handle file-related tool calls
        const fileTools = ["Read", "Write", "Edit", "MultiEdit"];
        if (fileTools.includes(toolItem.name)) {
          // Call async function without awaiting to avoid blocking
          this.handleFileToolCall(toolItem.name, toolItem.input).catch((err) => {
            this.logger.log(`Error handling file tool call: ${err}`, "error");
          });
        }

        this.sendEvent({
          id: generateId(),
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: {
            phaseId,
            action: "tool_use",
            content: "",
            toolName: toolItem.name,
            toolInput: toolItem.input,
          },
        } as AssistantActionEvent);
      }
    }
  }

  private handleResultMessage(msg: ResultMessage, phaseId: string): void {
    this.logger.log(`Phase ${phaseId} result message received: ${msg.subtype}`);
    if (msg.subtype === "success") {
      this.logger.log(`Phase ${phaseId} completed successfully`);

      // Update final token usage and cost from result message
      if (msg.usage && this.currentPhase) {
        const finalUsage: TokenUsage = {
          inputTokens: msg.usage.input_tokens || 0,
          outputTokens: msg.usage.output_tokens || 0,
          cacheCreationTokens: msg.usage.cache_creation_input_tokens || 0,
          cacheReadTokens: msg.usage.cache_read_input_tokens || 0,
        };

        // Use the total cost from the result message which is most accurate
        const finalCost = msg.total_cost_usd || calculateCost(finalUsage, this.config.costsPerMTok);

        this.currentPhase.phaseTokens = finalUsage;
        this.currentPhase.phaseCost = finalCost;

        this.logger.log(
          `Phase ${phaseId} final cost from result: $${finalCost.toFixed(4)} ` +
            `(${finalUsage.inputTokens} in, ${finalUsage.outputTokens} out, ` +
            `${finalUsage.cacheCreationTokens} cache create, ${finalUsage.cacheReadTokens} cache read)`,
        );

        // Send a final token usage event with the correct values
        this.sendEvent({
          id: generateId(),
          timestamp: new Date().toISOString(),
          type: "token.usage",
          data: {
            phaseId,
            ...finalUsage,
            totalCost: finalCost,
          },
        } as TokenUsageEvent);
      }
    }
  }

  private handlePhaseComplete(exitCode: number): void {
    if (!this.currentPhase) return;

    // Give the log parser a moment to catch up with the result message
    setTimeout(() => {
      if (!this.currentPhase) return;

      const duration = Date.now() - this.currentPhase.startTime.getTime();
      const success = exitCode === 0;
      const phaseCost = this.currentPhase.phaseCost;

      // Add to completed phases (even if skipped, to track progress)
      if (success || this.isSkippingPhase) {
        this.completedPhases.push({
          phaseId: this.currentPhase.phase.id,
          sessionId: this.currentPhase.sessionId,
          success,
          cost: phaseCost,
          duration,
          completedAt: new Date(),
        });

        // Recalculate total cost from all completed phases
        this.totalCost = this.completedPhases.reduce((sum, phase) => sum + phase.cost, 0);

        this.logger.log(
          `Phase ${this.currentPhase.phase.id} ${
            success ? "completed" : "skipped"
          } - Cost: $${phaseCost.toFixed(4)}, ` +
            `Total project cost: $${this.totalCost.toFixed(4)}`,
        );
      }

      this.sendEvent({
        id: generateId(),
        timestamp: new Date().toISOString(),
        type: "phase.completed",
        data: {
          phaseId: this.currentPhase.phase.id,
          success,
          cost: phaseCost,
          duration,
          exitCode,
        },
      } as PhaseCompletedEvent);

      this.cleanupCurrentPhase();

      // Send updated state snapshot after phase completion
      this.sendStateSnapshot();

      if (!success && !this.isShuttingDown) {
        if (this.isSkippingPhase) {
          // Phase was skipped, not failed - continue to next phase
          this.logger.log("Phase was skipped, continuing to next phase");
          this.isSkippingPhase = false;
          setTimeout(() => {
            this.autoStartNextPhase();
          }, 1000);
        } else {
          this.sendError(`Phase failed with exit code ${exitCode}`, true);
          this.shutdown("phase failure");
        }
      } else if (success && !this.isShuttingDown) {
        // Auto-continue to next phase after a short delay
        setTimeout(() => {
          this.autoStartNextPhase();
        }, 1000);
      }
    }, 1000); // Give 1s for result message to be parsed
  }

  private async handleFileToolCall(
    toolName: string,
    toolInput: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!this.watchedPattern) return;

    let filePath: string | null = null;
    let action: "created" | "modified" | "deleted" = "modified";
    let content = "";

    // Extract file path based on tool type
    switch (toolName) {
      case "Read":
        filePath = toolInput?.file_path as string;
        action = "modified"; // Read doesn't change the file
        break;
      case "Write":
        filePath = toolInput?.file_path as string;
        content = (toolInput?.content as string) || "";
        action = fs.existsSync(path.join(this.config.projectPath, filePath))
          ? "modified"
          : "created";
        break;
      case "Edit":
      case "MultiEdit":
        filePath = toolInput?.file_path as string;
        action = "modified";
        break;
    }

    if (!filePath) return;

    // Make path relative if it's absolute
    if (path.isAbsolute(filePath)) {
      filePath = path.relative(this.config.projectPath, filePath);
    }

    // Check if file matches watch pattern
    const normalizedPattern = this.watchedPattern.replace(/^\.\//g, "");
    const normalizedPath = filePath.replace(/^\.\//g, "");

    if (!minimatch(normalizedPath, normalizedPattern, { matchBase: true })) {
      return;
    }

    // Read current file content if not provided
    if (!content) {
      const fullPath = path.join(this.config.projectPath, filePath);
      if (fs.existsSync(fullPath)) {
        try {
          content = fs.readFileSync(fullPath, "utf-8");
        } catch (error) {
          this.logger.log(
            `Error reading file ${filePath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "error",
          );
          return;
        }
      }
    }

    // Store recent file access
    this.recentFileAccess = {
      path: filePath,
      content,
      timestamp: new Date(),
    };

    // Send file update event
    this.sendEvent({
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: "file.updated",
      data: {
        path: filePath,
        filename: path.basename(filePath),
        content,
        action,
      },
    } as FileUpdatedEvent);

    // Send file tree update
    await this.sendFileTreeUpdate();
  }

  private async sendFileTreeUpdate(): Promise<void> {
    if (!this.watchedPattern) return;

    const tree = await buildFileTree(this.config.projectPath, this.watchedPattern);

    this.sendEvent({
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: "filetree.updated",
      data: { tree },
    } as FileTreeUpdatedEvent);
  }

  private sendError(message: string, fatal: boolean): void {
    this.sendEvent({
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message,
        phase: this.currentPhase?.phase.id,
        fatal,
      },
    } as ErrorEvent);
  }

  private async checkIncompletePhases(): Promise<void> {
    let nextPhaseIndex = 0;

    if (this.completedPhases.length > 0) {
      const lastCompleted = this.completedPhases[this.completedPhases.length - 1];
      const lastIndex = this.config.phases.findIndex((p) => p.id === lastCompleted.phaseId);

      if (lastIndex >= 0 && lastIndex < this.config.phases.length - 1) {
        nextPhaseIndex = lastIndex + 1;
      } else if (lastIndex === this.config.phases.length - 1) {
        this.logger.log("All phases have been completed");
        this.sendEvent({
          id: generateId(),
          timestamp: new Date().toISOString(),
          type: "info",
          data: {
            message: "All phases have been completed. Use phase.redo to re-run the last phase.",
          },
        } as InfoEvent);
        return;
      }
    }

    const nextPhase = this.config.phases[nextPhaseIndex];
    const logPath = path.join(this.config.projectPath, `.logs/log-${nextPhase.id}.jsonl`);

    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, "utf8");
      const hasResult = content.includes('"type":"result"');

      if (!hasResult) {
        this.logger.log(`Found incomplete phase: ${nextPhase.id}`);
        this.sendEvent({
          id: generateId(),
          timestamp: new Date().toISOString(),
          type: "incomplete.phase",
          data: {
            phaseId: nextPhase.id,
            phaseName: nextPhase.name,
            message: `Phase ${nextPhase.name} appears to be incomplete. Use 'phase.next' to continue or 'phase.redo' to restart it.`,
          },
        } as IncompletePhaseEvent);
      }
    }
  }

  /**
   * Automatically start the next available phase if none is running.
   * Called on connection and after phase completion.
   */
  private async autoStartNextPhase(): Promise<void> {
    if (this.currentPhase || this.isShuttingDown) {
      return; // Phase already running or shutting down
    }

    // Determine next phase to run
    const nextPhaseIndex = this.getNextPhaseIndex();
    if (nextPhaseIndex === -1) {
      this.logger.log("All phases completed - shutting down");
      this.sendEvent({
        id: generateId(),
        timestamp: new Date().toISOString(),
        type: "info",
        data: {
          message: "All phases completed successfully. Server shutting down.",
        },
      } as InfoEvent);

      setTimeout(() => {
        this.shutdown("all phases completed");
      }, 2000);
      return;
    }

    const nextPhase = this.config.phases[nextPhaseIndex];
    this.logger.log(`Auto-starting phase: ${nextPhase.name}`);
    await this.startPhase(nextPhase.id);
  }

  private getNextPhaseIndex(): number {
    if (this.completedPhases.length === 0) {
      return this.config.phases.length > 0 ? 0 : -1;
    }

    const lastCompleted = this.completedPhases[this.completedPhases.length - 1];
    const lastIndex = this.config.phases.findIndex((p) => p.id === lastCompleted.phaseId);

    if (lastIndex >= 0 && lastIndex < this.config.phases.length - 1) {
      return lastIndex + 1;
    }

    return -1; // All phases completed
  }

  private async startNextPhase(): Promise<void> {
    if (this.currentPhase) {
      this.sendError("Cannot start next phase while current phase is running", false);
      return;
    }

    const lastCompleted = this.completedPhases[this.completedPhases.length - 1];
    if (!lastCompleted) {
      if (this.config.phases.length > 0) {
        await this.startPhase(this.config.phases[0].id);
      }
      return;
    }

    const lastIndex = this.config.phases.findIndex((p) => p.id === lastCompleted.phaseId);
    if (lastIndex >= 0 && lastIndex < this.config.phases.length - 1) {
      await this.startPhase(this.config.phases[lastIndex + 1].id);
    } else {
      this.sendError("No more phases to run", false);
    }
  }

  private async skipCurrentPhase(): Promise<void> {
    if (!this.currentPhase) {
      this.sendError("No phase is currently running", false);
      return;
    }

    this.logger.log(`Skipping phase ${this.currentPhase.phase.id}`);
    this.isSkippingPhase = true;

    if (this.claudeProcess) {
      this.claudeProcess.kill("SIGTERM");
    }
  }

  private async redoCurrentPhase(): Promise<void> {
    if (this.currentPhase) {
      this.sendError("Cannot redo while phase is running", false);
      return;
    }

    const lastPhase = this.completedPhases[this.completedPhases.length - 1];
    if (lastPhase) {
      await this.startPhase(lastPhase.phaseId);
    }
  }

  private cleanupCurrentPhase(): void {
    if (this.claudeProcess) {
      this.claudeProcess.removeAllListeners();
      if (!this.claudeProcess.killed) {
        this.claudeProcess.kill("SIGTERM");
      }
      this.claudeProcess = null;
    }

    this.watchedPattern = null;
    this.recentFileAccess = null;

    if (this.logParser) {
      this.logParser.stop();
      this.logParser = null;
    }

    this.currentPhase = null;
  }

  private async runCommand(command: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, {
        shell: true,
        cwd: this.config.projectPath,
      });

      proc.on("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Command failed with exit code ${code}`));
        }
      });

      proc.on("error", reject);
    });
  }

  async shutdown(reason: string): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    this.logger.log(`Shutting down server: ${reason}`);

    this.cleanupCurrentPhase();

    if (this.client) {
      this.client.close();
      this.client = null;
    }

    if (this.server) {
      this.server.stop();
      this.server = null;
    }

    if (fs.existsSync(this.config.lockFile)) {
      try {
        fs.unlinkSync(this.config.lockFile);
        this.logger.log("Lock file removed");
      } catch (error) {
        this.logger.log(`Failed to remove lock file: ${error}`, "error");
      }
    }

    this.logger.log("Server shutdown complete");

    // Small delay to ensure log is written and lock file removal completes
    setTimeout(() => {
      process.exit(0);
    }, 100);
  }
}
