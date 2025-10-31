import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { minimatch } from "minimatch";
import { CheckpointGit } from "./checkpoint-git.js";
import { ClaudeLogParser } from "./claude-log-parser.js";
import { ClaudeProcessManager } from "./claude-process-manager.js";
import { type ClientCommand, clientCommandSchema } from "./command-schemas.js";
import { calculateCost, DEFAULT_CONFIG, TIMEOUTS } from "./config.js";
import { EventJournal } from "./event-journal.js";
import {
  analyzeExecutionThread,
  findContinuationSessionId,
} from "./execution-thread.js";
import { fileResolver } from "./file-resolver.js";
import { BunProxyRunner } from "./llm-proxy.js";
// Import event types from new schema file
import type {
  AssistantActionEvent,
  ErrorEvent,
  FileTreeUpdatedEvent,
  FileUpdatedEvent,
  HistoryBatchEvent,
  InfoEvent,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  PongEvent,
  ServerEvent,
  ServerReadyEvent,
  StateSnapshotEvent,
  TokenUsageEvent,
} from "./schemas/event-schemas.js";
import {
  isConnectionStateEvent,
  isServerStateEvent,
} from "./schemas/event-schemas.js";
import { StateManager } from "./state-manager.js";
import { FileEventStorage } from "./storage/file-event-storage.js";
import {
  type ServerInternalEvents,
  TypedEventEmitter,
} from "./typed-event-emitter.js";
import { EventId, PhaseId, RunId, SessionId } from "./types/branded-types.js";
import type {
  AssistantMessage,
  ResultMessage,
  SystemMessage,
  TextContent,
  ThinkingContent,
  ToolResultContent,
  ToolUseContent,
  UserMessage,
} from "./types/claude-session-schema.js";
import { APITimeoutError, ErrorSeverity } from "./types/error-types.js";
import {
  isTerminalPhaseStatus,
  type PhaseExecution,
  type PhaseStatus,
} from "./types/state-types.js";
import type { ToolInputMap, ToolName } from "./types/tool-types.js";
import type {
  CheckpointInfo,
  ClaudeLogMessage,
  ClientData,
  FailureReason,
  HandshakeRequest,
  HandshakeResponse,
  PhaseConfig,
  ServerConfig,
  ShellCommand,
  TokenUsage,
  WorkspaceShellCommand,
} from "./types/types.js";
// Import remaining types from old file
import { ClientMode, isSyntheticTimeout } from "./types/types.js";
import {
  assertNever,
  buildFileTree,
  copyFiles,
  escapeShellArg,
  generateId,
  Logger,
  toError,
} from "./utils.js";

/**
 * This file is organized into logical sections for easier navigation.
 * Use `grep -A1 "// ====" tadpole-server.ts | grep "//"` to see all sections.
 */

/**
 * Main server class that orchestrates Claude phases.
 *
 * Responsibilities:
 * - WebSocket server management (multiple clients)
 * - Phase execution and lifecycle
 * - Claude process management
 * - File watching and change detection
 * - State persistence and recovery
 * - Cost tracking and reporting
 * - Event streaming to clients
 */
export class TadpoleServer extends TypedEventEmitter<ServerInternalEvents> {
  private server: Server | null = null;
  private clients: Map<string, ServerWebSocket<ClientData>> = new Map();
  public readonly config: ServerConfig;
  private logger: Logger;

  // Proxy server
  private proxyRunner: BunProxyRunner | null = null;

  // State management
  private stateManager: StateManager;
  private currentRunId: RunId | null = null;
  private heartbeatInterval?: NodeJS.Timeout;

  // Event Journal for multi-client support
  private eventJournal: EventJournal;
  private eventJournalAppendQueue: Promise<void> = Promise.resolve();

  // Track pending tool uses for result matching
  private pendingToolUses: Map<
    string,
    {
      toolName: string;
      timestamp: number;
      phaseId: string;
    }
  > = new Map();

  // Temporary state during phase execution
  private watchedPatterns: string[] = [];
  private currentPhase:
    | {
        status: "initializing" | "running";
        phase: PhaseConfig;
        previousSessionId?: SessionId;
        sessionId?: SessionId;
        startTime: Date;
        phaseCost: number;
        phaseTokens: TokenUsage;
      }
    | undefined;
  private recentFileAccess:
    | {
        path: string;
        content: string;
        timestamp: Date;
      }
    | undefined;
  private processManager: ClaudeProcessManager | undefined;
  private serverStartTime: Date;
  private isShuttingDown = false;
  private isSkippingPhase = false;
  private logParser: ClaudeLogParser | null = null;

  // Checkpoint-related properties
  private checkpointGit: CheckpointGit | null = null;
  private checkpointingEnabled = true;

  // Failure tracking
  private phaseFailureReason?: FailureReason;
  private isForceStopping = false;
  private resultMessageReceived = false;

  // Rollback state
  private isRollingBack = false;
  private readonly READ_ONLY_COMMANDS = new Set([
    "checkpoint.list",
    "server.shutdown", // Special case - always allowed
    "ping",
    "history.sync", // Read-only history pagination
  ]);

  constructor(
    config: Omit<ServerConfig, keyof typeof DEFAULT_CONFIG> &
      Partial<Pick<ServerConfig, keyof typeof DEFAULT_CONFIG>> & {
        phases: PhaseConfig[];
      }
  ) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    } as ServerConfig;

    // Update logger to use execution path
    this.logger = new Logger(
      path.join(this.config.executionPath, this.config.serverLogFile)
    );
    this.serverStartTime = new Date();

    // Initialize state manager with execution path
    const tadpoleDir = path.join(this.config.executionPath, ".tadpole");
    this.stateManager = new StateManager(
      tadpoleDir,
      this.logger,
      this.config.phases
    );

    // Initialize Event Journal with file-based storage
    this.eventJournal = new EventJournal(
      new FileEventStorage(path.join(tadpoleDir, "events"))
    );

    // Set up state manager listeners
    this.setupStateManagerListeners();
  }

  private setupStateManagerListeners(): void {
    this.stateManager.on("phaseRunning", (data) => {
      // State is already saved when we get here
      const phase = this.stateManager.getCurrentlyRunningPhase();
      if (phase && "claudeSessionId" in phase) {
        const phaseConfig = this.config.phases.find(
          (p) => p.id === data.phaseId
        );
        if (phaseConfig) {
          this.emit("event", {
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "phase.started",
            data: {
              phaseId: data.phaseId,
              phaseName: phaseConfig.name,
              phaseDescription: phaseConfig.description,
              sessionId: phase.claudeSessionId,
              previousSessionId:
                "previousSessionId" in phase
                  ? phase.previousSessionId
                  : undefined,
              startTime: phase.startTime,
            },
          } as PhaseStartedEvent);
        }
      }
    });

    // Listen to all state transitions and journal them
    this.stateManager.on("stateChanged", (transition) => {
      this.emitStateTransitionEvent(transition);
    });

    this.stateManager.on("transitionError", ({ event: _event, error }) => {
      if (error.name === "PersistenceError") {
        // Can't save state - this is fatal
        this.handleError(error, "state-persistence", ErrorSeverity.FATAL);
      }
    });
  }

  /**
   * Convert a state transition to a server event and emit it for journaling.
   * This provides an audit trail of all state machine transitions.
   */
  private emitStateTransitionEvent(
    transition: import("./types/state-types.js").StateTransition
  ): void {
    // Extract relevant IDs from transition data
    let runId: string | undefined;
    let phaseId: string | undefined;

    if ("runId" in transition.data) {
      runId = transition.data.runId as string;
    }
    if ("phaseId" in transition.data) {
      phaseId = transition.data.phaseId as string;
    }

    const stateTransitionEvent: import("./schemas/event-schemas.js").StateTransitionEvent =
      {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "state.transition",
        data: {
          transitionType: transition.type,
          runId,
          phaseId,
          transition: {
            type: transition.type,
            data: transition.data as Record<string, unknown>,
          },
          resultingState: {
            currentRunId: this.stateManager.getState().currentRunId,
            runCount: this.stateManager.getState().runs.length,
            totalCost: this.stateManager.getTotalCost(),
            currentRunCost: this.stateManager.getCurrentRunCost(),
          },
        },
      };

    // Emit as a server state event - will be journaled but NOT sent to clients
    this.emit("event", stateTransitionEvent);
  }

  // ============================================================================
  // Initialization & Server Management
  // ============================================================================

  /**
   * Check if a process with the given PID is running.
   * Uses process.kill(pid, 0) which doesn't actually send a signal but checks if the process exists.
   *
   * @param pid - Process ID to check
   * @returns true if the process is running, false otherwise
   */
  private isProcessRunning(pid: number): boolean {
    try {
      // Signal 0 doesn't kill the process, just checks if it exists
      process.kill(pid, 0);
      return true;
    } catch {
      // ESRCH error means the process doesn't exist
      return false;
    }
  }

  /**
   * Initialize and start the WebSocket server.
   *
   * Steps:
   * 1. Check for existing lock file (prevent multiple instances)
   * 2. Create lock file with current PID
   * 3. Initialize state manager
   * 4. Start WebSocket server on configured port
   * 5. Set up process termination handlers
   *
   * @throws Error if server is already running
   */
  async start(): Promise<void> {
    this.logger.log(
      `Starting Tadpole Server v${this.config.version} in ${this.config.executionPath}`
    );

    // Start proxy server first (if not disabled)
    if (!this.config.withoutProxy) {
      const proxyPort = this.config.port + 1;
      this.logger.log(`Starting proxy server on port ${proxyPort}`);
      this.proxyRunner = new BunProxyRunner(
        "passthrough",
        proxyPort,
        this.config.anthropicBaseURL || "https://api.anthropic.com",
        this.logger
      );
      this.proxyRunner.start();
    } else {
      this.logger.log("Proxy server disabled");
    }

    // Initialize checkpoint system (checks for existing .tadpole)
    await this.initializeCheckpoints();

    // Initialize state manager
    await this.stateManager.initialize();

    // Initialize event journal
    await this.eventJournal.initialize();

    // Check for existing lock file
    if (fs.existsSync(this.config.lockFile)) {
      const lockData = fs.readFileSync(this.config.lockFile, "utf-8");

      // Parse lock file for enhanced data
      try {
        const lockInfo = JSON.parse(lockData);
        const heartbeatAge =
          Date.now() - new Date(lockInfo.lastHeartbeat).getTime();

        // First check if the process is actually running
        const processRunning = this.isProcessRunning(lockInfo.pid);

        if (!processRunning) {
          // Process is not running - this is a crash regardless of heartbeat age
          this.logger.log(
            `Found lock file from dead process (PID: ${lockInfo.pid}), removing...`
          );
          fs.unlinkSync(this.config.lockFile);

          // Mark the run as crashed
          if (lockInfo.runId) {
            this.stateManager.transition({
              type: "RunCrashed",
              data: {
                runId: RunId(lockInfo.runId),
                detectedAt: new Date().toISOString(),
                lastPhaseStatus: "unknown" as PhaseStatus,
              },
            });
          }
        } else if (heartbeatAge > 120000) {
          // Process is running but heartbeat is stale (> 2 minutes)
          this.logger.log(
            `Found stale lock file (heartbeat age: ${heartbeatAge}ms), removing...`
          );
          fs.unlinkSync(this.config.lockFile);

          // Mark the run as crashed
          if (lockInfo.runId) {
            this.stateManager.transition({
              type: "RunCrashed",
              data: {
                runId: RunId(lockInfo.runId),
                detectedAt: new Date().toISOString(),
                lastPhaseStatus: "unknown" as PhaseStatus,
              },
            });
          }
        } else {
          // Process is running and heartbeat is recent - check if it's our current run
          const state = this.stateManager.getState();
          if (state.currentRunId && state.currentRunId === lockInfo.runId) {
            // We're recovering from a crash - continue the same run
            // TODO: This needs a lot more implementation to properly continue, but not implemented yet.
            this.currentRunId = RunId(lockInfo.runId);
            this.logger.log(`Recovering run ${this.currentRunId}`);
          } else {
            throw new Error(
              `Server already running (PID: ${lockInfo.pid}, Run: ${lockInfo.runId})`
            );
          }
        }
      } catch (_e) {
        // Old format lock file - just PID
        throw new Error(
          `Server already running (PID: ${lockData}). Remove ${this.config.lockFile} if this is incorrect.`
        );
      }
    }

    const thread = await this.stateManager.getExecutionThread();

    if (thread?.failed) {
      // let see if execution thread from state manager has previously failed
      this.logger.log("Execution thread failed, rolling back...", "error");
      await this.rollbackToLastSuccess(this.config.autostart);
    }

    // Start a new run if needed
    if (!thread?.failed && !this.currentRunId) {
      await this.startNewRun();

      // Now switch to the new run's branch if we have checkpoints
      const currentRun = this.stateManager.getCurrentRun();
      if (currentRun?.gitBranch && this.checkpointGit) {
        // For fresh runs, the branch doesn't exist yet - it will be created on first checkpoint
        // Check if this is a fresh run to avoid unnecessary warnings
        const isFreshRun = currentRun.startingConditions?.type === "fresh";
        if (!isFreshRun) {
          try {
            await this.checkpointGit.switchToBranch(currentRun.gitBranch);
          } catch (error) {
            this.logger.log(
              `Failed to switch to run branch: ${error}`,
              "error"
            );
          }
        } else {
          this.logger.log(
            `Fresh run ${currentRun.runId} - branch will be created on first checkpoint`
          );
        }
      }
    }

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
      this.logger.log(
        `Unhandled rejection at: ${promise}, reason: ${reason}`,
        "error"
      );
      this.shutdown("unhandledRejection");
    });
  }

  // ============================================================================
  // WebSocket Connection Management
  // ============================================================================

  private handleConnection(ws: ServerWebSocket<ClientData>): void {
    const clientId = generateId();
    this.logger.log(`Client ${clientId} connected`);

    const now = new Date();
    ws.data = {
      id: clientId,
      connectionTime: now,
      lastActivity: now,
      handshakeComplete: false,
    };

    this.clients.set(clientId, ws);

    // Wait for handshake before sending events
    // Handshake will send initial state and handle autostart
    this.logger.log(`Client ${clientId} waiting for handshake`);
  }

  private async handleHandshake(
    ws: ServerWebSocket<ClientData>,
    request: HandshakeRequest
  ): Promise<void> {
    const { mode, sendPreviousEvents = false } = request.data;

    // Use server-assigned client ID
    const clientId = ws.data.id;

    // Grant the requested mode (no restrictions)
    const grantedMode = mode;
    this.logger.log(`Client ${clientId} granted ${grantedMode} access`);

    // Update client data
    ws.data = {
      ...ws.data,
      id: clientId,
      mode: grantedMode,
      handshakeComplete: true,
    };

    // Get event history from journal for client synchronization
    // TODO: figure out if we want to send the most recent batch here
    // or send things chronologically from the start
    const {
      events: recentEvents,
      totalEvents,
      hasMore,
    } = sendPreviousEvents
      ? await this.eventJournal.getMostRecentEvents(
          this.config.handshakeHistoryLimit
        )
      : {
          events: [],
          totalEvents: await this.eventJournal.getTotalEvents(),
          hasMore: false,
        };

    this.logger.log(
      `Sending ${recentEvents.length} events (of ${totalEvents} total) to client ${clientId}` +
        (sendPreviousEvents ? " (limited history)" : " (no history)") +
        (hasMore ? " with additional history available via download" : "")
    );

    // Send handshake response
    const response: HandshakeResponse = {
      type: "handshake.response",
      data: {
        clientId,
        mode: grantedMode,
        eventHistory: recentEvents,
        totalEvents: totalEvents,
      },
    };

    ws.send(JSON.stringify(response));
    this.logger.log(
      `Handshake complete for client ${clientId} (${grantedMode})`
    );

    // Send initial events now that handshake is complete
    const serverReadyEvent: ServerReadyEvent = {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "server.ready",
      data: {
        serverVersion: this.config.version,
        executionPath: this.config.executionPath,
        dataPath: this.config.dataPathInExecutionDir,
      },
    };

    // server.ready is a connection state event - send to client only, don't journal
    this.emit("event", serverReadyEvent, ws);

    // Handle autostart logic (only if this is the first write client)
    if (this.config.autostart) {
      this.autoStartNextPhase();
    } else {
      const serverIdleEvent = {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "server.idle",
        data: {
          reason: "startup",
          message: "Server ready. Waiting for commands (autostart disabled).",
        },
      } as import("./types/types.js").ServerIdleEvent;

      // server.idle is a server state event - journal and broadcast to all clients
      this.emit("event", serverIdleEvent);
    }
  }

  private handleMessage(
    ws: ServerWebSocket<ClientData>,
    message: string | Buffer
  ): void {
    try {
      ws.data.lastActivity = new Date();

      const parsed = JSON.parse(message.toString());

      // Check for handshake first
      if (parsed.type === "handshake") {
        this.handleHandshake(ws, parsed as HandshakeRequest);
        return;
      }

      // Require handshake completion for all other messages
      if (!ws.data.handshakeComplete) {
        this.emit(
          "event",
          {
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "error",
            data: {
              message: "Handshake required before sending commands",
              fatal: false,
            },
          } as ErrorEvent,
          ws
        );
        return;
      }

      const result = clientCommandSchema.safeParse(parsed);

      if (!result.success) {
        this.logger.log(
          `Invalid client command: ${result.error.message}`,
          "error"
        );
        this.emit(
          "event",
          {
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "error",
            data: {
              message: "Invalid command format",
              fatal: false,
            },
          } as ErrorEvent,
          ws
        );
        return;
      }
      this.handleCommand(result.data, ws);
    } catch (error) {
      this.logger.log(
        `Error parsing command: ${toError(error).message}`,
        "error"
      );
    }
  }

  private handleClose(ws: ServerWebSocket<ClientData>): void {
    const clientId = ws.data.id;
    this.logger.log(`Client ${clientId} disconnected`);

    // Remove client from the map
    this.clients.delete(clientId);

    // For now, keep server running even with no clients (test expects this)
    // In future, this could be configurable behavior
  }

  // ============================================================================
  // Command Processing
  // ============================================================================

  private async handleCommand(
    command: ClientCommand,
    sender: ServerWebSocket<ClientData>
  ): Promise<void> {
    this.logger.log(`Handling command: ${command.type}`);

    // Check if command is blocked during rollback
    if (this.isRollingBack && !this.READ_ONLY_COMMANDS.has(command.type)) {
      this.logger.log(
        `Client ${sender.data.id} attempted state-modifying command while rollback is in progress`,
        "error"
      );
      this.emit(
        "event",
        {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "error",
          data: {
            message:
              "Cannot execute state-modifying commands while rollback is in progress",
            context: `Attempted command: ${command.type}`,
            phase: this.currentPhase?.phase.id,
            fatal: false,
            severity: ErrorSeverity.OPERATION,
            code: "ROLLBACK_IN_PROGRESS",
          },
        } as ErrorEvent,
        sender
      );
      return;
    }

    // Check if sender has permission for state-modifying commands
    if (!this.READ_ONLY_COMMANDS.has(command.type)) {
      // This is a state-modifying command
      if (!sender.data.handshakeComplete) {
        this.logger.log(
          `Client ${sender.data.id} attempted state-modifying command without handshake`,
          "error"
        );
        this.emit(
          "event",
          {
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "error",
            data: {
              message:
                "Cannot execute state-modifying commands without handshake",
              context: `Attempted command: ${command.type}`,
              phase: this.currentPhase?.phase.id,
              fatal: false,
              severity: ErrorSeverity.OPERATION,
              code: "HANDSHAKE_REQUIRED",
            },
          } as ErrorEvent,
          sender
        );
        return;
      }

      // Check if sender has read-write mode
      if (sender.data.mode === ClientMode.READONLY) {
        this.logger.log(
          `Client ${sender.data.id} attempted state-modifying command in read-only mode`,
          "error"
        );
        this.emit(
          "event",
          {
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "error",
            data: {
              message:
                "Cannot execute state-modifying commands in read-only mode",
              context: `Attempted command: ${command.type}`,
              phase: this.currentPhase?.phase.id,
              fatal: false,
              severity: ErrorSeverity.OPERATION,
              code: "INSUFFICIENT_PERMISSIONS",
            },
          } as ErrorEvent,
          sender
        );
        return;
      }
    }

    switch (command.type) {
      case "phase.start": {
        await this.startPhase(
          command.data.phaseId,
          command.data.skipPreCommands
        );
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
        await this.shutdown(command.data?.reason || "client request");
        break;

      case "checkpoint.list":
        await this.listCheckpoints(command.data?.runId);
        break;

      case "phase.forceStop":
        await this.forceStopPhase(command.data?.reason);
        break;

      case "rollback.toCheckpoint":
        await this.rollbackToCheckpoint(
          command.data.checkpointSha,
          command.data.autoRestart ?? false
        );
        break;

      case "rollback.toPhase":
        await this.rollbackToPhase(
          command.data.phaseId,
          command.data.checkpointType,
          command.data.autoRestart ?? false
        );
        break;

      case "rollback.toLastSuccess":
        await this.rollbackToLastSuccess(command.data?.autoRestart ?? false);
        break;

      case "ping":
        this.handlePing(command.id, sender);
        break;

      case "ping.broadcast":
        this.handlePingBroadcast(command.id, sender);
        break;

      case "history.sync":
        await this.handleHistorySync(command, sender);
        break;

      default:
        // This should never happen due to Zod validation
        assertNever(command);
    }
  }

  // ============================================================================
  // Ping Commands (for testing)
  // ============================================================================

  private handlePing(
    commandId: string,
    sender?: ServerWebSocket<ClientData>
  ): void {
    this.logger.log(`Handling ping command: ${commandId}`);

    // Send pong response only to the sender
    if (sender?.data.handshakeComplete) {
      const pongEvent: PongEvent = {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "pong",
        data: {
          message: "pong",
          timestamp: new Date().toISOString(),
        },
      };

      // pong is a connection state event - send to specific client only, don't journal
      this.emit("event", pongEvent, sender);
    } else {
      this.logger.log(
        "Ping command received but no valid sender provided",
        "error"
      );
    }
  }

  private handlePingBroadcast(
    commandId: string,
    sender?: ServerWebSocket<ClientData>
  ): void {
    this.logger.log(`Handling ping.broadcast command: ${commandId}`);

    const senderClientId = sender?.data.id || "unknown";

    // Send pong response to all clients, including the sender's client ID
    // For broadcast, we'll include a clientId to distinguish the sender
    // pong is a connection state event - each goes to a specific client, not journaled
    for (const [_, client] of this.clients) {
      if (!client.data.handshakeComplete) continue;

      const pongEvent: PongEvent = {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "pong",
        data: {
          message: "pong",
          timestamp: new Date().toISOString(),
          clientId: senderClientId, // Include the sender's client ID in broadcast responses
        },
      };

      this.emit("event", pongEvent, client);
    }
  }

  // ============================================================================
  // History Sync Command
  // ============================================================================

  private async handleHistorySync(
    command: import("./schemas/event-schemas.js").HistorySyncCommand,
    sender?: ServerWebSocket<ClientData>
  ): Promise<void> {
    if (!sender?.data.handshakeComplete) {
      this.logger.log(
        "History sync command received but sender not ready",
        "error"
      );
      return;
    }

    this.logger.log(`Handling history.sync command: ${command.id}`);

    const target = sender;
    if (!target) {
      this.logger.log("History sync command received without sender", "error");
      return;
    }

    const iterator = this.eventJournal.getAllEvents()[Symbol.asyncIterator]();
    let next = await iterator.next();

    if (next.done) {
      this.sendHistoryBatch(target, [], false);
      return;
    }

    let pending = next.value;
    while (true) {
      next = await iterator.next();
      if (next.done) {
        this.sendHistoryBatch(target, [pending], false);
        break;
      }

      this.sendHistoryBatch(target, [pending], true);
      pending = next.value;
    }

    // Note: We don't store history.batch events in the journal or emit them
    // as they are just responses containing existing events
  }

  // ============================================================================
  // Event & State Management
  // ============================================================================

  private sendHistoryBatch(
    sender: ServerWebSocket<ClientData>,
    events: ServerEvent[],
    hasMore: boolean
  ): void {
    const historyBatchEvent: HistoryBatchEvent = {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "history.batch",
      data: {
        events,
        hasMore,
      },
    };

    try {
      sender.send(JSON.stringify(historyBatchEvent));
      this.logger.log(
        `Sent ${events.length} events to client ${sender.data.id}`
      );
    } catch (error) {
      this.logger.log(
        `Failed to send history batch to client ${sender.data.id}: ${error}`,
        "error"
      );
      this.clients.delete(sender.data.id);
    }
  }

  /**
   * Override emit to handle server event routing with optional client targeting.
   *
   * - Server state events (no target): Journaled and broadcasted to all clients
   * - Server state events (with target): Sent only to specified client (e.g., validation errors)
   * - Connection state events (with target): Sent only to specified client, not journaled
   * - Error server event is a notable exception - it's a server state error that can be sent to a specific client if target is provided
   *
   * @param event - Event type (always "event" for ServerEvents)
   * @param data - The server event to emit
   * @param target - Optional target client. If provided, event is sent only to this client
   */
  emit<K extends keyof ServerInternalEvents>(
    event: K,
    data: ServerInternalEvents[K][0],
    target?: ServerWebSocket<ClientData>
  ): boolean {
    if (event !== "event") {
      // Should relax this restriction eventually
      this.logger.log(`Unsupported event type emitted: ${event}`, "error");
      throw new Error(
        `Unsupported event type: ${event}. Can only emit "event" events.`
      );
    }

    const serverEvent = data as ServerEvent;

    // this should never happen due to compile time checks, but...
    if (
      !isServerStateEvent(serverEvent) &&
      !isConnectionStateEvent(serverEvent)
    ) {
      // This should never happen - all ServerEvents should be categorized
      this.logger.log(
        `Unknown event type: ${(serverEvent as ServerEvent).type}`,
        "error"
      );
      throw new Error(`Unknown event: ${(serverEvent as ServerEvent).type}`);
    }

    // early exit if we have a connection state event without a target
    if (isConnectionStateEvent(serverEvent) && !target) {
      this.logger.log(
        `Connection state event ${serverEvent.type} requires a target client but none provided`,
        "error"
      );
      return false;
    }

    // extra target check for error events that can be sent to a specific client
    if (isServerStateEvent(serverEvent) && !target) {
      // Server state events without target: journal and broadcast to all clients
      // Use queue to ensure events are written in the order they're emitted
      this.eventJournalAppendQueue = this.eventJournalAppendQueue
        .then(() => this.eventJournal.append(serverEvent))
        .catch((error) => {
          this.logger.log(
            `Error appending event to journal: ${error}`,
            "error"
          );
        });

      // Broadcast to all connected clients that have completed handshake
      if (this.clients.size > 0) {
        for (const [_, client] of this.clients) {
          if (!client.data.handshakeComplete) continue;
          try {
            client.send(JSON.stringify(serverEvent));
          } catch (error) {
            this.logger.log(
              `Failed to send event to client ${client.data.id}: ${error}`,
              "error"
            );
          }
        }
      }
    } else {
      try {
        target?.send(JSON.stringify(serverEvent));
      } catch (error) {
        this.logger.log(
          `Failed to send event to client ${target?.data.id}: ${error}`,
          "error"
        );
      }
    }

    // Continue with normal emission for tests/TUI
    return super.emit(event, data);
  }

  private async sendStateSnapshot(): Promise<void> {
    const totalCost = this.stateManager.getTotalCost();
    const totalTime = this.serverStartTime
      ? Date.now() - this.serverStartTime.getTime()
      : 0;

    // Get terminal phases using execution thread
    const terminalPhases = await this.getTerminalPhasesForSnapshot();

    // Get the currently executing phase
    const currentPhase = this.stateManager.getCurrentlyRunningPhase();

    const stateSnapshotEvent: StateSnapshotEvent = {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "state.snapshot",
      data: {
        currentPhase: currentPhase || undefined,
        completedPhases: terminalPhases,
        fileTree: [],
        totalCost,
        totalTime,
        recentFileAccess: this.recentFileAccess,
        isRollingBack: this.isRollingBack,
      },
    };

    // state.snapshot is a server state event - journal and broadcast to all clients
    this.emit("event", stateSnapshotEvent);
  }

  // Get terminal phases for snapshot - returns all terminal phases (completed, failed, skipped)
  private async getTerminalPhasesForSnapshot(): Promise<PhaseExecution[]> {
    const thread = await this.stateManager.getExecutionThread();

    // Filter for terminal phases and extract just the phase execution objects
    return thread.phases
      .filter((threadPhase) => isTerminalPhaseStatus(threadPhase.phase.status))
      .map((threadPhase) => threadPhase.phase);
  }

  /**
   * Start a new run and create necessary infrastructure
   */
  private async startNewRun(
    startingConditions?: import("./types/state-types.js").StartingConditions
  ): Promise<void> {
    const runId = RunId(
      `${Date.now()}-${Math.random().toString(36).substring(2, 7)}`
    );
    const runFolder = path.join(
      this.config.executionPath,
      ".tadpole",
      "runs",
      runId
    );

    // Create run folder
    await fs.promises.mkdir(runFolder, { recursive: true });

    // Create run in state
    this.stateManager.transition({
      type: "RunStarted",
      data: {
        runId,
        runFolder,
        gitBranch: `run-${runId}`,
        startingConditions: startingConditions || { type: "fresh" },
        serverPid: process.pid,
      },
    });

    this.currentRunId = runId;

    // Update lock file with runId and heartbeat
    interface LockFile {
      pid: number;
      runId: string;
      startTime: string;
      lastHeartbeat: string;
    }

    const lockData: LockFile = {
      pid: process.pid,
      runId,
      startTime: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
    };

    const lockDir = path.dirname(this.config.lockFile);
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }
    fs.writeFileSync(this.config.lockFile, JSON.stringify(lockData));

    // Start heartbeat
    this.heartbeatInterval = setInterval(() => {
      this.updateHeartbeat();
    }, 30000); // Every 30 seconds

    this.logger.log(`Started new run: ${runId}`);
  }

  /**
   * Update heartbeat in lock file
   */
  private updateHeartbeat(): void {
    try {
      if (fs.existsSync(this.config.lockFile)) {
        const lock = JSON.parse(fs.readFileSync(this.config.lockFile, "utf-8"));
        lock.lastHeartbeat = new Date().toISOString();
        fs.writeFileSync(this.config.lockFile, JSON.stringify(lock));
      }
    } catch (error) {
      this.logger.log(`Failed to update heartbeat: ${error}`, "error");
    }
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
  private async startPhase(
    phaseId: PhaseId,
    skipPreCommands?: boolean
  ): Promise<void> {
    const phase = this.config.phases.find((p) => p.id === phaseId);
    if (!phase) {
      await this.handleError(
        new Error(`Unknown phase: ${phaseId}`),
        "startPhase",
        ErrorSeverity.OPERATION
      );
      return;
    }

    this.logger.log(`Starting phase: ${phase.name}`);

    // pull existing history for the phase and see if we had run workspace setup for it
    // git seems the best source of workspace setup related info
    const phaseHistory = await this.stateManager.getPhaseHistory(phase.id);
    let workspaceSetupCheckpoint: string | undefined;
    for (const entry of phaseHistory) {
      if (
        "workspaceSetupCheckpoint" in entry.phase &&
        entry.phase.workspaceSetupCheckpoint
      ) {
        workspaceSetupCheckpoint = entry.phase.workspaceSetupCheckpoint;
        break;
      }
    }

    if (workspaceSetupCheckpoint) {
      this.logger.log(
        `Found existing workspace setup checkpoint: ${workspaceSetupCheckpoint}`
      );
    }

    // Check if phase already running via state manager (single source of truth)
    const currentPhase = this.stateManager.getCurrentlyRunningPhase();
    if (currentPhase && !isTerminalPhaseStatus(currentPhase.status)) {
      await this.handleError(
        new Error(`Phase already running: ${currentPhase.phaseId}`),
        "startPhase",
        ErrorSeverity.OPERATION
      );
      return;
    }

    // Check if this phase was already attempted in current run
    const currentRun = this.stateManager.getCurrentRun();
    if (currentRun) {
      const previousAttempt = currentRun.phases.find(
        (p) => p.phaseId === phaseId
      );
      if (previousAttempt && isTerminalPhaseStatus(previousAttempt.status)) {
        // Phase was already attempted and finished - start new run
        this.logger.log(
          `Phase ${phaseId} was already attempted in current run, starting new run`
        );

        // Complete current run
        this.stateManager.transition({
          type: "RunCompleted",
          data: { runId: currentRun.runId },
        });

        await this.stateManager.waitForPendingTransitions();

        // Start new run
        await this.startNewRun({
          type: "continuation",
          source: {
            runId: currentRun.runId,
            afterPhase: null, // Start from beginning of this phase
            checkpointSha: "", // Will use current state
          },
          reason: "retry", // Use 'retry' for phase restart
        });
      }
    }

    // Create phase started transition (fire-and-forget)

    if (!this.currentRunId) {
      await this.handleError(
        new Error("No active run"),
        "startPhase",
        ErrorSeverity.FATAL
      );
      return;
    }

    this.stateManager.transition({
      type: "PhaseStarted",
      data: {
        runId: this.currentRunId,
        phaseId: phase.id,
      },
    });

    // Always transition from preparing to starting
    if (!this.currentRunId) {
      await this.handleError(
        new Error("No active run during phase start"),
        "startPhase",
        ErrorSeverity.FATAL
      );
      return;
    }

    // Run workspace setup operations if configured and we don't ask for explicit skip
    // and there is no existing workspace setup checkpoint for this phase
    if (!skipPreCommands && !workspaceSetupCheckpoint && phase.workspaceSetup) {
      this.logger.log(`Running workspace setup for phase: ${phase.name}`);
      let lastCopiedPath: string | null = null;

      for (const [index, item] of phase.workspaceSetup.entries()) {
        try {
          if (item.type === "copy" && item.copy) {
            const targetPath = path.join(
              this.config.executionPath,
              item.copy.to
            );
            this.logger.log(`Copying ${item.copy.from} to ${targetPath}`);
            // Check if target path already exists
            if (fs.existsSync(targetPath)) {
              this.logger.log(
                `Warning: Target path already exists: ${targetPath}. Removing it before copying.`
              );
              // TODO: let's discuss if this is too controversial
              // Remove the existing directory/file recursively
              await fs.promises.rm(targetPath, {
                recursive: true,
              });
              this.logger.log(`Removed existing path: ${targetPath}`);
            }

            await this.copyPath(item.copy.from, targetPath);
            lastCopiedPath = targetPath;
            this.logger.log(`Copied ${item.copy.from} to ${targetPath}`);
          } else if (item.type === "command" && item.command) {
            await this.runCommand(item, lastCopiedPath || undefined);
            const resolvedWorkingDir =
              item.command.workingDirectory === "lastCopied" && lastCopiedPath
                ? lastCopiedPath
                : this.config.executionPath;
            this.logger.log(
              `Ran command in ${resolvedWorkingDir}: ${item.command.run}`
            );
          }
        } catch (error) {
          const errorMessage = toError(error).message;
          this.logger.log(
            `Workspace setup failed at item ${index + 1} (${JSON.stringify(
              item
            )}): ${errorMessage}`,
            "error"
          );

          // Set failure reason with detailed information
          this.phaseFailureReason = {
            type: "unknown",
            retriable: true,
            message: `Workspace setup failed at ${item.type} operation: ${errorMessage}`,
          };

          // Transition phase to failed state
          if (this.currentRunId) {
            this.stateManager.transition({
              type: "PhaseTransitioned",
              data: {
                runId: this.currentRunId,
                phaseId: phase.id,
                from: "preparing",
                to: "failed",
                metadata: {
                  failedDuring: "preparing",
                  failureReason: this.phaseFailureReason,
                },
              },
            });
          }

          // Send error event with details
          this.emit("event", {
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "error",
            data: {
              message: `Workspace setup failed: ${errorMessage}`,
              context: `Phase ${phase.id} - ${item.type} operation (item ${
                index + 1
              })`,
              phase: phase.id,
              fatal: true,
              severity: ErrorSeverity.FATAL,
            },
          } as ErrorEvent);

          // Clean up and handle error
          this.cleanupCurrentPhase();
          await this.handleError(
            toError(error),
            `Workspace setup item ${index + 1}`,
            ErrorSeverity.FATAL
          );
          return;
        }
      }
    }

    // Transition to starting after preparing (regardless of workspace setup)
    this.stateManager.transition({
      type: "PhaseTransitioned",
      data: {
        runId: this.currentRunId,
        phaseId: phase.id,
        from: "preparing",
        to: "starting",
        metadata: {
          checkpointSha: workspaceSetupCheckpoint,
        },
      },
    });

    // Add checkpoint patterns - accumulate from all phases up to current
    // This ensures resume functionality works correctly
    const currentPhaseIndex = this.config.phases.findIndex(
      (p) => p.id === phase.id
    );
    if (currentPhaseIndex >= 0) {
      // Accumulate patterns from all phases up to and including current
      for (let i = 0; i <= currentPhaseIndex; i++) {
        const phaseConfig = this.config.phases[i];
        if (phaseConfig.trackedFiles && phaseConfig.trackedFiles.length > 0) {
          await this.addCheckpointPatterns(phaseConfig.trackedFiles);
        }
      }

      // Create checkpoint after workspace setup if we have workspace setup
      if (
        !skipPreCommands &&
        phase.workspaceSetup &&
        this.checkpointingEnabled
      ) {
        await this.createCheckpoint({
          status: "workspace-setup",
          phaseId: phase.id,
          phaseName: phase.name,
          runId: this.currentRunId || RunId("unknown"),
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Get previous session ID if needed
    let previousSessionId: string | null = null;

    if (phase.continuationMode === "continue-previous") {
      // Build execution thread to find continuation session
      const state = this.stateManager.getState();
      const thread = await analyzeExecutionThread(
        state,
        this.config.phases,
        undefined, // No checkpoint data needed for session lookup
        undefined, // Use latest run
        this.logger
      );

      const sessionId = findContinuationSessionId(
        thread,
        phase.id,
        this.config.phases
      );
      previousSessionId = sessionId;

      if (previousSessionId) {
        this.logger.log(
          `Phase ${phase.id} will continue from previous session: ${previousSessionId}`
        );

        // Send info event about continuation
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "info",
          data: {
            message: `Continuing from previous session: ${previousSessionId}`,
          },
        } as InfoEvent);
      } else {
        // Phase requires continuation but no valid session found - this is an error
        const errorMessage = `Phase ${phase.id} requires continuation from previous phase but no valid session found. Previous phase must complete successfully or be skipped with at least one assistant message.`;

        this.logger.log(errorMessage, "error");

        // Set failure reason
        this.phaseFailureReason = {
          type: "unknown",
          retriable: false,
          message: errorMessage,
        };

        // Transition to failed state
        if (this.currentRunId) {
          this.stateManager.transition({
            type: "PhaseTransitioned",
            data: {
              runId: this.currentRunId,
              phaseId: phase.id,
              from: "starting",
              to: "failed",
              metadata: {
                failedDuring: "starting",
                failureReason: this.phaseFailureReason,
              },
            },
          });
        }

        // Send error event
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "error",
          data: {
            message: errorMessage,
            phase: phase.id,
            fatal: true,
            severity: ErrorSeverity.PHASE,
          },
        } as ErrorEvent);

        // Clean up and return
        this.cleanupCurrentPhase();
        return;
      }
    }

    // Create phase state - start in initializing state
    this.currentPhase = {
      status: "initializing",
      phase,
      previousSessionId: previousSessionId
        ? SessionId(previousSessionId)
        : undefined, // Store for phase.started event
      startTime: new Date(),
      phaseCost: 0,
      phaseTokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };

    // Store watch patterns for tool-based tracking
    if (phase.trackedFiles && phase.trackedFiles.length > 0) {
      this.watchedPatterns = phase.trackedFiles;
      this.logger.log(`Watching patterns: ${this.watchedPatterns.join(", ")}`);
    }

    // NOTE: phase.started event is now sent when Claude sends init message
    // This ensures we have the actual session ID before notifying clients

    // Send initial file states if any exist
    if (phase.trackedFiles && phase.trackedFiles.length > 0) {
      // Use the unified file resolver to get files respecting gitignore
      const resolvedFiles = await fileResolver.resolveFiles(
        this.config.executionPath,
        phase.trackedFiles
      );

      // Get file contents for each resolved file
      const files = await Promise.all(
        resolvedFiles.map(async (filePath) => {
          const fullPath = path.join(this.config.executionPath, filePath);
          const stats = await fs.promises.stat(fullPath);
          const content = await fs.promises.readFile(fullPath, "utf-8");
          return {
            path: filePath,
            content,
            lastModified: stats.mtime.toISOString(),
          };
        })
      );

      // Only send events if we have files
      if (files.length > 0) {
        for (const file of files) {
          this.emit("event", {
            id: EventId(generateId()),
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
          new Date(file.lastModified) > new Date(latest.lastModified)
            ? file
            : latest
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
    previousSessionId: string | null
  ): Promise<void> {
    try {
      // Get run folder from state
      const currentRun = this.stateManager.getCurrentRun();
      if (!currentRun || !currentRun.runFolder) {
        throw new Error("No active run or run folder not found");
      }
      const runFolder = currentRun.runFolder;

      // Ensure run folder exists
      await fs.promises.mkdir(runFolder, { recursive: true });

      // Modify log path to use run folder
      const logPath = path.join(runFolder, `${phase.id}-claude.log`);

      // Create log parser first
      this.logParser = new ClaudeLogParser({
        logPath,
        phaseId: phase.id,
        parsingInterval: this.config.logParsingInterval,
        onSystemMessage: (msg) => this.handleSystemMessage(msg, phase.id),
        onAssistantMessage: (msg) => this.handleAssistantMessage(msg, phase.id),
        onUserMessage: (msg) => this.handleUserMessage(msg, phase.id),
        onResultMessage: (msg) => this.handleResultMessage(msg, phase.id),
      });

      // Create process manager with the log parser
      this.processManager = new ClaudeProcessManager(
        this.config.executionPath,
        this.logger,
        this.logParser,
        this.proxyRunner?.proxyUrl,
        this.config.modelOverride
      );

      // Set up event handlers
      this.processManager.on("exit", (code: number) => {
        this.handlePhaseComplete(code);
      });

      this.processManager.on("error", (error: Error) => {
        this.handleError(
          error,
          `Claude process for phase ${phase.id}`,
          ErrorSeverity.FATAL
        );
      });

      // Spawn process with custom log path
      const _logPathResult = await this.processManager.spawn(
        phase,
        previousSessionId,
        logPath
      );

      // Transition to initializing (fire-and-forget)
      if (!this.currentRunId) {
        throw new Error("No active run while starting Claude process");
      }

      const pid = this.processManager.getPid();
      if (!pid) {
        throw new Error("Failed to get Claude process PID");
      }

      // Get the phase from current state to check for previousSessionId
      const _currentPhase = this.currentPhase;

      this.stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: this.currentRunId,
          phaseId: phase.id,
          from: "starting",
          to: "initializing",
          metadata: {
            claudePid: pid,
            claudeLogPath: path.relative(this.config.executionPath, logPath),
            ...(previousSessionId && {
              previousSessionId: SessionId(previousSessionId),
            }),
          },
        },
      });

      // Start log parsing with delay
      setTimeout(() => {
        this.logParser?.start();
      }, TIMEOUTS.LOG_PARSER_DELAY_MS);
    } catch (error) {
      // Transition to failed (fire-and-forget) if we have a run
      if (this.currentRunId) {
        this.stateManager.transition({
          type: "PhaseTransitioned",
          data: {
            runId: this.currentRunId,
            phaseId: phase.id,
            from: "starting",
            to: "failed",
            metadata: {
              failedDuring: "starting",
              failureReason: {
                type: "unknown",
                retriable: false,
                message: toError(error).message,
              },
            },
          },
        });
      }
      this.cleanupCurrentPhase();
      throw error;
    }
  }

  private handleSystemMessage(msg: SystemMessage, phaseId: string): void {
    if (
      msg.subtype === "init" &&
      msg.session_id &&
      this.currentPhase &&
      this.currentPhase.status === "initializing"
    ) {
      // Transition to running (fire-and-forget)
      if (this.currentRunId) {
        this.stateManager.transition({
          type: "PhaseTransitioned",
          data: {
            runId: this.currentRunId,
            phaseId: PhaseId(phaseId),
            from: "initializing",
            to: "running",
            metadata: {
              claudeSessionId: SessionId(msg.session_id),
            },
          },
        });
      }

      // Update local state for backward compatibility
      this.currentPhase = {
        status: "running",
        phase: this.currentPhase.phase,
        sessionId: SessionId(msg.session_id),
        previousSessionId: this.currentPhase.previousSessionId,
        startTime: this.currentPhase.startTime,
        phaseCost: 0,
        phaseTokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      };

      // Log the session ID update
      this.logger.log(
        `Claude started phase ${phaseId} with session ID: ${msg.session_id}`
      );

      // Send existing info event
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "info",
        data: {
          message: `Claude started with session ID: ${msg.session_id}`,
        },
      } as InfoEvent);
    }
  }

  private handleAssistantMessage(msg: AssistantMessage, phaseId: string): void {
    // Track that we've received an assistant message
    if (this.currentRunId) {
      const currentPhase = this.stateManager.getPhaseInCurrentRun(
        PhaseId(phaseId)
      );
      const currentCount =
        currentPhase && "assistantMessageCount" in currentPhase
          ? currentPhase.assistantMessageCount ?? 0
          : 0;

      this.stateManager.transition({
        type: "AssistantMessageCountUpdated",
        data: {
          runId: this.currentRunId,
          phaseId: PhaseId(phaseId),
          newCount: currentCount + 1,
        },
      });
    }

    // Use type guard to check for synthetic timeout messages
    if (isSyntheticTimeout(msg as ClaudeLogMessage)) {
      this.logger.log(
        `API timeout detected in synthetic message for phase ${phaseId}`,
        "error"
      );

      const timeoutError = new APITimeoutError(phaseId, {
        message: "API Error: Request timed out.",
        timestamp: new Date().toISOString(),
        synthetic: true,
      });

      // Set failure reason
      this.phaseFailureReason = {
        type: "timeout",
        retriable: true,
        message: "API Error: Request timed out.",
      };

      // Send error event
      this.emit("event", {
        id: EventId(generateId()),
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

    if (msg.message.usage) {
      const usageDelta: TokenUsage = {
        inputTokens: msg.message.usage.input_tokens || 0,
        outputTokens: msg.message.usage.output_tokens || 0,
        cacheCreationTokens: msg.message.usage.cache_creation_input_tokens || 0,
        cacheReadTokens: msg.message.usage.cache_read_input_tokens || 0,
      };

      const costDelta = calculateCost(usageDelta, this.config.costsPerMTok);

      // This part is fine, it updates the transient in-memory state for now
      if (this.currentPhase && this.currentPhase.status === "running") {
        this.currentPhase.phaseCost += costDelta;
        this.currentPhase.phaseTokens.inputTokens += usageDelta.inputTokens;
        this.currentPhase.phaseTokens.outputTokens += usageDelta.outputTokens;
        this.currentPhase.phaseTokens.cacheCreationTokens +=
          usageDelta.cacheCreationTokens;
        this.currentPhase.phaseTokens.cacheReadTokens +=
          usageDelta.cacheReadTokens;
      }

      // Fire cost INCREMENT transition (fire-and-forget)
      if (this.currentRunId) {
        // Instead of calculating a new total from state, we just send the delta.
        this.stateManager.transition({
          type: "CostsIncremented", // Use the new incremental type
          data: {
            runId: this.currentRunId,
            phaseId: PhaseId(phaseId),
            costDelta: costDelta, // Send the delta
            tokensDelta: usageDelta, // Send the delta
          },
        });
      }

      this.logger.log(
        `Phase ${phaseId} token update - Call cost: $${costDelta.toFixed(
          4
        )}, Running total: $${this.currentPhase?.phaseCost.toFixed(4) || 0} ` +
          `(${usageDelta.inputTokens} in, ${usageDelta.outputTokens} out, ` +
          `${usageDelta.cacheCreationTokens} cache create, ${usageDelta.cacheReadTokens} cache read)`
      );

      // Send token.usage event with the delta cost
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "token.usage",
        data: {
          phaseId,
          ...usageDelta,
          totalCost: costDelta, // This event should report the delta cost
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

          // Set failure reason
          this.phaseFailureReason = {
            type: "timeout",
            retriable: true,
            message: "API Error: Request timed out.",
          };

          // Send error event
          this.emit("event", {
            id: EventId(generateId()),
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

        this.emit("event", {
          id: EventId(generateId()),
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
        this.emit("event", {
          id: EventId(generateId()),
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

        // Track this tool use for result matching
        this.pendingToolUses.set(toolItem.id, {
          toolName: toolItem.name,
          timestamp: Date.now(),
          phaseId,
        });

        // Handle file-related tool calls
        const fileTools: ToolName[] = ["Read", "Write", "Edit", "MultiEdit"];
        if (fileTools.includes(toolItem.name as ToolName)) {
          // Call async function without awaiting to avoid blocking
          this.handleFileToolCall(
            toolItem.name as ToolName,
            toolItem.input
          ).catch((err) => {
            this.handleError(
              toError(err),
              `handleFileToolCall(${toolItem.name})`,
              ErrorSeverity.OPERATION
            );
          });
        }

        // Send event for all tools, including unknown ones
        // toolName is typed as string to allow unknown tools
        this.emit("event", {
          id: EventId(generateId()),
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

    // Mark that we received a result message
    this.resultMessageReceived = true;

    // Check for API timeout in result (can be error subtype OR success with is_error=true)
    if (msg.result === "API Error: Request timed out." && msg.is_error) {
      this.logger.log(
        `API timeout detected in result message for phase ${phaseId}`,
        "error"
      );

      const timeoutError = new APITimeoutError(phaseId, {
        message: msg.result,
        timestamp: new Date().toISOString(),
        is_error: msg.is_error,
        duration_ms: msg.duration_ms,
        duration_api_ms: msg.duration_api_ms,
      });

      // Set failure reason
      this.phaseFailureReason = {
        type: "timeout",
        retriable: true,
        message: "API Error: Request timed out.",
      };

      // Send error event
      this.emit("event", {
        id: EventId(generateId()),
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
      if (msg.usage && this.currentRunId) {
        const finalUsage: TokenUsage = {
          inputTokens: msg.usage.input_tokens || 0,
          outputTokens: msg.usage.output_tokens || 0,
          cacheCreationTokens: msg.usage.cache_creation_input_tokens || 0,
          cacheReadTokens: msg.usage.cache_read_input_tokens || 0,
        };

        const finalCost =
          msg.total_cost_usd ||
          calculateCost(finalUsage, this.config.costsPerMTok);

        const accumulatedCost = this.currentPhase?.phaseCost || 0; // Still useful for logging
        if (Math.abs(accumulatedCost - finalCost) > 0.0001) {
          this.logger.log(
            `Phase ${phaseId} cost discrepancy - Accumulated: $${accumulatedCost.toFixed(
              4
            )}, ` +
              `Final: $${finalCost.toFixed(
                4
              )} (using final from result message)`
          );
        }

        // Fire a state transition with the authoritative final cost.
        this.stateManager.transition({
          type: "PhaseFinalCostSet",
          data: {
            runId: this.currentRunId,
            phaseId: PhaseId(phaseId),
            finalCost: finalCost,
            finalTokens: finalUsage,
          },
        });

        // Send a final token usage event with the correct values
        this.emit("event", {
          id: EventId(generateId()),
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

  private handleUserMessage(msg: UserMessage, _phaseId: string): void {
    // Process tool results from user messages
    const content = msg.message.content;
    const contentArray = Array.isArray(content) ? content : [];

    for (const item of contentArray) {
      if (item.type === "tool_result") {
        const toolResult = item as ToolResultContent;

        // Find the corresponding tool use
        const toolUse = this.pendingToolUses.get(toolResult.tool_use_id);
        if (!toolUse) {
          this.logger.log(
            `Tool result without matching tool use: ${toolResult.tool_use_id}`,
            "info"
          );
          continue;
        }

        // Calculate execution time
        const executionTimeMs = Date.now() - toolUse.timestamp;

        // Extract result content
        let resultText = "";
        let isError = false;

        if (typeof toolResult.content === "string") {
          resultText = toolResult.content;
        } else if (Array.isArray(toolResult.content)) {
          resultText = toolResult.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        } else if (
          toolResult.content &&
          typeof toolResult.content === "object"
        ) {
          // Check if it's an error result
          if ("is_error" in toolResult.content) {
            isError = toolResult.content.is_error === true;
          }
          resultText = JSON.stringify(toolResult.content, null, 2);
        }

        // Truncate result based on configuration
        const originalLength = resultText.length;
        const truncateLength = this.config.toolResultTruncateLength;
        const truncated = resultText.length > truncateLength;
        if (truncated) {
          resultText = `${resultText.substring(0, truncateLength)}...`;
        }

        // Send tool result event
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "tool.result",
          data: {
            phaseId: toolUse.phaseId,
            toolUseId: toolResult.tool_use_id,
            toolName: toolUse.toolName,
            result: resultText,
            truncated,
            originalLength,
            executionTimeMs,
            isError,
          },
        } as import("./types/types.js").ToolResultEvent);

        // Clean up tracked tool use
        this.pendingToolUses.delete(toolResult.tool_use_id);
      }
    }
  }

  private async handlePhaseComplete(exitCode: number): Promise<void> {
    // Get the current phase from the in-memory state first
    if (!this.currentPhase) return;

    const phaseId = this.currentPhase.phase.id;
    const wasSkipped = this.isSkippingPhase;

    // Now get the phase from state manager to ensure we have the latest status
    const currentPhase = this.stateManager.getPhaseInCurrentRun(
      PhaseId(phaseId)
    );
    if (!currentPhase || isTerminalPhaseStatus(currentPhase.status)) return;

    // Get current status before any transitions
    const currentStatus = currentPhase.status;

    // Wait for 2x the log parsing interval to ensure log parser catches up with final messages
    await new Promise((resolve) =>
      setTimeout(resolve, this.config.logParsingInterval * 2)
    );

    // Re-fetch the specific phase after potential transition to completing
    const updatedPhase = this.stateManager.getPhaseInCurrentRun(
      PhaseId(phaseId)
    );
    if (!updatedPhase) return;

    // Determine final status based on the actual phase outcome
    // Priority order: force stop > result message > skip request > exit code
    let finalStatus: PhaseStatus;
    if (this.isForceStopping) {
      finalStatus = "failed";
    } else if (exitCode === 0 && this.resultMessageReceived) {
      finalStatus = "completed"; // Result message with exit 0 = completed
    } else if (wasSkipped && !this.resultMessageReceived) {
      finalStatus = "skipped"; // Skip requested AND no result = skipped
    } else if (exitCode !== 0) {
      finalStatus = "failed"; // Non-zero exit = failed
    } else {
      // Exit 0 but no result message and not skipped = failed
      finalStatus = "failed";
    }

    // Create checkpoint BEFORE state transition
    let checkpointSha: string | undefined;
    if (this.checkpointingEnabled) {
      try {
        const checkpointType =
          finalStatus === "completed"
            ? "completed"
            : finalStatus === "skipped"
            ? "skipped"
            : "error";

        const commitInfo = await this.createCheckpoint({
          status: checkpointType,
          phaseId: phaseId,
          phaseName: this.currentPhase?.phase.name || phaseId,
          runId: this.currentRunId || RunId("unknown"),
          timestamp: new Date().toISOString(),
          duration: Date.now() - new Date(currentPhase.startTime).getTime(),
        });

        checkpointSha = commitInfo || undefined;
      } catch (error) {
        this.logger.log(`Checkpoint creation failed: ${error}`, "error");
        // Decide: fail the phase or continue without checkpoint?
        if (finalStatus === "completed") {
          // For completed phases, checkpoint failure is critical
          finalStatus = "failed";
          this.phaseFailureReason = {
            type: "unknown",
            retriable: false,
            message: `Checkpoint creation failed: ${toError(error).message}`,
          };
        }
      }
    }

    // Final transition (fire-and-forget)
    if (this.currentRunId) {
      this.stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: this.currentRunId,
          phaseId,
          from: updatedPhase.status, // Use the updated status (might be "completing" now)
          to: finalStatus,
          metadata: {
            exitCode,
            resultMessageReceived: this.resultMessageReceived,
            checkpointSha: checkpointSha || "", // Ensure we always have a string
            ...(finalStatus === "failed" && {
              failedDuring: wasSkipped ? currentStatus : updatedPhase.status,
              failureReason: this.phaseFailureReason || {
                type: "unknown",
                retriable: false,
              },
            }),
            ...(finalStatus === "skipped" && {
              skippedDuring: currentStatus, // Use original status for skip
            }),
          },
        },
      });
    }

    // Wait for this critical state transition to complete before cleanup
    await this.stateManager.waitForPendingTransitions();

    // Get the final persisted state for the phase
    const finalPhaseState = this.stateManager.getPhaseInCurrentRun(
      PhaseId(phaseId)
    );

    // Authoritatively get the cost from the final state object
    let finalCost = 0;
    if (finalPhaseState) {
      if (finalPhaseState.status === "completed") {
        finalCost = finalPhaseState.finalCost;
      } else if (
        finalPhaseState.status === "failed" ||
        finalPhaseState.status === "skipped"
      ) {
        finalCost = finalPhaseState.partialCost;
      }
    }

    // The design decision to report 0 for skipped phases is handled here
    const reportedCost = finalStatus === "skipped" ? 0 : finalCost;

    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "phase.completed",
      data: {
        phaseId,
        success: finalStatus === "completed",
        cost: reportedCost, // Use the authoritative, persisted cost
        duration: Date.now() - new Date(currentPhase.startTime).getTime(),
        exitStatus:
          finalStatus === "skipped"
            ? { type: "error", code: exitCode }
            : exitCode === 0
            ? { type: "success" }
            : { type: "error", code: exitCode },
        failureReason:
          finalStatus === "failed" ? this.phaseFailureReason : undefined,
      },
    } as PhaseCompletedEvent);

    // Send state snapshot
    await this.sendStateSnapshot();

    if (finalStatus === "completed" && this.currentPhase.phase.outputFiles) {
      for (const [
        groupIndex,
        outItem,
      ] of this.currentPhase.phase.outputFiles.entries()) {
        let beforeCopySuccess = false;
        try {
          if (outItem.beforeCopy && outItem.beforeCopy.length > 0) {
            this.logger.log(
              `Running ${
                outItem.beforeCopy.length
              } beforeCopy command(s) for phase ${
                this.currentPhase.phase.id
              } (group ${groupIndex + 1})`
            );

            for (const [index, command] of outItem.beforeCopy.entries()) {
              this.logger.log(
                `Running beforeCopy command ${index + 1}/${
                  outItem.beforeCopy.length
                }: ${command.command.run}`
              );
              await this.runCommand(command);
            }

            this.logger.log(
              `Completed all beforeCopy commands for phase ${
                this.currentPhase.phase.id
              } (group ${groupIndex + 1})`
            );
          }

          beforeCopySuccess = true;

          await copyFiles(
            this.config.executionPath,
            outItem.copy,
            path.join(this.config.cwd, this.config.outputDirectory),
            this.logger
          );
        } catch (error) {
          await this.handleError(
            new Error(`Copy group ${groupIndex} failed with: ${String(error)}`),
            beforeCopySuccess ? "phaseOutputCopyFiles" : "phaseOutputBeforeCopy"
          );
          // Continue to next output group
        }
      }
    }

    // Clean up - now happens after state is persisted
    this.cleanupCurrentPhase();

    // Handle next steps
    if (
      (finalStatus === "completed" || finalStatus === "skipped") &&
      !this.isShuttingDown
    ) {
      if (this.config.autostart) {
        await this.autoStartNextPhase();
      } else {
        // Emit idle event
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "server.idle",
          data: {
            reason: "phase-completed",
            message: `Phase ${phaseId} ${finalStatus}. Use 'phase.next' to continue.`,
          },
        } as import("./types/types.js").ServerIdleEvent);
      }
    } else if (finalStatus === "failed" && !this.isShuttingDown) {
      if (this.phaseFailureReason?.retriable) {
        this.logger.log(
          `Phase failed with retriable error. Server remains active.`
        );
      } else {
        // Non-retriable failure - shut down run
        if (this.currentRunId) {
          this.stateManager.transition({
            type: "RunFailed",
            data: { runId: this.currentRunId },
          });
          // Wait for this transition too
          await this.stateManager.waitForPendingTransitions();
        }
        await this.shutdown("phase failure");
      }
    }
  }

  // ============================================================================
  // File Operations & Watching
  // ============================================================================

  private async handleFileToolCall<T extends ToolName>(
    toolName: T,
    toolInput: Record<string, unknown> | undefined
  ): Promise<void> {
    if (this.watchedPatterns.length === 0) return;

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
          action = fs.existsSync(path.join(this.config.executionPath, filePath))
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
      filePath = path.relative(this.config.executionPath, filePath);
    }

    // Check if file matches any watch pattern
    const normalizedPath = filePath.replace(/^\.\//g, "");
    const matchesPattern = this.watchedPatterns.some((pattern) => {
      const normalizedPattern = pattern.replace(/^\.\//g, "");
      return minimatch(normalizedPath, normalizedPattern, { matchBase: true });
    });

    if (!matchesPattern) {
      return;
    }

    // Read current file content if not provided
    if (!content) {
      const fullPath = path.join(this.config.executionPath, filePath);
      if (fs.existsSync(fullPath)) {
        try {
          content = fs.readFileSync(fullPath, "utf-8");
        } catch (error) {
          this.logger.log(
            `Error reading file ${filePath}: ${toError(error).message}`,
            "error"
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
    this.emit("event", {
      id: EventId(generateId()),
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
    if (this.watchedPatterns.length === 0) return;

    // Build file tree for all watched patterns
    const allTrees = await Promise.all(
      this.watchedPatterns.map((pattern) =>
        buildFileTree(this.config.executionPath, pattern)
      )
    );

    // Merge all trees into one
    const mergedTree = allTrees.flat();

    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "filetree.updated",
      data: { tree: mergedTree },
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
    severity: ErrorSeverity = ErrorSeverity.OPERATION
  ): Promise<void> {
    // Always log
    this.logger.log(
      `[${severity}] ${context}: ${error.message}`,
      severity === ErrorSeverity.FATAL ? "error" : "info"
    );

    // Always send to client
    this.emit("event", {
      id: EventId(generateId()),
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

  /**
   * Automatically start the next available phase if none is running.
   * Called on connection and after phase completion.
   */
  private async autoStartNextPhase(): Promise<void> {
    const thread = await this.stateManager.getExecutionThread();

    this.logger.log(
      `[autoStartNextPhase] Called - hasRunningPhase: ${thread.hasRunningPhase}, isShuttingDown: ${this.isShuttingDown}`
    );

    if (thread.hasRunningPhase || this.isShuttingDown) {
      this.logger.log(
        `[autoStartNextPhase] Returning early - phase running or shutting down`
      );
      return; // Phase already running or shutting down
    }

    const nextPhaseId = thread.nextPhaseId;
    this.logger.log(
      `[autoStartNextPhase] ExecutionThread returned nextPhaseId: ${nextPhaseId}`
    );

    if (!nextPhaseId) {
      this.logger.log("[autoStartNextPhase] No more phases to run");

      if (this.config.autostart) {
        // Current behavior - shut down
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "info",
          data: {
            message: "All phases completed successfully. Server shutting down.",
          },
        } as InfoEvent);

        setTimeout(() => {
          this.shutdown("all phases completed");
        }, 2000);
      } else {
        // New behavior - stay running and emit idle
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "server.idle",
          data: {
            reason: "all-phases-completed",
            message: "All phases completed. Server remains active.",
          },
        } as import("./types/types.js").ServerIdleEvent);
      }
      return;
    }

    this.logger.log(`[autoStartNextPhase] Auto-starting phase: ${nextPhaseId}`);
    await this.startPhase(nextPhaseId);
  }

  private async startNextPhase(): Promise<void> {
    const thread = await this.stateManager.getExecutionThread();

    if (thread.hasRunningPhase) {
      await this.handleError(
        new Error("Cannot start next phase while current phase is running"),
        "startNextPhase",
        ErrorSeverity.OPERATION
      );
      return;
    }

    const nextPhaseId = thread.nextPhaseId;

    if (nextPhaseId) {
      this.logger.log(
        `[startNextPhase] Advancing to next phase: ${nextPhaseId}`
      );
      await this.startPhase(nextPhaseId);
    } else {
      await this.handleError(
        new Error("No more phases to run"),
        "startNextPhase",
        ErrorSeverity.OPERATION
      );
    }
  }

  private async skipCurrentPhase(): Promise<void> {
    if (!this.currentPhase) {
      await this.handleError(
        new Error("No phase is currently running"),
        "skipCurrentPhase",
        ErrorSeverity.OPERATION
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
    const thread = await this.stateManager.getExecutionThread();

    if (thread.hasRunningPhase) {
      await this.handleError(
        new Error("Cannot redo while phase is running"),
        "redoCurrentPhase",
        ErrorSeverity.OPERATION
      );
      return;
    }

    if (thread.phases.length > 0) {
      // Redo the most recently executed phase, whatever its status
      const lastAttemptedPhase = thread.phases[0];
      this.logger.log(
        `[redoCurrentPhase] Redoing last phase: ${lastAttemptedPhase.phase.phaseId}`
      );
      await this.startPhase(lastAttemptedPhase.phase.phaseId);
    } else {
      await this.handleError(
        new Error("No phase has been run yet to redo."),
        "redoCurrentPhase",
        ErrorSeverity.OPERATION
      );
    }
  }

  /**
   * List available checkpoints
   */
  private async listCheckpoints(runId?: string): Promise<void> {
    const targetRun = runId
      ? this.stateManager.getRun(RunId(runId))
      : this.stateManager.getCurrentRun();

    if (!targetRun) {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: runId ? `Run ${runId} not found` : "No active run",
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    const checkpoints: import("./types/types.js").CheckpointQueryInfo[] = [];

    for (const phase of targetRun.phases) {
      const phaseConfig = this.config.phases.find(
        (p) => p.id === phase.phaseId
      );
      const phaseName = phaseConfig?.name || phase.phaseId;

      // Workspace setup checkpoint
      if (
        "workspaceSetupCheckpoint" in phase &&
        phase.workspaceSetupCheckpoint
      ) {
        checkpoints.push({
          phaseId: phase.phaseId,
          phaseName,
          checkpointType: "workspace-setup",
          sha: phase.workspaceSetupCheckpoint,
          status: phase.status,
          timestamp: phase.startTime,
        });
      }

      // Completion checkpoint
      if (phase.status === "completed" && phase.completionCheckpoint) {
        checkpoints.push({
          phaseId: phase.phaseId,
          phaseName,
          checkpointType: "completed",
          sha: phase.completionCheckpoint,
          status: phase.status,
          timestamp: phase.endTime,
        });
      }

      // Error checkpoint
      if (
        phase.status === "failed" &&
        "errorCheckpoint" in phase &&
        phase.errorCheckpoint
      ) {
        checkpoints.push({
          phaseId: phase.phaseId,
          phaseName,
          checkpointType: "error",
          sha: phase.errorCheckpoint,
          status: phase.status,
          timestamp: phase.endTime,
        });
      }

      // Skip checkpoint
      if (
        phase.status === "skipped" &&
        "skipCheckpoint" in phase &&
        phase.skipCheckpoint
      ) {
        checkpoints.push({
          phaseId: phase.phaseId,
          phaseName,
          checkpointType: "skipped",
          sha: phase.skipCheckpoint,
          status: phase.status,
          timestamp: phase.endTime,
        });
      }
    }

    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "checkpoint.list",
      data: {
        runId: targetRun.runId,
        checkpoints,
        currentBranch: targetRun.gitBranch,
      },
    } as import("./types/types.js").CheckpointListEvent);
  }

  /**
   * Force stop the current running phase
   */
  private async forceStopPhase(reason?: string): Promise<void> {
    const currentPhase = this.stateManager.getCurrentlyRunningPhase();
    if (!currentPhase || isTerminalPhaseStatus(currentPhase.status)) {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: "No running phase to stop",
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    this.logger.log(
      `Force stopping phase ${currentPhase.phaseId}: ${
        reason || "user request"
      }`
    );

    // Set the force stopping flag
    this.isForceStopping = true;

    // Set failure reason
    this.phaseFailureReason = {
      type: "unknown",
      retriable: true,
      message: `Force stopped: ${reason || "user request"}`,
    };

    // Immediate state transition to failed
    if (this.currentRunId) {
      this.stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: this.currentRunId,
          phaseId: currentPhase.phaseId,
          from: currentPhase.status,
          to: "failed",
          metadata: {
            exitCode: -1,
            failureReason: this.phaseFailureReason,
            failedDuring: currentPhase.status,
          },
        },
      });
    }

    // Kill the process (if exists)
    if (this.processManager) {
      await this.processManager.kill("SIGTERM");
    }

    // Clean up phase state
    this.cleanupCurrentPhase();

    // Send confirmation
    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "info",
      data: {
        message: `Phase ${currentPhase.phaseId} force stopped`,
      },
    } as InfoEvent);
  }

  /**
   * Rollback to a specific checkpoint SHA (supports partial matching)
   */
  private async rollbackToCheckpoint(
    sha: string,
    autoRestart: boolean
  ): Promise<void> {
    // Check if phase is running
    const currentPhase = this.stateManager.getCurrentlyRunningPhase();
    if (currentPhase && !isTerminalPhaseStatus(currentPhase.status)) {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message:
            "Cannot rollback while phase is running. Use 'phase.forceStop' first.",
          phase: currentPhase.phaseId,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    // Build execution thread to search across all runs
    const thread = await analyzeExecutionThread(
      this.stateManager.getState(),
      this.config.phases,
      undefined, // No checkpoint validation needed for search
      undefined, // Use latest run
      this.logger
    );

    // Find all matching checkpoints across the thread
    const matches: Array<{
      threadPhase: import("./execution-thread.js").ThreadPhase;
      checkpointType: string;
      fullSha: string;
      phaseIndex: number;
    }> = [];

    thread.phases.forEach((threadPhase, index) => {
      const phase = threadPhase.phase;

      // Check workspace setup checkpoint
      if (
        "workspaceSetupCheckpoint" in phase &&
        phase.workspaceSetupCheckpoint
      ) {
        if (phase.workspaceSetupCheckpoint.startsWith(sha)) {
          matches.push({
            threadPhase,
            checkpointType: "workspace-setup",
            fullSha: phase.workspaceSetupCheckpoint,
            phaseIndex: index,
          });
        }
      }

      // Check completion checkpoint
      if (phase.status === "completed" && phase.completionCheckpoint) {
        if (phase.completionCheckpoint.startsWith(sha)) {
          matches.push({
            threadPhase,
            checkpointType: "completed",
            fullSha: phase.completionCheckpoint,
            phaseIndex: index,
          });
        }
      }

      // Check error checkpoint
      if (
        phase.status === "failed" &&
        "errorCheckpoint" in phase &&
        phase.errorCheckpoint
      ) {
        if (phase.errorCheckpoint.startsWith(sha)) {
          matches.push({
            threadPhase,
            checkpointType: "error",
            fullSha: phase.errorCheckpoint,
            phaseIndex: index,
          });
        }
      }

      // Check skip checkpoint
      if (
        phase.status === "skipped" &&
        "skipCheckpoint" in phase &&
        phase.skipCheckpoint
      ) {
        if (phase.skipCheckpoint.startsWith(sha)) {
          matches.push({
            threadPhase,
            checkpointType: "skipped",
            fullSha: phase.skipCheckpoint,
            phaseIndex: index,
          });
        }
      }
    });

    // Handle matches
    if (matches.length === 0) {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: `Checkpoint ${sha} not found in execution history`,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    if (matches.length > 1) {
      // Ambiguous SHA - provide helpful error message
      const matchDetails = matches
        .map((m) => {
          const phaseConfig = this.config.phases.find(
            (p) => p.id === m.threadPhase.phase.phaseId
          );
          const phaseName = phaseConfig?.name || m.threadPhase.phase.phaseId;
          return `  - ${m.fullSha.substring(0, 7)}... (${phaseName} - ${
            m.checkpointType
          }) in run ${m.threadPhase.runId}`;
        })
        .join("\n");

      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: `Ambiguous checkpoint SHA '${sha}'. Multiple checkpoints match:\n${matchDetails}\nPlease provide more characters to uniquely identify the checkpoint.`,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    // Single match found - proceed with rollback
    const match = matches[0];
    await this.executeRollback(
      thread,
      match.phaseIndex,
      match.fullSha,
      match.checkpointType,
      autoRestart
    );
  }

  /**
   * Rollback to a phase + checkpoint type
   */
  private async rollbackToPhase(
    phaseId: PhaseId,
    checkpointType:
      | "start"
      | "end"
      | "workspace-setup"
      | "completed"
      | "error"
      | "skipped",
    autoRestart: boolean
  ): Promise<void> {
    // Check if phase is running
    const currentPhase = this.stateManager.getCurrentlyRunningPhase();
    if (currentPhase && !isTerminalPhaseStatus(currentPhase.status)) {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message:
            "Cannot rollback while phase is running. Use 'phase.forceStop' first.",
          phase: currentPhase.phaseId,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    // Build execution thread to search across all runs
    const thread = await analyzeExecutionThread(
      this.stateManager.getState(),
      this.config.phases,
      undefined, // No checkpoint validation needed for search
      undefined, // Use latest run
      this.logger
    );

    // Find the phase in the thread
    let targetThreadPhase: import("./execution-thread.js").ThreadPhase | null =
      null;
    let targetPhaseIndex = -1;

    for (let i = 0; i < thread.phases.length; i++) {
      if (thread.phases[i].phase.phaseId === phaseId) {
        targetThreadPhase = thread.phases[i];
        targetPhaseIndex = i;
        break;
      }
    }

    if (!targetThreadPhase) {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: `Phase ${phaseId} not found in execution history`,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    const targetPhase = targetThreadPhase.phase;

    // Resolve checkpoint type aliases
    let actualCheckpointType:
      | "workspace-setup"
      | "completed"
      | "error"
      | "skipped"
      | undefined;
    let sha: string | null = null;

    if (checkpointType === "start") {
      // Find first checkpoint in phase
      if (
        "workspaceSetupCheckpoint" in targetPhase &&
        targetPhase.workspaceSetupCheckpoint
      ) {
        sha = targetPhase.workspaceSetupCheckpoint;
        actualCheckpointType = "workspace-setup";
      } else if (
        targetPhase.status === "completed" &&
        targetPhase.completionCheckpoint
      ) {
        sha = targetPhase.completionCheckpoint;
        actualCheckpointType = "completed";
      } else if (
        targetPhase.status === "failed" &&
        "errorCheckpoint" in targetPhase &&
        targetPhase.errorCheckpoint
      ) {
        sha = targetPhase.errorCheckpoint;
        actualCheckpointType = "error";
      } else if (
        targetPhase.status === "skipped" &&
        "skipCheckpoint" in targetPhase &&
        targetPhase.skipCheckpoint
      ) {
        sha = targetPhase.skipCheckpoint;
        actualCheckpointType = "skipped";
      }
    } else if (checkpointType === "end") {
      // Find last checkpoint in phase based on status
      if (
        targetPhase.status === "completed" &&
        targetPhase.completionCheckpoint
      ) {
        sha = targetPhase.completionCheckpoint;
        actualCheckpointType = "completed";
      } else if (
        targetPhase.status === "failed" &&
        "errorCheckpoint" in targetPhase &&
        targetPhase.errorCheckpoint
      ) {
        sha = targetPhase.errorCheckpoint;
        actualCheckpointType = "error";
      } else if (
        targetPhase.status === "skipped" &&
        "skipCheckpoint" in targetPhase &&
        targetPhase.skipCheckpoint
      ) {
        sha = targetPhase.skipCheckpoint;
        actualCheckpointType = "skipped";
      } else if (
        "workspaceSetupCheckpoint" in targetPhase &&
        targetPhase.workspaceSetupCheckpoint
      ) {
        // Fallback to workspace setup if no end checkpoint
        sha = targetPhase.workspaceSetupCheckpoint;
        actualCheckpointType = "workspace-setup";
      }
    } else {
      // Direct checkpoint type specified
      actualCheckpointType = checkpointType as
        | "workspace-setup"
        | "completed"
        | "error"
        | "skipped";

      switch (checkpointType) {
        case "workspace-setup":
          sha =
            "workspaceSetupCheckpoint" in targetPhase
              ? targetPhase.workspaceSetupCheckpoint || null
              : null;
          break;
        case "completed":
          sha =
            targetPhase.status === "completed"
              ? targetPhase.completionCheckpoint
              : null;
          break;
        case "error":
          sha =
            targetPhase.status === "failed" && "errorCheckpoint" in targetPhase
              ? targetPhase.errorCheckpoint || null
              : null;
          break;
        case "skipped":
          sha =
            targetPhase.status === "skipped" && "skipCheckpoint" in targetPhase
              ? targetPhase.skipCheckpoint || null
              : null;
          break;
      }
    }

    if (!sha || !actualCheckpointType) {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: `No ${checkpointType} checkpoint found for phase ${phaseId}`,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    await this.executeRollback(
      thread,
      targetPhaseIndex,
      sha,
      actualCheckpointType,
      autoRestart
    );
  }

  /**
   * Rollback to last successful phase
   */
  private async rollbackToLastSuccess(autoRestart: boolean): Promise<void> {
    // Check if phase is running
    const currentPhase = this.stateManager.getCurrentlyRunningPhase();
    if (currentPhase && !isTerminalPhaseStatus(currentPhase.status)) {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message:
            "Cannot rollback while phase is running. Use 'phase.forceStop' first.",
          phase: currentPhase.phaseId,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    // Build execution thread to search across all runs
    const thread = await analyzeExecutionThread(
      this.stateManager.getState(),
      this.config.phases,
      undefined, // No checkpoint validation needed for search
      undefined, // Use latest run
      this.logger
    );

    // Find last completed phase in the thread
    let lastCompletedIndex = -1;
    for (let i = 0; i < thread.phases.length; i++) {
      if (thread.phases[i].phase.status === "completed") {
        lastCompletedIndex = i;
        break;
      }
    }

    if (lastCompletedIndex >= 0) {
      const lastCompleted = thread.phases[lastCompletedIndex];
      if (lastCompleted.phase.status === "completed") {
        this.logger.log(
          `Found last successfully completed thread phase to rollback to: ${JSON.stringify(
            lastCompleted
          )}`
        );

        // Rollback to last successful phase
        await this.executeRollback(
          thread,
          lastCompletedIndex,
          lastCompleted.phase.completionCheckpoint,
          "completed",
          autoRestart
        );
        return;
      }
    }

    this.logger.log(
      "Did not find any successful phase to rollback to. Going to look for a checkpoint in the thread."
    );

    // No successful phases - find the first checkpoint in the thread
    let firstCheckpointIndex = -1;
    let firstCheckpointSha: string | null = null;
    let firstCheckpointType: string | null = null;

    for (let i = thread.phases.length - 1; i >= 0; i--) {
      const threadPhase = thread.phases[i];
      const phase = threadPhase.phase;

      if (
        "workspaceSetupCheckpoint" in phase &&
        phase.workspaceSetupCheckpoint
      ) {
        firstCheckpointIndex = i;
        firstCheckpointSha = phase.workspaceSetupCheckpoint;
        firstCheckpointType = "workspace-setup";
        this.logger.log(
          `Found workspace setup checkpoint in phase ${phase.phaseId}`
        );
      } else if (phase.status === "completed" && phase.completionCheckpoint) {
        firstCheckpointIndex = i;
        firstCheckpointSha = phase.completionCheckpoint;
        firstCheckpointType = "completed";
        this.logger.log(
          `Found completion checkpoint in phase ${phase.phaseId}`
        );
      } else if (
        phase.status === "failed" &&
        "errorCheckpoint" in phase &&
        phase.errorCheckpoint
      ) {
        firstCheckpointIndex = i;
        firstCheckpointSha = phase.errorCheckpoint;
        firstCheckpointType = "error";
        this.logger.log(`Found error checkpoint in phase ${phase.phaseId}`);
      } else if (
        phase.status === "skipped" &&
        "skipCheckpoint" in phase &&
        phase.skipCheckpoint
      ) {
        firstCheckpointIndex = i;
        firstCheckpointSha = phase.skipCheckpoint;
        firstCheckpointType = "skipped";
        this.logger.log(`Found skipped checkpoint in phase ${phase.phaseId}`);
      }
    }

    if (
      firstCheckpointIndex >= 0 &&
      firstCheckpointSha &&
      firstCheckpointType
    ) {
      await this.executeRollback(
        thread,
        firstCheckpointIndex,
        firstCheckpointSha,
        firstCheckpointType,
        autoRestart
      );
    } else {
      this.logger.log("No checkpoints found in execution history", "error");
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: "No checkpoints found in execution history",
          fatal: false,
        },
      } as ErrorEvent);
    }
  }

  /**
   * Execute the actual rollback
   */
  private async executeRollback(
    thread: import("./execution-thread.js").ExecutionThread,
    targetPhaseIndex: number,
    sha: string,
    checkpointType: string,
    autoRestart: boolean
  ): Promise<void> {
    const targetThreadPhase = thread.phases[targetPhaseIndex];
    if (!targetThreadPhase) {
      throw new Error(`Invalid target phase index: ${targetPhaseIndex}`);
    }

    const phaseConfig = this.config.phases.find(
      (p) => p.id === targetThreadPhase.phase.phaseId
    );
    const phaseName = phaseConfig?.name || targetThreadPhase.phase.phaseId;

    this.logger.log(
      `Starting phase-by-phase rollback to ${checkpointType} checkpoint ${sha} ` +
        `in phase ${targetThreadPhase.phase.phaseId} (${phaseName})`
    );

    // Set the rollback flag
    this.isRollingBack = true;

    // Execute the new phase-by-phase rollback
    // The flag will be cleared inside executePhaseByPhaseRollback before sending events
    await this.executePhaseByPhaseRollback(
      thread,
      targetPhaseIndex,
      sha,
      checkpointType,
      phaseName,
      autoRestart
    ).finally(() => {
      this.isRollingBack = false;
    });
  }

  /**
   * Execute phase-by-phase rollback with workspace cleanup
   */
  private async executePhaseByPhaseRollback(
    thread: import("./execution-thread.js").ExecutionThread,
    targetPhaseIndex: number,
    targetSha: string,
    checkpointType: string,
    targetPhaseName: string,
    autoRestart: boolean
  ): Promise<void> {
    // 1. Clean up current phase state
    this.cleanupCurrentPhase();

    // 2. Get target phase and phases to process from thread
    const targetThreadPhase = thread.phases[targetPhaseIndex];
    if (!targetThreadPhase) {
      throw new Error(`Invalid target phase index: ${targetPhaseIndex}`);
    }

    // Get all phases before target (they're already in reverse order)
    const phasesToProcess = thread.phases.slice(0, targetPhaseIndex);

    // 3. Emit rollback started event
    const fromRun = thread.phases[0]?.runId || targetThreadPhase.runId;
    const fromPhase =
      thread.phases[0]?.phase.phaseId || targetThreadPhase.phase.phaseId;

    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "rollback.started",
      data: {
        fromRun,
        fromPhase,
        toPhase: targetThreadPhase.phase.phaseId,
        toCheckpoint: targetSha,
        checkpointType,
        phasesToProcess: phasesToProcess.map((tp) => tp.phase.phaseId),
      },
    } as import("./types/types.js").RollbackStartedEvent);

    // 4. Process each phase (they're already in reverse order)
    let currentStep = 0;
    const totalSteps = phasesToProcess.length + 1; // +1 for final checkpoint

    for (const threadPhase of phasesToProcess) {
      currentStep++;

      // Emit progress
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "rollback.progress",
        data: {
          currentStep,
          totalSteps,
          message: `Rolling back through ${threadPhase.phase.phaseId}`,
        },
      } as import("./types/types.js").RollbackProgressEvent);

      // Get the last checkpoint for this phase
      const checkpoint = this.getLastCheckpointForPhase(threadPhase.phase);
      if (checkpoint && this.checkpointGit) {
        // Reset to this phase's checkpoint
        await this.checkpointGit.resetToCheckpoint(checkpoint.sha);

        // Emit checkpoint event
        const phaseConfig = this.config.phases.find(
          (p) => p.id === threadPhase.phase.phaseId
        );
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "rollback.phaseCheckpoint",
          data: {
            phaseId: threadPhase.phase.phaseId,
            phaseName: phaseConfig?.name || threadPhase.phase.phaseId,
            checkpoint: checkpoint.sha,
            checkpointType: checkpoint.type,
            message: `Reset to ${threadPhase.phase.phaseId} ${checkpoint.type} checkpoint`,
          },
        } as import("./types/types.js").RollbackPhaseCheckpointEvent);
      }

      // Clean up workspace directories from this phase
      await this.cleanupPhaseWorkspaceDirectories(threadPhase.phase);
    }

    // 5. Final reset to target checkpoint
    currentStep++;
    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "rollback.progress",
      data: {
        currentStep,
        totalSteps,
        message: `Applying final checkpoint`,
      },
    } as import("./types/types.js").RollbackProgressEvent);

    if (this.checkpointGit) {
      await this.checkpointGit.resetToCheckpoint(targetSha);
    }

    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "rollback.phaseCheckpoint",
      data: {
        phaseId: targetThreadPhase.phase.phaseId,
        phaseName: targetPhaseName,
        checkpoint: targetSha,
        checkpointType,
        message: `Reset to target checkpoint ${targetThreadPhase.phase.phaseId} (${checkpointType})`,
      },
    } as import("./types/types.js").RollbackPhaseCheckpointEvent);

    // 6. Complete current run
    const currentRun = this.stateManager.getCurrentRun();
    if (currentRun) {
      this.stateManager.transition({
        type: "RunCompleted",
        data: { runId: currentRun.runId },
      });
    }

    // 7. Wait for state transition
    await this.stateManager.waitForPendingTransitions();

    // 8. Start new continuation run
    const afterPhase =
      checkpointType === "workspace-setup"
        ? null
        : targetThreadPhase.phase.phaseId;

    await this.startNewRun({
      type: "continuation",
      source: {
        runId: targetThreadPhase.runId,
        afterPhase: afterPhase ? PhaseId(afterPhase) : null,
        checkpointSha: targetSha,
      },
      reason: "rollback",
    });

    // 9. Restore checkpoint patterns
    const targetPhaseConfigIndex = this.config.phases.findIndex(
      (p) => p.id === targetThreadPhase.phase.phaseId
    );
    if (targetPhaseConfigIndex >= 0) {
      const includeTarget = checkpointType === "workspace-setup";
      const maxIndex = includeTarget
        ? targetPhaseConfigIndex
        : targetPhaseConfigIndex - 1;

      for (let i = 0; i <= maxIndex; i++) {
        const phase = this.config.phases[i];
        if (phase.trackedFiles?.length) {
          await this.addCheckpointPatterns(phase.trackedFiles);
        }
      }
    }

    // 8.b. Wait for transitions

    await this.stateManager.waitForPendingTransitions();

    // 10. Clear rollback flag BEFORE sending events
    this.isRollingBack = false;

    // 11. Send completion event
    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "rollback.completed",
      data: {
        fromRun,
        toRun: this.currentRunId || "",
        checkpoint: targetSha,
        phaseId: targetThreadPhase.phase.phaseId,
        phaseName: targetPhaseName,
        checkpointType,
        autoRestart,
      },
    } as import("./types/types.js").RollbackCompletedEvent);

    // 12. Send state snapshot
    await this.sendStateSnapshot();

    // 12. Auto-restart if requested
    // TODO: figure out if this needs to be cleaned up
    // if we pass explicit autoRestart: true, should we ignore config.autostart?
    if (autoRestart && this.config.autostart) {
      const nextPhase = await this.stateManager.getNextPhaseToExecute();
      if (nextPhase) {
        await this.startPhase(nextPhase, checkpointType === "workspace-setup");
      }
    }
  }

  /**
   * Get the last checkpoint for a phase
   */
  private getLastCheckpointForPhase(
    phase: PhaseExecution
  ): { sha: string; type: string } | null {
    // Priority: completed > error > skipped > workspace-setup
    if (phase.status === "completed" && phase.completionCheckpoint) {
      return { sha: phase.completionCheckpoint, type: "completed" };
    }
    if (
      phase.status === "failed" &&
      "errorCheckpoint" in phase &&
      phase.errorCheckpoint
    ) {
      return { sha: phase.errorCheckpoint, type: "error" };
    }
    if (
      phase.status === "skipped" &&
      "skipCheckpoint" in phase &&
      phase.skipCheckpoint
    ) {
      return { sha: phase.skipCheckpoint, type: "skipped" };
    }
    if ("workspaceSetupCheckpoint" in phase && phase.workspaceSetupCheckpoint) {
      return { sha: phase.workspaceSetupCheckpoint, type: "workspace-setup" };
    }
    return null;
  }

  /**
   * Get workspace setup directories for a phase
   */
  private getWorkspaceSetupDirectories(phaseId: PhaseId): string[] {
    const phase = this.config.phases.find((p) => p.id === phaseId);
    if (!phase?.workspaceSetup) return [];

    const directories: string[] = [];
    for (const item of phase.workspaceSetup) {
      if (item.type === "copy" && item.copy) {
        directories.push(item.copy.to);
      }
    }
    return directories;
  }

  /**
   * Clean up workspace directories created by a phase
   */
  private async cleanupPhaseWorkspaceDirectories(
    phase: PhaseExecution
  ): Promise<void> {
    const directories = this.getWorkspaceSetupDirectories(phase.phaseId);
    if (directories.length === 0) return;

    const phaseConfig = this.config.phases.find((p) => p.id === phase.phaseId);
    const phaseName = phaseConfig?.name || phase.phaseId;

    // Emit cleanup started
    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "rollback.workspaceCleanup",
      data: {
        phaseId: phase.phaseId,
        phaseName,
        directories,
        status: "started",
      },
    } as import("./types/types.js").RollbackWorkspaceCleanupEvent);

    const successfulCleanups: string[] = [];
    const failedCleanups: { directory: string; error: string }[] = [];

    for (const dir of directories) {
      const fullPath = path.join(this.config.executionPath, dir);
      try {
        if (fs.existsSync(fullPath)) {
          await fs.promises.rm(fullPath, { recursive: true, force: true });
          this.logger.log(`Removed workspace setup directory: ${dir}`);
          successfulCleanups.push(dir);
        } else {
          // Directory doesn't exist, consider it a success
          this.logger.log(`Workspace setup directory already absent: ${dir}`);
          successfulCleanups.push(dir);
        }
      } catch (error) {
        const errorMessage = toError(error).message;
        this.logger.log(
          `Failed to remove workspace directory ${dir}: ${errorMessage}`,
          "error"
        );
        failedCleanups.push({ directory: dir, error: errorMessage });
      }
    }

    // Emit cleanup result with detailed information
    if (failedCleanups.length > 0) {
      // Partial or complete failure
      const status = successfulCleanups.length > 0 ? "partial" : "failed";
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "rollback.workspaceCleanup",
        data: {
          phaseId: phase.phaseId,
          phaseName,
          directories,
          status,
          successfulCleanups,
          failedCleanups,
          error: failedCleanups
            .map((f) => `${f.directory}: ${f.error}`)
            .join(", "),
        },
      } as import("./types/types.js").RollbackWorkspaceCleanupEvent);
    } else {
      // Complete success
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "rollback.workspaceCleanup",
        data: {
          phaseId: phase.phaseId,
          phaseName,
          directories,
          status: "completed",
          successfulCleanups,
          failedCleanups: [],
        },
      } as import("./types/types.js").RollbackWorkspaceCleanupEvent);
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
        .catch((err) =>
          this.logger.log(`Error closing log stream: ${err}`, "error")
        );
      this.processManager = undefined;
    }

    this.watchedPatterns = [];
    this.recentFileAccess = undefined;
    this.currentPhase = undefined;
    this.phaseFailureReason = undefined;
    this.isForceStopping = false;
    this.isSkippingPhase = false; // Reset skip flag after phase completion
    this.resultMessageReceived = false; // Reset result message flag

    // Clear any pending tool uses
    this.pendingToolUses.clear();
  }

  private async runCommand(
    shellCommand: ShellCommand | WorkspaceShellCommand | string,
    lastCopiedPath?: string
  ): Promise<void> {
    // Handle working directory resolution
    let workingDir: string;
    const cmd: ShellCommand | WorkspaceShellCommand =
      typeof shellCommand === "string"
        ? {
            type: "command",
            command: {
              run: shellCommand,
            },
          }
        : shellCommand;
    if (cmd.command.workingDirectory === "lastCopied") {
      if (lastCopiedPath) {
        workingDir = lastCopiedPath;
      } else {
        // Fallback to executionPath if lastCopiedPath not provided
        workingDir = this.config.executionPath;
      }
    } else {
      // Default to executionPath for "project"
      workingDir = this.config.executionPath;
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(cmd.command.run, {
        shell: true,
        cwd: workingDir,
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
      throw new Error(
        `Target parent directory does not exist: ${targetParent}`
      );
    }

    // Check if target already exists
    const targetStats = await fs.promises.stat(to).catch(() => null);
    if (targetStats) {
      throw new Error(`Target path already exists: ${to}`);
    }

    // Copy using cp command with recursive flag
    await this.runCommand(
      `cp -r ${escapeShellArg(from)} ${escapeShellArg(to)}`
    );
  }

  // ============================================================================
  // Checkpoint Methods
  // ============================================================================

  /**
   * Initialize checkpoint system - check git availability and switch branch
   */
  private async initializeCheckpoints(): Promise<void> {
    // Check if git is available
    if (!(await this.isGitAvailable())) {
      this.logger.log("Git is not available. Checkpointing disabled.", "info");
      this.checkpointingEnabled = false;
      return;
    }

    // Initialize checkpoint git
    this.checkpointGit = new CheckpointGit(
      this.config.executionPath,
      this.logger
    );
    await this.checkpointGit.initialize();

    // Provide checkpoint git to state manager for git operations
    this.stateManager.setCheckpointGit(this.checkpointGit);

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
      this.checkpointGit = new CheckpointGit(
        this.config.executionPath,
        this.logger
      );
      await this.checkpointGit.initialize();
    }

    // Add new patterns
    await this.checkpointGit.addPatterns(patterns);
    this.logger.log(`Added checkpoint patterns: ${patterns.join(", ")}`);
  }

  /**
   * Create a checkpoint commit
   */
  private async createCheckpoint(
    info: CheckpointInfo
  ): Promise<string | undefined> {
    if (!this.checkpointingEnabled || !this.checkpointGit) {
      this.logger.log(
        `[CHECKPOINT-DEBUG] Checkpoint creation skipped - enabled: ${
          this.checkpointingEnabled
        }, git: ${!!this.checkpointGit}`
      );
      return;
    }

    this.logger.log(
      `[CHECKPOINT-DEBUG] Creating checkpoint for phase ${info.phaseId} with status ${info.status}`
    );
    this.logger.log(
      `[CHECKPOINT-DEBUG] Checkpoint info: ${JSON.stringify(info)}`
    );

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
      this.logger.log(`[CHECKPOINT-DEBUG] Commit message: ${commitMessage}`);

      // Get current run's branch
      const currentRun = this.stateManager.getCurrentRun();
      const branchName = currentRun?.gitBranch || `run-${this.currentRunId}`;
      this.logger.log(`[CHECKPOINT-DEBUG] Using branch: ${branchName}`);

      // Create checkpoint on run-specific branch
      await this.checkpointGit.switchToBranch(branchName);
      const commitHash = await this.checkpointGit.commit(commitMessage);

      this.logger.log(
        `[CHECKPOINT-DEBUG] Checkpoint commit returned: ${commitHash}`
      );

      if (commitHash) {
        this.logger.log(
          `[CHECKPOINT-DEBUG] Created checkpoint: ${commitHash} (${info.status}) on branch ${branchName}`
        );

        // Fire checkpoint created transition to store SHA in state
        const checkpointType =
          info.status === "workspace-setup"
            ? "workspace-setup"
            : info.status === "completed"
            ? "completed"
            : info.status === "error"
            ? "error"
            : "skipped";

        this.logger.log(
          `[CHECKPOINT-DEBUG] Firing CheckpointCreated transition with type: ${checkpointType}`
        );

        if (this.currentRunId) {
          this.stateManager.transition({
            type: "CheckpointCreated",
            data: {
              runId: this.currentRunId,
              phaseId: PhaseId(info.phaseId),
              checkpointType,
              sha: commitHash,
              branch: branchName,
            },
          });
        }

        return commitHash;
      } else {
        this.logger.log(
          `[CHECKPOINT-DEBUG] No commit hash returned from checkpoint.commit()`
        );
      }
    } catch (error) {
      // Handle disk full or other git errors
      this.logger.log(
        `[CHECKPOINT-DEBUG] Checkpoint failed: ${toError(error).message}. ` +
          "Disabling checkpointing for this session.",
        "error"
      );
      this.checkpointingEnabled = false;
    }
  }

  // ============================================================================
  // Shutdown & Cleanup
  // ============================================================================

  /**
   * Shutdown the Tadpole server gracefully.
   * @param reason - The reason for shutdown (e.g., "client request", "SIGINT", "test cleanup")
   * @param exitProcess - Whether to exit the process after shutdown (default: true).
   *                      Set to false in test environments to prevent the test runner from terminating.
   */
  async shutdown(reason: string, exitProcess = true): Promise<void> {
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
    if (
      reason !== "all phases completed" &&
      this.checkpointingEnabled &&
      this.currentPhase
    ) {
      await this.createCheckpoint({
        status: "exit",
        phaseId: this.currentPhase.phase.id,
        phaseName: this.currentPhase.phase.name,
        runId: this.currentRunId || RunId("unknown"),
        timestamp: new Date().toISOString(),
      });
    }

    this.cleanupCurrentPhase();

    // Mark run as completed or failed based on reason
    if (this.currentRunId && reason === "all phases completed") {
      this.stateManager.transition({
        type: "RunCompleted",
        data: { runId: this.currentRunId },
      });
    } else if (this.currentRunId && reason !== "phase failure") {
      // Phase failure already marked the run as failed
      this.stateManager.transition({
        type: "RunFailed",
        data: { runId: this.currentRunId },
      });
    }

    // Wait for any pending state transitions
    await this.stateManager.waitForPendingTransitions();

    // Clear heartbeat interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

    // Close all connected clients
    for (const [clientId, client] of this.clients) {
      try {
        client.close();
      } catch (error) {
        this.logger.log(`Error closing client ${clientId}: ${error}`, "error");
      }
    }
    this.clients.clear();

    if (this.server) {
      this.server.stop();
      this.server = null;
    }

    // Stop proxy server
    if (this.proxyRunner) {
      this.proxyRunner.stop();
      this.proxyRunner = null;
    }

    // Close event journal
    try {
      // Event journal no longer requires explicit shutdown
      this.logger.log("Event journal closed");
    } catch (error) {
      this.logger.log(`Error closing event journal: ${error}`, "error");
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

    // Conditionally exit the process based on the exitProcess parameter
    // In production, we want to exit the process after shutdown
    // In tests, we don't want to exit to allow other tests to run
    if (exitProcess && reason !== "running integration test") {
      // Small delay to ensure log is written before process exits
      setTimeout(() => {
        process.exit(0);
      }, TIMEOUTS.PHASE_CLEANUP_DELAY_MS);
    }
  }
}
