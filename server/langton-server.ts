import { spawn } from "node:child_process";
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
import { EventId, PhaseId, RunId, SessionId } from "./branded-types.js";
import { CheckpointGit } from "./checkpoint-git.js";
import { ClaudeLogParser } from "./claude-log-parser.js";
import { ClaudeProcessManager } from "./claude-process-manager.js";
import { type ClientCommand, clientCommandSchema } from "./command-schemas.js";
import { calculateCost, DEFAULT_CONFIG, TIMEOUTS } from "./config.js";
import { APITimeoutError, ErrorSeverity } from "./error-types.js";
import { fileResolver } from "./file-resolver.js";
import { StateManager } from "./state-manager.js";
import { isTerminalPhaseStatus, type PhaseExecution, type PhaseStatus } from "./state-types.js";
import type { ToolInputMap, ToolName } from "./tool-types.js";
import { type ServerInternalEvents, TypedEventEmitter } from "./typed-event-emitter.js";
import type {
  AssistantActionEvent,
  CheckpointInfo,
  ClaudeLogMessage,
  CompletedPhase,
  ErrorEvent,
  FailureReason,
  FileTreeUpdatedEvent,
  FileUpdatedEvent,
  InfoEvent,
  PhaseCompletedEvent,
  PhaseConfig,
  PhaseStartedEvent,
  ServerConfig,
  ServerEvent,
  ServerReadyEvent,
  StateSnapshotEvent,
  TokenUsage,
  TokenUsageEvent,
} from "./types.js";
import { isSyntheticTimeout } from "./types.js";
import {
  assertNever,
  buildFileTree,
  escapeShellArg,
  generateId,
  Logger,
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
export class LangtonServer extends TypedEventEmitter<ServerInternalEvents> {
  private server: Server | null = null;
  private client: ServerWebSocket<ClientData> | null = null;
  public readonly config: ServerConfig;
  private logger: Logger;

  // State management
  private _stateManager: StateManager;
  private currentRunId: RunId | null = null;
  private heartbeatInterval?: NodeJS.Timeout;

  // Public getter for tests and external access
  public get stateManager(): Readonly<StateManager> {
    return this._stateManager;
  }

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

  // Failure tracking
  private phaseFailureReason?: FailureReason;

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

    // Initialize state manager
    const langtonDir = path.join(this.config.projectPath, ".langton");
    this._stateManager = new StateManager(langtonDir, this.logger, this.config.phases);

    // Set up state manager listeners
    this.setupStateManagerListeners();
  }

  private setupStateManagerListeners(): void {
    this._stateManager.on("phaseRunning", (data) => {
      // State is already saved when we get here
      const phase = this._stateManager.getCurrentPhase();
      if (phase && "claudeSessionId" in phase) {
        const phaseConfig = this.config.phases.find((p) => p.id === data.phaseId);
        if (phaseConfig) {
          this.sendEvent({
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "phase.started",
            data: {
              phaseId: data.phaseId,
              phaseName: phaseConfig.name,
              phaseDescription: phaseConfig.description,
              sessionId: phase.claudeSessionId,
              previousSessionId: "previousSessionId" in phase ? phase.previousSessionId : undefined,
              startTime: phase.startTime,
            },
          } as PhaseStartedEvent);
        }
      }
    });

    this._stateManager.on("transitionError", ({ event: _event, error }) => {
      if (error.name === "PersistenceError") {
        // Can't save state - this is fatal
        this.handleError(error, "state-persistence", ErrorSeverity.FATAL);
      }
    });
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
   * 3. Initialize state manager
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

    // Initialize state manager
    await this._stateManager.initialize();

    // Check for existing lock file
    if (fs.existsSync(this.config.lockFile)) {
      const lockData = fs.readFileSync(this.config.lockFile, "utf-8");

      // Parse lock file for enhanced data
      try {
        const lockInfo = JSON.parse(lockData);
        const heartbeatAge = Date.now() - new Date(lockInfo.lastHeartbeat).getTime();

        if (heartbeatAge > 120000) {
          // 2 minutes
          this.logger.log(`Found stale lock file (heartbeat age: ${heartbeatAge}ms), removing...`);
          fs.unlinkSync(this.config.lockFile);

          // Mark the run as crashed
          if (lockInfo.runId) {
            this._stateManager.transition({
              type: "RunCrashed",
              data: {
                runId: RunId(lockInfo.runId),
                detectedAt: new Date().toISOString(),
                lastPhaseStatus: "unknown" as PhaseStatus,
              },
            });
          }
        } else {
          // Check if it's our current run
          const state = this._stateManager.getState();
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

    // Start a new run if needed
    if (!this.currentRunId) {
      await this.startNewRun();
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
      id: EventId(generateId()),
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
      const result = clientCommandSchema.safeParse(parsed);

      if (!result.success) {
        this.logger.log(`Invalid client command: ${result.error.message}`, "error");
        this.sendEvent({
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "error",
          data: {
            message: "Invalid command format",
            fatal: false,
          },
        } as ErrorEvent);
        return;
      }

      this.logger.logSocketTraffic(this.config.socketLogFile, "in", result.data);
      this.handleCommand(result.data);
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
        await this.startPhase(command.data.phaseId, command.data.skipPreCommands);
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
        // This should never happen due to Zod validation
        assertNever(command);
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
    // Calculate costs
    const totalCost = this._stateManager.getTotalCost();

    const totalTime = this.serverStartTime ? Date.now() - this.serverStartTime.getTime() : 0;

    // Convert completed phases from state for backward compatibility
    const completedPhases = this.getCompletedPhasesForSnapshot();

    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "state.snapshot",
      data: {
        currentPhase: this.currentPhase,
        completedPhases,
        fileTree: [],
        totalCost,
        totalTime,
        recentFileAccess: this.recentFileAccess,
      },
    } as StateSnapshotEvent);
  }

  // Helper to maintain backward compatibility
  private getCompletedPhasesForSnapshot(): CompletedPhase[] {
    // Try current run first, then fallback to most recent run
    const state = this._stateManager.getState();
    const run =
      this._stateManager.getCurrentRun() || (state.runs.length > 0 ? state.runs[0] : null);
    if (!run) return [];

    return run.phases
      .filter((p) => p.status === "completed")
      .map((p) => ({
        phaseId: p.phaseId,
        sessionId: "claudeSessionId" in p ? p.claudeSessionId : SessionId("unknown"),
        success: true,
        cost: "finalCost" in p ? p.finalCost : 0,
        duration:
          "endTime" in p && p.startTime
            ? new Date(p.endTime).getTime() - new Date(p.startTime).getTime()
            : 0,
        completedAt: "endTime" in p ? new Date(p.endTime) : new Date(),
      }));
  }

  /**
   * Start a new run and create necessary infrastructure
   */
  private async startNewRun(): Promise<void> {
    const runId = RunId(`${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
    const runFolder = path.join(this.config.projectPath, ".langton", "runs", runId);

    // Create run folder
    await fs.promises.mkdir(runFolder, { recursive: true });

    // Create run in state
    this._stateManager.transition({
      type: "RunStarted",
      data: {
        runId,
        runFolder,
        gitBranch: `run-${runId}`,
        startingConditions: { type: "fresh" }, // TODO: Handle continuations
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
  private async startPhase(phaseId: PhaseId, skipPreCommands?: boolean): Promise<void> {
    const phase = this.config.phases.find((p) => p.id === phaseId);
    if (!phase) {
      await this.handleError(
        new Error(`Unknown phase: ${phaseId}`),
        "startPhase",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    this.logger.log(`Starting phase: ${phase.name}`);

    // Check if phase already running via state manager (single source of truth)
    const currentPhase = this._stateManager.getCurrentPhase();
    if (currentPhase && !isTerminalPhaseStatus(currentPhase.status)) {
      await this.handleError(
        new Error(`Phase already running: ${currentPhase.phaseId}`),
        "startPhase",
        ErrorSeverity.OPERATION,
      );
      return;
    }

    // Create phase started transition (fire-and-forget)
    const _previousSessionIdString =
      phase.continuationMode === "continue-previous" ? this.getPreviousSessionId(phase.id) : null;

    if (!this.currentRunId) {
      await this.handleError(new Error("No active run"), "startPhase", ErrorSeverity.FATAL);
      return;
    }

    this._stateManager.transition({
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
        ErrorSeverity.FATAL,
      );
      return;
    }

    // Run workspace setup operations if configured
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

    // Transition to starting after preparing (regardless of workspace setup)
    this._stateManager.transition({
      type: "PhaseTransitioned",
      data: {
        runId: this.currentRunId,
        phaseId: phase.id,
        from: "preparing",
        to: "starting",
      },
    });

    // Add checkpoint patterns - accumulate from all phases up to current
    // This ensures resume functionality works correctly
    const currentPhaseIndex = this.config.phases.findIndex((p) => p.id === phase.id);
    if (currentPhaseIndex >= 0) {
      // Accumulate patterns from all phases up to and including current
      for (let i = 0; i <= currentPhaseIndex; i++) {
        const phaseConfig = this.config.phases[i];
        if (phaseConfig.trackedFiles && phaseConfig.trackedFiles.length > 0) {
          await this.addCheckpointPatterns(phaseConfig.trackedFiles);
        }
      }

      // Create checkpoint after workspace setup if we have workspace setup
      if (!skipPreCommands && phase.workspaceSetup && this.checkpointingEnabled) {
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
      previousSessionId = this.getPreviousSessionId(phase.id);
      if (previousSessionId) {
        this.logger.log(
          `Phase ${phase.id} will continue from previous session: ${previousSessionId}`,
        );

        // Send info event about continuation
        this.sendEvent({
          id: EventId(generateId()),
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
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "info",
          data: {
            message: `No valid previous session found - starting phase fresh`,
          },
        } as InfoEvent);
      }
    }

    // Create phase state - start in initializing state
    this.currentPhase = {
      status: "initializing",
      phase,
      previousSessionId: previousSessionId ? SessionId(previousSessionId) : undefined, // Store for phase.started event
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
        this.config.projectPath,
        phase.trackedFiles,
      );

      // Get file contents for each resolved file
      const files = await Promise.all(
        resolvedFiles.map(async (filePath) => {
          const fullPath = path.join(this.config.projectPath, filePath);
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
          this.sendEvent({
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

    // Start Claude process
    await this.startClaudeProcess(phase, previousSessionId);
  }

  private getPreviousSessionId(currentPhaseId: string): string | null {
    const currentIndex = this.config.phases.findIndex((p) => p.id === currentPhaseId);
    if (currentIndex <= 0) return null;

    const previousPhaseId = this.config.phases[currentIndex - 1].id;
    const lastSuccessful = this._stateManager.getLastSuccessfulPhase(PhaseId(previousPhaseId));

    return lastSuccessful?.phase.claudeSessionId || null;
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
    this.processManager.on("exit", (code: number) => {
      this.handlePhaseComplete(code);
    });

    this.processManager.on("error", (error: Error) => {
      this.handleError(error, `Claude process for phase ${phase.id}`, ErrorSeverity.FATAL);
    });

    try {
      // Get run folder from state
      const currentRun = this._stateManager.getCurrentRun();
      if (!currentRun || !currentRun.runFolder) {
        throw new Error("No active run or run folder not found");
      }
      const runFolder = currentRun.runFolder;

      // Ensure run folder exists
      await fs.promises.mkdir(runFolder, { recursive: true });

      // Modify log path to use run folder
      const logPath = path.join(runFolder, `phase-${phase.id}-claude.log`);

      // Spawn process with custom log path
      const _logPathResult = await this.processManager.spawn(phase, previousSessionId, logPath);

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

      this._stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: this.currentRunId,
          phaseId: phase.id,
          from: "starting",
          to: "initializing",
          metadata: {
            claudePid: pid,
            claudeLogPath: path.relative(this.config.projectPath, logPath),
            ...(previousSessionId && {
              previousSessionId: SessionId(previousSessionId),
            }),
          },
        },
      });

      // Set up log parsing with delay
      setTimeout(() => {
        this.setupLogParsing(logPath, phase.id);
      }, TIMEOUTS.LOG_PARSER_DELAY_MS);
    } catch (error) {
      // Transition to failed (fire-and-forget) if we have a run
      if (this.currentRunId) {
        this._stateManager.transition({
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
    if (
      msg.subtype === "init" &&
      msg.session_id &&
      this.currentPhase &&
      this.currentPhase.status === "initializing"
    ) {
      // Transition to running (fire-and-forget)
      if (this.currentRunId) {
        this._stateManager.transition({
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
      this.logger.log(`Claude started phase ${phaseId} with session ID: ${msg.session_id}`);

      // Send existing info event
      this.sendEvent({
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
    // Use type guard to check for synthetic timeout messages
    if (isSyntheticTimeout(msg as ClaudeLogMessage)) {
      this.logger.log(`API timeout detected in synthetic message for phase ${phaseId}`, "error");

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
      this.sendEvent({
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
      const usage: TokenUsage = {
        inputTokens: msg.message.usage.input_tokens || 0,
        outputTokens: msg.message.usage.output_tokens || 0,
        cacheCreationTokens: msg.message.usage.cache_creation_input_tokens || 0,
        cacheReadTokens: msg.message.usage.cache_read_input_tokens || 0,
      };

      const messageCost = calculateCost(usage, this.config.costsPerMTok);

      if (this.currentPhase && this.currentPhase.status === "running") {
        // Claude reports per-call costs, so we accumulate them
        this.currentPhase.phaseCost += messageCost;

        // Update token counts (these are cumulative per message)
        this.currentPhase.phaseTokens.inputTokens += usage.inputTokens;
        this.currentPhase.phaseTokens.outputTokens += usage.outputTokens;
        this.currentPhase.phaseTokens.cacheCreationTokens += usage.cacheCreationTokens;
        this.currentPhase.phaseTokens.cacheReadTokens += usage.cacheReadTokens;

        // Fire cost update transition (fire-and-forget)
        const currentStatePhase = this._stateManager.getCurrentPhase();
        if (currentStatePhase && currentStatePhase.status === "running") {
          const newCost =
            "currentCost" in currentStatePhase
              ? currentStatePhase.currentCost + messageCost
              : messageCost;
          const newTokens = {
            inputTokens: this.currentPhase.phaseTokens.inputTokens,
            outputTokens: this.currentPhase.phaseTokens.outputTokens,
            cacheCreationTokens: this.currentPhase.phaseTokens.cacheCreationTokens,
            cacheReadTokens: this.currentPhase.phaseTokens.cacheReadTokens,
          };

          if (this.currentRunId) {
            this._stateManager.transition({
              type: "CostsUpdated",
              data: {
                runId: this.currentRunId,
                phaseId: PhaseId(phaseId),
                cost: newCost,
                tokens: newTokens,
              },
            });
          }
        }

        this.logger.log(
          `Phase ${phaseId} token update - Call cost: $${messageCost.toFixed(
            4,
          )}, Running total: $${this.currentPhase.phaseCost.toFixed(4)} ` +
            `(${usage.inputTokens} in, ${usage.outputTokens} out, ` +
            `${usage.cacheCreationTokens} cache create, ${usage.cacheReadTokens} cache read)`,
        );
      }

      this.sendEvent({
        id: EventId(generateId()),
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

          // Set failure reason
          this.phaseFailureReason = {
            type: "timeout",
            retriable: true,
            message: "API Error: Request timed out.",
          };

          // Send error event
          this.sendEvent({
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

        this.sendEvent({
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
        this.sendEvent({
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

    // Resolve any waiting promise using phase ID from current phase
    const currentPhaseId = this.currentPhase?.phase.id;
    if (currentPhaseId) {
      const promise = this.resultMessagePromises.get(currentPhaseId);
      if (promise) {
        clearTimeout(promise.timeout);
        this.resultMessagePromises.delete(currentPhaseId);
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

      // Set failure reason
      this.phaseFailureReason = {
        type: "timeout",
        retriable: true,
        message: "API Error: Request timed out.",
      };

      // Send error event
      this.sendEvent({
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
      if (msg.usage && this.currentPhase && this.currentPhase.status === "running") {
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

  private async handlePhaseComplete(exitCode: number): Promise<void> {
    // Get the current phase from the in-memory state first
    if (!this.currentPhase) return;

    const phaseId = this.currentPhase.phase.id;
    const wasSkipped = this.isSkippingPhase;

    // Now get the phase from state manager to ensure we have the latest status
    const currentPhase = this._stateManager.getPhaseInCurrentRun(PhaseId(phaseId));
    if (!currentPhase || isTerminalPhaseStatus(currentPhase.status)) return;

    // Get current status before any transitions
    const currentStatus = currentPhase.status;

    // Transition to completing (unless skipped or failed)
    if (
      !wasSkipped &&
      exitCode === 0 &&
      !this.isShuttingDown &&
      this.currentRunId &&
      currentStatus === "running"
    ) {
      this._stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: this.currentRunId,
          phaseId: PhaseId(phaseId),
          from: currentStatus,
          to: "completing",
        },
      });

      // Wait for result message
      try {
        const resultMsg = await this.waitForResultMessage(phaseId, TIMEOUTS.RESULT_MESSAGE_MS);

        // Update with final costs (fire-and-forget)
        if (resultMsg.usage && this.currentRunId) {
          this._stateManager.transition({
            type: "CostsUpdated",
            data: {
              runId: this.currentRunId,
              phaseId: PhaseId(phaseId),
              cost:
                resultMsg.total_cost_usd ||
                calculateCost(
                  {
                    inputTokens: resultMsg.usage.input_tokens || 0,
                    outputTokens: resultMsg.usage.output_tokens || 0,
                    cacheCreationTokens: resultMsg.usage.cache_creation_input_tokens || 0,
                    cacheReadTokens: resultMsg.usage.cache_read_input_tokens || 0,
                  },
                  this.config.costsPerMTok,
                ),
              tokens: {
                inputTokens: resultMsg.usage.input_tokens || 0,
                outputTokens: resultMsg.usage.output_tokens || 0,
                cacheCreationTokens: resultMsg.usage.cache_creation_input_tokens || 0,
                cacheReadTokens: resultMsg.usage.cache_read_input_tokens || 0,
              },
            },
          });
        }
      } catch (error) {
        this.logger.log(`Result message timeout for phase ${phaseId}: ${error}`, "info");
      }
    }

    // Re-fetch the specific phase after potential transition to completing
    const updatedPhase = this._stateManager.getPhaseInCurrentRun(PhaseId(phaseId));
    if (!updatedPhase) return;

    // Determine final status
    let finalStatus: PhaseStatus = wasSkipped ? "skipped" : exitCode === 0 ? "completed" : "failed";

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
      this._stateManager.transition({
        type: "PhaseTransitioned",
        data: {
          runId: this.currentRunId,
          phaseId,
          from: updatedPhase.status, // Use the updated status (might be "completing" now)
          to: finalStatus,
          metadata: {
            exitCode,
            resultMessageReceived: updatedPhase.status === "completing",
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

    // Send phase.completed event
    // For skipped phases, always report zero cost (by design)
    const phaseCost = finalStatus === "skipped" ? 0 : this.currentPhase?.phaseCost || 0;

    this.sendEvent({
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "phase.completed",
      data: {
        phaseId,
        success: finalStatus === "completed",
        cost: phaseCost,
        duration: Date.now() - new Date(currentPhase.startTime).getTime(),
        exitStatus: exitCode === 0 ? { type: "success" } : { type: "error", code: exitCode },
        failureReason: finalStatus === "failed" ? this.phaseFailureReason : undefined,
      },
    } as PhaseCompletedEvent);

    // Clean up - ensure this completes before continuing
    this.cleanupCurrentPhase();

    // Wait a tick to ensure cleanup is complete
    await new Promise((resolve) => setImmediate(resolve));

    // Give state manager time to process the transition before sending snapshot
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Send state snapshot
    this.sendStateSnapshot();

    // Handle next steps
    if ((finalStatus === "completed" || finalStatus === "skipped") && !this.isShuttingDown) {
      // Give state manager a moment to process the transition
      await new Promise((resolve) => setTimeout(resolve, 100));
      await this.autoStartNextPhase();
    } else if (finalStatus === "failed" && !this.isShuttingDown) {
      if (this.phaseFailureReason?.retriable) {
        this.logger.log(`Phase failed with retriable error. Server remains active.`);
      } else {
        // Non-retriable failure - shut down run (fire-and-forget)
        if (this.currentRunId) {
          this._stateManager.transition({
            type: "RunFailed",
            data: { runId: this.currentRunId },
          });
        }
        await this.shutdown("phase failure");
      }
    }
  }

  // Helper method to calculate phase cost
  private calculatePhaseCost(phase: PhaseExecution): number {
    switch (phase.status) {
      case "completed":
        return phase.finalCost;
      case "failed":
        return phase.partialCost;
      case "skipped":
        return 0;
      case "running":
      case "completing":
        return phase.currentCost;
      default:
        return 0;
    }
  }

  // ============================================================================
  // File Operations & Watching
  // ============================================================================

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
      this.watchedPatterns.map((pattern) => buildFileTree(this.config.projectPath, pattern)),
    );

    // Merge all trees into one
    const mergedTree = allTrees.flat();

    this.sendEvent({
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
    severity: ErrorSeverity = ErrorSeverity.OPERATION,
  ): Promise<void> {
    // Always log
    this.logger.log(
      `[${severity}] ${context}: ${error.message}`,
      severity === ErrorSeverity.FATAL ? "error" : "info",
    );

    // Always send to client
    this.sendEvent({
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

  private async checkIncompletePhases(): Promise<void> {
    let _nextPhaseIndex = 0;

    const completedPhases = this.getCompletedPhasesForSnapshot();
    if (completedPhases.length > 0) {
      const lastCompleted = completedPhases[completedPhases.length - 1];
      const lastIndex = this.config.phases.findIndex((p) => p.id === lastCompleted.phaseId);

      if (lastIndex >= 0 && lastIndex < this.config.phases.length - 1) {
        _nextPhaseIndex = lastIndex + 1;
      } else if (lastIndex === this.config.phases.length - 1) {
        this.logger.log("All phases have been completed");
        this.sendEvent({
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "info",
          data: {
            message: "All phases have been completed. Use phase.redo to re-run the last phase.",
          },
        } as InfoEvent);
        return;
      }
    }

    // Skip checking for incomplete phases - this is now handled by state
    // The state system tracks which phases completed vs failed
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
      return;
    }

    const nextPhase = this.config.phases[nextPhaseIndex];
    this.logger.log(`Auto-starting phase: ${nextPhase.name}`);
    await this.startPhase(nextPhase.id);
  }

  private getNextPhaseIndex(): number {
    const nextPhaseId = this._stateManager.getNextPhaseToExecute();
    if (!nextPhaseId) return -1;

    return this.config.phases.findIndex((p) => p.id === nextPhaseId);
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

    const completedPhases = this.getCompletedPhasesForSnapshot();
    const lastCompleted = completedPhases[completedPhases.length - 1];
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

    const completedPhases = this.getCompletedPhasesForSnapshot();
    const lastPhase = completedPhases[completedPhases.length - 1];
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
      this.processManager = undefined;
    }

    // Clean up any pending result message promises
    const phaseId = this.currentPhase?.phase.id;
    if (phaseId && this.resultMessagePromises.has(phaseId)) {
      const promise = this.resultMessagePromises.get(phaseId);
      if (promise) {
        clearTimeout(promise.timeout);
        promise.reject(new Error("Phase cleanup - result message promise cancelled"));
        this.resultMessagePromises.delete(phaseId);
      }
    }

    this.watchedPatterns = [];
    this.recentFileAccess = undefined;
    this.currentPhase = undefined;
    this.phaseFailureReason = undefined;
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
  private async createCheckpoint(info: CheckpointInfo): Promise<string | undefined> {
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

      // Get current run's branch
      const currentRun = this._stateManager.getCurrentRun();
      const branchName = currentRun?.gitBranch || `run-${this.currentRunId}`;

      // Create checkpoint on run-specific branch
      const allowEmpty = info.status === "skipped";
      const commitHash = await this.checkpointGit.commit(commitMessage, {
        branch: branchName,
        allowEmpty,
      });

      if (commitHash) {
        this.logger.log(
          `Created checkpoint: ${commitHash} (${info.status}) on branch ${branchName}`,
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

        if (this.currentRunId) {
          this._stateManager.transition({
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
        runId: this.currentRunId || RunId("unknown"),
        timestamp: new Date().toISOString(),
      });
    }

    this.cleanupCurrentPhase();

    // Mark run as completed or failed based on reason
    if (this.currentRunId && reason === "all phases completed") {
      this._stateManager.transition({
        type: "RunCompleted",
        data: { runId: this.currentRunId },
      });
    } else if (this.currentRunId && reason !== "phase failure") {
      // Phase failure already marked the run as failed
      this._stateManager.transition({
        type: "RunFailed",
        data: { runId: this.currentRunId },
      });
    }

    // Wait for any pending state transitions
    await this._stateManager.waitForPendingTransitions();

    // Clear heartbeat interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }

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
