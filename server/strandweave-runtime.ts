import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { minimatch } from "minimatch";
import { CheckpointGit } from "./checkpoint-git.js";
import { CodonRunner } from "./codon-runner.js";
import { type ClientCommand, clientCommandSchema } from "./command-schemas.js";
import { calculateCost, DEFAULT_CONFIG, TIMEOUTS } from "./config.js";
import { EventJournal } from "./event-journal.js";
import { analyzeExecutionThread, findContinuationSessionId } from "./execution-thread.js";
import { fileResolver } from "./file-resolver.js";
import { BunProxyRunner } from "./llm-proxy.js";
// Import event types from new schema file
import type {
  AssistantActionEvent,
  CodonCompletedEvent,
  CodonStartedEvent,
  ErrorEvent,
  FileTreeUpdatedEvent,
  FileUpdatedEvent,
  HistoryBatchEvent,
  InfoEvent,
  PongEvent,
  ServerEvent,
  ServerReadyEvent,
  StateSnapshotEvent,
  TokenUsageEvent,
} from "./schemas/event-schemas.js";
import {
  isAgenticBackboneEvent,
  isConnectionStateEvent,
  isSentinelEvent,
  isServerStateEvent,
} from "./schemas/event-schemas.js";
import { SentinelConfigLoader } from "./sentinels/sentinel-config-loader.js";
import { SentinelManager } from "./sentinels/sentinel-manager.js";
import { StateManager } from "./state-manager.js";
import { FileEventStorage } from "./storage/file-event-storage.js";
import { type ServerInternalEvents, TypedEventEmitter } from "./typed-event-emitter.js";
import { CodonId, EventId, RunId, SessionId } from "./types/branded-types.js";
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
  type CodonExecution,
  type CodonStatus,
  isTerminalCodonStatus,
} from "./types/state-types.js";
import type { ToolInputMap, ToolName } from "./types/tool-types.js";
import type {
  CheckpointInfo,
  ClaudeLogMessage,
  ClientData,
  Codon,
  CodonConfig,
  FailureReason,
  HandshakeRequest,
  HandshakeResponse,
  RigShellCommand,
  ShellCommand,
  StrandweaveConfig,
  TokenUsage,
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
 * Use `grep -A1 "// ====" strandweave-runtime.ts | grep "//"` to see all sections.
 */

/**
 * Main server class that orchestrates Claude codons.
 *
 * Responsibilities:
 * - WebSocket server management (multiple clients)
 * - Codon execution and lifecycle
 * - Claude process management
 * - File watching and change detection
 * - State persistence and recovery
 * - Cost tracking and reporting
 * - Event streaming to clients
 */
export class StrandweaveRuntime extends TypedEventEmitter<ServerInternalEvents> {
  private server: Server<ClientData> | null = null;
  private clients: Map<string, ServerWebSocket<ClientData>> = new Map();
  public readonly config: StrandweaveConfig;
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
      codonId: string;
    }
  > = new Map();

  // Temporary state during codon execution
  private watchedPatterns: string[] = [];
  private currentCodon:
    | {
        status: "initializing" | "running";
        codonId: CodonId; // Runtime codon ID (e.g., "review#0", "review#1" for loops)
        codon: Codon; // Only codons can be executed (loops are expanded first)
        previousSessionId?: SessionId;
        sessionId?: SessionId;
        startTime: Date;
        codonCost: number;
        codonTokens: TokenUsage;
      }
    | undefined;
  private recentFileAccess:
    | {
        path: string;
        content: string;
        timestamp: Date;
      }
    | undefined;
  private currentCodonRunner: CodonRunner | undefined;
  private serverStartTime: Date;
  private isShuttingDown = false;
  private isSkippingCodon = false;

  // Checkpoint-related properties
  private checkpointGit: CheckpointGit | null = null;
  private checkpointingEnabled = true;

  // Failure tracking
  private codonFailureReason?: FailureReason;
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

  // Sentinel system
  private sentinelManager: SentinelManager;
  private sentinelConfigLoader: SentinelConfigLoader;
  private currentCodonSentinels = new Set<string>();

  constructor(
    config: Omit<StrandweaveConfig, keyof typeof DEFAULT_CONFIG> &
      Partial<Pick<StrandweaveConfig, keyof typeof DEFAULT_CONFIG>> & {
        codons: CodonConfig[];
      },
  ) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    } as StrandweaveConfig;

    // Update logger to use execution path
    this.logger = new Logger(path.join(this.config.executionPath, this.config.serverLogFile));
    this.serverStartTime = new Date();

    // Initialize state manager with execution path
    const strandweaveDir = path.join(this.config.executionPath, ".strandweave");
    this.stateManager = new StateManager(strandweaveDir, this.logger, this.config.codons);

    // Initialize Event Journal with file-based storage
    this.eventJournal = new EventJournal(new FileEventStorage(path.join(strandweaveDir, "events")));

    // Initialize sentinel config loader (stateful, with cache)
    this.sentinelConfigLoader = new SentinelConfigLoader(this.logger);

    // Initialize SentinelManager
    this.sentinelManager = new SentinelManager({
      logger: this.logger,
      enablePersistence: this.config.sentinel.enablePersistence,
      healthCheckGracePeriodMs: this.config.sentinel.healthCheckGracePeriodMs,
      waitForHealthChecks: this.config.sentinel.waitForAllHealthChecks,
      rootDirectory: this.config.executionPath, // Ensure sentinel files are in execution directory
    });

    // Set up state manager listeners
    this.setupStateManagerListeners();
  }

  private setupStateManagerListeners(): void {
    this.stateManager.on("codonRunning", (data) => {
      // State is already saved when we get here
      const codon = this.stateManager.getCurrentlyRunningCodon();
      if (codon && "claudeSessionId" in codon) {
        // Look up codon config in execution plan
        const entry = this.stateManager.getCodonById(data.codonId);
        if (entry) {
          this.emit("event", {
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "codon.started",
            data: {
              codonId: data.codonId,
              codonName: entry.codon.name,
              codonDescription: entry.codon.description,
              sessionId: codon.claudeSessionId,
              previousSessionId: "previousSessionId" in codon ? codon.previousSessionId : undefined,
              startTime: codon.startTime,
            },
          } as CodonStartedEvent);
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
   * Set up event routing to sentinels using EventEmitter pattern.
   * Listening on the server's own "event" emissions is cleaner than
   * modifying the emit() override method.
   *
   * Event Filtering Design:
   * - Server State events → Sentinels ✓ (codon lifecycle, errors, etc.)
   * - Agentic Backbone events → Sentinels ✓ (assistant actions, tool results, file updates)
   * - Connection State events → NOT routed (client-specific, e.g., pong, handshake)
   * - Sentinel events → NOT routed (prevents infinite loops)
   *
   * Sentinel events (sentinel.loaded, sentinel.output, etc.) are persisted
   * and broadcast to clients like Server State events, but intentionally NOT
   * sent back to sentinels to avoid self-observation loops.
   */
  private setupSentinelEventRouting(): void {
    this.on("event", (event) => {
      // Only route Server State and Agentic Backbone events
      // Connection State events are client-specific
      // Sentinel events are intentionally NOT routed (isSentinelEvent check would go here)
      if (isServerStateEvent(event) || isAgenticBackboneEvent(event)) {
        // Fire-and-forget pattern - don't block event emission
        this.sentinelManager.handleEvent(event).catch((error) => {
          this.logger.log(`Error in sentinel event handling: ${error}`, "error");
        });
      }
    });
  }

  /**
   * Convert a state transition to a server event and emit it for journaling.
   * This provides an audit trail of all state machine transitions.
   */
  private emitStateTransitionEvent(
    transition: import("./types/state-types.js").StateTransition,
  ): void {
    // Extract relevant IDs from transition data
    let runId: string | undefined;
    let codonId: string | undefined;

    if ("runId" in transition.data) {
      runId = transition.data.runId as string;
    }
    if ("codonId" in transition.data) {
      codonId = transition.data.codonId as string;
    }

    const stateTransitionEvent: import("./schemas/event-schemas.js").StateTransitionEvent = {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "state.transition",
      data: {
        transitionType: transition.type,
        runId,
        codonId,
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

  // -------------
  // Initialization & Server Management
  // -------------

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
      `Starting Strandweave Runtime v${this.config.version} in ${this.config.executionPath}`,
    );

    // Start proxy server first (if not disabled)
    if (!this.config.withoutProxy) {
      const proxyPort = this.config.port + 1;
      this.logger.log(`Starting proxy server on port ${proxyPort}`);

      this.proxyRunner = new BunProxyRunner(
        "passthrough",
        proxyPort,
        this.config.anthropicBaseUrl || "https://api.anthropic.com",
        this.logger,
      );
      this.proxyRunner.start();
    } else {
      this.logger.log("Proxy server disabled");
    }

    // Initialize checkpoint system (checks for existing .strandweave)
    await this.initializeCheckpoints();

    // Initialize state manager
    await this.stateManager.initialize();

    // Initialize event journal
    await this.eventJournal.initialize();

    // Initialize SentinelManager (creates .strandweave/sentinels directory)
    await this.sentinelManager.initialize();

    // Codon 2: Set up event callback for sentinel events
    this.sentinelManager.setEventCallback((sentinelEvent) => {
      // Sentinel events are ServerEvents - emit them to the event stream
      this.emit("event", sentinelEvent);
    });

    // Set up event routing to sentinels
    this.setupSentinelEventRouting();

    // Check for existing lock file
    if (fs.existsSync(this.config.lockFile)) {
      const lockData = fs.readFileSync(this.config.lockFile, "utf-8");

      // Parse lock file for enhanced data
      try {
        const lockInfo = JSON.parse(lockData);
        const heartbeatAge = Date.now() - new Date(lockInfo.lastHeartbeat).getTime();

        // First check if the process is actually running
        const processRunning = this.isProcessRunning(lockInfo.pid);

        if (!processRunning) {
          // Process is not running - this is a crash regardless of heartbeat age
          this.logger.log(`Found lock file from dead process (PID: ${lockInfo.pid}), removing...`);
          fs.unlinkSync(this.config.lockFile);

          // Mark the run as crashed
          if (lockInfo.runId) {
            this.stateManager.transition({
              type: "RunCrashed",
              data: {
                runId: RunId(lockInfo.runId),
                detectedAt: new Date().toISOString(),
                lastCodonStatus: "unknown" as CodonStatus,
              },
            });
          }
        } else if (heartbeatAge > 120000) {
          // Process is running but heartbeat is stale (> 2 minutes)
          this.logger.log(`Found stale lock file (heartbeat age: ${heartbeatAge}ms), removing...`);
          fs.unlinkSync(this.config.lockFile);

          // Mark the run as crashed
          if (lockInfo.runId) {
            this.stateManager.transition({
              type: "RunCrashed",
              data: {
                runId: RunId(lockInfo.runId),
                detectedAt: new Date().toISOString(),
                lastCodonStatus: "unknown" as CodonStatus,
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
              `Server already running (PID: ${lockInfo.pid}, Run: ${lockInfo.runId})`,
            );
          }
        }
      } catch (_e) {
        // Old format lock file - just PID
        throw new Error(
          `Server already running (PID: ${lockData}). Remove ${this.config.lockFile} if this is incorrect.`,
        );
      }
    }

    const thread = await this.stateManager.getExecutionThread();

    if (thread?.failed) {
      // let see if execution thread from state manager has previously failed
      this.logger.log("Execution thread failed, rolling back...", "error");
      await this.rollbackToLastSuccess(this.config.autostart);
    }

    if (!thread?.failed && !this.currentRunId) {
      // Start a new run if needed
      // Check if there's an existing execution thread with completed codons
      // If so, create a continuation run instead of a fresh run
      let lastCompletedCodon = thread?.codons.find((tc) => tc.codon.status === "completed");

      // If the thread is empty (e.g., latest run is an empty fresh run),
      // search directly through state runs to find the last completed codon
      if (!lastCompletedCodon && thread?.codons.length === 0) {
        const state = this.stateManager.getState();
        for (const run of state.runs) {
          // Skip empty runs
          if (run.codons.length === 0) continue;

          // Find the last completed codon in this run (codons are in chronological order)
          for (let i = run.codons.length - 1; i >= 0; i--) {
            const codon = run.codons[i];
            if (codon.status === "completed" && codon.completionCheckpoint) {
              this.logger.log(
                `Thread was empty, found last completed codon by searching state: ${codon.codonId} in run ${run.runId}`,
              );
              // Create a minimal structure to use below
              lastCompletedCodon = {
                codon: codon,
                runId: run.runId,
              } as import("./execution-thread.js").ThreadCodon;
              break;
            }
          }
          if (lastCompletedCodon) break;
        }
      }

      if (lastCompletedCodon && lastCompletedCodon.codon.status === "completed") {
        // Create continuation from last completed codon
        this.logger.log(
          `Resuming from last completed codon: ${lastCompletedCodon.codon.codonId} in run ${lastCompletedCodon.runId}`,
        );
        await this.startNewRun({
          type: "continuation",
          source: {
            runId: lastCompletedCodon.runId,
            afterCodon: lastCompletedCodon.codon.codonId,
            checkpointSha: lastCompletedCodon.codon.completionCheckpoint,
          },
          reason: "continue",
        });
      } else {
        // No completed codons - start fresh
        await this.startNewRun();
      }

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
            this.logger.log(`Failed to switch to run branch: ${error}`, "error");
          }
        } else {
          this.logger.log(
            `Fresh run ${currentRun.runId} - branch will be created on first checkpoint`,
          );
        }
      }
    }

    // Start Bun WebSocket server
    this.server = Bun.serve<ClientData>({
      port: this.config.port,
      websocket: {
        open: (ws) => this.handleConnection(ws),
        message: (ws, message) => this.handleMessage(ws, message),
        close: (ws) => this.handleClose(ws),
      },
      fetch(req, server) {
        // Upgrade to WebSocket
        const now = new Date();
        if (
          server.upgrade(req, {
            data: {
              id: generateId(),
              connectionTime: now,
              lastActivity: now,
              handshakeComplete: false,
            },
          })
        ) {
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
      if (error.stack) {
        this.logger.log(`Stack trace:\n${error.stack}`, "error");
      }
      this.shutdown("uncaughtException");
    });
    process.on("unhandledRejection", (reason, promise) => {
      this.logger.log(`Unhandled rejection at: ${promise}, reason: ${reason}`, "error");
      // Log the full stack trace if the reason is an Error
      if (reason instanceof Error) {
        this.logger.log(`Error name: ${reason.name}`, "error");
        this.logger.log(`Error message: ${reason.message}`, "error");
        if (reason.stack) {
          this.logger.log(`Stack trace:\n${reason.stack}`, "error");
        }
      } else if (reason && typeof reason === "object") {
        // Try to extract any useful info from non-Error objects
        try {
          this.logger.log(`Reason object: ${JSON.stringify(reason, null, 2)}`, "error");
        } catch {
          this.logger.log(`Reason (unstringifiable): ${String(reason)}`, "error");
        }
      }
      this.shutdown("unhandledRejection");
    });
  }

  // -------------
  // WebSocket Connection Management
  // -------------

  private handleConnection(ws: ServerWebSocket<ClientData>): void {
    // Data is already initialized in the fetch handler during upgrade
    const clientId = ws.data.id;
    this.logger.log(`Client ${clientId} connected`);

    this.clients.set(clientId, ws);

    // Wait for handshake before sending events
    // Handshake will send initial state and handle autostart
    this.logger.log(`Client ${clientId} waiting for handshake`);
  }

  private async handleHandshake(
    ws: ServerWebSocket<ClientData>,
    request: HandshakeRequest,
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
      ? await this.eventJournal.getMostRecentEvents(this.config.handshakeHistoryLimit)
      : {
          events: [],
          totalEvents: await this.eventJournal.getTotalEvents(),
          hasMore: false,
        };

    this.logger.log(
      `Sending ${recentEvents.length} events (of ${totalEvents} total) to client ${clientId}` +
        (sendPreviousEvents ? " (limited history)" : " (no history)") +
        (hasMore ? " with additional history available via download" : ""),
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
    this.logger.log(`Handshake complete for client ${clientId} (${grantedMode})`);

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

    if (this.config.autostart) {
      this.autoStartNextCodon();
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

  private async handleMessage(
    ws: ServerWebSocket<ClientData>,
    message: string | Buffer,
  ): Promise<void> {
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
          ws,
        );
        return;
      }

      const result = clientCommandSchema.safeParse(parsed);

      if (!result.success) {
        this.logger.log(`Invalid client command: ${result.error.message}`, "error");
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
          ws,
        );
        return;
      }
      // Await handleCommand to properly catch any errors from async operations
      await this.handleCommand(result.data, ws);
    } catch (error) {
      const err = toError(error);
      this.logger.log(`Error handling command: ${err.message}`, "error");
      if (err.stack) {
        this.logger.log(`Stack trace: ${err.stack}`, "error");
      }
      // Emit error event to client
      this.emit(
        "event",
        {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "error",
          data: {
            message: `Command execution failed: ${err.message}`,
            fatal: false,
          },
        } as ErrorEvent,
        ws,
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

  // -------------
  // Command Processing
  // -------------

  private async handleCommand(
    command: ClientCommand,
    sender: ServerWebSocket<ClientData>,
  ): Promise<void> {
    this.logger.log(`Handling command: ${command.type}`);

    // Check if command is blocked during rollback
    if (this.isRollingBack && !this.READ_ONLY_COMMANDS.has(command.type)) {
      this.logger.log(
        `Client ${sender.data.id} attempted state-modifying command while rollback is in progress`,
        "error",
      );
      this.emit(
        "event",
        {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "error",
          data: {
            message: "Cannot execute state-modifying commands while rollback is in progress",
            context: `Attempted command: ${command.type}`,
            codon: this.currentCodon?.codon.id,
            fatal: false,
            severity: ErrorSeverity.OPERATION,
            code: "ROLLBACK_IN_PROGRESS",
          },
        } as ErrorEvent,
        sender,
      );
      return;
    }

    // Check if sender has permission for state-modifying commands
    if (!this.READ_ONLY_COMMANDS.has(command.type)) {
      // This is a state-modifying command
      if (!sender.data.handshakeComplete) {
        this.logger.log(
          `Client ${sender.data.id} attempted state-modifying command without handshake`,
          "error",
        );
        this.emit(
          "event",
          {
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "error",
            data: {
              message: "Cannot execute state-modifying commands without handshake",
              context: `Attempted command: ${command.type}`,
              codon: this.currentCodon?.codon.id,
              fatal: false,
              severity: ErrorSeverity.OPERATION,
              code: "HANDSHAKE_REQUIRED",
            },
          } as ErrorEvent,
          sender,
        );
        return;
      }

      // Check if sender has read-write mode
      if (sender.data.mode === ClientMode.READONLY) {
        this.logger.log(
          `Client ${sender.data.id} attempted state-modifying command in read-only mode`,
          "error",
        );
        this.emit(
          "event",
          {
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "error",
            data: {
              message: "Cannot execute state-modifying commands in read-only mode",
              context: `Attempted command: ${command.type}`,
              codon: this.currentCodon?.codon.id,
              fatal: false,
              severity: ErrorSeverity.OPERATION,
              code: "INSUFFICIENT_PERMISSIONS",
            },
          } as ErrorEvent,
          sender,
        );
        return;
      }
    }

    switch (command.type) {
      case "codon.start": {
        await this.startCodon(command.data.codonId, command.data.skipPreCommands);
        break;
      }

      case "codon.next":
        await this.startNextCodon();
        break;

      case "codon.skip":
        await this.skipCurrentCodon();
        break;

      case "codon.redo":
        await this.redoCurrentCodon();
        break;

      case "server.shutdown":
        await this.shutdown(command.data?.reason || "client request");
        break;

      case "checkpoint.list":
        await this.listCheckpoints(command.data?.runId);
        break;

      case "codon.forceStop":
        await this.forceStopCodon(command.data?.reason);
        break;

      case "rollback.toCheckpoint":
        await this.rollbackToCheckpoint(
          command.data.checkpointSha,
          command.data.autoRestart ?? false,
        );
        break;

      case "rollback.toCodon":
        await this.rollbackToCodon(
          command.data.codonId,
          command.data.checkpointType,
          command.data.autoRestart ?? false,
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

  // -------------
  // Ping Commands (for testing)
  // -------------

  private handlePing(commandId: string, sender?: ServerWebSocket<ClientData>): void {
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
      this.logger.log("Ping command received but no valid sender provided", "error");
    }
  }

  private handlePingBroadcast(commandId: string, sender?: ServerWebSocket<ClientData>): void {
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

  // -------------
  // History Sync Command
  // -------------

  private async handleHistorySync(
    command: import("./schemas/event-schemas.js").HistorySyncCommand,
    sender?: ServerWebSocket<ClientData>,
  ): Promise<void> {
    if (!sender?.data.handshakeComplete) {
      this.logger.log("History sync command received but sender not ready", "error");
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

  // -------------
  // Event & State Management
  // -------------

  private sendHistoryBatch(
    sender: ServerWebSocket<ClientData>,
    events: ServerEvent[],
    hasMore: boolean,
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
      this.logger.log(`Sent ${events.length} events to client ${sender.data.id}`);
    } catch (error) {
      this.logger.log(
        `Failed to send history batch to client ${sender.data.id}: ${error}`,
        "error",
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
    target?: ServerWebSocket<ClientData>,
  ): boolean {
    if (event !== "event") {
      // Should relax this restriction eventually
      this.logger.log(`Unsupported event type emitted: ${event}`, "error");
      throw new Error(`Unsupported event type: ${event}. Can only emit "event" events.`);
    }

    const serverEvent = data as ServerEvent;
    const isServerState = isServerStateEvent(serverEvent);
    const isAgenticBackbone = isAgenticBackboneEvent(serverEvent);
    const isSentinel = isSentinelEvent(serverEvent);
    const isConnectionState = isConnectionStateEvent(serverEvent);

    // this should never happen due to compile time checks, but...
    if (!isServerState && !isAgenticBackbone && !isSentinel && !isConnectionState) {
      // This should never happen - all ServerEvents should be categorized
      this.logger.log(`Unknown event type: ${(serverEvent as ServerEvent).type}`, "error");
      throw new Error(`Unknown event: ${(serverEvent as ServerEvent).type}`);
    }

    // early exit if we have a connection state event without a target
    if (isConnectionState && !target) {
      this.logger.log(
        `Connection state event ${serverEvent.type} requires a target client but none provided`,
        "error",
      );
      return false;
    }

    // Journal and broadcast events that should reach all clients when no target is provided
    if ((isServerState || isAgenticBackbone || isSentinel) && !target) {
      // Server state or agentic backbone events without target: journal and broadcast to all clients
      // Use queue to ensure events are written in the order they're emitted
      this.eventJournalAppendQueue = this.eventJournalAppendQueue
        .then(() => this.eventJournal.append(serverEvent))
        .catch((error) => {
          this.logger.log(`Error appending event to journal: ${error}`, "error");
        });

      // Broadcast to all connected clients that have completed handshake
      if (this.clients.size > 0) {
        for (const [_, client] of this.clients) {
          if (!client.data.handshakeComplete) continue;
          try {
            client.send(JSON.stringify(serverEvent));
          } catch (error) {
            this.logger.log(`Failed to send event to client ${client.data.id}: ${error}`, "error");
          }
        }
      }
    } else {
      try {
        target?.send(JSON.stringify(serverEvent));
      } catch (error) {
        this.logger.log(`Failed to send event to client ${target?.data.id}: ${error}`, "error");
      }
    }

    // Continue with normal emission for tests/TUI
    return super.emit(event, data);
  }

  private async sendStateSnapshot(): Promise<void> {
    const totalCost = this.stateManager.getTotalCost();
    const totalTime = this.serverStartTime ? Date.now() - this.serverStartTime.getTime() : 0;

    // Get terminal codons using execution thread
    const terminalCodons = await this.getTerminalCodonsForSnapshot();

    // Get the currently executing codon
    const currentCodon = this.stateManager.getCurrentlyRunningCodon();

    const stateSnapshotEvent: StateSnapshotEvent = {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "state.snapshot",
      data: {
        currentCodon: currentCodon || undefined,
        completedCodons: terminalCodons,
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

  // Get terminal codons for snapshot - returns all terminal codons (completed, failed, skipped)
  private async getTerminalCodonsForSnapshot(): Promise<CodonExecution[]> {
    const thread = await this.stateManager.getExecutionThread();

    // Filter for terminal codons and extract just the codon execution objects
    return thread.codons
      .filter((threadCodon) => isTerminalCodonStatus(threadCodon.codon.status))
      .map((threadCodon) => threadCodon.codon);
  }

  /**
   * Start a new run and create necessary infrastructure
   */
  private async startNewRun(
    startingConditions?: import("./types/state-types.js").StartingConditions,
  ): Promise<void> {
    const runId = RunId(`${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
    const runFolder = path.join(this.config.executionPath, ".strandweave", "runs", runId);

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

  // -------------
  // Codon Execution & Management
  // -------------

  /**
   * Start execution of a specific codon.
   *
   * @param codonId - ID of the codon to start
   * @param skipPreCommands - Skip pre-start commands (useful for retries)
   *
   * Process:
   * 1. Validate codon exists and no codon is currently running
   * 2. Run pre-start command if specified
   * 3. Get previous session ID if continuing
   * 4. Initialize codon state
   * 5. Start file watching if configured
   * 6. Send codon.started event
   * 7. Spawn Claude process with prompt
   */
  private async startCodon(codonId: CodonId, skipPreCommands?: boolean): Promise<void> {
    // Look up in execution plan (Step 4 of looping codons plan)
    const entry = this.stateManager.getCodonById(codonId);
    if (!entry) {
      await this.handleError(
        new Error(`Unknown codon: ${codonId}`),
        "startCodon",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    const codon = entry.codon;

    this.logger.log(`Starting codon: ${codon.name}`);

    // pull existing history for the codon and see if we had run rig setup for it
    // git seems the best source of rig setup related info
    const codonHistory = await this.stateManager.getCodonHistory(CodonId(codon.id));
    let rigSetupCheckpoint: string | undefined;
    for (const entry of codonHistory) {
      if ("rigSetupCheckpoint" in entry.codon && entry.codon.rigSetupCheckpoint) {
        rigSetupCheckpoint = entry.codon.rigSetupCheckpoint;
        break;
      }
    }

    if (rigSetupCheckpoint) {
      this.logger.log(`Found existing rig setup checkpoint: ${rigSetupCheckpoint}`);
    }

    // Check if codon already running via state manager (single source of truth)
    const currentCodon = this.stateManager.getCurrentlyRunningCodon();
    if (currentCodon && !isTerminalCodonStatus(currentCodon.status)) {
      await this.handleError(
        new Error(`Codon already running: ${currentCodon.codonId}`),
        "startCodon",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    // Check if this codon was already attempted in current run
    const currentRun = this.stateManager.getCurrentRun();
    if (currentRun) {
      const previousAttempt = currentRun.codons.find((p) => p.codonId === codonId);
      if (previousAttempt && isTerminalCodonStatus(previousAttempt.status)) {
        // Codon was already attempted and finished - start new run
        this.logger.log(`Codon ${codonId} was already attempted in current run, starting new run`);

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
            afterCodon: null, // Start from beginning of this codon
            checkpointSha: "", // Will use current state
          },
          reason: "retry", // Use 'retry' for codon restart
        });
      }
    }

    // Create codon started transition (fire-and-forget)

    if (!this.currentRunId) {
      await this.handleError(new Error("No active run"), "startCodon", ErrorSeverity.FATAL);
      return;
    }

    this.stateManager.transition({
      type: "CodonStarted",
      data: {
        runId: this.currentRunId,
        codonId: codonId, // Use the runtime-generated ID (e.g., "review#0", "review#1")
        loopContext: entry.loopContext,
      },
    });

    // Always transition from preparing to starting
    if (!this.currentRunId) {
      await this.handleError(
        new Error("No active run during codon start"),
        "startCodon",
        ErrorSeverity.FATAL,
      );
      return;
    }

    // Run rig setup operations if configured and we don't ask for explicit skip
    // and there is no existing rig setup checkpoint for this codon
    if (!skipPreCommands && !rigSetupCheckpoint && codon.rigSetup) {
      this.logger.log(`Running rig setup for codon: ${codon.name}`);
      let lastCopiedPath: string | null = null;

      for (const [index, item] of codon.rigSetup.entries()) {
        try {
          if (item.type === "copy" && item.copy) {
            const targetPath = path.join(this.config.executionPath, item.copy.to);
            this.logger.log(`Copying ${item.copy.from} to ${targetPath}`);
            // Check if target path already exists
            if (fs.existsSync(targetPath)) {
              this.logger.log(
                `Warning: Target path already exists: ${targetPath}. Removing it before copying.`,
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
            this.logger.log(`Ran command in ${resolvedWorkingDir}: ${item.command.run}`);
          }
        } catch (error) {
          const errorMessage = toError(error).message;

          // Check if this operation allows failure
          if (item.allowFailure) {
            // Log warning but continue execution
            this.logger.log(
              `Rig setup operation failed (allowFailure=true) at item ${
                index + 1
              } (${JSON.stringify(item)}): ${errorMessage}`,
              "info",
            );

            // Emit non-fatal warning event
            this.emit("event", {
              id: EventId(generateId()),
              timestamp: new Date().toISOString(),
              type: "error",
              data: {
                message: `Rig setup operation failed but continuing (allowFailure=true): ${errorMessage}`,
                context: `Codon ${codon.id} - ${item.type} operation (item ${index + 1})`,
                codon: codon.id,
                fatal: false,
                severity: ErrorSeverity.OPERATION,
              },
            } as ErrorEvent);

            // Continue to next rig setup item
            continue;
          }

          // Fatal error - operation does not allow failure
          this.logger.log(
            `Rig setup failed at item ${index + 1} (${JSON.stringify(item)}): ${errorMessage}`,
            "error",
          );

          // Set failure reason with detailed information
          this.codonFailureReason = {
            type: "unknown",
            retriable: true,
            message: `Rig setup failed at ${item.type} operation: ${errorMessage}`,
          };

          // Transition codon to failed state
          if (this.currentRunId) {
            this.stateManager.transition({
              type: "CodonTransitioned",
              data: {
                runId: this.currentRunId,
                codonId: codonId,
                from: "preparing",
                to: "failed",
                metadata: {
                  failedDuring: "preparing",
                  failureReason: this.codonFailureReason,
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
              message: `Rig setup failed: ${errorMessage}`,
              context: `Codon ${codon.id} - ${item.type} operation (item ${index + 1})`,
              codon: codon.id,
              fatal: true,
              severity: ErrorSeverity.FATAL,
            },
          } as ErrorEvent);

          // Clean up and handle error
          this.cleanupCurrentCodon();
          await this.handleError(
            toError(error),
            `Rig setup item ${index + 1}`,
            ErrorSeverity.FATAL,
          );
          return;
        }
      }
    }

    // Transition to starting after preparing (regardless of rig setup)
    this.stateManager.transition({
      type: "CodonTransitioned",
      data: {
        runId: this.currentRunId,
        codonId: codonId,
        from: "preparing",
        to: "starting",
        metadata: {
          checkpointSha: rigSetupCheckpoint,
        },
      },
    });

    // Load sentinels for this codon (during "starting" state)
    const sentinelResult = await this.loadSentinelsForCodon(codon, codonId);

    // Check for fatal sentinel load failures
    const fatalFailures = sentinelResult.errors.filter((e) => e.fatal);
    if (fatalFailures.length > 0) {
      const failedSentinels = fatalFailures.map((e) => e.ref).join(", ");
      const errorMsg = `Required sentinels failed to load (failCodonIfNotLoaded=true): ${failedSentinels}`;

      // Use specific failure reason type
      this.codonFailureReason = {
        type: "sentinel-load-failure",
        retriable: false,
        message: errorMsg,
        sentinelRefs: fatalFailures.map((e) => e.ref),
      };

      this.stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: this.currentRunId,
          codonId: CodonId(codon.id),
          from: "starting",
          to: "failed",
          metadata: {
            failedDuring: "starting",
            failureReason: this.codonFailureReason,
          },
        },
      });

      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: errorMsg,
          context: `Failed sentinels: ${failedSentinels}`,
          codon: codon.id,
          fatal: true,
          severity: ErrorSeverity.CODON,
          code: "SENTINEL_LOAD_FAILURE",
        },
      } as ErrorEvent);

      this.cleanupCurrentCodon();
      return;
    }

    // Log warnings for non-fatal failures
    for (const error of sentinelResult.errors.filter((e) => !e.fatal)) {
      this.logger.log(
        `Non-required sentinel failed to load (${error.ref}): ${error.error}`,
        "info",
      );
    }

    // Add checkpoint patterns - accumulate from all codons up to current
    // This ensures resume functionality works correctly
    const currentCodonIndex = this.config.codons.findIndex((p) => p.id === codon.id);
    if (currentCodonIndex >= 0) {
      // Accumulate patterns from all codons up to and including current
      for (let i = 0; i <= currentCodonIndex; i++) {
        const codonConfig = this.config.codons[i];
        // Only codons have trackedFiles (not loops)
        if (
          codonConfig.type !== "loop" &&
          codonConfig.trackedFiles &&
          codonConfig.trackedFiles.length > 0
        ) {
          await this.addCheckpointPatterns(codonConfig.trackedFiles);
        }
      }

      // Create checkpoint after rig setup if we have rig setup
      if (!skipPreCommands && codon.rigSetup && this.checkpointingEnabled) {
        await this.createCheckpoint({
          status: "rig-setup",
          codonId: codonId,
          codonName: codon.name,
          runId: this.currentRunId || RunId("unknown"),
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Get previous session ID if needed
    let previousSessionId: string | null = null;

    if (codon.continuationMode === "continue-previous") {
      // Build execution thread to find continuation session
      const state = this.stateManager.getState();
      const thread = await analyzeExecutionThread(
        state,
        undefined, // No checkpoint data needed for session lookup
        undefined, // Use latest run
        this.logger,
      );

      const sessionId = findContinuationSessionId(thread, codonId, state);
      previousSessionId = sessionId;

      if (previousSessionId) {
        this.logger.log(
          `Codon ${codonId} will continue from previous session: ${previousSessionId}`,
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
        // Codon requires continuation but no valid session found - this is an error
        const errorMessage = `Codon ${codonId} requires continuation from previous codon but no valid session found. Previous codon must complete successfully or be skipped with at least one assistant message.`;

        this.logger.log(errorMessage, "error");

        // Set failure reason
        this.codonFailureReason = {
          type: "unknown",
          retriable: false,
          message: errorMessage,
        };

        // Transition to failed state
        if (this.currentRunId) {
          this.stateManager.transition({
            type: "CodonTransitioned",
            data: {
              runId: this.currentRunId,
              codonId: codonId,
              from: "starting",
              to: "failed",
              metadata: {
                failedDuring: "starting",
                failureReason: this.codonFailureReason,
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
            codon: codon.id,
            fatal: true,
            severity: ErrorSeverity.CODON,
          },
        } as ErrorEvent);

        // Clean up and return
        this.cleanupCurrentCodon();
        return;
      }
    }

    // Create codon state - start in initializing state
    this.currentCodon = {
      status: "initializing",
      codonId: codonId,
      codon,
      previousSessionId: previousSessionId ? SessionId(previousSessionId) : undefined, // Store for codon.started event
      startTime: new Date(),
      codonCost: 0,
      codonTokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    };

    // Store watch patterns for tool-based tracking
    if (codon.trackedFiles && codon.trackedFiles.length > 0) {
      this.watchedPatterns = codon.trackedFiles;
      this.logger.log(`Watching patterns: ${this.watchedPatterns.join(", ")}`);
    }

    // NOTE: codon.started event is now sent when Claude sends init message
    // This ensures we have the actual session ID before notifying clients

    // Send initial file states if any exist
    if (codon.trackedFiles && codon.trackedFiles.length > 0) {
      // Use the unified file resolver to get files respecting gitignore
      const resolvedFiles = await fileResolver.resolveFiles(
        this.config.executionPath,
        codon.trackedFiles,
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
        }),
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

    // Run the codon
    await this.runCodon(codonId, codon, previousSessionId);
  }

  // -------------
  // Codon Execution
  // -------------

  /**
   * Execute a codon using CodonRunner.
   *
   * @param codonId - Runtime codon ID (e.g., "review#0", "review#1" for loops)
   * @param codon - Codon configuration (not Loop - loops must be expanded first)
   * @param previousSessionId - Session to continue from (if any)
   */
  private async runCodon(
    codonId: CodonId,
    codon: Codon,
    previousSessionId: string | null,
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

      // Calculate log path to use run folder
      // Use codonId (runtime ID with iteration suffix) instead of codon.id (base config ID)
      // Replace # with - for safer file names
      const logFileName = `${codonId.replace(/#/g, "-")}-claude.log`;
      const logPath = path.join(runFolder, logFileName);

      // Create runner for this codon
      this.currentCodonRunner = new CodonRunner({
        codon,
        codonId,
        executionPath: this.config.executionPath,
        logger: this.logger,
        logParsingInterval: this.config.logParsingInterval,
        anthropicBaseUrl: this.proxyRunner?.proxyUrl,
        logPath, // Pass the run-specific log path
      });

      // Subscribe to runner events
      this.setupCodonRunnerEventHandlers(codonId);

      // Start execution
      await this.currentCodonRunner.run(
        previousSessionId ? SessionId(previousSessionId) : undefined,
      );

      // Validate process started
      if (!this.currentRunId) {
        throw new Error("No active run while starting Claude process");
      }

      const pid = this.currentCodonRunner.getPid();
      if (!pid) {
        throw new Error("Failed to get process PID");
      }

      // Transition to initializing (fire-and-forget)
      this.stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: this.currentRunId,
          codonId: codonId,
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
    } catch (error) {
      // Clean up runner if initialization fails
      if (this.currentCodonRunner) {
        await this.currentCodonRunner.cleanup();
        this.currentCodonRunner = undefined;
      }

      // Transition to failed (fire-and-forget) if we have a run
      if (this.currentRunId) {
        this.stateManager.transition({
          type: "CodonTransitioned",
          data: {
            runId: this.currentRunId,
            codonId: codonId,
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
      this.cleanupCurrentCodon();
      throw error;
    }
  }

  /**
   * Set up event handlers for the current codon runner
   */
  private setupCodonRunnerEventHandlers(codonId: CodonId): void {
    if (!this.currentCodonRunner) {
      throw new Error("Cannot setup handlers: no current codon runner");
    }

    // Process lifecycle events
    this.currentCodonRunner.on("exit", (code: number, isContextExceeded: boolean) => {
      if (isContextExceeded) {
        this.logger.log(
          `[STRANDWEAVE-SERVER] Context exceeded error detected for codon ${codonId}`,
          "error",
        );
      }
      this.handleCodonComplete(code, isContextExceeded);
    });

    this.currentCodonRunner.on("error", (error: Error) => {
      this.handleError(error, `Process for codon ${codonId}`, ErrorSeverity.FATAL);
    });

    // Log parser events (forwarded through runner)
    this.currentCodonRunner.on("systemMessage", (msg: SystemMessage) => {
      this.handleSystemMessage(msg, codonId);
    });

    this.currentCodonRunner.on("assistantMessage", (msg: AssistantMessage) => {
      this.handleAssistantMessage(msg, codonId);
    });

    this.currentCodonRunner.on("userMessage", (msg: UserMessage) => {
      this.handleUserMessage(msg, codonId);
    });

    this.currentCodonRunner.on("resultMessage", (msg: ResultMessage) => {
      this.handleResultMessage(msg, codonId);
    });
  }

  private handleSystemMessage(msg: SystemMessage, codonId: string): void {
    if (
      msg.subtype === "init" &&
      msg.session_id &&
      this.currentCodon &&
      this.currentCodon.status === "initializing"
    ) {
      // Transition to running (fire-and-forget)
      if (this.currentRunId) {
        this.stateManager.transition({
          type: "CodonTransitioned",
          data: {
            runId: this.currentRunId,
            codonId: CodonId(codonId),
            from: "initializing",
            to: "running",
            metadata: {
              claudeSessionId: SessionId(msg.session_id),
            },
          },
        });
      }

      // Update local state for backward compatibility
      this.currentCodon = {
        status: "running",
        codonId: this.currentCodon.codonId,
        codon: this.currentCodon.codon,
        sessionId: SessionId(msg.session_id),
        previousSessionId: this.currentCodon.previousSessionId,
        startTime: this.currentCodon.startTime,
        codonCost: 0,
        codonTokens: {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
      };

      // Log the session ID update
      this.logger.log(`Claude started codon ${codonId} with session ID: ${msg.session_id}`);

      // Send info event with codon ID
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "info",
        data: {
          message: `Claude started codon ${codonId} with session ID: ${msg.session_id}`,
        },
      } as InfoEvent);
    }
  }

  private handleAssistantMessage(msg: AssistantMessage, codonId: string): void {
    // Track that we've received an assistant message
    if (this.currentRunId) {
      const currentCodon = this.stateManager.getCodonInCurrentRun(CodonId(codonId));
      const currentCount =
        currentCodon && "assistantMessageCount" in currentCodon
          ? (currentCodon.assistantMessageCount ?? 0)
          : 0;

      this.stateManager.transition({
        type: "AssistantMessageCountUpdated",
        data: {
          runId: this.currentRunId,
          codonId: CodonId(codonId),
          newCount: currentCount + 1,
        },
      });
    }

    // Use type guard to check for synthetic timeout messages
    if (isSyntheticTimeout(msg as ClaudeLogMessage)) {
      this.logger.log(`API timeout detected in synthetic message for codon ${codonId}`, "error");

      const timeoutError = new APITimeoutError(codonId, {
        message: "API Error: Request timed out.",
        timestamp: new Date().toISOString(),
        synthetic: true,
      });

      // Set failure reason
      this.codonFailureReason = {
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
          codon: codonId,
          fatal: false,
          severity: timeoutError.severity,
          context: JSON.stringify(timeoutError.context),
        },
      } as ErrorEvent);

      // Runner will handle the cleanup
      if (this.currentCodonRunner) {
        this.currentCodonRunner.kill();
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
      if (this.currentCodon && this.currentCodon.status === "running") {
        this.currentCodon.codonCost += costDelta;
        this.currentCodon.codonTokens.inputTokens += usageDelta.inputTokens;
        this.currentCodon.codonTokens.outputTokens += usageDelta.outputTokens;
        this.currentCodon.codonTokens.cacheCreationTokens += usageDelta.cacheCreationTokens;
        this.currentCodon.codonTokens.cacheReadTokens += usageDelta.cacheReadTokens;
      }

      // Fire cost INCREMENT transition (fire-and-forget)
      if (this.currentRunId) {
        // Instead of calculating a new total from state, we just send the delta.
        this.stateManager.transition({
          type: "CostsIncremented", // Use the new incremental type
          data: {
            runId: this.currentRunId,
            codonId: CodonId(codonId),
            costDelta: costDelta, // Send the delta
            tokensDelta: usageDelta, // Send the delta
          },
        });
      }

      this.logger.log(
        `Codon ${codonId} token update - Call cost: $${costDelta.toFixed(
          4,
        )}, Running total: $${this.currentCodon?.codonCost.toFixed(4) || 0} ` +
          `(${usageDelta.inputTokens} in, ${usageDelta.outputTokens} out, ` +
          `${usageDelta.cacheCreationTokens} cache create, ${usageDelta.cacheReadTokens} cache read)`,
      );

      // Send token.usage event with the delta cost
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "token.usage",
        data: {
          codonId,
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
          this.logger.log(`API timeout detected in codon ${codonId}`, "error");

          // Immediately handle the timeout error
          const timeoutError = new APITimeoutError(codonId, {
            message: textItem.text,
            timestamp: new Date().toISOString(),
          });

          // Set failure reason
          this.codonFailureReason = {
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
              codon: codonId,
              fatal: false,
              severity: timeoutError.severity,
              context: JSON.stringify(timeoutError.context),
            },
          } as ErrorEvent);

          // Runner will handle the cleanup
          if (this.currentCodonRunner) {
            this.currentCodonRunner.kill();
          }

          return; // Stop processing further messages
        }

        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: {
            codonId,
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
            codonId,
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
          codonId,
        });

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
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "assistant.action",
          data: {
            codonId,
            action: "tool_use",
            content: "",
            toolName: toolItem.name,
            toolInput: toolItem.input,
          },
        } as AssistantActionEvent);
      }
    }
  }

  private handleResultMessage(msg: ResultMessage, codonId: string): void {
    this.logger.log(`Codon ${codonId} result message received: ${msg.subtype}`);

    // Mark that we received a result message
    this.resultMessageReceived = true;

    // Check for API timeout in result (can be error subtype OR success with is_error=true)
    if (msg.result === "API Error: Request timed out." && msg.is_error) {
      this.logger.log(`API timeout detected in result message for codon ${codonId}`, "error");

      const timeoutError = new APITimeoutError(codonId, {
        message: msg.result,
        timestamp: new Date().toISOString(),
        is_error: msg.is_error,
        duration_ms: msg.duration_ms,
        duration_api_ms: msg.duration_api_ms,
      });

      // Set failure reason
      this.codonFailureReason = {
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
          codon: codonId,
          fatal: false,
          severity: timeoutError.severity,
          context: JSON.stringify(timeoutError.context),
        },
      } as ErrorEvent);
    }

    if (msg.subtype === "success") {
      this.logger.log(`Codon ${codonId} completed successfully`);

      // Update final token usage and cost from result message
      if (msg.usage && this.currentRunId) {
        const finalUsage: TokenUsage = {
          inputTokens: msg.usage.input_tokens || 0,
          outputTokens: msg.usage.output_tokens || 0,
          cacheCreationTokens: msg.usage.cache_creation_input_tokens || 0,
          cacheReadTokens: msg.usage.cache_read_input_tokens || 0,
        };

        const finalCost = msg.total_cost_usd || calculateCost(finalUsage, this.config.costsPerMTok);

        const accumulatedCost = this.currentCodon?.codonCost || 0; // Still useful for logging
        if (Math.abs(accumulatedCost - finalCost) > 0.0001) {
          this.logger.log(
            `Codon ${codonId} cost discrepancy - Accumulated: $${accumulatedCost.toFixed(4)}, ` +
              `Final: $${finalCost.toFixed(4)} (using final from result message)`,
          );
        }

        // Fire a state transition with the authoritative final cost.
        this.stateManager.transition({
          type: "CodonFinalCostSet",
          data: {
            runId: this.currentRunId,
            codonId: CodonId(codonId),
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
            codonId,
            ...finalUsage,
            totalCost: finalCost,
            // Include per-model usage if available (for multi-model scenarios)
            ...(msg.modelUsage ? { modelUsage: msg.modelUsage } : {}),
          },
        } as TokenUsageEvent);
      }
    }
  }

  private handleUserMessage(msg: UserMessage, _codonId: string): void {
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
            "info",
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
        } else if (toolResult.content && typeof toolResult.content === "object") {
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
            codonId: toolUse.codonId,
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

  private async handleCodonComplete(exitCode: number, isContextExceeded: boolean): Promise<void> {
    // Get the current codon from the in-memory state first
    if (!this.currentCodon) return;

    const codonId = this.currentCodon.codonId;
    const wasSkipped = this.isSkippingCodon;

    // Now get the codon from state manager to ensure we have the latest status
    const currentCodon = this.stateManager.getCodonInCurrentRun(CodonId(codonId));
    if (!currentCodon || isTerminalCodonStatus(currentCodon.status)) return;

    // Get current status before any transitions
    const currentStatus = currentCodon.status;

    // Wait for 2x the log parsing interval to ensure log parser catches up with final messages
    await new Promise((resolve) => setTimeout(resolve, this.config.logParsingInterval * 2));

    // Re-fetch the specific codon after potential transition to completing
    const updatedCodon = this.stateManager.getCodonInCurrentRun(CodonId(codonId));
    if (!updatedCodon) return;

    // Codon 2: Transition to completing-sentinels if we have any sentinels
    // This provides visibility into "agent done, sentinels working" state
    const sentinelCount = this.currentCodonSentinels.size;
    if (sentinelCount > 0 && this.currentRunId) {
      this.stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: this.currentRunId,
          codonId,
          from: updatedCodon.status,
          to: "completing-sentinels",
          metadata: {
            sentinelCount,
            sentinelIds: Array.from(this.currentCodonSentinels),
          },
        },
      });

      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "info",
        data: {
          message: `Completing work for ${sentinelCount} sentinel(s)...`,
        },
      } as InfoEvent);

      // Wait for transition to complete before continuing
      await this.stateManager.waitForPendingTransitions();
    }

    // Complete sentinel work BEFORE determining final status
    // This ensures all sentinel queues are drained and costs are finalized
    if (this.sentinelManager && sentinelCount > 0) {
      await this.sentinelManager.completeAllWork();

      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "info",
        data: {
          message: `Sentinel work completed (${sentinelCount} sentinel(s))`,
        },
      } as InfoEvent);
    }

    // Codon 2: Capture final sentinel states after completing work
    if (this.currentRunId && sentinelCount > 0) {
      const sentinelStates = this.sentinelManager.getSentinelStates();
      const totalCost = sentinelStates.reduce((sum, state) => sum + state.totalCost, 0);

      this.stateManager.transition({
        type: "SentinelStatesUpdated",
        data: {
          runId: this.currentRunId,
          codonId,
          sentinelStates,
          totalCost,
        },
      });

      this.logger.log(`Updated final state for ${sentinelStates.length} sentinel(s)`, "debug");

      // Wait for this transition to complete before continuing
      await this.stateManager.waitForPendingTransitions();
    }

    // Get sentinel costs for logging
    const sentinelCostMap: Record<string, number> = {};
    if (this.sentinelManager && this.currentCodonSentinels.size > 0) {
      const costs = this.sentinelManager.getSentinelCosts();
      for (const [id, cost] of costs) {
        sentinelCostMap[id] = cost;
      }

      const totalSentinelCost = Object.values(sentinelCostMap).reduce((a, b) => a + b, 0);
      this.logger.log(
        `Sentinel costs: ${JSON.stringify(
          sentinelCostMap,
        )} (total: $${totalSentinelCost.toFixed(6)})`,
        "info",
      );
    }

    // Determine final status based on the actual codon outcome
    // Priority order: force stop > result message > context exceeded (conditional) > skip request > exit code
    let finalStatus: CodonStatus;

    if (this.isForceStopping) {
      finalStatus = "failed";
    } else if (exitCode === 0 && this.resultMessageReceived) {
      finalStatus = "completed"; // Result message with exit 0 = completed
    } else if (isContextExceeded && this.stateManager.isContextExceededAcceptable(codonId)) {
      // Context exceeded in a loop that terminates on context exceeded = completed
      finalStatus = "completed";

      // Emit info event for clarity
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "info",
        data: {
          message: `Codon completed successfully due to context exceeded (loop termination condition met)`,
        },
      } as InfoEvent);
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
          codonId: codonId,
          codonName: this.currentCodon?.codon.name || codonId,
          runId: this.currentRunId || RunId("unknown"),
          timestamp: new Date().toISOString(),
          duration: Date.now() - new Date(currentCodon.startTime).getTime(),
        });

        checkpointSha = commitInfo || undefined;
      } catch (error) {
        this.logger.log(`Checkpoint creation failed: ${error}`, "error");
        // Decide: fail the codon or continue without checkpoint?
        if (finalStatus === "completed") {
          // For completed codons, checkpoint failure is critical
          finalStatus = "failed";
          this.codonFailureReason = {
            type: "unknown",
            retriable: false,
            message: `Checkpoint creation failed: ${toError(error).message}`,
          };
        }
      }
    }

    // Re-fetch codon status after completing-sentinels transition (if it happened)
    const codonBeforeFinalTransition =
      sentinelCount > 0 ? this.stateManager.getCodonInCurrentRun(CodonId(codonId)) : updatedCodon;

    // Final transition (fire-and-forget)
    if (this.currentRunId && codonBeforeFinalTransition) {
      this.stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: this.currentRunId,
          codonId,
          from: codonBeforeFinalTransition.status, // Use the most current status
          to: finalStatus,
          metadata: {
            exitCode,
            resultMessageReceived: this.resultMessageReceived,
            checkpointSha: checkpointSha || "", // Ensure we always have a string
            contextExceeded: isContextExceeded,
            ...(finalStatus === "failed" && {
              failedDuring: wasSkipped ? currentStatus : updatedCodon.status,
              failureReason: this.codonFailureReason || {
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

    // Get the final persisted state for the codon
    const finalCodonState = this.stateManager.getCodonInCurrentRun(CodonId(codonId));

    // Authoritatively get the cost from the final state object
    let finalCost = 0;
    if (finalCodonState) {
      if (finalCodonState.status === "completed") {
        finalCost = finalCodonState.finalCost;
      } else if (finalCodonState.status === "failed" || finalCodonState.status === "skipped") {
        finalCost = finalCodonState.partialCost;
      }
    }

    // The design decision to report 0 for skipped codons is handled here
    const reportedCost = finalStatus === "skipped" ? 0 : finalCost;

    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "codon.completed",
      data: {
        codonId,
        success: finalStatus === "completed",
        cost: reportedCost, // Use the authoritative, persisted cost
        duration: Date.now() - new Date(currentCodon.startTime).getTime(),
        exitStatus:
          finalStatus === "skipped"
            ? { type: "error", code: exitCode }
            : exitCode === 0
              ? { type: "success" }
              : { type: "error", code: exitCode },
        failureReason: finalStatus === "failed" ? this.codonFailureReason : undefined,
      },
    } as CodonCompletedEvent);

    // Send state snapshot
    await this.sendStateSnapshot();

    if (finalStatus === "completed" && this.currentCodon.codon.outputFiles) {
      for (const [groupIndex, outItem] of this.currentCodon.codon.outputFiles.entries()) {
        let beforeCopySuccess = false;
        try {
          if (outItem.beforeCopy && outItem.beforeCopy.length > 0) {
            this.logger.log(
              `Running ${outItem.beforeCopy.length} beforeCopy command(s) for codon ${
                this.currentCodon.codon.id
              } (group ${groupIndex + 1})`,
            );

            for (const [index, command] of outItem.beforeCopy.entries()) {
              this.logger.log(
                `Running beforeCopy command ${index + 1}/${
                  outItem.beforeCopy.length
                }: ${command.command.run}`,
              );
              await this.runCommand(command);
            }

            this.logger.log(
              `Completed all beforeCopy commands for codon ${
                this.currentCodon.codon.id
              } (group ${groupIndex + 1})`,
            );
          }

          beforeCopySuccess = true;

          await copyFiles(
            this.config.executionPath,
            outItem.copy,
            path.join(this.config.cwd, this.config.outputDirectory),
            this.logger,
          );
        } catch (error) {
          await this.handleError(
            new Error(`Copy group ${groupIndex} failed with: ${String(error)}`),
            beforeCopySuccess ? "codonOutputCopyFiles" : "codonOutputBeforeCopy",
          );
          // Continue to next output group
        }
      }
    }

    // Loop expansion logic
    // Check if this completed codon is part of a loop and expand next iteration if needed
    if (finalStatus === "completed" || finalStatus === "skipped") {
      await this.stateManager.expandNextIterationForCodon({
        codonId: CodonId(codonId),
        contextExceeded: isContextExceeded,
      });
    }

    // Clean up - now happens after state is persisted
    this.cleanupCurrentCodon();

    // Handle next steps
    if ((finalStatus === "completed" || finalStatus === "skipped") && !this.isShuttingDown) {
      if (this.config.autostart) {
        await this.autoStartNextCodon();
      } else {
        // Emit idle event
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "server.idle",
          data: {
            reason: "codon-completed",
            message: `Codon ${codonId} ${finalStatus}. Use 'codon.next' to continue.`,
          },
        } as import("./types/types.js").ServerIdleEvent);
      }
    } else if (finalStatus === "failed" && !this.isShuttingDown) {
      if (this.codonFailureReason?.retriable) {
        this.logger.log(`Codon failed with retriable error. Server remains active.`);
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
        await this.shutdown("codon failure");
      }
    }
  }

  // -------------
  // File Operations & Watching
  // -------------

  private async handleFileToolCall<T extends ToolName>(
    toolName: T,
    toolInput: Record<string, unknown> | undefined,
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
      this.watchedPatterns.map((pattern) => buildFileTree(this.config.executionPath, pattern)),
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

  // -------------
  // Error Handling
  // -------------

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
    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: {
        message: error.message,
        context,
        severity,
        codon: this.currentCodon?.codon.id,
        fatal: severity === ErrorSeverity.FATAL,
      },
    } as ErrorEvent);

    // Handle based on severity
    switch (severity) {
      case ErrorSeverity.FATAL:
        await this.shutdown(`Fatal error: ${context}`);
        break;
      case ErrorSeverity.CODON:
        this.cleanupCurrentCodon();
        break;
      // OPERATION and WARNING just log and notify
    }
  }
  // -------------
  // Codon Status & Control
  // -------------

  /**
   * Automatically start the next available codon if none is running.
   * Called on connection and after codon completion.
   */
  private async autoStartNextCodon(): Promise<void> {
    const thread = await this.stateManager.getExecutionThread();

    this.logger.log(
      `[autoStartNextCodon] Called - hasRunningCodon: ${thread.hasRunningCodon}, isShuttingDown: ${this.isShuttingDown}`,
    );

    if (thread.hasRunningCodon || this.isShuttingDown) {
      this.logger.log(`[autoStartNextCodon] Returning early - codon running or shutting down`);
      return; // Codon already running or shutting down
    }

    const nextCodonId = thread.nextCodonId;
    this.logger.log(`[autoStartNextCodon] ExecutionThread returned nextCodonId: ${nextCodonId}`);

    if (!nextCodonId) {
      this.logger.log("[autoStartNextCodon] No more codons to run");

      if (this.config.autostart) {
        // Current behavior - shut down
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "info",
          data: {
            message: "All codons completed successfully. Server shutting down.",
          },
        } as InfoEvent);

        setTimeout(() => {
          this.shutdown("all codons completed");
        }, 2000);
      } else {
        // New behavior - stay running and emit idle
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "server.idle",
          data: {
            reason: "all-codons-completed",
            message: "All codons completed. Server remains active.",
          },
        } as import("./types/types.js").ServerIdleEvent);
      }
      return;
    }

    this.logger.log(`[autoStartNextCodon] Auto-starting codon: ${nextCodonId}`);
    await this.startCodon(nextCodonId);
  }

  private async startNextCodon(): Promise<void> {
    const thread = await this.stateManager.getExecutionThread();

    if (thread.hasRunningCodon) {
      await this.handleError(
        new Error("Cannot start next codon while current codon is running"),
        "startNextCodon",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    const nextCodonId = thread.nextCodonId;

    if (nextCodonId) {
      this.logger.log(`[startNextCodon] Advancing to next codon: ${nextCodonId}`);
      await this.startCodon(nextCodonId);
    } else {
      await this.handleError(
        new Error("No more codons to run"),
        "startNextCodon",
        ErrorSeverity.OPERATION,
      );
    }
  }

  private async skipCurrentCodon(): Promise<void> {
    if (!this.currentCodon) {
      await this.handleError(
        new Error("No codon is currently running"),
        "skipCurrentCodon",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    this.logger.log(`Skipping codon ${this.currentCodon.codonId}`);
    this.isSkippingCodon = true;

    if (this.currentCodonRunner) {
      await this.currentCodonRunner.kill("SIGTERM");
    }
  }

  private async redoCurrentCodon(): Promise<void> {
    const thread = await this.stateManager.getExecutionThread();

    if (thread.hasRunningCodon) {
      await this.handleError(
        new Error("Cannot redo while codon is running"),
        "redoCurrentCodon",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    if (thread.codons.length > 0) {
      // Redo the most recently executed codon, whatever its status
      const lastAttemptedCodon = thread.codons[0];
      this.logger.log(`[redoCurrentCodon] Redoing last codon: ${lastAttemptedCodon.codon.codonId}`);
      await this.startCodon(lastAttemptedCodon.codon.codonId);
    } else {
      await this.handleError(
        new Error("No codon has been run yet to redo."),
        "redoCurrentCodon",
        ErrorSeverity.OPERATION,
      );
    }
  }

  /**
   * List available checkpoints.
   *
   * Lists ALL checkpoints across ALL runs (not just current execution thread),
   * allowing rollback to any historical checkpoint including those from
   * previously rolled-back timelines. If a specific runId is provided,
   * filters to just that run's checkpoints.
   */
  private async listCheckpoints(runId?: string): Promise<void> {
    const state = this.stateManager.getState();

    // Get the target run for metadata (gitBranch, runId to report)
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

    // If a specific runId is provided, only list that run's checkpoints
    // Otherwise, list ALL checkpoints from ALL runs (not just current thread)
    const runsToProcess = runId ? state.runs.filter((r) => r.runId === runId) : state.runs;

    // Process runs in reverse order (oldest first) so checkpoints are in chronological order
    // Then we'll reverse at the end to show most recent first
    for (const run of [...runsToProcess].reverse()) {
      for (const codon of run.codons) {
        const codonConfig = this.config.codons.find((p) => p.id === codon.codonId);
        const codonName = codonConfig?.name || codon.codonId;

        // Rig setup checkpoint
        if ("rigSetupCheckpoint" in codon && codon.rigSetupCheckpoint) {
          checkpoints.push({
            codonId: codon.codonId,
            codonName,
            checkpointType: "rig-setup",
            sha: codon.rigSetupCheckpoint,
            status: codon.status,
            timestamp: codon.startTime,
          });
        }

        // Completion checkpoint
        if (codon.status === "completed" && codon.completionCheckpoint) {
          checkpoints.push({
            codonId: codon.codonId,
            codonName,
            checkpointType: "completed",
            sha: codon.completionCheckpoint,
            status: codon.status,
            timestamp: codon.endTime,
          });
        }

        // Error checkpoint
        if (codon.status === "failed" && "errorCheckpoint" in codon && codon.errorCheckpoint) {
          checkpoints.push({
            codonId: codon.codonId,
            codonName,
            checkpointType: "error",
            sha: codon.errorCheckpoint,
            status: codon.status,
            timestamp: codon.endTime,
          });
        }

        // Skip checkpoint
        if (codon.status === "skipped" && "skipCheckpoint" in codon && codon.skipCheckpoint) {
          checkpoints.push({
            codonId: codon.codonId,
            codonName,
            checkpointType: "skipped",
            sha: codon.skipCheckpoint,
            status: codon.status,
            timestamp: codon.endTime,
          });
        }
      }
    }

    // Reverse to show most recent first
    checkpoints.reverse();

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
   * Force stop the current running codon
   */
  private async forceStopCodon(reason?: string): Promise<void> {
    const currentCodon = this.stateManager.getCurrentlyRunningCodon();
    if (!currentCodon || isTerminalCodonStatus(currentCodon.status)) {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: "No running codon to stop",
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    this.logger.log(`Force stopping codon ${currentCodon.codonId}: ${reason || "user request"}`);

    // Set the force stopping flag
    this.isForceStopping = true;

    // Set failure reason
    this.codonFailureReason = {
      type: "unknown",
      retriable: true,
      message: `Force stopped: ${reason || "user request"}`,
    };

    // Immediate state transition to failed
    if (this.currentRunId) {
      this.stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: this.currentRunId,
          codonId: currentCodon.codonId,
          from: currentCodon.status,
          to: "failed",
          metadata: {
            exitCode: -1,
            failureReason: this.codonFailureReason,
            failedDuring: currentCodon.status,
          },
        },
      });
    }

    // Kill the process (if exists)
    if (this.currentCodonRunner) {
      await this.currentCodonRunner.kill("SIGTERM");
    }

    // Clean up codon state
    this.cleanupCurrentCodon();

    // Send confirmation
    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "info",
      data: {
        message: `Codon ${currentCodon.codonId} force stopped`,
      },
    } as InfoEvent);
  }

  /**
   * Rollback to a specific checkpoint SHA (supports partial matching)
   *
   * Searches ALL runs in state.json, not just the current execution thread,
   * allowing rollback to any historical checkpoint including those from
   * previously rolled-back timelines.
   */
  private async rollbackToCheckpoint(sha: string, autoRestart: boolean): Promise<void> {
    // Check if codon is running
    const currentCodon = this.stateManager.getCurrentlyRunningCodon();
    if (currentCodon && !isTerminalCodonStatus(currentCodon.status)) {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: "Cannot rollback while codon is running. Use 'codon.forceStop' first.",
          codon: currentCodon.codonId,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    // Build execution thread for current timeline
    const state = this.stateManager.getState();
    const thread = await analyzeExecutionThread(
      state,
      undefined, // No checkpoint validation needed for search
      undefined, // Use latest run
      this.logger,
    );

    // Find all matching checkpoints across the thread
    const matches: Array<{
      threadCodon: import("./execution-thread.js").ThreadCodon;
      checkpointType: string;
      fullSha: string;
      codonIndex: number;
    }> = [];

    thread.codons.forEach((threadCodon, index) => {
      const codon = threadCodon.codon;

      // Check rig setup checkpoint
      if ("rigSetupCheckpoint" in codon && codon.rigSetupCheckpoint) {
        if (codon.rigSetupCheckpoint.startsWith(sha)) {
          matches.push({
            threadCodon,
            checkpointType: "rig-setup",
            fullSha: codon.rigSetupCheckpoint,
            codonIndex: index,
          });
        }
      }

      // Check completion checkpoint
      if (codon.status === "completed" && codon.completionCheckpoint) {
        if (codon.completionCheckpoint.startsWith(sha)) {
          matches.push({
            threadCodon,
            checkpointType: "completed",
            fullSha: codon.completionCheckpoint,
            codonIndex: index,
          });
        }
      }

      // Check error checkpoint
      if (codon.status === "failed" && "errorCheckpoint" in codon && codon.errorCheckpoint) {
        if (codon.errorCheckpoint.startsWith(sha)) {
          matches.push({
            threadCodon,
            checkpointType: "error",
            fullSha: codon.errorCheckpoint,
            codonIndex: index,
          });
        }
      }

      // Check skip checkpoint
      if (codon.status === "skipped" && "skipCheckpoint" in codon && codon.skipCheckpoint) {
        if (codon.skipCheckpoint.startsWith(sha)) {
          matches.push({
            threadCodon,
            checkpointType: "skipped",
            fullSha: codon.skipCheckpoint,
            codonIndex: index,
          });
        }
      }
    });

    // If not found in current thread, search ALL runs (allows rollback to old timelines)
    if (matches.length === 0) {
      this.logger.log(`SHA ${sha} not found in current thread, searching all historical runs...`);

      // Search through all runs in state
      for (const run of state.runs) {
        for (let codonIndex = 0; codonIndex < run.codons.length; codonIndex++) {
          const codon = run.codons[codonIndex];

          // Create a synthetic ThreadCodon for compatibility
          const syntheticThreadCodon: import("./execution-thread.js").ThreadCodon = {
            codon,
            runId: run.runId,
            runStatus: run.status,
            runStartTime: run.startTime,
            runEndTime: run.endTime || null,
            gitBranch: run.gitBranch,
            globalIndex: -1, // Not relevant for historical search
            runIndex: codonIndex,
            codonIndexInRun: codonIndex,
            validatedCheckpoints: [],
            continuationSessionId: null,
          };

          // Check rig setup checkpoint
          if ("rigSetupCheckpoint" in codon && codon.rigSetupCheckpoint) {
            if (codon.rigSetupCheckpoint.startsWith(sha)) {
              matches.push({
                threadCodon: syntheticThreadCodon,
                checkpointType: "rig-setup",
                fullSha: codon.rigSetupCheckpoint,
                codonIndex: codonIndex,
              });
            }
          }

          // Check completion checkpoint
          if (codon.status === "completed" && codon.completionCheckpoint) {
            if (codon.completionCheckpoint.startsWith(sha)) {
              matches.push({
                threadCodon: syntheticThreadCodon,
                checkpointType: "completed",
                fullSha: codon.completionCheckpoint,
                codonIndex: codonIndex,
              });
            }
          }

          // Check error checkpoint
          if (codon.status === "failed" && "errorCheckpoint" in codon && codon.errorCheckpoint) {
            if (codon.errorCheckpoint.startsWith(sha)) {
              matches.push({
                threadCodon: syntheticThreadCodon,
                checkpointType: "error",
                fullSha: codon.errorCheckpoint,
                codonIndex: codonIndex,
              });
            }
          }

          // Check skip checkpoint
          if (codon.status === "skipped" && "skipCheckpoint" in codon && codon.skipCheckpoint) {
            if (codon.skipCheckpoint.startsWith(sha)) {
              matches.push({
                threadCodon: syntheticThreadCodon,
                checkpointType: "skipped",
                fullSha: codon.skipCheckpoint,
                codonIndex: codonIndex,
              });
            }
          }
        }
      }

      if (matches.length > 0) {
        this.logger.log(`Found ${matches.length} match(es) in historical runs`);
      }
    }

    // Handle matches
    if (matches.length === 0) {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: `Checkpoint ${sha} not found in any run (current or historical)`,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    if (matches.length > 1) {
      // Ambiguous SHA - provide helpful error message
      const matchDetails = matches
        .map((m) => {
          const codonConfig = this.config.codons.find((p) => p.id === m.threadCodon.codon.codonId);
          const codonName = codonConfig?.name || m.threadCodon.codon.codonId;
          return `  - ${m.fullSha.substring(0, 7)}... (${codonName} - ${
            m.checkpointType
          }) in run ${m.threadCodon.runId}`;
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
    try {
      // Check if the match is from the current execution thread
      const isInCurrentThread = thread.codons.some(
        (tc) =>
          tc.runId === match.threadCodon.runId &&
          tc.codon.codonId === match.threadCodon.codon.codonId,
      );

      if (isInCurrentThread) {
        // Find the correct index in the current thread
        const threadIndex = thread.codons.findIndex(
          (tc) =>
            tc.runId === match.threadCodon.runId &&
            tc.codon.codonId === match.threadCodon.codon.codonId,
        );

        this.logger.log(
          `Executing rollback to ${match.fullSha.substring(0, 7)} (${
            match.checkpointType
          }) at thread index ${threadIndex}`,
        );
        await this.executeRollback(
          thread,
          threadIndex,
          match.fullSha,
          match.checkpointType,
          autoRestart,
        );
      } else {
        // Historical checkpoint from an old run - use direct rollback
        this.logger.log(
          `Executing direct rollback to historical checkpoint ${match.fullSha.substring(
            0,
            7,
          )} (${match.checkpointType}) from run ${match.threadCodon.runId}`,
        );
        await this.executeDirectRollback(
          match.threadCodon,
          match.fullSha,
          match.checkpointType,
          autoRestart,
        );
      }
    } catch (error) {
      const err = toError(error);
      this.logger.log(`Rollback failed: ${err.message}`, "error");
      if (err.stack) {
        this.logger.log(`Stack trace: ${err.stack}`, "error");
      }
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: `Rollback failed: ${err.message}`,
          fatal: false,
        },
      } as ErrorEvent);
      throw error; // Re-throw to propagate to command handler
    }
  }

  /**
   * Execute a direct rollback to a historical checkpoint from an old run.
   * This is simpler than the codon-by-codon rollback - it just:
   * 1. Resets git to the checkpoint
   * 2. Creates a new continuation run from that point
   */
  private async executeDirectRollback(
    targetCodon: import("./execution-thread.js").ThreadCodon,
    sha: string,
    checkpointType: string,
    autoRestart: boolean,
  ): Promise<void> {
    const codonConfig = this.config.codons.find((p) => p.id === targetCodon.codon.codonId);
    const codonName = codonConfig?.name || targetCodon.codon.codonId;

    this.logger.log(
      `Direct rollback to ${checkpointType} checkpoint ${sha} ` +
        `in codon ${targetCodon.codon.codonId} (${codonName}) from run ${targetCodon.runId}`,
    );

    // Set the rollback flag
    this.isRollingBack = true;

    try {
      // 1. Clean up current codon state
      this.cleanupCurrentCodon();

      // 2. Get current run info for events
      const currentRun = this.stateManager.getCurrentRun();
      const fromRun = currentRun?.runId || targetCodon.runId;
      const fromCodon = currentRun?.codons[0]?.codonId || targetCodon.codon.codonId;

      // 3. Emit rollback started event
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "rollback.started",
        data: {
          fromRun,
          fromCodon,
          toCodon: targetCodon.codon.codonId,
          toCheckpoint: sha,
          checkpointType,
          codonsToProcess: [targetCodon.codon.codonId], // Direct rollback, just one codon
        },
      } as import("./types/types.js").RollbackStartedEvent);

      // 4. Complete current run as rollback
      if (currentRun && currentRun.status !== "completed") {
        this.stateManager.transition({
          type: "RunCompleted",
          data: {
            runId: currentRun.runId,
          },
        });
        await this.stateManager.waitForPendingTransitions();
      }

      // 5. Reset git to the target checkpoint
      if (this.checkpointGit) {
        this.logger.log(`Resetting to checkpoint ${sha.substring(0, 7)}`);
        await this.checkpointGit.resetToCheckpoint(sha);

        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "rollback.codonCheckpoint",
          data: {
            codonId: targetCodon.codon.codonId,
            codonName,
            checkpointType,
            checkpoint: sha,
            message: `Reset to ${codonName} ${checkpointType} checkpoint`,
          },
        } as import("./types/types.js").RollbackCodonCheckpointEvent);
      }

      // 6. Start new continuation run
      const afterCodon = checkpointType === "rig-setup" ? null : targetCodon.codon.codonId;
      await this.startNewRun({
        type: "continuation",
        source: {
          runId: targetCodon.runId,
          afterCodon: afterCodon ? CodonId(afterCodon) : null,
          checkpointSha: sha,
        },
        reason: "rollback",
      });

      // 7. Emit rollback completed event
      const newRun = this.stateManager.getCurrentRun();
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "rollback.completed",
        data: {
          fromRun,
          toRun: newRun?.runId || targetCodon.runId,
          codonId: targetCodon.codon.codonId,
          codonName,
          checkpointType,
          checkpoint: sha,
          autoRestart,
        },
      } as import("./types/types.js").RollbackCompletedEvent);

      // 8. Auto-restart if requested
      if (autoRestart && newRun) {
        this.logger.log("Auto-starting next codon after rollback");
        await this.autoStartNextCodon();
      }
    } finally {
      this.isRollingBack = false;
    }
  }

  /**
   * Rollback to a codon + checkpoint type
   */
  private async rollbackToCodon(
    codonId: CodonId,
    checkpointType: "start" | "end" | "rig-setup" | "completed" | "error" | "skipped",
    autoRestart: boolean,
  ): Promise<void> {
    // Check if codon is running
    const currentCodon = this.stateManager.getCurrentlyRunningCodon();
    if (currentCodon && !isTerminalCodonStatus(currentCodon.status)) {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: "Cannot rollback while codon is running. Use 'codon.forceStop' first.",
          codon: currentCodon.codonId,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    // Build execution thread to search across all runs
    const state = this.stateManager.getState();
    const thread = await analyzeExecutionThread(
      state,
      undefined, // No checkpoint validation needed for search
      undefined, // Use latest run
      this.logger,
    );

    // Find the codon in the thread
    let targetThreadCodon: import("./execution-thread.js").ThreadCodon | null = null;
    let targetCodonIndex = -1;

    for (let i = 0; i < thread.codons.length; i++) {
      if (thread.codons[i].codon.codonId === codonId) {
        targetThreadCodon = thread.codons[i];
        targetCodonIndex = i;
        break;
      }
    }

    if (!targetThreadCodon) {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: `Codon ${codonId} not found in execution history`,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    const targetCodon = targetThreadCodon.codon;

    // Resolve checkpoint type aliases
    let actualCheckpointType: "rig-setup" | "completed" | "error" | "skipped" | undefined;
    let sha: string | null = null;

    if (checkpointType === "start") {
      // Find first checkpoint in codon
      if ("rigSetupCheckpoint" in targetCodon && targetCodon.rigSetupCheckpoint) {
        sha = targetCodon.rigSetupCheckpoint;
        actualCheckpointType = "rig-setup";
      } else if (targetCodon.status === "completed" && targetCodon.completionCheckpoint) {
        sha = targetCodon.completionCheckpoint;
        actualCheckpointType = "completed";
      } else if (
        targetCodon.status === "failed" &&
        "errorCheckpoint" in targetCodon &&
        targetCodon.errorCheckpoint
      ) {
        sha = targetCodon.errorCheckpoint;
        actualCheckpointType = "error";
      } else if (
        targetCodon.status === "skipped" &&
        "skipCheckpoint" in targetCodon &&
        targetCodon.skipCheckpoint
      ) {
        sha = targetCodon.skipCheckpoint;
        actualCheckpointType = "skipped";
      }
    } else if (checkpointType === "end") {
      // Find last checkpoint in codon based on status
      if (targetCodon.status === "completed" && targetCodon.completionCheckpoint) {
        sha = targetCodon.completionCheckpoint;
        actualCheckpointType = "completed";
      } else if (
        targetCodon.status === "failed" &&
        "errorCheckpoint" in targetCodon &&
        targetCodon.errorCheckpoint
      ) {
        sha = targetCodon.errorCheckpoint;
        actualCheckpointType = "error";
      } else if (
        targetCodon.status === "skipped" &&
        "skipCheckpoint" in targetCodon &&
        targetCodon.skipCheckpoint
      ) {
        sha = targetCodon.skipCheckpoint;
        actualCheckpointType = "skipped";
      } else if ("rigSetupCheckpoint" in targetCodon && targetCodon.rigSetupCheckpoint) {
        // Fallback to rig setup if no end checkpoint
        sha = targetCodon.rigSetupCheckpoint;
        actualCheckpointType = "rig-setup";
      }
    } else {
      // Direct checkpoint type specified
      actualCheckpointType = checkpointType as "rig-setup" | "completed" | "error" | "skipped";

      switch (checkpointType) {
        case "rig-setup":
          sha = "rigSetupCheckpoint" in targetCodon ? targetCodon.rigSetupCheckpoint || null : null;
          break;
        case "completed":
          sha = targetCodon.status === "completed" ? targetCodon.completionCheckpoint : null;
          break;
        case "error":
          sha =
            targetCodon.status === "failed" && "errorCheckpoint" in targetCodon
              ? targetCodon.errorCheckpoint || null
              : null;
          break;
        case "skipped":
          sha =
            targetCodon.status === "skipped" && "skipCheckpoint" in targetCodon
              ? targetCodon.skipCheckpoint || null
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
          message: `No ${checkpointType} checkpoint found for codon ${codonId}`,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    await this.executeRollback(thread, targetCodonIndex, sha, actualCheckpointType, autoRestart);
  }

  /**
   * Rollback to last successful codon
   */
  private async rollbackToLastSuccess(autoRestart: boolean): Promise<void> {
    // Check if codon is running
    const currentCodon = this.stateManager.getCurrentlyRunningCodon();
    if (currentCodon && !isTerminalCodonStatus(currentCodon.status)) {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          message: "Cannot rollback while codon is running. Use 'codon.forceStop' first.",
          codon: currentCodon.codonId,
          fatal: false,
        },
      } as ErrorEvent);
      return;
    }

    // Build execution thread to search across all runs
    const state = this.stateManager.getState();
    const thread = await analyzeExecutionThread(
      state,
      undefined, // No checkpoint validation needed for search
      undefined, // Use latest run
      this.logger,
    );

    // Find last completed codon in the thread
    let lastCompletedIndex = -1;
    for (let i = 0; i < thread.codons.length; i++) {
      if (thread.codons[i].codon.status === "completed") {
        lastCompletedIndex = i;
        break;
      }
    }

    if (lastCompletedIndex >= 0) {
      const lastCompleted = thread.codons[lastCompletedIndex];
      if (lastCompleted.codon.status === "completed") {
        this.logger.log(
          `Found last successfully completed thread codon to rollback to: ${JSON.stringify(
            lastCompleted,
          )}`,
        );

        // Rollback to last successful codon
        await this.executeRollback(
          thread,
          lastCompletedIndex,
          lastCompleted.codon.completionCheckpoint,
          "completed",
          autoRestart,
        );
        return;
      }
    }

    this.logger.log(
      "Did not find any successful codon to rollback to. Going to look for a checkpoint in the thread.",
    );

    // No successful codons - find the first checkpoint in the thread
    let firstCheckpointIndex = -1;
    let firstCheckpointSha: string | null = null;
    let firstCheckpointType: string | null = null;

    for (let i = thread.codons.length - 1; i >= 0; i--) {
      const threadCodon = thread.codons[i];
      const codon = threadCodon.codon;

      if ("rigSetupCheckpoint" in codon && codon.rigSetupCheckpoint) {
        firstCheckpointIndex = i;
        firstCheckpointSha = codon.rigSetupCheckpoint;
        firstCheckpointType = "rig-setup";
        this.logger.log(`Found rig setup checkpoint in codon ${codon.codonId}`);
      } else if (codon.status === "completed" && codon.completionCheckpoint) {
        firstCheckpointIndex = i;
        firstCheckpointSha = codon.completionCheckpoint;
        firstCheckpointType = "completed";
        this.logger.log(`Found completion checkpoint in codon ${codon.codonId}`);
      } else if (codon.status === "failed" && "errorCheckpoint" in codon && codon.errorCheckpoint) {
        firstCheckpointIndex = i;
        firstCheckpointSha = codon.errorCheckpoint;
        firstCheckpointType = "error";
        this.logger.log(`Found error checkpoint in codon ${codon.codonId}`);
      } else if (codon.status === "skipped" && "skipCheckpoint" in codon && codon.skipCheckpoint) {
        firstCheckpointIndex = i;
        firstCheckpointSha = codon.skipCheckpoint;
        firstCheckpointType = "skipped";
        this.logger.log(`Found skipped checkpoint in codon ${codon.codonId}`);
      }
    }

    if (firstCheckpointIndex >= 0 && firstCheckpointSha && firstCheckpointType) {
      await this.executeRollback(
        thread,
        firstCheckpointIndex,
        firstCheckpointSha,
        firstCheckpointType,
        autoRestart,
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
    targetCodonIndex: number,
    sha: string,
    checkpointType: string,
    autoRestart: boolean,
  ): Promise<void> {
    const targetThreadCodon = thread.codons[targetCodonIndex];
    if (!targetThreadCodon) {
      throw new Error(`Invalid target codon index: ${targetCodonIndex}`);
    }

    const codonConfig = this.config.codons.find((p) => p.id === targetThreadCodon.codon.codonId);
    const codonName = codonConfig?.name || targetThreadCodon.codon.codonId;

    this.logger.log(
      `Starting codon-by-codon rollback to ${checkpointType} checkpoint ${sha} ` +
        `in codon ${targetThreadCodon.codon.codonId} (${codonName})`,
    );

    // Set the rollback flag
    this.isRollingBack = true;

    // Execute the new codon-by-codon rollback
    // The flag will be cleared inside executeCodonByCodonRollback before sending events
    await this.executeCodonByCodonRollback(
      thread,
      targetCodonIndex,
      sha,
      checkpointType,
      codonName,
      autoRestart,
    ).finally(() => {
      this.isRollingBack = false;
    });
  }

  /**
   * Execute codon-by-codon rollback with rig cleanup
   */
  private async executeCodonByCodonRollback(
    thread: import("./execution-thread.js").ExecutionThread,
    targetCodonIndex: number,
    targetSha: string,
    checkpointType: string,
    targetCodonName: string,
    autoRestart: boolean,
  ): Promise<void> {
    // 1. Clean up current codon state
    this.cleanupCurrentCodon();

    // 2. Get target codon and codons to process from thread
    const targetThreadCodon = thread.codons[targetCodonIndex];
    if (!targetThreadCodon) {
      throw new Error(`Invalid target codon index: ${targetCodonIndex}`);
    }

    // Get all codons before target (they're already in reverse order)
    const codonsToProcess = thread.codons.slice(0, targetCodonIndex);

    // 3. Emit rollback started event
    const fromRun = thread.codons[0]?.runId || targetThreadCodon.runId;
    const fromCodon = thread.codons[0]?.codon.codonId || targetThreadCodon.codon.codonId;

    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "rollback.started",
      data: {
        fromRun,
        fromCodon,
        toCodon: targetThreadCodon.codon.codonId,
        toCheckpoint: targetSha,
        checkpointType,
        codonsToProcess: codonsToProcess.map((tp) => tp.codon.codonId),
      },
    } as import("./types/types.js").RollbackStartedEvent);

    // 4. Process each codon (they're already in reverse order)
    let currentStep = 0;
    const totalSteps = codonsToProcess.length + 1; // +1 for final checkpoint

    for (const threadCodon of codonsToProcess) {
      currentStep++;

      // Emit progress
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "rollback.progress",
        data: {
          currentStep,
          totalSteps,
          message: `Rolling back through ${threadCodon.codon.codonId}`,
        },
      } as import("./types/types.js").RollbackProgressEvent);

      // Get the last checkpoint for this codon
      const checkpoint = this.getLastCheckpointForCodon(threadCodon.codon);
      if (checkpoint && this.checkpointGit) {
        // Reset to this codon's checkpoint
        await this.checkpointGit.resetToCheckpoint(checkpoint.sha);

        // Emit checkpoint event
        const codonConfig = this.config.codons.find((p) => p.id === threadCodon.codon.codonId);
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "rollback.codonCheckpoint",
          data: {
            codonId: threadCodon.codon.codonId,
            codonName: codonConfig?.name || threadCodon.codon.codonId,
            checkpoint: checkpoint.sha,
            checkpointType: checkpoint.type,
            message: `Reset to ${threadCodon.codon.codonId} ${checkpoint.type} checkpoint`,
          },
        } as import("./types/types.js").RollbackCodonCheckpointEvent);
      }

      // Clean up rig directories from this codon
      await this.cleanupCodonRigDirectories(threadCodon.codon);
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
      type: "rollback.codonCheckpoint",
      data: {
        codonId: targetThreadCodon.codon.codonId,
        codonName: targetCodonName,
        checkpoint: targetSha,
        checkpointType,
        message: `Reset to target checkpoint ${targetThreadCodon.codon.codonId} (${checkpointType})`,
      },
    } as import("./types/types.js").RollbackCodonCheckpointEvent);

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
    const afterCodon = checkpointType === "rig-setup" ? null : targetThreadCodon.codon.codonId;

    await this.startNewRun({
      type: "continuation",
      source: {
        runId: targetThreadCodon.runId,
        afterCodon: afterCodon ? CodonId(afterCodon) : null,
        checkpointSha: targetSha,
      },
      reason: "rollback",
    });

    // 9. Restore checkpoint patterns
    const targetCodonConfigIndex = this.config.codons.findIndex(
      (p) => p.id === targetThreadCodon.codon.codonId,
    );
    if (targetCodonConfigIndex >= 0) {
      const includeTarget = checkpointType === "rig-setup";
      const maxIndex = includeTarget ? targetCodonConfigIndex : targetCodonConfigIndex - 1;

      for (let i = 0; i <= maxIndex; i++) {
        const codonConfig = this.config.codons[i];
        // Only codons have trackedFiles (not loops)
        if (codonConfig.type !== "loop" && codonConfig.trackedFiles?.length) {
          await this.addCheckpointPatterns(codonConfig.trackedFiles);
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
        codonId: targetThreadCodon.codon.codonId,
        codonName: targetCodonName,
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
      const nextCodon = await this.stateManager.getNextCodonToExecute();
      if (nextCodon) {
        await this.startCodon(nextCodon, checkpointType === "rig-setup");
      }
    }
  }

  /**
   * Get the last checkpoint for a codon
   */
  private getLastCheckpointForCodon(codon: CodonExecution): { sha: string; type: string } | null {
    // Priority: completed > error > skipped > rig-setup
    if (codon.status === "completed" && codon.completionCheckpoint) {
      return { sha: codon.completionCheckpoint, type: "completed" };
    }
    if (codon.status === "failed" && "errorCheckpoint" in codon && codon.errorCheckpoint) {
      return { sha: codon.errorCheckpoint, type: "error" };
    }
    if (codon.status === "skipped" && "skipCheckpoint" in codon && codon.skipCheckpoint) {
      return { sha: codon.skipCheckpoint, type: "skipped" };
    }
    if ("rigSetupCheckpoint" in codon && codon.rigSetupCheckpoint) {
      return { sha: codon.rigSetupCheckpoint, type: "rig-setup" };
    }
    return null;
  }

  /**
   * Get rig setup directories for a codon
   */
  private getRigSetupDirectories(codonId: CodonId): string[] {
    const codonConfig = this.config.codons.find((p) => p.id === codonId);
    if (!codonConfig) return [];

    // Only codons have rigSetup (not loops)
    // TODO: this is needs more attention (how does rig setup work in the loopy context)
    if (codonConfig.type === "loop") return [];

    const codon = codonConfig;
    if (!codon.rigSetup) return [];

    const directories: string[] = [];
    for (const item of codon.rigSetup) {
      if (item.type === "copy" && item.copy) {
        directories.push(item.copy.to);
      }
    }
    return directories;
  }

  /**
   * Clean up rig directories created by a codon
   */
  private async cleanupCodonRigDirectories(codon: CodonExecution): Promise<void> {
    const directories = this.getRigSetupDirectories(codon.codonId);
    if (directories.length === 0) return;

    const codonConfig = this.config.codons.find((p) => p.id === codon.codonId);
    const codonName = codonConfig?.name || codon.codonId;

    // Emit cleanup started
    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "rollback.rigCleanup",
      data: {
        codonId: codon.codonId,
        codonName,
        directories,
        status: "started",
      },
    } as import("./types/types.js").RollbackRigCleanupEvent);

    const successfulCleanups: string[] = [];
    const failedCleanups: { directory: string; error: string }[] = [];

    for (const dir of directories) {
      const fullPath = path.join(this.config.executionPath, dir);
      try {
        if (fs.existsSync(fullPath)) {
          await fs.promises.rm(fullPath, { recursive: true, force: true });
          this.logger.log(`Removed rig setup directory: ${dir}`);
          successfulCleanups.push(dir);
        } else {
          // Directory doesn't exist, consider it a success
          this.logger.log(`Rig setup directory already absent: ${dir}`);
          successfulCleanups.push(dir);
        }
      } catch (error) {
        const errorMessage = toError(error).message;
        this.logger.log(`Failed to remove rig directory ${dir}: ${errorMessage}`, "error");
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
        type: "rollback.rigCleanup",
        data: {
          codonId: codon.codonId,
          codonName,
          directories,
          status,
          successfulCleanups,
          failedCleanups,
          error: failedCleanups.map((f) => `${f.directory}: ${f.error}`).join(", "),
        },
      } as import("./types/types.js").RollbackRigCleanupEvent);
    } else {
      // Complete success
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "rollback.rigCleanup",
        data: {
          codonId: codon.codonId,
          codonName,
          directories,
          status: "completed",
          successfulCleanups,
          failedCleanups: [],
        },
      } as import("./types/types.js").RollbackRigCleanupEvent);
    }
  }

  // -------------
  // Sentinel Integration
  // -------------

  /**
   * Load sentinels for a codon.
   * Parses configs, passes to SentinelManager for instantiation.
   *
   * @returns Result with loaded configs and any errors
   */
  private async loadSentinelsForCodon(
    codon: Codon,
    runtimeCodonId: CodonId,
  ): Promise<{
    loaded: string[];
    errors: { ref: string; error: string; fatal: boolean }[];
  }> {
    // FIX: Clear previous sentinels immediately to prevent state leaking
    this.currentCodonSentinels.clear();

    if (!codon.sentinels || codon.sentinels.length === 0) {
      return { loaded: [], errors: [] };
    }

    this.logger.log(
      `Loading ${codon.sentinels.length} sentinel config(s) for codon ${runtimeCodonId}`,
      "info",
    );

    // Use config loader to parse and validate
    // Use configPath if available, otherwise fall back to cwd
    const codonConfigDir = this.config.configPath
      ? path.dirname(this.config.configPath)
      : this.config.cwd;
    const loadResult = this.sentinelConfigLoader.loadConfigsForCodon(
      codon.sentinels,
      codon.id,
      codonConfigDir,
    );

    if (loadResult.errors.length > 0) {
      this.logger.log(`${loadResult.errors.length} sentinel config(s) failed to load`, "info");
    }

    if (loadResult.configs.length === 0) {
      this.logger.log("No sentinels loaded for this codon", "info");
      return { loaded: [], errors: loadResult.errors };
    }

    // Pass to SentinelManager for instantiation
    try {
      // Apply codon-level overrides to sentinel configs
      const configs = loadResult.configs.map((lc) => {
        const config = lc.config;

        // Merge reportToWebsocket settings (codon overrides sentinel)
        if (lc.config.reportToWebsocket || lc.outputPaths || lc.failCodonIfNotLoaded) {
          // Create a merged config with codon-level reportToWebsocket override
          const codonReportSettings = codon.sentinels?.find(
            (entry) =>
              (typeof entry.sentinelConfig === "object" && entry.sentinelConfig.id === config.id) ||
              typeof entry.sentinelConfig === "string",
          )?.settings?.reportToWebsocket;

          if (codonReportSettings) {
            // Merge codon settings over sentinel settings (handle undefined safely)
            const mergedReportSettings = {
              ...(config.reportToWebsocket || {}),
              ...codonReportSettings,
            };

            return {
              ...config,
              reportToWebsocket: mergedReportSettings,
            };
          }
        }

        return config;
      });

      const configDirs = loadResult.configs.map((lc) => lc.configDirectory);

      // Build output paths map from codon-level settings
      const outputPathsMap = new Map<string, { logFile?: string; lastValueFile?: string }>();
      for (const lc of loadResult.configs) {
        if (lc.outputPaths) {
          outputPathsMap.set(lc.config.id, lc.outputPaths);
        }
      }

      // SentinelManager internally unloads previous codon's sentinels
      await this.sentinelManager.loadSentinelsForCodon(configs, runtimeCodonId, {
        configDirectory: configDirs[0],
        runStartTime: new Date(),
        executionPath: this.config.executionPath,
        outputPathsMap: outputPathsMap.size > 0 ? outputPathsMap : undefined,
        // Note: llmCallOverride and llmObjectCallOverride are only used in tests
        // In production, SentinelManager uses its own provider registry
      });

      // Track loaded sentinel IDs
      this.currentCodonSentinels.clear();
      for (const config of configs) {
        this.currentCodonSentinels.add(config.id);
      }

      this.logger.log(`Successfully loaded ${configs.length} sentinel instance(s)`, "info");

      // Codon 2: Emit sentinel.loaded events
      for (const loadedConfig of loadResult.configs) {
        const config = loadedConfig.config;
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "sentinel.loaded",
          data: {
            sentinelId: config.id,
            codonId: runtimeCodonId,
            model: config.model,
            triggerType: config.trigger.type,
            executionStrategy: config.execution.strategy,
            conversational: !!config.conversational,
            source: loadedConfig.source,
            sourcePath: loadedConfig.sourcePath,
          },
        } as import("./schemas/event-schemas.js").SentinelLoadedEvent);
      }

      // Codon 2: Capture initial sentinel states in codon state
      if (this.currentRunId && configs.length > 0) {
        const sentinelStates = this.sentinelManager.getSentinelStates();
        const totalCost = sentinelStates.reduce((sum, state) => sum + state.totalCost, 0);

        this.stateManager.transition({
          type: "SentinelStatesUpdated",
          data: {
            runId: this.currentRunId,
            codonId: codon.id as CodonId,
            sentinelStates,
            totalCost,
          },
        });

        this.logger.log(`Captured initial state for ${sentinelStates.length} sentinel(s)`, "debug");
      }

      return {
        loaded: loadResult.configs.map((c) => c.config.id),
        errors: loadResult.errors,
      };
    } catch (error) {
      const errorMsg = `Failed to instantiate sentinels in SentinelManager: ${error}`;

      // Treat as fatal if all loaded configs had failCodonIfNotLoaded=true
      const allRequired = loadResult.configs.every((lc) => lc.failCodonIfNotLoaded);

      return {
        loaded: [],
        errors: [
          {
            ref: "SentinelManager",
            error: errorMsg,
            fatal: allRequired,
          },
        ],
      };
    }
  }

  // -------------
  // Utility & Helper Methods
  // -------------

  private cleanupCurrentCodon(): void {
    // Clean up runner (handles both logParser and processManager)
    if (this.currentCodonRunner) {
      this.currentCodonRunner
        .cleanup()
        .catch((err) => this.logger.log(`Error cleaning up codon runner: ${err}`, "error"));
      this.currentCodonRunner = undefined;
    }

    this.watchedPatterns = [];
    this.recentFileAccess = undefined;
    this.currentCodon = undefined;
    this.codonFailureReason = undefined;
    this.isForceStopping = false;
    this.isSkippingCodon = false; // Reset skip flag after codon completion
    this.resultMessageReceived = false; // Reset result message flag

    // Clear any pending tool uses
    this.pendingToolUses.clear();
  }

  private async runCommand(
    shellCommand: ShellCommand | RigShellCommand | string,
    lastCopiedPath?: string,
  ): Promise<void> {
    // Handle working directory resolution
    let workingDir: string;
    const cmd: ShellCommand | RigShellCommand =
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
      throw new Error(`Target parent directory does not exist: ${targetParent}`);
    }

    // Check if target already exists
    const targetStats = await fs.promises.stat(to).catch(() => null);
    if (targetStats) {
      throw new Error(`Target path already exists: ${to}`);
    }

    // Copy using cp command with recursive flag
    await this.runCommand(`cp -r ${escapeShellArg(from)} ${escapeShellArg(to)}`);
  }

  // -------------
  // Checkpoint Methods
  // -------------

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
    this.checkpointGit = new CheckpointGit(this.config.executionPath, this.logger);
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
   * Add checkpoint patterns for a codon (cumulative)
   */
  private async addCheckpointPatterns(patterns: string[]): Promise<void> {
    if (!this.checkpointingEnabled || patterns.length === 0) return;

    // Initialize repository on first tracked patterns
    if (!this.checkpointGit) {
      this.checkpointGit = new CheckpointGit(this.config.executionPath, this.logger);
      await this.checkpointGit.initialize();
    }

    // Add new patterns
    await this.checkpointGit.addPatterns(patterns);
    this.logger.log(`Added checkpoint patterns: ${patterns.join(", ")}`);
  }

  /**
   * Create a checkpoint commit
   */
  private async createCheckpoint(info: CheckpointInfo): Promise<string | undefined> {
    if (!this.checkpointingEnabled || !this.checkpointGit) {
      this.logger.log(
        `[CHECKPOINT-DEBUG] Checkpoint creation skipped - enabled: ${
          this.checkpointingEnabled
        }, git: ${!!this.checkpointGit}`,
      );
      return;
    }

    this.logger.log(
      `[CHECKPOINT-DEBUG] Creating checkpoint for codon ${info.codonId} with status ${info.status}`,
    );
    this.logger.log(`[CHECKPOINT-DEBUG] Checkpoint info: ${JSON.stringify(info)}`);

    try {
      // Format commit message
      const firstLine = `${info.status}:${info.codonId} [run:${info.runId}] ${info.codonName}`;
      const body = [
        "",
        `Codon: ${info.codonName}`,
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

      this.logger.log(`[CHECKPOINT-DEBUG] Checkpoint commit returned: ${commitHash}`);

      if (commitHash) {
        this.logger.log(
          `[CHECKPOINT-DEBUG] Created checkpoint: ${commitHash} (${info.status}) on branch ${branchName}`,
        );

        // Fire checkpoint created transition to store SHA in state
        const checkpointType =
          info.status === "rig-setup"
            ? "rig-setup"
            : info.status === "completed"
              ? "completed"
              : info.status === "error"
                ? "error"
                : "skipped";

        this.logger.log(
          `[CHECKPOINT-DEBUG] Firing CheckpointCreated transition with type: ${checkpointType}`,
        );

        if (this.currentRunId) {
          this.stateManager.transition({
            type: "CheckpointCreated",
            data: {
              runId: this.currentRunId,
              codonId: CodonId(info.codonId),
              checkpointType,
              sha: commitHash,
              branch: branchName,
            },
          });
        }

        return commitHash;
      } else {
        this.logger.log(`[CHECKPOINT-DEBUG] No commit hash returned from checkpoint.commit()`);
      }
    } catch (error) {
      // Handle disk full or other git errors
      this.logger.log(
        `[CHECKPOINT-DEBUG] Checkpoint failed: ${toError(error).message}. ` +
          "Disabling checkpointing for this session.",
        "error",
      );
      this.checkpointingEnabled = false;
    }
  }

  // -------------
  // Shutdown & Cleanup
  // -------------

  /**
   * Shutdown the Strandweave server gracefully.
   *
   * 1. Set shutting down flag to prevent new codons
   * 2. Kill Claude process if running
   * 3. Wait for pending transitions
   * 4. Create final checkpoint if needed
   * 5. Exit process
   */
  async shutdown(reason: string, exitProcess = true): Promise<void> {
    if (this.isShuttingDown) {
      this.logger.log(`Shutdown already in progress, ignoring: ${reason}`);
      return;
    }
    this.logger.log(`Shutting down server: ${reason}`);

    // Kill any running process immediately before setting shutdown flag
    if (this.currentCodonRunner && this.currentCodon) {
      this.logger.log("Killing current codon runner for shutdown");
      await this.currentCodonRunner.kill("SIGTERM");
    }

    this.isShuttingDown = true;

    // Create exit checkpoint if not shutting down normally (all codons completed)
    if (reason !== "all codons completed" && this.checkpointingEnabled && this.currentCodon) {
      await this.createCheckpoint({
        status: "exit",
        codonId: CodonId(this.currentCodon.codon.id),
        codonName: this.currentCodon.codon.name,
        runId: this.currentRunId || RunId("unknown"),
        timestamp: new Date().toISOString(),
      });
    }

    this.cleanupCurrentCodon();

    // Shutdown sentinel manager
    if (this.sentinelManager) {
      this.logger.log("Shutting down sentinel manager...", "info");
      await this.sentinelManager.shutdown();
      this.logger.log("Sentinel manager shutdown complete", "info");
    }

    // Mark run as completed or failed based on reason
    if (this.currentRunId && reason === "all codons completed") {
      this.stateManager.transition({
        type: "RunCompleted",
        data: { runId: this.currentRunId },
      });
    } else if (this.currentRunId && reason !== "codon failure") {
      // Codon failure already marked the run as failed
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
      }, TIMEOUTS.CODON_CLEANUP_DELAY_MS);
    }
  }
}
