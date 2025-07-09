import { spawn } from "node:child_process";
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
import { CheckpointGit } from "./checkpoint-git.js";
import { ClaudeLogParser, loadPhaseStateFromLog } from "./claude-log-parser.js";
import { ClaudeProcessManager } from "./claude-process-manager.js";
import { calculateCost, DEFAULT_CONFIG, TIMEOUTS } from "./config.js";
import { APITimeoutError, ErrorSeverity } from "./error-types.js";
import type { ToolInputMap, ToolName } from "./tool-types.js";
import { isStartPhaseCommand, isValidClientCommand } from "./type-guards.js";
import type {
  AssistantActionEvent,
  CheckpointInfo,
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
  toError,
} from "./utils.js";

/**
 * This file is organized into logical sections for easier navigation.
 * Use `grep -A1 "// ====" langton-server.ts | grep "//"` to see all sections.
 */

/**
 * Client metadata stored with each WebSocket connection.
 * Provides connection tracking and activity monitoring.
 */
interface ClientData {
  connectionTime: Date;
  lastActivity: Date;
}

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
  private client: ServerWebSocket<ClientData> | null = null;
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
  private processManager: ClaudeProcessManager | null = null;
  private totalCost = 0;
  private serverStartTime: Date;
  private isShuttingDown = false;
  private isSkippingPhase = false;
  private logParser: ClaudeLogParser | null = null;
  private runId: string;
  private resultMessagePromises = new Map<
    string,
    {
      resolve: (msg: ResultMessage) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  // Checkpoint-related properties
  private checkpointGit: CheckpointGit | null = null;
  private checkpointingEnabled = true;

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
    this.runId = generateId();
  }

  // ============================================================================
  // Initialization & Server Management
  // ============================================================================

  /**
   * Wait for result message from a specific phase execution.
   */
  private waitForResultMessage(
    phaseExecutionId: string,
    timeoutMs = 60000,
  ): Promise<ResultMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.resultMessagePromises.delete(phaseExecutionId);
        reject(
          new Error(`Timeout waiting for result message from phase execution ${phaseExecutionId}`),
        );
      }, timeoutMs);

      this.resultMessagePromises.set(phaseExecutionId, {
        resolve,
        reject,
        timeout,
      });
    });
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

    // Initialize checkpoint system (checks for existing .langton)
    await this.initializeCheckpoints();

    // Check for existing lock file
    if (fs.existsSync(this.config.lockFile)) {
      const lockData = fs.readFileSync(this.config.lockFile, "utf-8");
      throw new Error(
        `Server already running (PID: ${lockData}). Remove ${this.config.lockFile} if this is incorrect.`,
      );
    }

    // Create lock file
    const lockDir = path.dirname(this.config.lockFile);
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }
    fs.writeFileSync(this.config.lockFile, process.pid.toString());

    // Load previous state from logs
    await this.loadPreviousState();

    // Start Bun WebSocket server
    this.server = Bun.serve<ClientData, undefined>({
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
    process.on("unhandledRejection", (reason, promise) => {
      this.logger.log(`Unhandled rejection at: ${promise}, reason: ${reason}`, "error");
      this.shutdown("unhandledRejection");
    });
  }

  // ============================================================================
  // WebSocket Connection Management
  // ============================================================================

  private handleConnection(ws: ServerWebSocket<ClientData>): void {
    if (this.client) {
      this.logger.log("Rejecting connection - already have a client");
      ws.close(1008, "Server already has a client");
      return;
    }

    this.logger.log("Client connected");
    const now = new Date();
    ws.data = {
      connectionTime: now,
      lastActivity: now,
    };
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

  private handleMessage(ws: ServerWebSocket<ClientData>, message: string | Buffer): void {
    try {
      ws.data.lastActivity = new Date();

      const parsed = JSON.parse(message.toString());
      if (!isValidClientCommand(parsed)) {
        this.logger.log("Invalid client command received", "error");
        return;
      }

      this.logger.logSocketTraffic(this.config.socketLogFile, "in", parsed);
      this.handleCommand(parsed);
    } catch (error) {
      this.logger.log(`Error parsing command: ${toError(error).message}`, "error");
    }
  }

  private handleClose(_ws: ServerWebSocket<ClientData>): void {
    this.logger.log("Client disconnected - shutting down server");
    this.shutdown("client disconnect");
  }

  // ============================================================================
  // Command Processing
  // ============================================================================

  async handleCommand(command: ClientCommand): Promise<void> {
    this.logger.log(`Handling command: ${command.type}`);

    switch (command.type) {
      case "phase.start": {
        if (isStartPhaseCommand(command)) {
          await this.startPhase(command.data.phaseId, command.data.skipPreCommands);
        } else {
          this.logger.log("Invalid phase.start command structure", "error");
        }
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

  // ============================================================================
  // Event & State Management
  // ============================================================================

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
      const logPath = path.join(this.config.projectPath, `.langton/logs/log-${phase.id}.jsonl`);

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

  // ============================================================================
  // Phase Execution & Management
  // ============================================================================

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
      await this.handleError(
        new Error(`Unknown phase: ${phaseId}`),
        "startPhase",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    if (this.currentPhase) {
      await this.handleError(
        new Error(`Phase already running: ${this.currentPhase.phase.id}`),
        "startPhase",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    this.logger.log(`Starting phase: ${phase.name}`);

    // Run workspace setup operations
    if (!skipPreCommands && phase.workspaceSetup) {
      this.logger.log(`Running workspace setup for phase: ${phase.name}`);
      let lastCopiedPath: string | null = null;

      for (const [index, item] of phase.workspaceSetup.entries()) {
        try {
          if (item.type === "copy" && item.copy) {
            const targetPath = path.join(this.config.projectPath, item.copy.to);
            await this.copyPath(item.copy.from, targetPath);
            lastCopiedPath = targetPath;
            this.logger.log(`Copied ${item.copy.from} to ${targetPath}`);
          } else if (item.type === "command" && item.command) {
            const workingDir =
              item.command.workingDirectory === "lastCopied" && lastCopiedPath
                ? lastCopiedPath
                : this.config.projectPath;
            await this.runCommand(item.command.run, workingDir);
            this.logger.log(`Ran command in ${workingDir}: ${item.command.run}`);
          }
        } catch (error) {
          await this.handleError(
            toError(error),
            `Workspace setup item ${index + 1}`,
            ErrorSeverity.FATAL,
          );
          return;
        }
      }
    }

    // Add checkpoint patterns for this phase
    if (phase.checkpointAndWatch && phase.checkpointAndWatch.length > 0) {
      await this.addCheckpointPatterns(phase.checkpointAndWatch);

      // Create checkpoint after workspace setup if we have workspace setup
      if (!skipPreCommands && phase.workspaceSetup && this.checkpointingEnabled) {
        await this.createCheckpoint({
          status: "workspace-setup",
          phaseId: phase.id,
          phaseName: phase.name,
          runId: this.runId,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Get previous session ID if needed
    let previousSessionId: string | null = null;

    if (phase.continueFromPrevious) {
      previousSessionId = this.getPreviousSessionId(phase.id);
      if (previousSessionId) {
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
      } else {
        this.logger.log(
          `Phase ${phase.id} requested continuation but no valid previous session found - starting fresh`,
        );

        // Send info event about starting fresh
        this.sendEvent({
          id: generateId(),
          timestamp: new Date().toISOString(),
          type: "info",
          data: {
            message: `No valid previous session found - starting phase fresh`,
          },
        } as InfoEvent);
      }
    }

    // Create phase state with dual ID system
    this.currentPhase = {
      phase,
      phaseExecutionId: generateId(), // Internal tracking ID
      sessionId: undefined, // Claude's UUID (will be set on init)
      previousSessionId: previousSessionId || undefined, // Store for phase.started event
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

    // NOTE: phase.started event is now sent when Claude sends init message
    // This ensures we have the actual session ID before notifying clients

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
    await this.startClaudeProcess(phase, previousSessionId);
  }

  private getPreviousSessionId(currentPhaseId: string): string | null {
    const currentIndex = this.config.phases.findIndex((p) => p.id === currentPhaseId);
    if (currentIndex <= 0) return null;

    const previousPhase = this.config.phases[currentIndex - 1];

    // Check log file for successful completion and extract Claude's actual session ID
    const logPath = path.join(
      this.config.projectPath,
      `.langton/logs/log-${previousPhase.id}.jsonl`,
    );

    // Only return Claude's session ID if the phase was successful
    const { success } = loadPhaseStateFromLog(logPath, this.config.costsPerMTok);
    if (success) {
      // Extract Claude's actual UUID session ID from the log
      return extractSessionIdFromLog(logPath);
    }

    return null;
  }

  // ============================================================================
  // Claude Process Management
  // ============================================================================

  /**
   * Spawn Claude CLI process for a phase using ClaudeProcessManager.
   *
   * @param phase - Phase configuration
   * @param previousSessionId - Session to continue from (if any)
   */
  private async startClaudeProcess(
    phase: PhaseConfig,
    previousSessionId: string | null,
  ): Promise<void> {
    // Create process manager
    this.processManager = new ClaudeProcessManager(
      this.config.projectPath,
      this.logger,
      this.config.anthropicBaseURL,
    );

    // Set up event handlers
    this.processManager.on("exit", (code) => {
      this.handlePhaseComplete(code);
    });

    this.processManager.on("error", (error) => {
      this.handleError(error, `Claude process for phase ${phase.id}`, ErrorSeverity.FATAL);
    });

    try {
      // Spawn process and get log path
      const logPath = await this.processManager.spawn(phase, previousSessionId);

      // Set up log parsing with delay
      setTimeout(() => {
        this.setupLogParsing(logPath, phase.id);
      }, TIMEOUTS.LOG_PARSER_DELAY_MS);
    } catch (error) {
      this.cleanupCurrentPhase();
      throw error;
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
      // Set the Claude session ID
      this.currentPhase.sessionId = msg.session_id;

      // Log the session ID update
      this.logger.log(`Claude started phase ${phaseId} with session ID: ${msg.session_id}`);

      // NOW send the phase.started event with the real session ID
      this.sendEvent({
        id: generateId(),
        timestamp: new Date().toISOString(),
        type: "phase.started",
        data: {
          phaseId: this.currentPhase.phase.id,
          phaseName: this.currentPhase.phase.name,
          phaseDescription: this.currentPhase.phase.description,
          sessionId: msg.session_id, // Use Claude's real ID
          previousSessionId: this.currentPhase.previousSessionId || undefined,
          startTime: this.currentPhase.startTime.toISOString(),
        },
      } as PhaseStartedEvent);

      // Send existing info event
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
    // Check for synthetic timeout messages first
    if (msg.message.model === "<synthetic>") {
      const content = msg.message.content;
      const textContent = Array.isArray(content)
        ? content.find((item) => item.type === "text")?.text
        : content;

      if (textContent === "API Error: Request timed out.") {
        this.logger.log(`API timeout detected in synthetic message for phase ${phaseId}`, "error");

        const timeoutError = new APITimeoutError(phaseId, {
          message: textContent,
          timestamp: new Date().toISOString(),
          synthetic: true,
        });

        // Send error event
        this.sendEvent({
          id: generateId(),
          timestamp: new Date().toISOString(),
          type: "error",
          data: {
            message: timeoutError.message,
            phase: phaseId,
            fatal: false,
            severity: timeoutError.severity,
            context: JSON.stringify(timeoutError.context),
          },
        } as ErrorEvent);

        // Process manager will handle the cleanup
        if (this.processManager) {
          this.processManager.kill();
        }

        return; // Stop processing
      }
    }

    if (msg.message.usage) {
      const usage: TokenUsage = {
        inputTokens: msg.message.usage.input_tokens || 0,
        outputTokens: msg.message.usage.output_tokens || 0,
        cacheCreationTokens: msg.message.usage.cache_creation_input_tokens || 0,
        cacheReadTokens: msg.message.usage.cache_read_input_tokens || 0,
      };

      const messageCost = calculateCost(usage, this.config.costsPerMTok);

      if (this.currentPhase) {
        // Claude reports per-call costs, so we accumulate them
        this.currentPhase.phaseCost += messageCost;

        // Update token counts (these are cumulative per message)
        this.currentPhase.phaseTokens.inputTokens += usage.inputTokens;
        this.currentPhase.phaseTokens.outputTokens += usage.outputTokens;
        this.currentPhase.phaseTokens.cacheCreationTokens += usage.cacheCreationTokens;
        this.currentPhase.phaseTokens.cacheReadTokens += usage.cacheReadTokens;

        this.logger.log(
          `Phase ${phaseId} token update - Call cost: $${messageCost.toFixed(
            4,
          )}, Running total: $${this.currentPhase.phaseCost.toFixed(4)} ` +
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

        // Check for API timeout error
        if (textItem.text === "API Error: Request timed out.") {
          this.logger.log(`API timeout detected in phase ${phaseId}`, "error");

          // Immediately handle the timeout error
          const timeoutError = new APITimeoutError(phaseId, {
            message: textItem.text,
            timestamp: new Date().toISOString(),
          });

          // Send error event
          this.sendEvent({
            id: generateId(),
            timestamp: new Date().toISOString(),
            type: "error",
            data: {
              message: timeoutError.message,
              phase: phaseId,
              fatal: false,
              severity: timeoutError.severity,
              context: JSON.stringify(timeoutError.context),
            },
          } as ErrorEvent);

          // Process manager will handle the cleanup
          if (this.processManager) {
            this.processManager.kill();
          }

          return; // Stop processing further messages
        }

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
        const fileTools: ToolName[] = ["Read", "Write", "Edit", "MultiEdit"];
        if (fileTools.includes(toolItem.name as ToolName)) {
          // Call async function without awaiting to avoid blocking
          this.handleFileToolCall(toolItem.name as ToolName, toolItem.input).catch((err) => {
            this.handleError(
              toError(err),
              `handleFileToolCall(${toolItem.name})`,
              ErrorSeverity.OPERATION,
            );
          });
        }

        // Send event for all tools, including unknown ones
        // toolName is typed as string to allow unknown tools
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

    // Resolve any waiting promise using phaseExecutionId
    const executionId = this.currentPhase?.phaseExecutionId;
    if (executionId) {
      const promise = this.resultMessagePromises.get(executionId);
      if (promise) {
        clearTimeout(promise.timeout);
        this.resultMessagePromises.delete(executionId);
        promise.resolve(msg);
      }
    }

    // Check for API timeout in result (can be error subtype OR success with is_error=true)
    if (msg.result === "API Error: Request timed out." && msg.is_error) {
      this.logger.log(`API timeout detected in result message for phase ${phaseId}`, "error");

      const timeoutError = new APITimeoutError(phaseId, {
        message: msg.result,
        timestamp: new Date().toISOString(),
        is_error: msg.is_error,
        duration_ms: msg.duration_ms,
        duration_api_ms: msg.duration_api_ms,
      });

      // Send error event
      this.sendEvent({
        id: generateId(),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: timeoutError.message,
          phase: phaseId,
          fatal: false,
          severity: timeoutError.severity,
          context: JSON.stringify(timeoutError.context),
        },
      } as ErrorEvent);
    }

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

        // The result message contains the final cumulative cost for the entire phase
        const finalCost = msg.total_cost_usd || calculateCost(finalUsage, this.config.costsPerMTok);

        // Log if there's a discrepancy between our accumulated cost and Claude's final cost
        const accumulatedCost = this.currentPhase.phaseCost;
        if (Math.abs(accumulatedCost - finalCost) > 0.0001) {
          this.logger.log(
            `Phase ${phaseId} cost discrepancy - Accumulated: $${accumulatedCost.toFixed(4)}, ` +
              `Final: $${finalCost.toFixed(4)} (using final)`,
          );
        }

        // Use Claude's final cost as the authoritative value
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

  private async handlePhaseComplete(exitCode: number): Promise<void> {
    if (!this.currentPhase) return;

    // Capture all phase information immediately to avoid race conditions
    const phaseSnapshot = {
      phase: { ...this.currentPhase.phase },
      phaseExecutionId: this.currentPhase.phaseExecutionId, // Internal tracking
      sessionId: this.currentPhase.sessionId, // Claude's UUID (may be null if failed early)
      previousSessionId: this.currentPhase.previousSessionId,
      startTime: this.currentPhase.startTime,
      phaseCost: this.currentPhase.phaseCost,
      phaseTokens: { ...this.currentPhase.phaseTokens },
      isSkipping: this.isSkippingPhase,
    };

    // Only wait for result message if phase wasn't skipped and we're not shutting down
    if (!phaseSnapshot.isSkipping && exitCode === 0 && !this.isShuttingDown) {
      try {
        // Wait for result message with 30 second timeout
        const resultMsg = await this.waitForResultMessage(
          phaseSnapshot.phaseExecutionId,
          TIMEOUTS.RESULT_MESSAGE_MS,
        );

        // Update costs from result message
        if (resultMsg.usage) {
          phaseSnapshot.phaseTokens = {
            inputTokens: resultMsg.usage.input_tokens || 0,
            outputTokens: resultMsg.usage.output_tokens || 0,
            cacheCreationTokens: resultMsg.usage.cache_creation_input_tokens || 0,
            cacheReadTokens: resultMsg.usage.cache_read_input_tokens || 0,
          };
          phaseSnapshot.phaseCost =
            resultMsg.total_cost_usd ||
            calculateCost(phaseSnapshot.phaseTokens, this.config.costsPerMTok);
        }
      } catch (error) {
        // Log timeout but continue
        this.logger.log(
          `Result message timeout for phase ${phaseSnapshot.phase.id}: ${error}`,
          "info",
        );
      }
    }

    // Process completion with the captured snapshot
    const duration = Date.now() - phaseSnapshot.startTime.getTime();
    // Phase is only successful if it exited cleanly AND we're not shutting down
    const success = exitCode === 0 && !this.isShuttingDown;
    const phaseCost = phaseSnapshot.phaseCost;

    // Add to completed phases (even if skipped, to track progress)
    if ((success || phaseSnapshot.isSkipping) && phaseSnapshot.sessionId) {
      this.completedPhases.push({
        phaseId: phaseSnapshot.phase.id,
        sessionId: phaseSnapshot.sessionId,
        success,
        cost: phaseCost,
        duration,
        completedAt: new Date(),
      });

      // Create checkpoint for phase completion
      if (this.checkpointingEnabled) {
        const status = phaseSnapshot.isSkipping ? "skipped" : "completed";
        await this.createCheckpoint({
          status,
          phaseId: phaseSnapshot.phase.id,
          phaseName: phaseSnapshot.phase.name,
          runId: this.runId,
          timestamp: new Date().toISOString(),
          duration,
        });
      }

      // Recalculate total cost from all completed phases
      this.totalCost = this.completedPhases.reduce((sum, phase) => sum + phase.cost, 0);

      this.logger.log(
        `Phase ${phaseSnapshot.phase.id} ${
          success ? "completed" : "skipped"
        } - Cost: $${phaseCost.toFixed(4)}, ` + `Total project cost: $${this.totalCost.toFixed(4)}`,
      );
    }

    this.sendEvent({
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: "phase.completed",
      data: {
        phaseId: phaseSnapshot.phase.id,
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
      if (phaseSnapshot.isSkipping) {
        // Phase was skipped, not failed - continue to next phase
        this.logger.log("Phase was skipped, continuing to next phase");
        this.isSkippingPhase = false;
        // Small delay to ensure cleanup completes
        await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.PHASE_CLEANUP_DELAY_MS));
        await this.autoStartNextPhase();
      } else {
        // Create error checkpoint before shutdown
        if (this.checkpointingEnabled) {
          await this.createCheckpoint({
            status: "error",
            phaseId: phaseSnapshot.phase.id,
            phaseName: phaseSnapshot.phase.name,
            runId: this.runId,
            timestamp: new Date().toISOString(),
            duration,
          });
        }
        await this.handleError(
          new Error(`Phase failed with exit code ${exitCode}`),
          `phase ${phaseSnapshot.phase.id}`,
          ErrorSeverity.FATAL,
        );
      }
    } else if (success && !this.isShuttingDown) {
      // Auto-continue to next phase after a short delay
      // Small delay to ensure cleanup completes
      await new Promise((resolve) => setTimeout(resolve, TIMEOUTS.PHASE_CLEANUP_DELAY_MS));
      await this.autoStartNextPhase();
    }
  }

  // ============================================================================
  // File Operations & Watching
  // ============================================================================

  private async handleFileToolCall<T extends ToolName>(
    toolName: T,
    toolInput: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (!this.watchedPattern) return;

    let filePath: string | null = null;
    let action: "created" | "modified" | "deleted" = "modified";
    let content = "";

    // Type-safe tool input handling
    switch (toolName) {
      case "Read": {
        const input = toolInput as ToolInputMap["Read"] | undefined;
        filePath = input?.file_path || null;
        action = "modified"; // Read doesn't change the file
        break;
      }
      case "Write": {
        const input = toolInput as ToolInputMap["Write"] | undefined;
        filePath = input?.file_path || null;
        content = input?.content || "";
        if (filePath) {
          action = fs.existsSync(path.join(this.config.projectPath, filePath))
            ? "modified"
            : "created";
        }
        break;
      }
      case "Edit": {
        const input = toolInput as ToolInputMap["Edit"] | undefined;
        filePath = input?.file_path || null;
        action = "modified";
        break;
      }
      case "MultiEdit": {
        const input = toolInput as ToolInputMap["MultiEdit"] | undefined;
        filePath = input?.file_path || null;
        action = "modified";
        break;
      }
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
          this.logger.log(`Error reading file ${filePath}: ${toError(error).message}`, "error");
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

  // ============================================================================
  // Error Handling
  // ============================================================================

  /**
   * Handle errors with appropriate severity and client notification.
   */
  private async handleError(
    error: Error,
    context: string,
    severity: ErrorSeverity = ErrorSeverity.OPERATION,
  ): Promise<void> {
    // Always log
    this.logger.log(
      `[${severity}] ${context}: ${error.message}`,
      severity === ErrorSeverity.FATAL ? "error" : "info",
    );

    // Always send to client
    this.sendEvent({
      id: generateId(),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: error.message,
        context,
        severity,
        phase: this.currentPhase?.phase.id,
        fatal: severity === ErrorSeverity.FATAL,
      },
    } as ErrorEvent);

    // Handle based on severity
    switch (severity) {
      case ErrorSeverity.FATAL:
        await this.shutdown(`Fatal error: ${context}`);
        break;
      case ErrorSeverity.PHASE:
        this.cleanupCurrentPhase();
        break;
      // OPERATION and WARNING just log and notify
    }
  }

  // ============================================================================
  // Phase Status & Control
  // ============================================================================

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
    const logPath = path.join(this.config.projectPath, `.langton/logs/log-${nextPhase.id}.jsonl`);

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
      await this.handleError(
        new Error("Cannot start next phase while current phase is running"),
        "startNextPhase",
        ErrorSeverity.OPERATION,
      );
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
      await this.handleError(
        new Error("No more phases to run"),
        "startNextPhase",
        ErrorSeverity.OPERATION,
      );
    }
  }

  private async skipCurrentPhase(): Promise<void> {
    if (!this.currentPhase) {
      await this.handleError(
        new Error("No phase is currently running"),
        "skipCurrentPhase",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    this.logger.log(`Skipping phase ${this.currentPhase.phase.id}`);
    this.isSkippingPhase = true;

    if (this.processManager) {
      await this.processManager.kill("SIGTERM");
    }
  }

  private async redoCurrentPhase(): Promise<void> {
    if (this.currentPhase) {
      await this.handleError(
        new Error("Cannot redo while phase is running"),
        "redoCurrentPhase",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    const lastPhase = this.completedPhases[this.completedPhases.length - 1];
    if (lastPhase) {
      await this.startPhase(lastPhase.phaseId);
    }
  }

  // ============================================================================
  // Utility & Helper Methods
  // ============================================================================

  private cleanupCurrentPhase(): void {
    if (this.logParser) {
      this.logParser.stop();
      this.logParser = null;
    }

    if (this.processManager) {
      this.processManager.removeAllListeners();
      // Ensure log stream is closed
      this.processManager
        .closeLogStream()
        .catch((err) => this.logger.log(`Error closing log stream: ${err}`, "error"));
      this.processManager = null;
    }

    // Clean up any pending result message promises
    const executionId = this.currentPhase?.phaseExecutionId;
    if (executionId && this.resultMessagePromises.has(executionId)) {
      const promise = this.resultMessagePromises.get(executionId);
      if (promise) {
        clearTimeout(promise.timeout);
        promise.reject(new Error("Phase cleanup - result message promise cancelled"));
        this.resultMessagePromises.delete(executionId);
      }
    }

    this.watchedPattern = null;
    this.recentFileAccess = null;
    this.currentPhase = null;
  }

  private async runCommand(command: string, workingDir?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, {
        shell: true,
        cwd: workingDir || this.config.projectPath,
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

  private async copyPath(from: string, to: string): Promise<void> {
    // Check if source exists
    const sourceStats = await fs.promises.stat(from).catch(() => null);
    if (!sourceStats) {
      throw new Error(`Source path does not exist: ${from}`);
    }

    // Check if target parent directory exists
    const targetParent = path.dirname(to);
    const parentStats = await fs.promises.stat(targetParent).catch(() => null);
    if (!parentStats || !parentStats.isDirectory()) {
      throw new Error(`Target parent directory does not exist: ${targetParent}`);
    }

    // Check if target already exists
    const targetStats = await fs.promises.stat(to).catch(() => null);
    if (targetStats) {
      throw new Error(`Target path already exists: ${to}`);
    }

    // Copy using cp command with recursive flag
    const cpCommand = `cp -r ${escapeShellArg(from)} ${escapeShellArg(to)}`;
    await this.runCommand(cpCommand);
  }

  // ============================================================================
  // Checkpoint Methods
  // ============================================================================

  /**
   * Initialize checkpoint system - check git availability
   */
  private async initializeCheckpoints(): Promise<void> {
    // Check if git is available
    if (!(await this.isGitAvailable())) {
      this.logger.log("Git is not available. Checkpointing disabled.", "info");
      this.checkpointingEnabled = false;
      return;
    }

    this.logger.log("Checkpoint system initialized");
  }

  /**
   * Check if git command is available using spawn for consistency
   */
  private async isGitAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("git", ["--version"], {
        stdio: "ignore",
      });

      proc.on("error", () => resolve(false));
      proc.on("exit", (code) => resolve(code === 0));
    });
  }

  /**
   * Add checkpoint patterns for a phase (cumulative)
   */
  private async addCheckpointPatterns(patterns: string[]): Promise<void> {
    if (!this.checkpointingEnabled || patterns.length === 0) return;

    // Initialize repository on first tracked patterns
    if (!this.checkpointGit) {
      this.checkpointGit = new CheckpointGit(this.config.projectPath, this.logger);
      await this.checkpointGit.initialize();
    }

    // Add new patterns
    await this.checkpointGit.addPatterns(patterns);
    this.logger.log(`Added checkpoint patterns: ${patterns.join(", ")}`);
  }

  /**
   * Create a checkpoint commit
   */
  private async createCheckpoint(info: CheckpointInfo): Promise<void> {
    if (!this.checkpointingEnabled || !this.checkpointGit) return;

    try {
      // Format commit message
      const firstLine = `${info.status}:${info.phaseId} [run:${info.runId}] ${info.phaseName}`;
      const body = [
        "",
        `Phase: ${info.phaseName}`,
        `Status: ${info.status}`,
        `Timestamp: ${info.timestamp}`,
      ];

      if (info.duration !== undefined) {
        body.push(`Duration: ${info.duration}ms`);
      }

      const commitMessage = `${firstLine}\n${body.join("\n")}`;

      // Determine if we need to create a branch
      const shouldBranch = info.status === "error" || info.status === "exit";
      const branchName = shouldBranch
        ? info.status === "error"
          ? `error/${info.phaseId}/${Date.now()}`
          : `exit/${Date.now()}`
        : undefined;

      // Create checkpoint (allow empty commits for skipped phases)
      const allowEmpty = info.status === "skipped";
      const commitHash = await this.checkpointGit.commit(commitMessage, {
        branch: branchName,
        allowEmpty,
      });

      if (commitHash) {
        this.logger.log(`Created checkpoint: ${commitHash} (${info.status})`);
      }
    } catch (error) {
      // Handle disk full or other git errors
      this.logger.log(
        `Checkpoint failed: ${toError(error).message}. ` +
          "Disabling checkpointing for this session.",
        "error",
      );
      this.checkpointingEnabled = false;
    }
  }

  // ============================================================================
  // Shutdown & Cleanup
  // ============================================================================

  async shutdown(reason: string): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.log(`Shutdown already in progress, ignoring: ${reason}`);
      return;
    }
    this.logger.log(`Shutting down server: ${reason}`);

    // Kill any running process immediately before setting shutdown flag
    if (this.processManager && this.currentPhase) {
      this.logger.log("Killing current Claude process for shutdown");
      await this.processManager.kill("SIGTERM");
    }

    this.isShuttingDown = true;

    // Create exit checkpoint if not shutting down normally (all phases completed)
    if (reason !== "all phases completed" && this.checkpointingEnabled && this.currentPhase) {
      await this.createCheckpoint({
        status: "exit",
        phaseId: this.currentPhase.phase.id,
        phaseName: this.currentPhase.phase.name,
        runId: this.runId,
        timestamp: new Date().toISOString(),
      });
    }

    this.cleanupCurrentPhase();

    // Clean up all pending result message promises
    for (const promise of this.resultMessagePromises.values()) {
      clearTimeout(promise.timeout);
      promise.reject(new Error("Server shutdown - result message promise cancelled"));
    }
    this.resultMessagePromises.clear();

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

    // Ensure lock file is really gone before delay
    try {
      if (fs.existsSync(this.config.lockFile)) {
        fs.unlinkSync(this.config.lockFile);
      }
    } catch {
      // Ignore errors on second attempt
    }

    // Small delay to ensure log is written
    setTimeout(() => {
      process.exit(0);
    }, TIMEOUTS.PHASE_CLEANUP_DELAY_MS);
  }
}
