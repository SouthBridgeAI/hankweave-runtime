import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ArchiveManifestManager } from "./archive-manifest.js";
import { BodyResolver } from "./body-resolver.js";
import { Budget } from "./budget.js";
import {
  assertGitAvailable,
  CheckpointGit,
  CheckpointNotFoundError,
  CheckpointStorageError,
  type RecoverySnapshot,
  type RestorePreconditions,
} from "./checkpoint-git.js";
import { CodonRunner, type ExtensionInfo } from "./codon-runner.js";
import { type ClientCommand, clientCommandSchema } from "./command-schemas.js";
import { DEFAULT_CONFIG, TIMEOUTS } from "./config.js";
import { synthesizeMissingFailureReason } from "./error-classification.js";
import { EventJournal } from "./event-journal.js";
import { ExecutionLayout } from "./execution-layout.js";
import { checkpointPatternsThrough } from "./execution-planner.js";
import {
  analyzeExecutionThread,
  bestConfirmedCheckpoint,
  findContinuationSessionId,
} from "./execution-thread.js";
import { fileResolver } from "./file-resolver.js";
import { LlmProviderRegistry } from "./llm/llm-provider-registry.js";
import { ProxyRunner } from "./llm-proxy.js";
import { Replay } from "./replay.js";
import { RetryCoordinator } from "./retry-coordinator.js";
// Import event types from new schema file
import type {
  AssistantActionEvent,
  CodonCompletedEvent,
  CodonExtendedEvent,
  CodonStartedEvent,
  ErrorEvent,
  FileTreeUpdatedEvent,
  FileUpdatedEvent,
  HistoryBatchEvent,
  InfoEvent,
  LoopIterationCompletedEvent,
  PongEvent,
  RigOutputEvent,
  RigSetupCompletedEvent,
  RigSetupFailedEvent,
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
import { ShutdownWatchdog, shutdownWatchdogWanted } from "./shutdown-watchdog.js";
import { StateManager } from "./state-manager.js";
import { FileEventStorage } from "./storage/file-event-storage.js";
import {
  dietJournal,
  ensureJournalRestored,
  isProcessOwnedLock,
  registerProcessOwnedLock,
  releaseProcessOwnedLock,
} from "./storage/journal-diet.js";
import { isTraceEnabled, registerTraceUpload } from "./trace-watcher.js";
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
import { APITimeoutError, CommandError, ErrorSeverity } from "./types/error-types.js";
import {
  type CodonExecution,
  type CodonStatus,
  getCodonCost,
  getCodonTokens,
  isTerminalCodonStatus,
  type Run,
} from "./types/state-types.js";
import type {
  CheckpointInfo,
  ClientData,
  Codon,
  CodonConfig,
  FailureReason,
  HandshakeRequest,
  HandshakeResponse,
  HankweaveConfig,
  RigShellCommand,
  ShellCommand,
} from "./types/types.js";
// Import remaining types from old file
import { ClientMode } from "./types/types.js";
import {
  assertNever,
  copyFiles,
  escapeShellArg,
  generateId,
  type HankweaveServer,
  type HankweaveWebSocket,
  Logger,
  serve,
  toError,
} from "./utils.js";

/**
 * This file is organized into logical sections for easier navigation.
 * Use `grep -A1 "// ====" hankweave-runtime.ts | grep "//"` to see all sections.
 */

/**
 * Thrown when a rollback failed AFTER it had started changing the work tree
 * (a checkpoint was checked out or rig directories were removed). The tree
 * may be half-restored; the pre-rollback tree is on a recovery/* branch.
 * Callers must not start new work on it — unlike a rollback rejected up
 * front (CheckpointNotFoundError), which left the tree untouched and may be
 * degraded around.
 */
interface ArchiveRestoreResult {
  entry: import("./archive-manifest.js").ArchiveEntry;
  path: string;
  success: boolean;
  error?: string;
}

export class RollbackMutatedWorkspaceError extends Error {
  constructor(cause: unknown) {
    super(`Rollback failed after the work tree was changed: ${toError(cause).message}`, {
      cause,
    });
    this.name = "RollbackMutatedWorkspaceError";
  }
}

/**
 * Main server class that orchestrates Claude codons.
 *
 * Responsibilities:
 * - WebSocket server management (multiple clients)
 * - Codon execution and lifecycle
 * - Claude process management
 * - Watched-file event routing
 * - State persistence and recovery
 * - Cost tracking and reporting
 * - Event streaming to clients
 */
export class HankweaveRuntime extends TypedEventEmitter<ServerInternalEvents> {
  private server: HankweaveServer | null = null;
  private clients: Map<string, HankweaveWebSocket<ClientData>> = new Map();
  public readonly config: HankweaveConfig;
  private logger: Logger;

  // Proxy server
  private proxyRunner: ProxyRunner | null = null;

  // Replay mode (replays existing JSONL logs instead of making real LLM calls)
  private replay: Replay | undefined;

  // State management
  /** Well-known paths under config.executionPath, derived once. */
  private readonly layout: ExecutionLayout;
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
  private currentCodon:
    | {
        status: "initializing" | "running";
        codonId: CodonId; // Runtime codon ID (e.g., "review#0", "review#1" for loops)
        codon: Codon; // Only codons can be executed (loops are expanded first)
        previousSessionId?: SessionId;
        sessionId?: SessionId;
        startTime: Date;
      }
    | undefined;
  // Map of codonId -> CodonRunner - single source of truth for all runners
  private codonRunners = new Map<string, CodonRunner>();
  private serverStartTime: Date;
  private isShuttingDown = false;
  private readonly watchdog = new ShutdownWatchdog({
    timeoutMs: TIMEOUTS.SHUTDOWN_WATCHDOG_MS,
    log: (message, level) => this.logger.log(message, level),
  });
  private isSkippingCodon = false;
  private uploadTrace?: () => void;

  /**
   * Tracks whether the initial autostart has been triggered.
   * This is a defense-in-depth guard against the race condition where both
   * headless startup and client handshake try to trigger autostart before
   * hasRunningCodon becomes true.
   *
   * NOTE: This does NOT prevent subsequent autoStartNextCodon() calls after
   * codons complete. Those are guarded by the existing hasRunningCodon check.
   */
  private initialAutostartTriggered = false;

  // Checkpoint-related properties. Both objects are built in the constructor
  // (neither touches disk there) and brought up by initializeCheckpoints() in
  // start(), which throws rather than leave them unusable. Non-nullable so no
  // caller has to ask whether the repo "is there".
  private readonly checkpointGit: CheckpointGit;
  /**
   * The recovery snapshot taken during this boot, if any. start() may reach
   * the fresh-run fallback after a rung that already snapshotted the work
   * tree; nothing changes the tree in between, so one snapshot is enough.
   */
  private bootRecoverySnapshot: RecoverySnapshot | null = null;

  // Archive manifest for archiveOnSuccess feature
  private readonly archiveManifest: ArchiveManifestManager;

  // Failure tracking
  private codonFailureReason?: FailureReason;
  /** The original Error object that caused a codon failure (when available).
   *  Stored separately from codonFailureReason because Error objects aren't
   *  JSON-serializable. Used by error tracking to send real stack traces. */
  private codonFailureError?: Error;
  private isForceStopping = false;

  // Failure-policy decisions and retry bookkeeping (see RetryCoordinator for
  // the in-memory-counter caveats); the runtime performs the effects.
  private readonly retryCoordinator = new RetryCoordinator((message) =>
    this.logger.log(message, "info"),
  );
  private budget: Budget | null = null;

  // Per-run file.updated fingerprint chokepoint and sentinel body source
  // (fingerprint-events proposal). Spans codon boundaries by design; cleared
  // on run start and rollback. Assigned in the constructor (needs config).
  private readonly bodyResolver: BodyResolver;

  // Rollback state
  private isRollingBack = false;
  private readonly READ_ONLY_COMMANDS = new Set([
    "checkpoint.list",
    "server.shutdown", // Special case - always allowed
    "server.force_shutdown", // Special case - always allowed (escalated shutdown)
    "ping",
    "history.sync", // Read-only history pagination
  ]);

  // Sentinel system
  private sentinelManager: SentinelManager;
  private sentinelConfigLoader: SentinelConfigLoader;
  private currentCodonSentinels = new Set<string>();

  // LLM registry for cost calculations
  private llmRegistry: LlmProviderRegistry;

  // Telemetry collector (optional - may be disabled)
  private telemetryCollector:
    | import("./telemetry/telemetry-collector.js").TelemetryCollector
    | null = null;

  constructor(
    config: Omit<HankweaveConfig, keyof typeof DEFAULT_CONFIG> &
      Partial<Pick<HankweaveConfig, keyof typeof DEFAULT_CONFIG>> & {
        codons: CodonConfig[];
      },
  ) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    } as HankweaveConfig;
    this.replay = this.config.replayDir ? new Replay() : undefined;

    // Update logger to use execution path
    // Check if serverLogFile is already absolute to avoid path duplication on Windows
    const serverLogPath = path.isAbsolute(this.config.serverLogFile)
      ? this.config.serverLogFile
      : path.join(this.config.executionPath, this.config.serverLogFile);
    this.logger = new Logger(serverLogPath);
    this.serverStartTime = new Date();

    // Make lockFile path absolute (relative to execution path)
    // Check if lockFile is already absolute to avoid path duplication on Windows
    this.config.lockFile = path.isAbsolute(this.config.lockFile)
      ? this.config.lockFile
      : path.join(this.config.executionPath, this.config.lockFile);

    // Initialize state manager with execution path
    this.layout = new ExecutionLayout(this.config.executionPath);
    this.stateManager = new StateManager(this.layout, this.logger, this.config.codons);

    // Checkpoint repository and archive manifest: constructing either is pure
    // bookkeeping (paths + logger); initializeCheckpoints() does the disk work.
    this.checkpointGit = new CheckpointGit(
      this.config.executionPath,
      this.config.agentRootPath,
      this.logger,
    );
    this.stateManager.setCheckpointGit(this.checkpointGit);
    this.archiveManifest = new ArchiveManifestManager(this.config.executionPath, this.logger);

    // Initialize Event Journal with file-based storage
    this.eventJournal = new EventJournal(new FileEventStorage(this.layout.eventsDir));

    // Initialize sentinel config loader (stateful, with cache)
    this.sentinelConfigLoader = new SentinelConfigLoader(this.logger);

    // file.updated events carry fingerprints only; this resolver retains the
    // bodies for sentinel `content` access (fingerprint-events proposal).
    this.bodyResolver = new BodyResolver(this.config.agentRootPath, this.logger);

    // Initialize SentinelManager
    this.sentinelManager = new SentinelManager({
      logger: this.logger,
      enablePersistence: this.config.sentinel.enablePersistence,
      healthCheckGracePeriodMs: this.config.sentinel.healthCheckGracePeriodMs,
      waitForHealthChecks: this.config.sentinel.waitForAllHealthChecks,
      rootDirectory: this.config.executionPath, // Ensure sentinel files are in execution directory
      resolveFileBody: (data) => this.bodyResolver.resolve(data),
    });

    // Get LLM registry instance for cost calculations
    this.llmRegistry = LlmProviderRegistry.getInstance();

    // Set up state manager listeners
    this.setupStateManagerListeners();
  }

  /**
   * Set the telemetry collector for this runtime.
   * Called from index.ts after config resolution.
   */
  setTelemetryCollector(
    collector: import("./telemetry/telemetry-collector.js").TelemetryCollector,
  ): void {
    this.telemetryCollector = collector;

    // Subscribe to events for telemetry collection
    if (collector.isEnabled()) {
      this.on("event", (event) => {
        collector.handleEvent(event);
      });
    }
  }

  private setupStateManagerListeners(): void {
    this.stateManager.on("codonRunning", (data) => {
      // State is already saved when we get here
      const codon = this.stateManager.getCurrentlyRunningCodon();
      if (codon && "claudeSessionId" in codon) {
        // Look up codon config in execution plan
        const entry = this.stateManager.getCodonById(data.codonId);
        if (entry) {
          // Get frontmatter from the runner if available
          const runner = this.codonRunners.get(data.codonId);
          const promptMetadata = runner?.getPromptFrontmatter();

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
              promptMetadata,
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
    } catch (error) {
      // Only ESRCH proves the process is gone. EPERM means it exists but
      // belongs to another user — very much alive.
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  /** True only after THIS runtime instance wrote runtime.lock. */
  private ownsLockFile = false;
  /** Unique token for this instance's current lock acquisition. */
  private lockId: string | null = null;
  /**
   * Set when a successor's lockId is conclusively observed in runtime.lock:
   * this runtime is fenced — it must not reacquire the lock, and its
   * finalize diet must not run (it would unlink the journal the successor
   * is actively appending to).
   */
  private lockLostToSuccessor = false;

  /**
   * Write runtime.lock atomically (temp + rename). A plain truncating write
   * that fails midway (ENOSPC/EIO) leaves an empty/partial lock that no
   * later boot can parse — and fail-closed guards then refuse until someone
   * deletes it by hand. rename() replaces the file whole or not at all.
   */
  private writeLockFileAtomic(json: string): void {
    const tmp = `${this.config.lockFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, this.config.lockFile);
  }

  /**
   * Remove the lock file only if THIS runtime acquired it AND the file on
   * disk is still ITS acquisition (lockId match). A runtime whose start()
   * was refused must not unlink a sibling's lock, and a runtime that hung
   * past staleness and was legitimately replaced must not unlink its
   * successor's lock — either would leave a live runtime running unlocked.
   * The registry entry is always released (by token) and the heartbeat
   * stopped: an on-disk leftover then reads as recycled once its heartbeat
   * lapses, instead of wedging later same-process runtimes or being kept
   * fresh forever by an orphaned timer.
   */
  private removeOwnLockFile(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (!this.ownsLockFile) return;
    try {
      let stillOurs = false;
      try {
        const current = JSON.parse(fs.readFileSync(this.config.lockFile, "utf-8")) as {
          lockId?: unknown;
        };
        stillOurs = this.lockId !== null && current.lockId === this.lockId;
      } catch {
        // Absent, unreadable, or unparseable: not provably ours — leave it.
      }
      if (stillOurs) {
        try {
          fs.unlinkSync(this.config.lockFile);
          this.logger.log("Lock file removed");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            this.logger.log(`Failed to remove lock file: ${error}`, "error");
          }
        }
      } else {
        this.logger.log("Lock file is no longer this runtime's acquisition — leaving it");
      }
    } finally {
      if (this.lockId !== null) releaseProcessOwnedLock(this.lockId);
      this.lockId = null;
      this.ownsLockFile = false;
    }
  }

  /**
   * Fail fast when runtime.lock names a POSITIVELY live sibling instance —
   * read-only, before any journal mutation (restore, append-mode open). A
   * live pid with a fresh heartbeat always refuses: the old "recovering the
   * same run" branch in start()'s lock check let a second instance run
   * alongside a live first one (its own TODO admits recovery was never
   * implemented), and two instances racing one journal is data loss. Dead
   * and stale-heartbeat locks pass through — their removal, and the
   * RunCrashed transitions, stay with start()'s full lock check.
   */
  private assertNoLiveSiblingLock(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.config.lockFile, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return; // No lock — nothing to protect against.
      }
      // Present but unreadable: owner liveness is unknown — fail closed
      // before the journal-mutating steps below (a torn heartbeat rewrite
      // must not read as "no owner").
      throw new Error(
        `${this.config.lockFile} exists but could not be read — refusing to touch the event ` +
          `journal while owner liveness is unknown. Remove the lock file if this is incorrect.`,
      );
    }
    let pid: number | null = null;
    let heartbeatFresh = true;
    try {
      const parsed = JSON.parse(raw) as unknown;
      // Only a POSITIVE integer is a pid — kill(-n, 0) probes a process group.
      if (parsed && typeof parsed === "object") {
        const info = parsed as { pid?: unknown; lastHeartbeat?: unknown };
        if (typeof info.pid === "number" && Number.isInteger(info.pid) && info.pid > 0) {
          pid = info.pid;
        }
        if (typeof info.lastHeartbeat === "string") {
          const age = Date.now() - new Date(info.lastHeartbeat).getTime();
          // A heartbeat we cannot parse is unknown, not stale — fail closed.
          heartbeatFresh = Number.isNaN(age) ? true : age <= 120000;
        }
      } else if (typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0) {
        // Legacy bare-pid locks parse as a JSON number, not an object.
        pid = parsed;
      }
    } catch {
      const bare = Number(raw.trim());
      if (Number.isInteger(bare) && bare > 0) pid = bare;
    }
    if (pid === null) {
      // Neither JSON nor a bare pid — e.g. a torn mid-write lock. Liveness
      // unknown: fail closed, matching start()'s own unparseable-lock refusal
      // but BEFORE any journal mutation instead of after.
      throw new Error(
        `${this.config.lockFile} exists but could not be parsed — refusing to touch the event ` +
          `journal while owner liveness is unknown. Remove the lock file if this is incorrect.`,
      );
    }
    if (pid === process.pid) {
      if (isProcessOwnedLock(this.config.lockFile)) {
        // We wrote this lock: a live runtime in THIS process owns the
        // directory (two in-process runtimes, as integration tests do).
        throw new Error(
          `Server already running in this process — refusing to touch its event journal ` +
            `(${this.config.lockFile}).`,
        );
      }
      if (!heartbeatFresh) {
        // A dead predecessor whose pid we recycled (e.g. a restarted PID-1
        // container), gone long enough for its heartbeat to lapse — not a
        // sibling.
        return;
      }
      // Fresh (or unknown) heartbeat on an own-pid lock we did not write:
      // possibly a live incumbent in another pid namespace sharing this
      // volume (both PID 1). Refuse; a real leftover goes stale in 2min.
      throw new Error(
        `${this.config.lockFile} names this process's pid but was not written by it, and its ` +
          `heartbeat is not stale — refusing to touch the event journal. Retry after the ` +
          `heartbeat lapses, or remove the lock file if no runtime is running.`,
      );
    }
    if (!heartbeatFresh || !this.isProcessRunning(pid)) return;
    throw new Error(
      `Server already running (PID: ${pid}) — refusing to touch its event journal. ` +
        `Remove ${this.config.lockFile} if this is incorrect.`,
    );
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
  async start(): Promise<number> {
    this.logger.log(
      `Starting Hankweave Runtime v${this.config.version} in ${this.config.executionPath}`,
    );
    this.logger.log(`[DEBUG] Platform: ${process.platform}, Arch: ${process.arch}`);
    this.logger.log(`[DEBUG] Node version: ${process.version}`);

    // NOTE: Proxy startup moved AFTER WebSocket server to support dynamic ports

    // A live sibling instance may own this directory — including one mid-
    // shutdown whose finalize diet is about to swap events.jsonl for the
    // compressed pair. Touching the journal in that window buries its
    // history (our append-mode open would create an empty journal beside the
    // valid diet), and touching the checkpoint repo (rebuild,
    // temp-folder sweep) races its builder. Positively-live locks fail the
    // boot HERE, before either; dead/stale locks are recovered later by the
    // full lock check below, which owns lock removal and RunCrashed
    // transitions.
    this.assertNoLiveSiblingLock();

    // Initialize checkpoint system (checks for existing .hankweave)
    this.logger.log(`[DEBUG] Initializing checkpoints...`);
    await this.initializeCheckpoints();
    this.logger.log(`[DEBUG] Checkpoints initialized`);

    // Initialize state manager
    this.logger.log(`[DEBUG] Initializing state manager...`);
    await this.stateManager.initialize();
    this.logger.log(`[DEBUG] State manager initialized`);

    // Initialize replay policy (manifest load).
    await this.replay?.initializeForStartup({
      executionPath: this.config.executionPath,
      logger: this.logger,
    });

    // Initialize event journal. A dieted directory is auto-restored first
    // (verified byte-identical, stale diet pair pruned): the runtime must
    // never append to a dieted directory, and restoring is how a boot or
    // resume on one just works. Damaged diet artifacts still fail the boot.
    await ensureJournalRestored(this.config.executionPath, (message) => this.logger.log(message));
    this.logger.log(`[DEBUG] Initializing event journal...`);
    await this.eventJournal.initialize();
    this.logger.log(`[DEBUG] Event journal initialized`);

    // Initialize SentinelManager (creates .hankweave/sentinels directory)
    this.logger.log(`[DEBUG] Initializing sentinel manager...`);
    await this.sentinelManager.initialize();
    this.logger.log(`[DEBUG] Sentinel manager initialized`);

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
        const parsedLock = JSON.parse(lockData) as unknown;
        // A legacy bare-pid lock parses as a JSON number, not an object —
        // coerce it so a DEAD legacy lock is recovered below instead of
        // process.kill(undefined) reading as alive. Anything without an
        // integer pid throws into the old-format refusal.
        const lockInfo = (
          parsedLock && typeof parsedLock === "object" ? parsedLock : { pid: parsedLock }
        ) as { pid?: unknown; lastHeartbeat?: unknown; runId?: string };
        if (
          typeof lockInfo.pid !== "number" ||
          !Number.isInteger(lockInfo.pid) ||
          lockInfo.pid <= 0 // kill(-n, 0) probes a process GROUP, not a pid
        ) {
          throw new Error(`lock file has no usable pid`);
        }
        const heartbeatAge = Date.now() - new Date(String(lockInfo.lastHeartbeat)).getTime();

        // A lock naming OUR pid that this process did not write, whose
        // heartbeat has lapsed, is a dead predecessor's leftover on a
        // recycled pid (restarted PID-1 container) — kill(0) on ourselves
        // would read it as alive and this check would refuse forever. Route
        // it through the dead-process recovery below. A fresh-or-unknown
        // heartbeat does NOT qualify: it may be a live incumbent in another
        // pid namespace sharing the volume.
        const ownRecycled =
          lockInfo.pid === process.pid &&
          !isProcessOwnedLock(this.config.lockFile) &&
          heartbeatAge > 120000;

        // First check if the process is actually running
        const processRunning = !ownRecycled && this.isProcessRunning(lockInfo.pid);

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
          // Process is running and heartbeat is recent: another live instance
          // owns this directory. The old "recovering the same run" branch
          // (matching persisted currentRunId) never actually recovered — its
          // TODO admitted it — and simply let a second instance run beside a
          // live first one, racing the journal, state.json, and the lock.
          // A live owner always refuses, whatever run it is on.
          throw new Error(`Server already running (PID: ${lockInfo.pid}, Run: ${lockInfo.runId})`);
        }
      } catch (_e) {
        // Old format lock file - just PID
        throw new Error(
          `Server already running (PID: ${lockData}). Remove ${this.config.lockFile} if this is incorrect.`,
        );
      }
    }

    // Recovery decisions below rest on the thread's git validation. The
    // storage was proven readable by stateManager.initialize(), so this
    // strict build cannot mistake "unreadable" for "no checkpoints".
    const thread = await this.stateManager.getExecutionThreadForRecovery();

    if (this.replay) {
      // In replay mode, always start a fresh run — we replay all codons from scratch
      this.logger.log(`[REPLAY] Starting fresh run (replay mode ignores existing state)`);
      await this.startNewRun();
    } else if (thread?.failed) {
      // let see if execution thread from state manager has previously failed
      this.logger.log("Execution thread failed, rolling back...", "error");
      try {
        await this.rollbackToLastSuccess(this.config.autostart);
      } catch (error) {
        // A rollback rejected before it touched the work tree is a
        // degradation, not a failure: fall through to the continuation/
        // fresh-run logic below. One that failed after changing files, or
        // one that found the storage itself unreadable, must NOT start new
        // work on a half-restored folder — stop with a clear error.
        if (
          error instanceof RollbackMutatedWorkspaceError ||
          error instanceof CheckpointStorageError
        ) {
          throw this.recoveryStoppedError("rollback failed", error);
        }
        const message =
          `Recovery degraded: rollback could not start (${toError(error).message}); ` +
          "falling back to continuation or a fresh run";
        this.logger.log(`${message} (work tree untouched)`, "error");
        this.emitErrorEvent(message);
      }
    }

    if (!this.replay && !this.currentRunId) {
      // Every rollback path above either created the run or left the tree
      // untouched; pick a continuation seed or start fresh from history.
      await this.establishRunFromHistory();

      // Now switch to the new run's branch if we have checkpoints
      const currentRun = this.stateManager.getCurrentRun();
      if (currentRun?.gitBranch) {
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

    // Start WebSocket server FIRST (to get dynamic port before proxy starts)
    this.logger.log(`[DEBUG] About to start WebSocket server on port ${this.config.port}...`);
    try {
      this.server = serve<ClientData>({
        port: this.config.port, // If 0, Bun assigns a free port
        fetch: (request: Request) => {
          // HTTP requests are not supported - this is a WebSocket-only server
          // Return helpful error instead of crashing
          const url = new URL(request.url);
          this.logger.log(`HTTP request to ${url.pathname} rejected (WebSocket-only server)`);

          return new Response(
            JSON.stringify({
              error: "HTTP API not available",
              message: "This server only accepts WebSocket connections",
              websocket: `ws://${url.host}/ws`,
              help: "Connect to the WebSocket endpoint to interact with Hankweave",
            }),
            {
              status: 400,
              headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
              },
            },
          );
        },
        websocket: {
          upgrade: () => {
            // Initialize connection data before WebSocket opens
            const now = new Date();
            return {
              id: generateId(),
              connectionTime: now,
              lastActivity: now,
              handshakeComplete: false,
            };
          },
          open: (ws) => this.handleConnection(ws),
          message: (ws, message) => this.handleMessage(ws, message),
          close: (ws) => this.handleClose(ws),
        },
      });
      this.logger.log(`[DEBUG] serve() call completed successfully`);

      // IMPORTANT: If port was 0, update config with actual assigned port
      const actualPort = this.server.port;
      if (this.config.port === 0) {
        this.logger.log(`Dynamic port assigned: ${actualPort}`);
        this.config.port = actualPort; // Update config for consistency
      }

      this.logger.log(`WebSocket server listening on port ${actualPort}`);
    } catch (error) {
      this.logger.log(`[ERROR] Failed to start WebSocket server: ${error}`, "error");
      if (error instanceof Error && error.stack) {
        this.logger.log(`Stack: ${error.stack}`, "error");
      }
      throw error;
    }

    // NOW start proxy server AFTER we know the actual WebSocket port
    let actualProxyPort: number | undefined;
    if (!this.config.withoutProxy) {
      const preferredProxyPort = this.config.port + 1;
      this.logger.log(`Attempting to start proxy on port ${preferredProxyPort}`);

      try {
        this.proxyRunner = new ProxyRunner(
          "passthrough",
          preferredProxyPort,
          this.config.anthropicBaseUrl || "https://api.anthropic.com",
          this.logger,
        );
        this.proxyRunner.start();
        actualProxyPort = this.proxyRunner.getActualPort() ?? preferredProxyPort;
        this.logger.log(`Proxy server started on port ${actualProxyPort}`);
      } catch (error) {
        // If preferred port fails, try dynamic allocation
        // Check for EADDRINUSE via code property or error message
        const isPortError =
          error instanceof Error &&
          (("code" in error && (error as NodeJS.ErrnoException).code === "EADDRINUSE") ||
            error.message.toLowerCase().includes("address") ||
            error.message.toLowerCase().includes("port") ||
            error.message.toLowerCase().includes("eaddrinuse"));

        if (isPortError) {
          this.logger.log(`Port ${preferredProxyPort} unavailable, using dynamic port for proxy`);
          this.proxyRunner = new ProxyRunner(
            "passthrough",
            0, // Let OS assign
            this.config.anthropicBaseUrl || "https://api.anthropic.com",
            this.logger,
          );
          this.proxyRunner.start();
          actualProxyPort = this.proxyRunner.getActualPort() ?? 0;
          this.logger.log(`Proxy server started on dynamic port ${actualProxyPort}`);
        } else {
          // Log unexpected error for debugging, then re-throw
          this.logger.log(`Unexpected proxy startup error: ${error}`, "error");
          throw error;
        }
      }
    } else {
      this.logger.log("Proxy server disabled");
    }

    // Update lock file with actual ports
    this.updateLockFileWithPort(this.config.port, actualProxyPort);

    // Prominent port display
    console.log(`\n${"═".repeat(50)}`);
    console.log(`  Hankweave Server Started`);
    console.log(`  WebSocket: ws://localhost:${this.config.port}`);
    if (actualProxyPort !== undefined) {
      console.log(`  Proxy:     http://localhost:${actualProxyPort}`);
    }
    console.log(`${"═".repeat(50)}\n`);

    // Handle process termination — second signal escalates to force shutdown
    process.on("SIGINT", () => {
      if (this.isShuttingDown) {
        this.forceShutdown("second SIGINT");
      } else {
        this.shutdown("SIGINT");
      }
    });
    process.on("SIGTERM", () => {
      if (this.isShuttingDown) {
        this.forceShutdown("second SIGTERM");
      } else {
        this.shutdown("SIGTERM");
      }
    });
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

    // Register post-run trace upload if any platform is configured.
    // Stores the upload function and calls it explicitly in shutdown() so the
    // upload runs before process.exit() rather than blocking in an exit handler.
    if (isTraceEnabled()) {
      this.uploadTrace = registerTraceUpload(this.config.executionPath, this.logger);
    }

    // Return actual port for callers
    return this.config.port;
  }

  /**
   * Update the lock file with the actual server port.
   * Called after WebSocket server binds when using dynamic ports.
   */
  private updateLockFileWithPort(actualPort: number, proxyPort?: number): void {
    try {
      if (fs.existsSync(this.config.lockFile)) {
        const lockData = JSON.parse(fs.readFileSync(this.config.lockFile, "utf-8"));
        lockData.port = actualPort;
        if (proxyPort !== undefined) {
          lockData.proxyPort = proxyPort;
        }
        this.writeLockFileAtomic(JSON.stringify(lockData));
        this.logger.log(
          `Lock file updated with port ${actualPort}${proxyPort !== undefined ? `, proxy ${proxyPort}` : ""}`,
        );
      }
    } catch (error) {
      this.logger.log(`Failed to update lock file with port: ${error}`, "error");
    }
  }

  // -------------
  // WebSocket Connection Management
  // -------------

  private handleConnection(ws: HankweaveWebSocket<ClientData>): void {
    // Data is already initialized in the upgrade hook
    const clientId = ws.data.id;
    this.logger.log(`Client ${clientId} connected`);

    this.clients.set(clientId, ws);

    // Wait for handshake before sending events
    // Handshake will send initial state and handle autostart
    this.logger.log(`Client ${clientId} waiting for handshake`);
  }

  private async handleHandshake(
    ws: HankweaveWebSocket<ClientData>,
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
        agentRootPath: this.config.agentRootPath,
        dataPath: this.config.dataPathInExecutionDir,
        port: this.config.port,
        proxyPort: this.proxyRunner?.getActualPort() ?? undefined,
        outputDirectory: this.config.outputDirectory,
      },
    };

    // server.ready is a connection state event - send to client only, don't journal
    this.emit("event", serverReadyEvent, ws);

    this.logger.log(`[handleHandshake] config.autostart = ${this.config.autostart}`);
    if (this.config.autostart) {
      this.logger.log("[handleHandshake] Calling requestAutostart()");
      this.requestAutostart().catch((err) => {
        this.logger.log(`[handleHandshake] requestAutostart error: ${err}`, "error");
      });
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
    ws: HankweaveWebSocket<ClientData>,
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

  private handleClose(ws: HankweaveWebSocket<ClientData>): void {
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
    sender: HankweaveWebSocket<ClientData>,
  ): Promise<void> {
    this.logger.log(`Handling command: ${command.type}`);

    // Sockets stay open for a while during shutdown's awaited cleanup, and a
    // fenced runtime's directory may already belong to a successor — no
    // state-modifying command may land after the shutdown flag flips
    // (rollback reaching git/workspace resets was the concrete hazard).
    if (this.isShuttingDown && !this.READ_ONLY_COMMANDS.has(command.type)) {
      this.logger.log(
        `Client ${sender.data.id} attempted state-modifying command '${command.type}' during shutdown — refused`,
        "error",
      );
      return;
    }

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

      case "server.force_shutdown":
        await this.forceShutdown(command.data?.reason || "client force request");
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

  private handlePing(commandId: string, sender?: HankweaveWebSocket<ClientData>): void {
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

  private handlePingBroadcast(commandId: string, sender?: HankweaveWebSocket<ClientData>): void {
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
    sender?: HankweaveWebSocket<ClientData>,
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
    sender: HankweaveWebSocket<ClientData>,
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
    target?: HankweaveWebSocket<ClientData>,
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
    const activeRunner = this.currentCodon
      ? this.codonRunners.get(this.currentCodon.codonId)
      : undefined;

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
        // Pointer only ({path, timestamp}): the body was always a duplicate
        // of the immediately-preceding file.updated emission, and no consumer
        // read it (fingerprint-events proposal).
        recentFileAccess: activeRunner?.getRecentFileAccess(),
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
    if (this.lockLostToSuccessor) {
      // Fenced BEFORE any state mutation (RunStarted, currentRunId, body
      // resolver) — a successor owns this directory's state now, and the
      // later lock-reacquisition refusal alone would fire only after this
      // method had already queued transitions into the successor's state.
      throw new Error(
        "This runtime lost its lock to a successor instance — refusing to start a new run. " +
          "Shut this instance down.",
      );
    }
    if (this.isShuttingDown) {
      // A rollback-continuation (or any other caller) racing shutdown must
      // not rewrite runtime.lock and restart the heartbeat during teardown.
      throw new Error("Shutdown in progress — refusing to start a new run.");
    }
    const runId = RunId(`${Date.now()}-${Math.random().toString(36).substring(2, 7)}`);
    const runFolder = path.join(this.layout.runsDir, runId);

    // Retained bodies must not describe an earlier run's state.
    this.bodyResolver.clear();

    // Create run folder
    await fs.promises.mkdir(runFolder, { recursive: true });

    // The mkdir above yields to the event loop, where a heartbeat tick may
    // have fenced this runtime OR a shutdown may have begun — re-check both
    // before the first STATE mutation, or RunStarted/currentRunId (and the
    // lock rewrite + heartbeat restart further down) would land in the
    // successor's state or recreate the lock after teardown.
    if (this.lockLostToSuccessor) {
      throw new Error(
        "This runtime lost its lock to a successor instance — refusing to start a new run. " +
          "Shut this instance down.",
      );
    }
    if (this.isShuttingDown) {
      throw new Error("Shutdown in progress — refusing to start a new run.");
    }

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

    // Create budget facade for this run
    const state = this.stateManager.getState();
    this.budget = new Budget({
      config: {
        maxDollars: this.config.budget?.maxDollars,
        maxTimeSeconds: this.config.budget?.maxTimeSeconds,
        allocationMode: this.config.budget?.allocation,
        shares: this.config.budget?.shares,
        onExceeded: this.config.budget?.onExceeded,
      },
      executionPlan: state.executionPlan,
      logger: this.logger,
      telemetry: this.telemetryCollector ?? undefined,
      ...(startingConditions?.type === "continuation" && {
        priorRuns: { runs: state.runs, currentRunId: runId },
      }),
    });

    // Set run ID on telemetry collector for LLM analytics trace correlation
    if (this.telemetryCollector) {
      this.telemetryCollector.setRunId(runId);
    }

    // Update lock file with runId and heartbeat
    interface LockFile {
      pid: number;
      /**
       * Unique per lock acquisition. Pid + "acquired once" is not identity:
       * after >120s of missed heartbeats a successor may legitimately
       * replace this lock, and teardown/heartbeat must then recognize the
       * file is no longer theirs instead of unlinking or refreshing it.
       */
      lockId: string;
      runId: string;
      startTime: string;
      lastHeartbeat: string;
      port?: number; // Optional for backward compatibility with old lock files
    }

    // The new token is committed to this.lockId only AFTER the write
    // succeeds: assigning first would leave the instance holding token B
    // while disk and registry still carry token A on an ENOSPC/EACCES
    // failure — teardown would then release B (a no-op), skip the
    // still-owned A lock, and leak A's registry entry.
    const newLockId = randomUUID();
    const lockData: LockFile = {
      pid: process.pid,
      lockId: newLockId,
      runId,
      startTime: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      port: this.config.port, // NOTE: May be 0 initially if using dynamic port; updated after server binds
    };

    if (this.lockLostToSuccessor) {
      // A successor conclusively took this directory over; reacquiring would
      // stomp its lock and race its journal. This runtime is fenced.
      throw new Error(
        "This runtime lost its lock to a successor instance — refusing to reacquire " +
          `${this.config.lockFile}. Shut this instance down.`,
      );
    }
    const lockDir = path.dirname(this.config.lockFile);
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }
    this.writeLockFileAtomic(JSON.stringify(lockData));
    // Mark the lock as held by THIS runtime and process so the ownership
    // guards can tell a live in-process sibling from a recycled-pid
    // leftover, and so teardown only ever removes a lock it acquired. A
    // re-acquisition releases the previous token first.
    if (this.lockId !== null) releaseProcessOwnedLock(this.lockId);
    registerProcessOwnedLock(this.config.lockFile, newLockId);
    this.lockId = newLockId;
    this.ownsLockFile = true;

    // (Re)start the heartbeat — clearing any previous interval, or a
    // re-acquisition would leak a timer that shutdown can no longer stop.
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
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
      // Only ENOENT is "the lock is gone". existsSync also returns false on
      // EACCES/EIO, and fencing on a transient filesystem error would
      // permanently stop a healthy runtime's heartbeat — whose untouched
      // lock then goes stale and invites a takeover beside it.
      let lockPresent: boolean;
      try {
        fs.statSync(this.config.lockFile);
        lockPresent = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger.log(`Heartbeat: could not stat lock file (transient?): ${error}`, "error");
          return; // Unknown state — neither refresh nor fence this tick.
        }
        lockPresent = false;
      }
      if (!lockPresent) {
        if (this.ownsLockFile) {
          // We believe we hold the lock but the file is GONE: a successor
          // took over and already finished (removing its own lock), or an
          // operator deleted ours. Either way this runtime conclusively
          // lost the directory — the ABA case a foreign-token check alone
          // misses. Fence, same as an observed takeover.
          this.logger.log(
            "runtime.lock disappeared while this runtime believed it held it — fencing " +
              "(no lock reacquisition, no finalize diet)",
            "error",
          );
          this.fenceAfterLostLock();
        }
        return;
      }
      {
        const lock = JSON.parse(fs.readFileSync(this.config.lockFile, "utf-8"));
        // A lock that is not THIS acquisition belongs to a successor that
        // legitimately replaced us after our heartbeat lapsed. Our own
        // acquisition always carries a string UUID, so an ABSENT lockId is
        // foreign too (an older runtime's lock, or the diet CLI's
        // maintenance claim). Refreshing either would keep alive a lock we
        // no longer own; stop instead.
        if ((lock as { lockId?: unknown }).lockId !== this.lockId) {
          this.logger.log(
            "runtime.lock was taken over by another instance — stopping heartbeat and " +
              "fencing this runtime (no lock reacquisition, no finalize diet)",
            "error",
          );
          this.fenceAfterLostLock();
          return;
        }
        lock.lastHeartbeat = new Date().toISOString();
        this.writeLockFileAtomic(JSON.stringify(lock));
      }
    } catch (error) {
      this.logger.log(`Failed to update heartbeat: ${error}`, "error");
    }
  }

  /**
   * Common fencing after conclusively losing the lock (foreign token or
   * vanished file). Fencing is not bookkeeping alone: a displaced runtime
   * that keeps serving commands and starting codons is ongoing split-brain
   * against the successor's journal, state, and workspace — so this also
   * INITIATES shutdown. shutdown() flips isShuttingDown synchronously,
   * which closes the autostart/command gates; the finalize diet is
   * separately guarded by the fresh lock-ownership check, and teardown by
   * the lockId match. exitProcess=true, exit code 1: a fenced runtime has
   * no legitimate work left, the TUI holds raw stdin that would keep a
   * "drained" process alive forever, and exiting arms the shutdown
   * watchdog so a wedged cleanup cannot leave a fenced server serving. A
   * displaced runtime is a dead runtime.
   */
  private fenceAfterLostLock(): void {
    this.lockLostToSuccessor = true;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (this.lockId !== null) releaseProcessOwnedLock(this.lockId);
    this.lockId = null;
    this.ownsLockFile = false;
    if (!this.isShuttingDown) {
      void this.shutdown("lock lost to successor instance — fencing", true, 1).catch((error) => {
        this.logger.log(`Fencing shutdown failed: ${error}`, "error");
      });
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
   *
   * @param codonId - The codon to start
   * @param skipPreCommands - If true, skip rig setup (for runner failures where rig setup already succeeded)
   * @param isAutoRetry - If true, skip continuation run creation (for automatic retries within same run)
   */
  private async startCodon(
    codonId: CodonId,
    skipPreCommands?: boolean,
    isAutoRetry?: boolean,
  ): Promise<void> {
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

    // Skip the rig only if it already ran in THIS run (a retry). A rig-setup
    // checkpoint from an earlier run does not count: the restart that led
    // here restored a completion checkpoint, i.e. the tree from before the
    // rig ran, so the rig's work must be redone. See
    // StateManager.getRigSetupCheckpointInRun (66).
    const rigSetupCheckpoint = this.currentRunId
      ? (this.stateManager.getRigSetupCheckpointInRun(codonId, this.currentRunId) ?? undefined)
      : undefined;
    if (rigSetupCheckpoint) {
      this.logger.log(
        `Rig already ran in this run (checkpoint ${rigSetupCheckpoint.substring(0, 7)}); skipping rig setup`,
      );
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
    // Skip this check during auto-retry (we want to stay in the same run)
    const currentRun = this.stateManager.getCurrentRun();
    if (currentRun && !isAutoRetry) {
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

    let rigSetupTelemetry:
      | {
          commandCount: number;
          durationMs: number;
        }
      | undefined;

    // Run rig setup operations if configured, not explicitly skipped, and no checkpoint exists.
    //
    // Rig setup is intentionally skipped in replay mode. In replay, the execution directory
    // is copied wholesale from the original run (cpSync in index.ts), so it already contains
    // the post-rig-setup filesystem state. Re-running rig setup would be redundant and fragile —
    // source paths may have moved, network-dependent commands (e.g. installs) may fail, and
    // shell commands may behave differently on a different machine or at a different time.
    // Replay's goal is fast, deterministic reproduction of codon LLM output, not full
    // behavioral re-execution of the setup pipeline.
    if (
      !this.replay &&
      !skipPreCommands &&
      !rigSetupCheckpoint &&
      codon.rigSetup &&
      codon.rigSetup.length > 0
    ) {
      const rigSetupCount = codon.rigSetup.length;
      const rigSetupStartTime = Date.now();

      // CRITICAL: Initialize counters BEFORE the loop for completion event
      let rigSetupCompletedCount = 0;
      let rigSetupFailedCount = 0;

      this.logger.log(`Running rig setup for codon: ${codon.name}`);

      // Emit rig setup started info event
      // MESSAGE FORMAT CONTRACT: TUI uses string matching on "Rig setup started"
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "info",
        data: {
          message: `Rig setup started for codon '${codon.name}': ${rigSetupCount} operation${rigSetupCount !== 1 ? "s" : ""}`,
        },
      } as InfoEvent);

      let lastCopiedPath: string | null = null;

      for (const [index, item] of codon.rigSetup.entries()) {
        // Rig shells are untracked local children, so shutdown's kill pass
        // cannot stop them — cooperative cancellation between steps is the
        // bound. A shutdown (fencing included) that starts mid-setup must
        // not have further rig steps mutating what may now be a successor's
        // workspace. ABORT the whole codon start, not just the loop: falling
        // through would report completed setup, cut a rig-setup checkpoint
        // missing steps, and let a later resume skip them forever
        // (skipPreCommands trusts that checkpoint).
        if (this.isShuttingDown) {
          this.logger.log(
            `Codon start aborted before rig step ${index + 1}/${codon.rigSetup.length}: ` +
              `shutdown in progress — no completion is reported and no checkpoint is cut`,
          );
          return;
        }
        const operationNum = index + 1;
        const operationType = item.type;
        const operationDetails =
          item.type === "copy" && item.copy
            ? `${item.copy.from} → ${item.copy.to}`
            : item.type === "command" && item.command
              ? `'${item.command.run}'`
              : "unknown";

        // Emit operation start info event
        // MESSAGE FORMAT CONTRACT: TUI uses string matching on "Rig operation"
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "info",
          data: {
            message: `Rig operation ${operationNum}/${rigSetupCount}: ${operationType} ${operationDetails}`,
          },
        } as InfoEvent);
        try {
          if (item.type === "copy" && item.copy) {
            const targetPath = path.join(this.config.agentRootPath, item.copy.to);
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

            // Removal + copy are two operations: a shutdown landing during
            // the awaited removal must not be followed by a fresh cp -r
            // into what may now be a successor-owned workspace.
            if (this.isShuttingDown) {
              this.logger.log(
                `Codon start aborted between rig removal and copy for ${targetPath}: ` +
                  `shutdown in progress`,
              );
              return;
            }
            await this.copyPath(item.copy.from, targetPath);
            lastCopiedPath = targetPath;
            this.logger.log(`Copied ${item.copy.from} to ${targetPath}`);
          } else if (item.type === "command" && item.command) {
            await this.runCommand(item, lastCopiedPath || undefined, codon.env, {
              codonId: codon.id,
              commandIndex: index,
            });
            const resolvedWorkingDir =
              item.command.workingDirectory === "lastCopied" && lastCopiedPath
                ? lastCopiedPath
                : this.config.agentRootPath;
            this.logger.log(`Ran command in ${resolvedWorkingDir}: ${item.command.run}`);
          }
          // Operation succeeded
          rigSetupCompletedCount++;
        } catch (error) {
          const errorObj = toError(error);
          const errorMessage = errorObj.message;

          // Extract exit code if available (from command failures)
          const isCommandError = error instanceof CommandError;
          const exitCode = isCommandError ? error.exitCode : -1;
          const stdout = isCommandError ? error.stdout : "";
          const stderr = isCommandError ? error.stderr : "";

          // Diagnostic logging
          this.logger.log(`[DEBUG] Rig setup error details - Exit code: ${exitCode}`, "error");
          if (stdout) {
            this.logger.log(`[DEBUG] Rig setup error stdout: ${stdout}`, "info");
          }
          if (stderr) {
            this.logger.log(`[DEBUG] Rig setup error stderr: ${stderr}`, "error");
          }

          // Check if this operation allows failure (either per-operation or global flag)
          // NOTE: Use nullish coalescing since ignoreRigFailures is optional in the type
          const ignoreFailure = item.allowFailure || (this.config.ignoreRigFailures ?? false);
          this.emit("event", {
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "rig.setup.failed",
            data: {
              codonId: codonId,
              failureType: this.classifyRigSetupFailureType(error, item.type),
              exitCode: isCommandError ? exitCode : undefined,
              commandIndex: index,
              ignored: ignoreFailure,
            },
          } as RigSetupFailedEvent);
          if (ignoreFailure) {
            const reason = item.allowFailure ? "allowFailure=true" : "--ignore-rig-failures";
            // Log warning but continue execution
            this.logger.log(
              `Rig setup operation failed (${reason}) at item ${
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
                message: `Rig setup operation failed but continuing (${reason}): ${errorMessage}`,
                context: `Codon ${codon.id} - ${item.type} operation (item ${index + 1})`,
                codon: codon.id,
                fatal: false,
                severity: ErrorSeverity.OPERATION,
              },
            } as ErrorEvent);

            // Operation failed but allowed
            rigSetupFailedCount++;

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
          this.codonFailureError = errorObj;

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
                  exitCode, // Include exit code in metadata
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

          // Apply failure policy
          const decision = this.retryCoordinator.decide(codonId, codon, this.codonFailureReason);

          if (decision.action === "continue") {
            // Emit codon.completed event with failureIgnored flag
            // (Early failure paths don't go through handleCodonComplete)
            this.emit("event", {
              id: EventId(generateId()),
              timestamp: new Date().toISOString(),
              type: "codon.completed",
              data: {
                codonId: codonId,
                success: false,
                cost: 0, // No cost incurred during rig setup
                duration: Date.now() - (this.currentCodon?.startTime?.getTime() || Date.now()),
                exitStatus: { type: "error", code: exitCode },
                failureReason: this.codonFailureReason,
                failureIgnored: true,
              },
            } as CodonCompletedEvent);

            // Emit info event about the ignored failure
            this.emit("event", {
              id: EventId(generateId()),
              timestamp: new Date().toISOString(),
              type: "info",
              data: {
                message: `Codon ${codonId} rig setup failed, continuing (onFailure=ignore)`,
              },
            } as InfoEvent);

            this.cleanupCurrentCodon();

            await this.stateManager.waitForPendingTransitions();
            await this.stateManager.expandNextIterationForCodon({
              codonId: CodonId(codonId),
              contextExceeded: false,
              budgetExceeded: this.isLoopOrCodonBudgetExceeded(codonId),
            });

            // Ignored failure - proceed to next codon
            if (this.config.autostart) {
              await this.autoStartNextCodon();
            }
            return;
          }

          if (decision.action === "retry") {
            // Rig setup failures with retry policy - retry the codon
            // (rig setup will run again since we're not skipping)
            const { attempt, maxAttempts, delayBeforeThisAttemptMs } = decision;
            this.retryCoordinator.recordAttempt(codonId);

            this.emit("event", {
              id: EventId(generateId()),
              timestamp: new Date().toISOString(),
              type: "info",
              data: {
                message: `Retrying codon ${codonId} after rig setup failure (attempt ${attempt}/${maxAttempts}) in ${delayBeforeThisAttemptMs}ms`,
              },
            } as InfoEvent);

            this.cleanupCurrentCodon();
            await this.delay(delayBeforeThisAttemptMs);

            // Check if shutdown was requested during delay
            if (this.isShuttingDown) {
              this.logger.log(`Server shutting down, skipping retry for ${codonId}`);
              return;
            }

            // Don't skip rig setup on retry - that's what failed!
            // Pass isAutoRetry=true to prevent creating a new run
            await this.startCodon(codonId, false, true);
            return;
          }

          // Fall through to original error handling for shutdown cases
          this.cleanupCurrentCodon();
          await this.handleError(
            toError(error),
            `Rig setup item ${index + 1}`,
            ErrorSeverity.FATAL,
          );
          return;
        }
      }

      // Re-check after the LAST in-flight rig step: a shutdown that began
      // during it gets no next loop iteration to abort on, and falling
      // through would report completion and cut a rig-setup checkpoint
      // post-shutdown.
      if (this.isShuttingDown) {
        this.logger.log(
          "Codon start aborted after final rig step: shutdown in progress — " +
            "no completion is reported and no checkpoint is cut",
        );
        return;
      }

      // Emit rig setup completed info event
      // MESSAGE FORMAT CONTRACT: TUI uses string matching on "Rig setup completed" and "failed"
      const rigSetupDuration = Date.now() - rigSetupStartTime;
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "info",
        data: {
          message: `Rig setup completed for codon '${codon.name}' (${rigSetupDuration}ms, ${rigSetupCompletedCount} succeeded${rigSetupFailedCount > 0 ? `, ${rigSetupFailedCount} failed` : ""})`,
        },
      } as InfoEvent);

      rigSetupTelemetry = {
        commandCount: rigSetupCount,
        durationMs: rigSetupDuration,
      };
    }

    let rigSetupCheckpointCreated = false;

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

    // Load sentinels for this codon (during "starting" state).
    //
    // Sentinels are intentionally skipped in replay mode for several reasons:
    // 1. They make real LLM API calls with real cost — replay should be free to run.
    // 2. Sentinel LLM responses are non-deterministic, so re-running them would produce
    //    different output than the original run, undermining replay's reproducibility.
    // 3. Replay's goal is fast, deterministic codon output reproduction — sentinel
    //    analysis is orthogonal to that goal.
    // 4. The original sentinel events aren't part of the codon JSONL logs that replay
    //    reads from, so there's no recorded sentinel behavior to reproduce.
    const sentinelResult = this.replay
      ? { loaded: [], errors: [] }
      : await this.loadSentinelsForCodon(codon, codonId);

    // Check for fatal sentinel load failures
    const fatalFailures = sentinelResult.errors.filter((e) => e.fatal);
    if (fatalFailures.length > 0) {
      const failedSentinels = fatalFailures.map((e) => e.ref).join(", ");
      const errorMsg = `Required sentinels failed to load (failCodonIfNotLoaded=true): ${failedSentinels}`;

      // Use specific failure reason type
      this.codonFailureError = new Error(errorMsg);
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
            exitCode: -1,
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

      // Apply failure policy (sentinel failures respect codon onFailure config)
      const { action } = this.retryCoordinator.decide(codonId, codon, this.codonFailureReason);

      if (action === "continue") {
        // Emit codon.completed event with failureIgnored flag
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "codon.completed",
          data: {
            codonId: codonId,
            success: false,
            cost: 0,
            duration: Date.now() - (this.currentCodon?.startTime?.getTime() || Date.now()),
            exitStatus: { type: "error", code: -1 },
            failureReason: this.codonFailureReason,
            failureIgnored: true,
          },
        } as CodonCompletedEvent);

        // Emit info event
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "info",
          data: {
            message: `Codon ${codonId} sentinel load failed, continuing (onFailure=ignore)`,
          },
        } as InfoEvent);

        this.cleanupCurrentCodon();

        await this.stateManager.waitForPendingTransitions();
        await this.stateManager.expandNextIterationForCodon({
          codonId: CodonId(codonId),
          contextExceeded: false,
          budgetExceeded: this.isLoopOrCodonBudgetExceeded(codonId),
        });

        if (this.config.autostart) {
          await this.autoStartNextCodon();
        }
        return;
      }

      // shutdown/stay-active - original behavior
      // Note: Sentinel failures have retriable=false, so retry policy falls through to shutdown
      this.cleanupCurrentCodon();

      if (action === "shutdown") {
        if (this.currentRunId) {
          this.stateManager.transition({
            type: "RunFailed",
            data: { runId: this.currentRunId },
          });
          await this.stateManager.waitForPendingTransitions();
        }
        await this.shutdown("sentinel load failure");
      }
      return;
    }

    // Log warnings for non-fatal failures
    for (const error of sentinelResult.errors.filter((e) => !e.fatal)) {
      this.logger.log(
        `Non-required sentinel failed to load (${error.ref}): ${error.error}`,
        "info",
      );
    }

    // Register the checkpoint patterns in force for this codon: every plan
    // entry up to and including it (see checkpointPatternsThrough for why the
    // plan, not this.config.codons, is the source). The pattern set lives in
    // memory only, so this must run on every start — a crash restart begins
    // with an empty set.
    await this.registerCheckpointPatternsThrough(codonId, true);

    // A shutdown that began during the awaited sentinel/pattern work above
    // must not be followed by fresh checkpoint git operations (branch
    // checkout/commit) — abort the codon start instead.
    if (this.isShuttingDown) {
      this.logger.log("Codon start aborted before rig-setup checkpoint: shutdown in progress");
      return;
    }

    // Create checkpoint after rig setup if we have rig setup
    if (!skipPreCommands && codon.rigSetup) {
      try {
        await this.createCheckpoint({
          status: "rig-setup",
          codonId: codonId,
          codonName: codon.name,
          runId: this.currentRunId || RunId("unknown"),
          timestamp: new Date().toISOString(),
        });
        rigSetupCheckpointCreated = true;
      } catch (error) {
        // The codon is in `starting` here (rig work done, no runner yet).
        // Fail it the same way a missing continuation session does.
        await this.failCodonAtStart(
          codonId,
          codon,
          `Rig-setup checkpoint failed for codon ${codonId}: ${toError(error).message}`,
          toError(error),
        );
        return;
      }
    }

    if (rigSetupTelemetry) {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "rig.setup.completed",
        data: {
          codonId: codonId,
          rigType: rigSetupTelemetry.commandCount === 1 ? "command" : "commands",
          commandCount: rigSetupTelemetry.commandCount,
          durationMs: rigSetupTelemetry.durationMs,
          createdCheckpoint: rigSetupCheckpointCreated,
        },
      } as RigSetupCompletedEvent);
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
        this.codonFailureError = new Error(errorMessage);
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
                exitCode: -1,
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

        // Apply failure policy
        const { action } = this.retryCoordinator.decide(codonId, codon, this.codonFailureReason);

        if (action === "continue") {
          // Emit codon.completed event with failureIgnored flag
          this.emit("event", {
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "codon.completed",
            data: {
              codonId: codonId,
              success: false,
              cost: 0,
              duration: Date.now() - (this.currentCodon?.startTime?.getTime() || Date.now()),
              exitStatus: { type: "error", code: -1 },
              failureReason: this.codonFailureReason,
              failureIgnored: true,
            },
          } as CodonCompletedEvent);

          // Emit info event
          this.emit("event", {
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "info",
            data: {
              message: `Codon ${codonId} continuation session not found, continuing (onFailure=ignore)`,
            },
          } as InfoEvent);

          // Note: This is an unusual case - ignoring a continuation failure
          // The next codon may also fail if it expects to continue
          this.cleanupCurrentCodon();

          await this.stateManager.waitForPendingTransitions();
          await this.stateManager.expandNextIterationForCodon({
            codonId: CodonId(codonId),
            contextExceeded: false,
            budgetExceeded: this.isLoopOrCodonBudgetExceeded(codonId),
          });

          if (this.config.autostart) {
            await this.autoStartNextCodon();
          }
          return;
        }

        // shutdown/stay-active - let existing behavior proceed
        // (Missing continuation is non-retriable, so retry policy won't apply)
        this.cleanupCurrentCodon();

        if (action === "shutdown") {
          if (this.currentRunId) {
            this.stateManager.transition({
              type: "RunFailed",
              data: { runId: this.currentRunId },
            });
            await this.stateManager.waitForPendingTransitions();
          }
          await this.shutdown("continuation session not found");
        }
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
    };

    // NOTE: codon.started event is now sent when Claude sends init message
    // This ensures we have the actual session ID before notifying clients

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

      // Create runner for this codon and store in map (single source of truth)
      // Build config with proper discriminated union structure.
      const replayConfig = this.replay?.resolveCodonConfig(codonId, codon.id);

      if (!this.currentRunId) {
        throw new Error("No active run while creating CodonRunner");
      }
      const runId = this.currentRunId;

      const baseConfig = {
        codon,
        codonId,
        runId,
        stateManager: this.stateManager,
        executionPath: this.config.executionPath,
        agentRootPath: this.config.agentRootPath,
        logger: this.logger,
        llmRegistry: this.llmRegistry,
        logParsingInterval: this.config.logParsingInterval,
        anthropicBaseUrl: this.proxyRunner?.proxyUrl,
        logPath,
        globalSystemPrompt: this.config.globalSystemPrompt,
        // Wiring: CLI --shim-idle-timeout → resolveSettings → serverConfig → here → CodonRunner → ClaudeAgentSDKManager / PiSdkManager
        shimIdleTimeout: this.config.shimIdleTimeout,
        // Budget is always initialized in startNewRun() before any codon execution
        budget: this.budget as Budget,
        replayConfig,
      };

      // A shutdown (including a fencing shutdown) may have begun while the
      // rig/sentinel setup above was running — its one-time kill pass can
      // miss a codon that has no runner yet, so a runner must never LAUNCH
      // once shutdown is underway.
      if (this.isShuttingDown) {
        this.logger.log(
          `[runCodon] Shutdown in progress — not launching runner for codon ${codonId}`,
        );
        return;
      }

      // Extension config is only provided when exhaustWithPrompt is set
      // The discriminated union requires shouldInterrupt and onExtension when extensionConfig is present
      const runner = codon.exhaustWithPrompt
        ? new CodonRunner({
            ...baseConfig,
            extensionConfig: {
              exhaustWithPrompt: codon.exhaustWithPrompt,
              maxExtensions: codon.maxExtensions ?? 100,
            },
            shouldInterrupt: () => this.isSkippingCodon || this.isForceStopping,
            onExtension: (info: ExtensionInfo) => {
              this.handleExtension(codonId, codon, info);
            },
          })
        : new CodonRunner(baseConfig);
      this.codonRunners.set(codonId, runner);

      // Subscribe to runner events
      this.logger.log(`[runCodon] Setting up event handlers for codon ${codonId}`, "debug");
      this.setupCodonRunnerEventHandlers(codonId);

      // Start execution
      this.logger.log(
        `[runCodon] Starting runner execution for codon ${codonId}, previousSessionId: ${
          previousSessionId || "none"
        }`,
        "debug",
      );

      await runner.run(previousSessionId ? SessionId(previousSessionId) : undefined);
      this.logger.log(`[runCodon] Runner.run() completed for codon ${codonId}`, "debug");

      // Validate process started
      this.logger.log(`[runCodon] Validating process started for codon ${codonId}`, "debug");
      if (!this.currentRunId) {
        throw new Error("No active run while starting Claude process");
      }

      const pid = runner.getPid();
      this.logger.log(`[runCodon] Got PID ${pid} for codon ${codonId}`, "debug");
      if (!pid) {
        throw new Error("Failed to get process PID");
      }

      // Transition to initializing (fire-and-forget)
      this.logger.log(
        `[runCodon] Transitioning codon ${codonId} to initializing (PID: ${pid})`,
        "debug",
      );
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
      this.logger.log(
        `[runCodon] Successfully completed runCodon for ${codonId}, status should be initializing`,
        "debug",
      );
    } catch (error) {
      // LOG: Caught error during codon initialization
      this.logger.log(
        `[runCodon] CAUGHT ERROR during codon ${codonId} initialization: ${toError(error).message}`,
        "error",
      );
      this.logger.log(`[runCodon] Error stack: ${toError(error).stack}`, "error");
      const runnerForCleanup = this.codonRunners.get(codonId);
      this.logger.log(
        `[runCodon] State at error - currentRunId: ${
          this.currentRunId
        }, hasRunner: ${!!runnerForCleanup}`,
        "error",
      );

      // Clean up runner if initialization fails
      if (runnerForCleanup) {
        this.logger.log(
          `[runCodon] Calling cleanup on runner for codon ${codonId} due to error`,
          "error",
        );
        await runnerForCleanup.cleanup();
        this.codonRunners.delete(codonId);
        this.logger.log(`[runCodon] CodonRunner cleanup complete, removed from map`, "error");
      }

      // Transition to failed (fire-and-forget) if we have a run
      if (this.currentRunId) {
        this.logger.log(
          `[runCodon] Transitioning codon ${codonId} to failed due to error`,
          "error",
        );
        this.stateManager.transition({
          type: "CodonTransitioned",
          data: {
            runId: this.currentRunId,
            codonId: codonId,
            from: "starting",
            to: "failed",
            metadata: {
              exitCode: -1,
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
      this.logger.log(`[runCodon] Calling cleanupCurrentCodon()`, "error");
      this.cleanupCurrentCodon();
      this.logger.log(`[runCodon] Re-throwing error`, "error");
      throw error;
    }
  }

  /**
   * Set up event handlers for the current codon runner
   */
  private setupCodonRunnerEventHandlers(codonId: CodonId): void {
    const runner = this.codonRunners.get(codonId);
    if (!runner) {
      throw new Error(`Cannot setup handlers: no runner found for codon ${codonId}`);
    }

    // Process lifecycle events
    // CodonRunner now handles extension loop internally - exit is only emitted when truly done
    runner.on("exit", (code: number, isContextExceeded: boolean, extensionCount: number) => {
      if (isContextExceeded) {
        this.logger.log(
          `[HANKWEAVE-SERVER] Context exceeded error detected for codon ${codonId}`,
          "error",
        );
      }

      // Codon is truly complete (extension loop finished if any)
      this.handleCodonComplete(code, isContextExceeded, extensionCount);
    });

    runner.on("error", (error: Error) => {
      this.handleError(error, `Process for codon ${codonId}`, ErrorSeverity.FATAL);
    });

    // Live display of failures the runner classifies (error results, timeouts).
    // Forward as a non-fatal error event; nothing is stored — the authoritative
    // outcome is read via runner.getOutcome() in handleCodonComplete.
    runner.on("codonFailure", ({ reason, error }) => {
      this.logger.log(`Codon ${codonId} failure classified: ${reason.message}`, "error");
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "error",
        data: {
          // APITimeoutError carries the legacy display message + timing context
          message: error instanceof APITimeoutError ? error.message : reason.message,
          codon: codonId,
          fatal: false,
          severity: error instanceof APITimeoutError ? error.severity : ErrorSeverity.CODON,
          ...(error instanceof APITimeoutError && {
            context: JSON.stringify(error.context),
          }),
        },
      } as ErrorEvent);
    });

    // Watched-file state is owned by this runner. Runtime only adds the
    // public event envelope, which keeps journaling/broadcast/sentinels at the
    // server boundary and prevents one codon from sharing another's patterns.
    runner.on("fileUpdated", (data) => {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "file.updated",
        // Fingerprint form only — the body is hashed and retained for
        // sentinel resolution; journal and broadcast carry the same object
        // (diet decision 0.3.1 — no wire/journal divergence).
        data: this.bodyResolver.process(data),
      } as FileUpdatedEvent);
    });

    runner.on("fileTreeUpdated", (data) => {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "filetree.updated",
        data,
      } as FileTreeUpdatedEvent);
    });

    runner.on("fileTrackingError", (error, context) => {
      void this.handleError(error, context, ErrorSeverity.OPERATION);
    });

    // Log parser events (forwarded through runner)
    runner.on("systemMessage", (msg: SystemMessage) => {
      this.handleSystemMessage(msg, codonId);
    });

    // Pass the runner captured by this closure — not a lookup of "the current
    // runner" — so a message parsed during finalization overlap still routes
    // its file tools to the codon that produced it (no cross-codon pattern
    // leakage through a stale shared reference).
    runner.on("assistantMessage", (msg: AssistantMessage) => {
      this.handleAssistantMessage(msg, codonId, runner);
    });

    runner.on("userMessage", (msg: UserMessage) => {
      this.handleUserMessage(msg, codonId);
    });

    runner.on("resultMessage", (msg: ResultMessage) => {
      this.handleResultMessage(msg, codonId);
    });

    // Cost events — CodonRunner handles state transitions and logging internally.
    // Runtime just forwards to server event channel for client broadcasting.
    runner.on("costIncremented", (data) => {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "token.usage",
        data: {
          codonId: data.codonId,
          ...data.tokens,
          totalCost: data.totalCost,
          modelId: data.modelId,
        },
      } as TokenUsageEvent);
    });

    runner.on("finalCostSet", (data) => {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "token.usage",
        data: {
          codonId: data.codonId,
          ...data.tokens,
          totalCost: data.totalCost,
          ...(data.modelUsage ? { modelUsage: data.modelUsage } : {}),
          ...(!data.modelUsage ? { modelId: data.modelId } : {}),
        },
      } as TokenUsageEvent);
    });
  }

  private handleSystemMessage(msg: SystemMessage, codonId: string): void {
    // Debug logging for system messages
    if (msg.subtype === "init") {
      this.logger.log(
        `[handleSystemMessage] Received init message for codon ${codonId}, session: ${msg.session_id}`,
        "debug",
      );
      this.logger.log(
        `[handleSystemMessage] Condition check - subtype=init: true, has_session: ${!!msg.session_id}, has_currentCodon: ${!!this
          .currentCodon}, currentCodon_status: ${this.currentCodon?.status || "N/A"}`,
        "debug",
      );
    }

    if (
      msg.subtype === "init" &&
      msg.session_id &&
      this.currentCodon &&
      this.currentCodon.status === "initializing"
    ) {
      this.logger.log(
        `[handleSystemMessage] All conditions met, transitioning codon ${codonId} to running`,
        "info",
      );

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
      };

      // Log the session ID update
      this.logger.log(`Started codon ${codonId} with session ID: ${msg.session_id}`);

      // Send info event with codon ID
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "info",
        data: {
          message: `Started codon ${codonId} with session ID: ${msg.session_id}`,
        },
      } as InfoEvent);
    } else if (msg.subtype === "init") {
      this.logger.log(
        `[handleSystemMessage] Init message for codon ${codonId} did NOT meet all conditions - skipping transition`,
        "info",
      );
    }
  }

  private handleAssistantMessage(
    msg: AssistantMessage,
    codonId: string,
    runner: CodonRunner,
  ): void {
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

    // Presentation-only: timeout detection lives in
    // CodonRunner.detectAssistantTimeout, and cost tracking in CostTracker.

    const content = msg.message.content;
    const contentArray = Array.isArray(content)
      ? content
      : [{ type: "text" as const, text: content }];

    for (const item of contentArray) {
      if ("text" in item && item.type === "text") {
        const textItem = item as TextContent;

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

        // Feed file tools to the emitting runner's tracker at this item's
        // position: the tracker emits fileUpdated synchronously, so the
        // file.updated event lands immediately before this tool's
        // assistant.action, preserving the message's internal order. The
        // toolUseId becomes file.updated.source.toolUseId — the join from a
        // fingerprint to the receipt below that holds the change's bytes.
        runner.observeToolUse(toolItem.name, toolItem.input, toolItem.id);

        // Track this tool use for result matching
        this.pendingToolUses.set(toolItem.id, {
          toolName: toolItem.name,
          timestamp: Date.now(),
          codonId,
        });

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
            // CONTRACT: toolInput is journaled verbatim (see
            // assistantActionEventDataSchema) — with fingerprint-only
            // file.updated it is the journal's only copy of file bodies.
            toolInput: toolItem.input,
            toolUseId: toolItem.id,
          },
        } as AssistantActionEvent);
      }
    }
  }

  private handleResultMessage(msg: ResultMessage, codonId: string): void {
    // Presentation-only: result classification lives in CodonRunner (read at
    // completion via getOutcome(); the client-facing error event comes from
    // the forwarded codonFailure event).
    this.logger.log(`Codon ${codonId} result message received: ${msg.subtype}`);

    if (msg.subtype === "success" && !msg.is_error) {
      this.logger.log(`Codon ${codonId} completed successfully`);
    } else if (msg.subtype === "success" && msg.is_error) {
      this.logger.log(
        `Codon ${codonId} received result subtype="success" with is_error=true — treating as failure. Result: ${msg.result || "(empty)"}`,
        "error",
      );
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

  /**
   * Handle extension notification from CodonRunner.
   * Called when CodonRunner decides to extend and before it re-runs.
   *
   * This method:
   * 1. Emits codon.extended event for TUI/clients
   * 2. Updates state with new extension count
   */
  private handleExtension(codonId: CodonId, codon: Codon, info: ExtensionInfo): void {
    // Get current state for cumulative costs
    const currentState = this.stateManager.getCodonInCurrentRun(codonId);
    if (!currentState || currentState.status !== "running") {
      this.logger.log(`Cannot handle extension for ${codonId}: not in running state`, "error");
      return;
    }

    // Emit extension event for TUI/clients
    // Use info.exhaustWithPrompt (guaranteed by ExtensionInfo) instead of codon.exhaustWithPrompt
    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "codon.extended",
      data: {
        codonId: codonId,
        codonName: codon.name,
        extensionNumber: info.extensionNumber,
        exhaustWithPrompt: info.exhaustWithPrompt,
        cumulativeTokens: currentState.currentTokens,
        cumulativeCost: currentState.currentCost,
      },
    } as CodonExtendedEvent);

    this.logger.log(`Codon ${codonId} extending (extension #${info.extensionNumber})`, "info");

    // Update state with extension count
    if (this.currentRunId) {
      this.stateManager.transition({
        type: "ExtensionCountUpdated",
        data: {
          runId: this.currentRunId,
          codonId: codonId,
          extensionCount: info.extensionNumber,
        },
      });
    }
  }

  private async handleCodonComplete(
    exitCode: number,
    isContextExceeded: boolean,
    extensionCount: number,
  ): Promise<void> {
    this.logger.log(
      `[handleCodonComplete] ======= ENTERED handleCodonComplete - exitCode=${exitCode}, isContextExceeded=${isContextExceeded}, extensionCount=${extensionCount} =======`,
      "info",
    );
    const runner = this.currentCodon ? this.codonRunners.get(this.currentCodon.codonId) : undefined;
    const hasRunner = !!runner;
    this.logger.log(
      `[handleCodonComplete] currentCodon=${
        this.currentCodon?.codonId || "none"
      }, hasRunner=${hasRunner}`,
      "info",
    );

    // Get the current codon from the in-memory state first
    if (!this.currentCodon) {
      this.logger.log(`[handleCodonComplete] No currentCodon, returning early`, "info");
      return;
    }

    const codonId = this.currentCodon.codonId;
    const codonConfig = this.currentCodon.codon; // Save codon config before potential cleanup
    const wasSkipped = this.isSkippingCodon;

    // Now get the codon from state manager to ensure we have the latest status.
    // These early-returns are silent stalls of the completion handler — if the
    // record is missing or already terminal, the codon will NOT advance from
    // here. Log both so a wedge (e.g. the ATUS post-retry hang, where a stale
    // terminal record was fetched while the live retry sat in `running`) is
    // visible in the server log instead of presenting as silence.
    const currentCodon = this.stateManager.getCodonInCurrentRun(CodonId(codonId));
    if (!currentCodon) {
      this.logger.log(
        `[handleCodonComplete] No state record found for codon ${codonId} in current run — returning early (codon will not advance)`,
        "error",
      );
      return;
    }
    if (isTerminalCodonStatus(currentCodon.status)) {
      this.logger.log(
        `[handleCodonComplete] Codon ${codonId} is already terminal (status=${currentCodon.status}) — returning early without completing (exitCode=${exitCode})`,
        "info",
      );
      return;
    }

    // Get current status before any transitions
    const currentStatus = currentCodon.status;

    // Drain the log parser instead of sleeping for it.
    //
    // This used to be `await sleep(logParsingInterval * 2)` — a 2-second flat
    // tax on every codon completion at the production default, and ~35% of the
    // offline test tier's wall time. The sleep was a guess with both failure
    // modes: usually the parser is ALREADY caught up (every exit path runs
    // `emitExit` → `parseNow()` synchronously before the exit event fires), so
    // the wait bought nothing; and when the final result line was still
    // buffered in the manager's write stream, a fixed wait could still be too
    // short on a loaded machine — the "Timeout waiting for state.transition"
    // flake was exactly that.
    //
    // Now: re-parse on demand and stop the moment the result message is in.
    // The old sleep duration survives only as the ceiling, for exits that
    // legitimately have no result message (crashes, kills).
    {
      const drainDeadline = Date.now() + this.config.logParsingInterval * 2;
      runner?.parseLog();
      while (runner && !runner.hasResultMessage() && Date.now() < drainDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        runner.parseLog();
      }
    }

    // The parse above only QUEUES state transitions (running → completing and
    // the cost updates). The old sleep incidentally gave the queue time to
    // apply; without this the final transition below can read a stale
    // `running` and be rejected as `running → completed`. Wait for the queue
    // explicitly — that, plus the drained parser, is the entire condition the
    // old sleep was approximating.
    await this.stateManager.waitForPendingTransitions();

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

    // The runner owns "what happened" this attempt — read it once. Null-safe:
    // shim early-exits can complete without a runner in the map.
    const outcome = runner?.getOutcome();

    // Determine final status based on the actual codon outcome
    // Priority order: force stop > explicit skip > budget exceeded > success result >
    // acceptable context exceeded > error result > exit code
    let finalStatus: CodonStatus;
    // True when a failure's reason originates in the runtime (force-stop,
    // budget) rather than from the attempt itself — those reasons must not be
    // overwritten by the runner-outcome adoption below.
    let failureReasonOwnedByRuntime = false;

    if (this.isForceStopping) {
      finalStatus = "failed";
      failureReasonOwnedByRuntime = true;
    } else if (wasSkipped) {
      // User explicitly requested skip — honour intent even if the agent
      // managed to emit a result message before SIGTERM took effect.
      finalStatus = "skipped";
    } else if (this.budget?.isExceeded(codonId)) {
      const onExceeded = this.budget.getEffectiveLimits(codonId).onExceeded ?? "complete";
      if (onExceeded === "fail") {
        finalStatus = "failed";
        failureReasonOwnedByRuntime = true;
        this.codonFailureReason = {
          type: "unknown" as const,
          retriable: false,
          message: `Budget exceeded: ${this.budget.getExceededInfo(codonId)?.message || "unknown"}`,
        };
      } else {
        finalStatus = "completed";
      }
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "info",
        data: {
          message: `Codon ${onExceeded === "fail" ? "failed" : "completed"} (budget limit reached: ${this.budget.getExceededInfo(codonId)?.message || "unknown"})`,
        },
      } as InfoEvent);
    } else if (exitCode === 0 && outcome?.success) {
      finalStatus = "completed"; // Success result message with exit 0 = completed
    } else if (isContextExceeded && this.stateManager.isContextExceededAcceptable(codonId)) {
      // Context exceeded in a loop that terminates on context exceeded = completed.
      //
      // Checked BEFORE the exit-0-error-result branch below: input-overflow
      // signals arrive as ERROR results ("Prompt is too long" from the Claude
      // SDK, context_length_exceeded through pi — see isContextExceeded), and
      // in replay the process exits 0 after writing them. With the old order
      // those completions were shadowed into failures on the exit-0 path while
      // the live path (SDK throws → exit 1) completed — a live/replay
      // divergence. Non-context error results (billing, auth, …) don't match
      // isContextExceeded and still fail below.
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
    } else if (exitCode === 0 && outcome?.resultReceived && !outcome.success) {
      // Got a result message but it wasn't "success" (e.g., error subtype).
      // This catches API errors like insufficient credits that the SDK reports
      // as exit code 0 with an error result.
      finalStatus = "failed";
      this.logger.log(
        `Codon ${codonId} received error result message with exit code 0 — marking as failed`,
        "error",
      );
    } else if (exitCode !== 0) {
      finalStatus = "failed"; // Non-zero exit = failed
    } else {
      // Exit 0 but no result message and not skipped = failed
      finalStatus = "failed";
    }

    // Adopt the runner's classification for every runner-attributable failure.
    // Unconditional (no `!this.codonFailureReason` guard): the runner is the
    // single writer for attempt-derived reasons, so nothing can shadow its
    // classification. Runtime-owned reasons (force-stop, budget) are excluded
    // via failureReasonOwnedByRuntime. When the runner has no reason (shim
    // early-exit, or an exit with no result and no crash text), synthesize a
    // bounded-retriable backstop.
    if (finalStatus === "failed" && !failureReasonOwnedByRuntime) {
      this.codonFailureReason =
        outcome?.failureReason ??
        synthesizeMissingFailureReason({
          isForceStopping: this.isForceStopping,
          isContextExceeded,
          exitCode,
          // A process that exited with no result before establishing a session is
          // a local setup failure (non-retriable); default true when unknown to
          // preserve the bounded-retriable backstop.
          sessionEstablished: outcome?.sessionEstablished ?? true,
        });
      // Keep the runner's Error for telemetry stacks (e.g. APITimeoutError).
      this.codonFailureError = outcome?.failureError ?? this.codonFailureError;
    }

    // Create checkpoint BEFORE state transition. Left unset only when the
    // checkpoint failed; a completed codon is then failed instead.
    let checkpointSha: string | undefined;
    try {
      const checkpointType =
        finalStatus === "completed" ? "completed" : finalStatus === "skipped" ? "skipped" : "error";

      checkpointSha = await this.createCheckpoint({
        status: checkpointType,
        codonId: codonId,
        codonName: codonConfig.name || codonId,
        runId: this.currentRunId || RunId("unknown"),
        timestamp: new Date().toISOString(),
        duration: Date.now() - new Date(currentCodon.startTime).getTime(),
      });
    } catch (error) {
      // Already logged and emitted by createCheckpoint.
      if (finalStatus === "completed") {
        // For completed codons, checkpoint failure is critical
        finalStatus = "failed";
        this.codonFailureError = toError(error);
        this.codonFailureReason = {
          type: "unknown",
          retriable: false,
          message: `Checkpoint creation failed: ${toError(error).message}`,
        };
      }
    }

    // Re-fetch codon status after completing-sentinels transition (if it happened)
    const codonBeforeFinalTransition =
      sentinelCount > 0 ? this.stateManager.getCodonInCurrentRun(CodonId(codonId)) : updatedCodon;

    const budgetInfo = this.budget?.getExceededInfo(codonId);

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
            resultMessageReceived: outcome?.resultReceived ?? false,
            // Absent only when createCheckpoint threw, and then finalStatus is
            // never "completed" (see above) — the completed guard in
            // state-transition-guards rejects a blank SHA outright.
            ...(checkpointSha !== undefined && { checkpointSha }),
            contextExceeded: isContextExceeded,
            extensionCount,
            ...(budgetInfo && {
              budgetExceeded: {
                currency: budgetInfo.currency,
                limit: budgetInfo.limit,
                used: budgetInfo.used,
              },
            }),
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

    // Update budget tracking with final cost
    if (finalStatus === "completed") {
      this.budget?.completeCodon(codonId, finalCost);
    } else if (finalStatus === "failed") {
      this.budget?.failCodon(codonId, finalCost);
    } else if (finalStatus === "skipped") {
      this.budget?.skipCodon(codonId);
    }

    // The design decision to report 0 for skipped codons is handled here
    // For retried codons, include accumulated cost from failed attempts
    const accumulatedRetryCost = this.budget?.getAndClearRetryCost(codonId) ?? 0;
    const reportedCost = finalStatus === "skipped" ? 0 : finalCost + accumulatedRetryCost;

    // Determine if this failure will be ignored (for event reporting)
    const willIgnoreFailure = finalStatus === "failed" && codonConfig.onFailure === "ignore";

    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "codon.completed",
      data: {
        codonId,
        success: finalStatus === "completed",
        cost: reportedCost, // Use the authoritative, persisted cost (includes retry costs)
        duration: Date.now() - new Date(currentCodon.startTime).getTime(),
        // Derived from finalStatus, not the raw exit code: disguised API
        // errors exit 0, and reporting {type: "success"} for a failed codon
        exitStatus:
          finalStatus === "completed" ? { type: "success" } : { type: "error", code: exitCode },
        failureReason: finalStatus === "failed" ? this.codonFailureReason : undefined,
        // Mark if this failure will be ignored due to onFailure config
        failureIgnored: willIgnoreFailure ? true : undefined,
        budgetExceeded: budgetInfo
          ? {
              currency: budgetInfo.currency,
              limit: budgetInfo.limit,
              used: budgetInfo.used,
            }
          : undefined,
      },
    } as CodonCompletedEvent);

    // DRAIN 2: Process any sentinel work triggered by codon.completed
    // The codon.completed event above is routed to sentinels via fire-and-forget
    // (setupSentinelEventRouting). Without this second drain, sentinels watching
    // codon.completed would have their triggers queued but never processed —
    // they'd be silently dropped when the sentinel is destroyed for the next codon.
    //
    // Safe from infinite loops: sentinel events (sentinel.output, etc.) are NOT
    // routed back to sentinels, and codon.completed fires exactly once.
    if (this.sentinelManager && sentinelCount > 0) {
      await this.sentinelManager.completeAllWork();

      // Re-capture sentinel states after post-completion work.
      // This updates costs to include any LLM work triggered by codon.completed.
      if (this.currentRunId) {
        const postCompletionStates = this.sentinelManager.getSentinelStates();
        const postCompletionCost = postCompletionStates.reduce(
          (sum, state) => sum + state.totalCost,
          0,
        );

        this.stateManager.transition({
          type: "SentinelStatesUpdated",
          data: {
            runId: this.currentRunId,
            codonId,
            sentinelStates: postCompletionStates,
            totalCost: postCompletionCost,
          },
        });

        await this.stateManager.waitForPendingTransitions();
      }
    }

    // Send state snapshot
    await this.sendStateSnapshot();

    // Copy outputs to external directory only if outputDirectory is configured
    // If outputDirectory is undefined, outputs stay in the agent workspace ({executionPath}/agentRoot)
    if (finalStatus === "completed" && codonConfig.outputFiles && this.config.outputDirectory) {
      for (const [groupIndex, outItem] of codonConfig.outputFiles.entries()) {
        // beforeCopy runs arbitrary shell commands and each group performs
        // several copies — do not start another group once shutdown began
        // (the awaited snapshot/sentinel work above yields).
        if (this.isShuttingDown) {
          this.logger.log(
            `Output copy aborted before group ${groupIndex + 1}: shutdown in progress`,
          );
          break;
        }
        let beforeCopySuccess = false;
        try {
          if (outItem.beforeCopy && outItem.beforeCopy.length > 0) {
            this.logger.log(
              `Running ${outItem.beforeCopy.length} beforeCopy command(s) for codon ${
                codonConfig.id
              } (group ${groupIndex + 1})`,
            );

            for (const [index, command] of outItem.beforeCopy.entries()) {
              this.logger.log(
                `Running beforeCopy command ${index + 1}/${
                  outItem.beforeCopy.length
                }: ${command.command.run}`,
              );
              await this.runCommand(command, undefined, codonConfig.env);
            }

            this.logger.log(
              `Completed all beforeCopy commands for codon ${
                codonConfig.id
              } (group ${groupIndex + 1})`,
            );
          }

          beforeCopySuccess = true;

          const { conflicts } = await copyFiles(
            this.config.agentRootPath, // Agent workspace — where output files actually live
            outItem.copy,
            this.config.outputDirectory, // Already resolved to absolute path in index.ts
            this.logger,
            { overwrite: this.config.overwriteOutput },
          );

          // Emit info events for any file conflicts
          if (conflicts.length > 0) {
            this.logger.log(
              `Output file conflicts resolved: ${conflicts.length} file(s) renamed`,
              "info",
            );

            this.emit("event", {
              id: EventId(generateId()),
              timestamp: new Date().toISOString(),
              type: "info",
              data: {
                message: `Output file conflicts: ${conflicts.length} file(s) were renamed to avoid overwriting.`,
                details: conflicts.map((c) => ({
                  original: path.basename(c.original),
                  resolved: path.basename(c.resolved),
                })),
              },
            } as import("./types/types.js").InfoEvent);

            // Conflict summary display
            console.log(`\nOutput files copied to ${this.config.outputDirectory}`);
            console.log(`  Conflicts resolved:`);
            for (const c of conflicts) {
              console.log(`    - ${path.basename(c.original)} → ${path.basename(c.resolved)}`);
            }
          }
        } catch (error) {
          await this.handleError(
            new Error(`Copy group ${groupIndex} failed with: ${String(error)}`),
            beforeCopySuccess ? "codonOutputCopyFiles" : "codonOutputBeforeCopy",
          );
          // An output-stage failure (beforeCopy validator or copy) must fail
          // the run. handleError at OPERATION severity only logs and notifies;
          // without the transition + shutdown below the runtime proceeds to
          // the "all codons completed" shutdown and exits 0 despite the
          // failure. Fail fast: don't run remaining output groups.
          if (this.currentRunId) {
            this.stateManager.transition({
              type: "RunFailed",
              data: { runId: this.currentRunId },
            });
            await this.stateManager.waitForPendingTransitions();
          }
          await this.shutdown("codon failure");
          return;
        }
      }
    }

    // Execute archiveOnSuccess if configured (after outputFiles, before loop expansion)
    if (finalStatus === "completed" && codonConfig.archiveOnSuccess) {
      const loopCtx = currentCodon.loopContext;
      await this.executeArchiveRigs(
        codonConfig.archiveOnSuccess,
        codonId,
        checkpointSha || "orphan", // Use 'orphan' if no checkpoint (shouldn't happen for completed)
        loopCtx ? { loopId: loopCtx.loopId, iteration: loopCtx.iteration } : undefined,
        false, // not a loop-level archive
      );
    }

    // Loop expansion logic
    // Check if this completed codon is part of a loop and expand next iteration if needed
    if (finalStatus === "completed" || finalStatus === "skipped") {
      const expansionResult = await this.stateManager.expandNextIterationForCodon({
        codonId: CodonId(codonId),
        contextExceeded: isContextExceeded,
        budgetExceeded: this.isLoopOrCodonBudgetExceeded(codonId),
      });

      // Update budget's execution plan after loop expansion may have added new entries
      this.budget?.updateExecutionPlan(this.stateManager.getState().executionPlan);

      // Handle loop termination archives
      if (expansionResult.loopTerminated?.archiveOnSuccess?.length) {
        const { loopId, archiveOnSuccess, completedIterations } = expansionResult.loopTerminated;
        this.logger.log(
          `Loop '${loopId}' terminated after ${completedIterations} iterations, executing archiveOnSuccess`,
        );
        await this.executeArchiveRigs(
          archiveOnSuccess,
          loopId, // Use loop ID as the codon ID for archive path construction
          checkpointSha || "orphan",
          undefined, // No loop context for loop-level archives
          true, // This IS a loop-level archive
        );
      }

      this.emitLoopIterationCompletedEvent({
        codonId: CodonId(codonId),
        isContextExceeded,
      });
    }

    // Capture the classified failure context BEFORE cleanup. cleanupCurrentCodon()
    // (below) nulls this.codonFailureReason/Error, but the failure-policy
    // resolution and telemetry below still need them — otherwise resolveFailurePolicy
    // sees "no failure reason", treats every retriable failure as non-retriable, and
    // `onFailure: "retry"` silently falls back to abort (and `onFailure: "abort"`
    // shuts down instead of staying active). Covered by
    // tests/e2e/error-classification-replay-e2e.test.ts.
    const capturedFailureReason = this.codonFailureReason;
    const capturedFailureError = this.codonFailureError;

    // Clean up - now happens after state is persisted
    // RACE CONDITION FIX: Look up the runner by codonId from the map
    // This ensures we clean up the correct runner even if autoStartNextCodon already started a new codon
    this.logger.log(
      `[handleCodonComplete] About to cleanup codon ${codonId} - exitCode=${exitCode}, isContextExceeded=${isContextExceeded}, finalStatus=${finalStatus}`,
      "info",
    );
    this.logger.log(`[handleCodonComplete] Stack trace:\n${new Error().stack}`, "debug");

    const runnerToCleanup = this.codonRunners.get(codonId);
    if (runnerToCleanup) {
      this.logger.log(
        `[handleCodonComplete] Found runner for codon ${codonId}, cleaning up`,
        "info",
      );
      await runnerToCleanup
        .cleanup()
        .catch((err) =>
          this.logger.log(`Error cleaning up runner for ${codonId}: ${err}`, "error"),
        );
      this.codonRunners.delete(codonId);
    } else {
      this.logger.log(`[handleCodonComplete] No runner found in map for codon ${codonId}`, "info");
    }

    // Only clear current codon state if this is still the current codon
    if (this.currentCodon?.codonId === codonId) {
      this.logger.log(`[handleCodonComplete] Clearing current codon state for ${codonId}`, "info");
      this.cleanupCurrentCodon();
    } else {
      this.logger.log(
        `[handleCodonComplete] Not clearing current codon state (current is ${
          this.currentCodon?.codonId || "none"
        }, completed is ${codonId})`,
        "info",
      );
    }

    this.logger.log(`[handleCodonComplete] Cleanup completed for codon ${codonId}`, "info");

    // Handle next steps
    if ((finalStatus === "completed" || finalStatus === "skipped") && !this.isShuttingDown) {
      // Clear retry counters for this codon (cost was already included in event emission)
      this.retryCoordinator.reset(codonId);

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
      // Capture error for PostHog error tracking
      try {
        const { captureError } = await import("./telemetry/error-tracking.js");
        const { sha256 } = await import("./telemetry/privacy-maps.js");
        const { getMetadata } = await import("./utils.js");
        const failureType = capturedFailureReason?.type || "unknown";
        const failureMsg = capturedFailureReason?.message || `Codon ${codonId} failed`;

        // Use the original error when available — its stack trace points to where
        // the failure actually happened. Fall back to a synthetic error if we
        // don't have the original (e.g., failures detected from log analysis).
        const err = capturedFailureError || new Error(failureMsg);
        err.name = `CodonFailure:${failureType}`;

        // Look up codon position from execution plan for correlation
        const executionPlan = this.stateManager.getState().executionPlan;
        const codonPosition = executionPlan.findIndex((e) => e.codonId === codonId);

        captureError(err, {
          codonStatus: "failed",
          runStatus: "failed",
          failureType,
          exitCode,
          errorCode: failureType,
          // Correlation context for cross-referencing with telemetry events
          runIdHash: this.currentRunId ? sha256(this.currentRunId) : undefined,
          codonIdHash: sha256(codonId),
          codonPosition: codonPosition >= 0 ? codonPosition : undefined,
          model:
            typeof codonConfig.model === "string"
              ? codonConfig.model
              : codonConfig.model?.name || codonConfig.model?.modelId,
          hankweaveVersion: getMetadata().version,
        });
      } catch {
        // Silent fail - error tracking should never impact runtime
      }

      const decision = this.retryCoordinator.decide(codonId, codonConfig, capturedFailureReason);

      switch (decision.action) {
        case "shutdown":
          // Non-retriable failure or exhausted retries - fail the run and shutdown
          if (this.currentRunId) {
            this.stateManager.transition({
              type: "RunFailed",
              data: { runId: this.currentRunId },
            });
            await this.stateManager.waitForPendingTransitions();
          }
          await this.shutdown("codon failure");
          break;

        case "stay-active":
          // Retriable failure with abort policy. The intent is to park the
          // server so an interactive client can issue a manual retry. In
          // headless mode there is no such client, so parking hangs the
          // process forever (and any parent process waiting on it). Fail the
          // run and shut down instead; the shutdown watchdog guarantees exit.
          if (this.config.headless) {
            this.logger.log(
              `Codon ${codonId} failed with retriable error in headless mode (no client to retry) — failing run and shutting down.`,
            );
            if (this.currentRunId) {
              this.stateManager.transition({
                type: "RunFailed",
                data: { runId: this.currentRunId },
              });
              await this.stateManager.waitForPendingTransitions();
            }
            await this.shutdown("codon failure (headless, no client to retry)");
          } else {
            this.logger.log(`Codon failed with retriable error. Server remains active.`);
          }
          break;

        case "retry": {
          const { attempt, maxAttempts, delayBeforeThisAttemptMs } = decision;

          // Accumulate cost from this failed attempt before retrying
          // Note: this.currentCodon is already cleaned up at this point, use finalCost from state
          const currentCost = finalCost;
          this.budget?.accumulateRetryCost(codonId, currentCost);

          this.retryCoordinator.recordAttempt(codonId);

          this.logger.log(
            `Retry ${attempt}/${maxAttempts} for codon ${codonId} in ${delayBeforeThisAttemptMs}ms`,
          );

          // Emit info event about the retry
          this.emit("event", {
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "info",
            data: {
              message: `Retrying codon ${codonId} (attempt ${attempt}/${maxAttempts})`,
            },
          } as InfoEvent);

          await this.delay(delayBeforeThisAttemptMs);

          // Check if server is shutting down before retrying
          // (User may have requested shutdown during the delay period)
          if (this.isShuttingDown) {
            this.logger.log(`Server shutting down, skipping retry for ${codonId}`);
            return;
          }

          // NOTE: Cleanup already happened above for all status values.
          // Do NOT call cleanupCurrentCodon() again here.

          // Retry the codon with skipPreCommands=true (rig setup already succeeded)
          // and isAutoRetry=true to prevent creating a new continuation run
          await this.startCodon(CodonId(codonId), true, true);
          break;
        }

        case "continue": {
          // Clear retry counters for this codon
          this.retryCoordinator.reset(codonId);

          // Emit info event about the ignored failure
          this.emit("event", {
            id: EventId(generateId()),
            timestamp: new Date().toISOString(),
            type: "info",
            data: {
              message: `Codon ${codonId} failed, continuing (onFailure=ignore)`,
            },
          } as InfoEvent);

          // Note: The codon.completed event was already emitted above with failureIgnored flag

          // Run loop expansion (normally only for completed/skipped, but also for ignored failures)
          await this.stateManager.expandNextIterationForCodon({
            codonId: CodonId(codonId),
            contextExceeded: false, // Failed codon, not context exceeded
            budgetExceeded: this.isLoopOrCodonBudgetExceeded(codonId),
          });
          this.emitLoopIterationCompletedEvent({
            codonId: CodonId(codonId),
            isContextExceeded: false,
          });

          // Check if there's a next codon to run
          const thread = await analyzeExecutionThread(
            this.stateManager.getState(),
            undefined,
            undefined,
            this.logger,
          );
          const hasNextCodon = thread.nextCodonId !== null;

          if (hasNextCodon) {
            // Auto-start next codon if configured
            if (this.config.autostart) {
              await this.autoStartNextCodon();
            } else {
              this.emit("event", {
                id: EventId(generateId()),
                timestamp: new Date().toISOString(),
                type: "server.idle",
                data: {
                  reason: "codon-completed",
                  message: `Codon ${codonId} failed (ignored). Use 'codon.next' to continue.`,
                },
              } as import("./types/types.js").ServerIdleEvent);
            }
          } else {
            // This was the last codon - mark run as completed
            // The run succeeded overall because all codons were executed (some failed-but-ignored)
            if (this.currentRunId) {
              this.stateManager.transition({
                type: "RunCompleted",
                data: { runId: this.currentRunId },
              });
              await this.stateManager.waitForPendingTransitions();
            }
            // Emit idle with all-codons-completed since all codons have run
            this.emit("event", {
              id: EventId(generateId()),
              timestamp: new Date().toISOString(),
              type: "server.idle",
              data: {
                reason: "all-codons-completed",
                message: `Run completed. Last codon ${codonId} failed (ignored).`,
              },
            } as import("./types/types.js").ServerIdleEvent);
          }
          break;
        }
      }
    }
  }

  // -------------
  // Failure Policy Helpers
  // -------------
  // Policy decisions and retry bookkeeping live in RetryCoordinator; the
  // runtime keeps only the effects (emitting, delaying, respawning the codon).

  /**
   * Simple delay helper for retry timing.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
   * Request the initial autostart of codons. Idempotent - multiple calls are safe.
   * Called automatically in headless mode on startup, and on client handshake.
   *
   * This guards against triggering autostart TWICE (from both headless and handshake).
   * It does NOT prevent autoStartNextCodon() from running subsequent codons.
   */
  public async requestAutostart(): Promise<void> {
    if (this.initialAutostartTriggered) {
      this.logger.log(`[requestAutostart] Initial autostart already triggered, ignoring`);
      return;
    }

    if (!this.config.autostart) {
      this.logger.log(`[requestAutostart] Autostart disabled`);
      return;
    }

    // Set flag IMMEDIATELY (synchronously) to prevent race condition
    this.initialAutostartTriggered = true;
    this.logger.log(`[requestAutostart] Triggering initial autostart`);

    await this.autoStartNextCodon(true);
  }

  /**
   * Automatically start the next available codon if none is running.
   * Called on connection and after codon completion.
   *
   * @param initialAutostart true only for the startup autostart from
   *   requestAutostart() — used to detect a no-op rerun of a completed
   *   execution (issue #231).
   */
  private async autoStartNextCodon(initialAutostart = false): Promise<void> {
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
        // Current behavior - announce completion and shut down
        this.announceAllCodonsCompleted(initialAutostart);

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

  /**
   * Emit the "all codons completed" info event that precedes the autostart
   * shutdown.
   *
   * Issue #231: a resumed, already-completed execution reaches this point on
   * the very first autostart without running anything. Say so on the console
   * instead of looking like a successful fresh run. The reason === "continue"
   * check keeps rollback's empty continuation runs (reason: "rollback") from
   * triggering the notice.
   *
   * @param initialAutostart true only for the startup autostart from
   *   requestAutostart().
   */
  private announceAllCodonsCompleted(initialAutostart: boolean): void {
    const run = this.stateManager.getCurrentRun();
    const isStartupNoop =
      initialAutostart &&
      this.config.isResuming &&
      run?.startingConditions.type === "continuation" &&
      run.startingConditions.reason === "continue" &&
      run.codons.length === 0;

    // MESSAGE FORMAT CONTRACT: the TUI string-matches
    // "All codons completed successfully" (server/basic-tui.ts) — the
    // no-op message must not contain that substring.
    const message = isStartupNoop
      ? `Resumed completed execution ${path.basename(this.config.executionPath)} — nothing to do. All codons already completed. Use --start-new to run fresh.`
      : "All codons completed successfully. Server shutting down.";

    if (isStartupNoop && this.config.headless) {
      // Headless has no connected client to render the info event; print
      // directly. TUI mode renders the event, so don't print twice.
      console.log(message);
    }

    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "info",
      data: {
        message,
      },
    } as InfoEvent);
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

    const runner = this.codonRunners.get(this.currentCodon.codonId);
    if (runner) {
      await runner.kill("SIGTERM");
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
    this.codonFailureError = new Error(`Force stopped: ${reason || "user request"}`);
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
    if (this.currentCodon) {
      const runner = this.codonRunners.get(this.currentCodon.codonId);
      if (runner) {
        await runner.kill("SIGTERM");
      }
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

    // Build execution thread for current timeline, with git's checkpoint
    // map: the codon-by-codon walk steps through validatedCheckpoints, so a
    // thread built without it walks nothing and emits no per-codon events.
    const state = this.stateManager.getState();
    const thread = await this.stateManager.getExecutionThread();

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
    // Checkpoint restore changes files underneath the retained-body map —
    // drop it so sentinel resolution never serves a pre-rollback body.
    this.bodyResolver.clear();

    try {
      // 0. Preflight the target and snapshot the work tree BEFORE any state
      // or workspace mutation, exactly as the codon-by-codon rollback does:
      // a dangling reference must fail here, not after the current run has
      // already been marked completed.
      sha = (await this.confirmAndSnapshot(sha, `direct rollback to ${sha.substring(0, 7)}`))
        .checkpoint;
      const entriesToRestore = await this.planArchiveRestore(sha);

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

      // 5. Put the work tree at the target checkpoint.
      // The awaits above (pending transitions) yield — a fencing shutdown
      // landing there must stop this rollback before its first workspace
      // mutation.
      if (this.isShuttingDown) {
        throw new Error("Direct rollback aborted: shutdown in progress");
      }
      this.logger.log(`Resetting to checkpoint ${sha.substring(0, 7)}`);
      try {
        await this.restoreWorkTreeToCheckpoint(sha, entriesToRestore);
      } catch (error) {
        throw new RollbackMutatedWorkspaceError(error);
      }
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
      } else {
        // Not auto-restarting — tell the user we're waiting
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "server.idle",
          data: {
            reason: "rollback-completed",
            message: `Rollback completed. Use 'codon.next' to continue.`,
          },
        } as import("./types/types.js").ServerIdleEvent);
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

    // Build execution thread to search across all runs, with git's
    // checkpoint map (see rollbackToCheckpoint).
    const thread = await this.stateManager.getExecutionThread();

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
      this.emitErrorEvent("Cannot rollback while codon is running. Use 'codon.forceStop' first.", {
        codon: currentCodon.codonId,
      });
      return;
    }

    // Rungs 0 and 1 are decided by the state manager on the strict thread
    // (unreadable storage throws CheckpointStorageError for start()'s catch).
    const { thread, target, passedOverCompletion } = await this.stateManager.findRollbackTarget();
    if (passedOverCompletion?.codon.status === "completed") {
      this.logger.log(
        `Completed codon ${passedOverCompletion.codon.codonId} (run ${passedOverCompletion.runId}) ` +
          "has no git-confirmed completion checkpoint (reference " +
          `${JSON.stringify(passedOverCompletion.codon.completionCheckpoint)}) — not a rollback target`,
        "error",
      );
    }
    if (target) {
      const tc = thread.codons[target.index];
      this.logger.log(
        `Rolling back to ${target.type} checkpoint of codon ${tc.codon.codonId} (run ${tc.runId}): ` +
          JSON.stringify(tc),
      );
      await this.executeRollback(thread, target.index, target.sha, target.type, autoRestart);
      return;
    }

    // Rung 2: nothing restorable. start() will fall back to a continuation or
    // a fresh run; a fresh run's rig setup deletes its copy.to directories and
    // every codon re-runs, so snapshot the work tree first and say so loudly.
    const snapshot = await this.snapshotWorkspaceForRecovery("no restorable checkpoint");
    const message =
      "Recovery degraded: no git-confirmed checkpoint in execution history; falling back to " +
      `continuation or a fresh run (work tree snapshotted to ${snapshot.recoveryBranch})`;
    this.logger.log(message, "error");
    this.emitErrorEvent(message);
  }

  /**
   * Save the work tree on a recovery branch before recovery changes or
   * discards files. Throws CheckpointStorageError if git cannot record it —
   * proceeding to change files without a snapshot is the one thing recovery
   * must never do.
   */
  private async snapshotWorkspaceForRecovery(reason: string): Promise<RecoverySnapshot> {
    try {
      const snapshot = await this.checkpointGit.snapshotForRecovery(reason);
      this.noteRecoverySnapshot(snapshot, reason);
      return snapshot;
    } catch (error) {
      throw this.recoverySnapshotFailed(reason, error);
    }
  }

  /**
   * Confirm a restore target and save the work tree, in that order, before
   * anything is touched. A reference git does not hold is a
   * CheckpointNotFoundError (nothing changed; callers may degrade); anything
   * else is a CheckpointStorageError (callers must stop).
   */
  private async confirmAndSnapshot(sha: string, reason: string): Promise<RestorePreconditions> {
    try {
      const preconditions = await this.checkpointGit.confirmAndSnapshot(sha, reason);
      this.noteRecoverySnapshot(preconditions, reason);
      return preconditions;
    } catch (error) {
      if (error instanceof CheckpointNotFoundError) throw error;
      throw this.recoverySnapshotFailed(reason, error);
    }
  }

  private noteRecoverySnapshot(snapshot: RecoverySnapshot, reason: string): void {
    this.emitInfoEvent(
      `Recovery snapshot: work tree saved to ${snapshot.recoveryBranch} ` +
        `(${snapshot.recoveryCommit.substring(0, 7)}) before ${reason}`,
    );
    this.bootRecoverySnapshot = snapshot;
  }

  private recoverySnapshotFailed(reason: string, error: unknown): CheckpointStorageError {
    const message = `Recovery snapshot failed before ${reason}: ${toError(error).message}`;
    this.logger.log(message, "error");
    this.emitErrorEvent(message);
    return error instanceof CheckpointStorageError
      ? error
      : new CheckpointStorageError(message, error);
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
    // Checkpoint restore changes files underneath the retained-body map —
    // drop it so sentinel resolution never serves a pre-rollback body.
    this.bodyResolver.clear();

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
    requestedSha: string,
    checkpointType: string,
    targetCodonName: string,
    autoRestart: boolean,
  ): Promise<void> {
    // 0. Confirm the target and snapshot the work tree BEFORE anything is
    // touched (see confirmAndSnapshot for what each failure means).
    const targetSha = (
      await this.confirmAndSnapshot(requestedSha, `rollback to ${requestedSha.substring(0, 7)}`)
    ).checkpoint;

    // Decide the archive restore now, from the HEAD this rollback abandons:
    // the per-codon checkouts below move HEAD. Still read-only.
    const originHead = await this.checkpointGit.getHeadSha();
    const entriesToRestore = await this.planArchiveRestore(targetSha, originHead);

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

    // 4. Process each codon (they're already in reverse order). From the
    // first checkout or rig deletion on, the work tree is changing; an error
    // after that point is reported as RollbackMutatedWorkspaceError so the
    // caller knows it must not start new work on this tree.
    let currentStep = 0;
    const totalSteps = codonsToProcess.length + 1; // +1 for final checkpoint
    let mutated = false;

    try {
      for (const threadCodon of codonsToProcess) {
        // A rollback accepted while ownership was valid can be overtaken by a
        // fencing shutdown mid-flight (each await below yields). Every further
        // checkout and rig deletion would then mutate a successor-owned
        // workspace — abort between steps rather than only at dispatch.
        if (this.isShuttingDown) {
          throw new Error("Rollback aborted: shutdown in progress");
        }
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

        // Step through this codon's best git-confirmed checkpoint, if it has
        // one; the final target below is what the work tree ends up as.
        const checkpoint = bestConfirmedCheckpoint(threadCodon);
        if (checkpoint) {
          mutated = true;
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

        // Clean up rig directories from this codon — re-check after the
        // awaited reset above: a shutdown landing during it must not be
        // followed by fresh recursive rig deletion.
        if (this.isShuttingDown) {
          throw new Error("Rollback aborted before rig cleanup: shutdown in progress");
        }
        mutated = true;
        await this.cleanupCodonRigDirectories(threadCodon.codon);
      }

      // 5. Final reset to target checkpoint
      if (this.isShuttingDown) {
        throw new Error("Rollback aborted before final checkpoint reset: shutdown in progress");
      }
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

      mutated = true;
      await this.restoreWorkTreeToCheckpoint(targetSha, entriesToRestore);
    } catch (error) {
      throw mutated ? new RollbackMutatedWorkspaceError(error) : error;
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

    // 9. Restore checkpoint patterns: everything in force at the target. A
    // rig-setup target was taken after the target codon's rig ran, so its own
    // patterns count too; a completion target does not include the codon
    // that will run next.
    await this.registerCheckpointPatternsThrough(
      targetThreadCodon.codon.codonId,
      checkpointType === "rig-setup",
    );

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
    if (autoRestart && this.config.autostart) {
      const nextCodon = await this.stateManager.getNextCodonToExecute();
      if (nextCodon) {
        await this.startCodon(nextCodon, checkpointType === "rig-setup");
      } else {
        // Rollback succeeded but no next codon found
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "server.idle",
          data: {
            reason: "rollback-completed",
            message: "Rollback completed. No next codon to run.",
          },
        } as import("./types/types.js").ServerIdleEvent);
      }
    } else {
      // Not auto-restarting — tell the user we're waiting
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "server.idle",
        data: {
          reason: "rollback-completed",
          message: `Rollback completed. Use 'codon.next' to continue.`,
        },
      } as import("./types/types.js").ServerIdleEvent);
    }
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
   * Execute archiveOnSuccess for a codon - moves files to rigArchive/ after successful completion.
   *
   * @param archiveOnSuccess - Array of paths to archive (relative to agentRoot/)
   * @param codonId - The codon ID (with iteration suffix for loops)
   * @param checkpointSha - The checkpoint SHA at time of archiving
   * @param loopContext - Loop context if codon is part of a loop
   * @param isLoopLevelArchive - If true, this is a loop-level archive (uses -loop suffix)
   */
  private async executeArchiveRigs(
    archiveOnSuccess: string[],
    codonId: string,
    checkpointSha: string,
    loopContext?: { loopId: string; iteration: number },
    isLoopLevelArchive = false,
  ): Promise<void> {
    if (!archiveOnSuccess || archiveOnSuccess.length === 0) return;
    // Archiving is a chain of mkdir/rm/cp/manifest operations — none of it
    // may START once shutdown has begun (archives are re-creatable on the
    // next successful run of the codon).
    if (this.isShuttingDown) {
      this.logger.log(`Archive rigs skipped for codon ${codonId}: shutdown in progress`);
      return;
    }

    this.logger.log(`Executing archiveOnSuccess for ${codonId}: ${archiveOnSuccess.join(", ")}`);

    // Resolve glob patterns to actual files
    const resolvedFiles = await fileResolver.resolveFiles(
      this.config.agentRootPath,
      archiveOnSuccess,
    );

    this.logger.log(`Resolved ${resolvedFiles.length} files to archive from patterns`);

    const results: { path: string; success: boolean; error?: string }[] = [];

    for (const sourcePath of resolvedFiles) {
      const fullSourcePath = path.join(this.config.agentRootPath, sourcePath);

      // Build archive destination path
      // Note: Only codonId needs sanitization (# -> -) since loop IDs don't contain #
      let archiveSubdir: string;
      if (isLoopLevelArchive) {
        // Loop-level archive: rigArchive/<loopId>-loop/<path>
        // (codonId here is actually the loop ID)
        archiveSubdir = `${codonId}-loop`;
      } else if (loopContext) {
        // Loop codon: rigArchive/<loopId>-<iteration>/<codonId>/<path>
        archiveSubdir = path.join(
          `${loopContext.loopId}-${loopContext.iteration}`,
          codonId.replace(/#/g, "-"), // Only codonId needs sanitization
        );
      } else {
        // Non-loop codon: rigArchive/<codonId>/<path>
        archiveSubdir = codonId.replace(/#/g, "-");
      }

      const archivePath = path.join(this.config.rigArchivePath, archiveSubdir, sourcePath);

      try {
        // Check if source exists
        if (!fs.existsSync(fullSourcePath)) {
          this.logger.log(`Archive source not found (skipping): ${sourcePath}`, "info");
          results.push({ path: sourcePath, success: true }); // Not an error, just skip
          continue;
        }

        // Create archive directory
        await fs.promises.mkdir(path.dirname(archivePath), { recursive: true });

        // Remove existing archive if present (overwrite semantics)
        if (fs.existsSync(archivePath)) {
          this.logger.log(`Archive path collision, overwriting: ${archivePath}`, "error");
          await fs.promises.rm(archivePath, { recursive: true, force: true });
        }

        // Move files (copy then remove)
        await fs.promises.cp(fullSourcePath, archivePath, { recursive: true });
        await fs.promises.rm(fullSourcePath, { recursive: true, force: true });

        // Record in manifest
        await this.archiveManifest.addEntry({
          sourcePath,
          archivePath: path.relative(this.config.executionPath, archivePath),
          codonId,
          loopContext: isLoopLevelArchive ? undefined : loopContext,
          checkpointSha,
          timestamp: new Date().toISOString(),
        });

        this.logger.log(`Archived: ${sourcePath} → ${archivePath}`, "info");
        results.push({ path: sourcePath, success: true });
      } catch (error) {
        // Graceful degradation: log error and continue with next path
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.log(`Failed to archive ${sourcePath}: ${errorMsg}`, "error");
        results.push({ path: sourcePath, success: false, error: errorMsg });
      }
    }

    // Emit archive completed event (includes partial successes)
    const successfulPaths = results.filter((r) => r.success).map((r) => r.path);
    const failedResults = results.filter((r) => !r.success);

    if (failedResults.length > 0) {
      // Partial success - some paths failed
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "archive.partial",
        data: {
          codonId,
          archivedPaths: successfulPaths,
          failedPaths: failedResults.map((r) => ({
            path: r.path,
            error: r.error || "Unknown error",
          })),
        },
      });
    } else if (successfulPaths.length > 0) {
      // Full success
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "archive.completed",
        data: {
          codonId,
          archivedPaths: successfulPaths,
        },
      });
    }
  }

  /**
   * Restore archived files back to agentRoot/ during rollback.
   * Called after git reset has restored the workspace to checkpoint state.
   *
   * The target checkpoint tree is authoritative: when a destination path
   * already exists in the post-checkout workspace BEFORE restoration begins,
   * the entry is SKIPPED (with a warning) and its archive copy and manifest
   * entry stay in place — nothing the target tree contains is silently
   * overwritten by an archived copy. Destinations created by earlier entries
   * of the same restoration (multiple loop iterations archiving one path)
   * are overwritten newest-wins, as before.
   *
   * @param entries - Archive entries to restore (from planArchiveRestore)
   * @param targetCheckpointSha - The checkpoint we're rolling back to
   * @returns Per-entry outcomes; callers remove ONLY the successfully
   *          restored entries from the manifest
   */
  private async restoreArchiveEntries(
    entries: import("./archive-manifest.js").ArchiveEntry[],
    targetCheckpointSha: string,
  ): Promise<ArchiveRestoreResult[]> {
    if (entries.length === 0) return [];

    this.logger.log(
      `Restoring ${entries.length} archived files during rollback to ${targetCheckpointSha}`,
    );

    // Destinations the TARGET TREE owns, captured before any restoration
    // touches the workspace. Only these are protected by the collision rule.
    const targetTreeOwned = new Set<string>();
    for (const entry of entries) {
      const sourceFullPath = path.join(this.config.agentRootPath, entry.sourcePath);
      if (fs.existsSync(sourceFullPath)) {
        targetTreeOwned.add(sourceFullPath);
      }
    }

    const results: ArchiveRestoreResult[] = [];

    for (const entry of entries) {
      // Each entry is several destructive operations (removals, copies,
      // pruning) — a shutdown mid-restore must not start further entries
      // against what may now be a successor-owned workspace.
      if (this.isShuttingDown) {
        throw new Error(
          `Archive restoration aborted after ${results.length}/${entries.length} entries: ` +
            `shutdown in progress`,
        );
      }
      const archiveFullPath = path.join(this.config.executionPath, entry.archivePath);
      const sourceFullPath = path.join(this.config.agentRootPath, entry.sourcePath);

      try {
        // Check if archive exists
        if (!fs.existsSync(archiveFullPath)) {
          this.logger.log(`Archive file not found (skipping): ${entry.archivePath}`, "error");
          results.push({
            entry,
            path: entry.sourcePath,
            success: false,
            error: "Archive not found",
          });
          continue;
        }

        // The target checkpoint tree is authoritative: keep the workspace
        // file AND the archive copy (plus its manifest entry).
        if (targetTreeOwned.has(sourceFullPath)) {
          this.logger.log(
            `Restore destination already exists in target checkpoint tree, ` +
              `leaving archived: ${entry.sourcePath} (archive kept at ${entry.archivePath})`,
            "error",
          );
          results.push({
            entry,
            path: entry.sourcePath,
            success: false,
            error: "Destination exists in target checkpoint tree; archive copy kept",
          });
          continue;
        }

        // Create parent directory for restoration
        await fs.promises.mkdir(path.dirname(sourceFullPath), {
          recursive: true,
        });

        // Remove a destination created by an earlier entry of this loop (the
        // same sourcePath archived by several iterations — newest wins).
        if (fs.existsSync(sourceFullPath)) {
          await fs.promises.rm(sourceFullPath, {
            recursive: true,
            force: true,
          });
        }

        // Move files from archive back to source
        await fs.promises.cp(archiveFullPath, sourceFullPath, {
          recursive: true,
        });
        await fs.promises.rm(archiveFullPath, { recursive: true, force: true });

        this.logger.log(`Restored: ${entry.archivePath} → ${entry.sourcePath}`, "info");
        results.push({ entry, path: entry.sourcePath, success: true });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.logger.log(`Failed to restore ${entry.sourcePath}: ${errorMsg}`, "error");
        results.push({
          entry,
          path: entry.sourcePath,
          success: false,
          error: errorMsg,
        });
      }
    }

    // Emit rollback archive restore event
    const successfulPaths = results.filter((r) => r.success).map((r) => r.path);
    const failedResults = results.filter((r) => !r.success);

    let status: "completed" | "partial" | "failed";
    if (failedResults.length === 0) {
      status = "completed";
    } else if (successfulPaths.length > 0) {
      status = "partial";
    } else {
      status = "failed";
    }

    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "rollback.archiveRestore",
      data: {
        codonId: targetCheckpointSha, // Use checkpoint SHA as identifier
        restoredPaths: successfulPaths,
        failedPaths:
          failedResults.length > 0
            ? failedResults.map((r) => ({
                path: r.path,
                error: r.error || "Unknown error",
              }))
            : undefined,
        status,
      },
    });

    // Clean up empty archive directories after restoration
    // Collect unique archive parent directories (e.g., rigArchive/archive-loop-1/process-iteration-1)
    const archiveDirs = new Set<string>();
    for (const entry of entries) {
      const archiveFullPath = path.join(this.config.executionPath, entry.archivePath);
      // Get the directory containing the archived file
      let currentDir = path.dirname(archiveFullPath);
      // Walk up until we reach rigArchivePath, collecting directories
      while (
        currentDir !== this.config.rigArchivePath &&
        currentDir.startsWith(this.config.rigArchivePath)
      ) {
        archiveDirs.add(currentDir);
        currentDir = path.dirname(currentDir);
      }
    }

    // Remove empty directories (deepest first) — skipped once shutdown has
    // begun (a shutdown during the final archive entry would otherwise fall
    // through into fresh rmdir operations); leftover empty dirs are pruned
    // by any later archive pass.
    if (this.isShuttingDown) return results;
    const sortedDirs = Array.from(archiveDirs).sort((a, b) => b.length - a.length);
    for (const dir of sortedDirs) {
      try {
        if (fs.existsSync(dir)) {
          const contents = await fs.promises.readdir(dir);
          if (contents.length === 0) {
            await fs.promises.rmdir(dir);
            this.logger.log(
              `Cleaned up empty archive directory: ${path.relative(this.config.executionPath, dir)}`,
              "info",
            );
          }
        }
      } catch (error) {
        // Ignore errors (directory might not be empty or already removed)
        this.logger.log(`Could not clean up archive directory ${dir}: ${error}`, "debug");
      }
    }

    return results;
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
      // Each target is its own recursive deletion — do not start the next
      // one once shutdown has begun.
      if (this.isShuttingDown) {
        throw new Error(
          `Rig cleanup aborted after ${successfulCleanups.length}/${directories.length} ` +
            `directories: shutdown in progress`,
        );
      }
      const fullPath = path.join(this.config.agentRootPath, dir);
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

    // Relative sentinel config paths like "sentinels/check.json" are resolved
    // from the folder hank.json lives in. path.resolve makes that folder
    // absolute in case hank.json itself was given as a relative path — the
    // loader (via hank-refs) rejects relative base dirs. If there is no
    // configPath, the configured cwd is used instead.
    const hankDirectory = this.config.configPath
      ? path.dirname(path.resolve(this.config.configPath))
      : this.config.cwd;
    const loadResult = this.sentinelConfigLoader.loadConfigsForCodon(
      codon.sentinels,
      codon.id,
      hankDirectory,
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

      // Each sentinel resolves its file refs against its own config's directory
      const configDirectories = new Map<string, string>();
      // Build output paths map from codon-level settings
      const outputPathsMap = new Map<string, { logFile?: string; lastValueFile?: string }>();
      for (const lc of loadResult.configs) {
        configDirectories.set(lc.config.id, lc.configDirectory);
        if (lc.outputPaths) {
          outputPathsMap.set(lc.config.id, lc.outputPaths);
        }
      }

      // SentinelManager internally unloads previous codon's sentinels
      const { loadedIds } = await this.sentinelManager.loadSentinelsForCodon(
        configs,
        runtimeCodonId,
        {
          configDirectories,
          hankDirectory, // Containment anchor for the sentinels' own strict-ref checks
          runStartTime: new Date(),
          executionPath: this.config.executionPath,
          agentRootPath: this.config.agentRootPath, // For sentinel output path resolution
          outputPathsMap: outputPathsMap.size > 0 ? outputPathsMap : undefined,
          // Note: llmCallOverride and llmObjectCallOverride are only used in tests
          // In production, SentinelManager uses its own provider registry
        },
      );

      // Track loaded sentinel IDs
      this.currentCodonSentinels.clear();
      for (const id of loadedIds) {
        this.currentCodonSentinels.add(id);
      }

      this.logger.log(`Successfully loaded ${loadedIds.length} sentinel instance(s)`, "info");

      // Codon 2: Emit sentinel.loaded events
      const loadedConfigEntries = loadResult.configs.filter((lc) =>
        loadedIds.includes(lc.config.id),
      );
      for (const loadedConfig of loadedConfigEntries) {
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
      if (this.currentRunId && loadedIds.length > 0) {
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
        loaded: loadedIds,
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
    const hasRunner = this.currentCodon
      ? !!this.codonRunners.get(this.currentCodon.codonId)
      : false;
    this.logger.log(
      `[cleanupCurrentCodon] Called - currentCodon=${
        this.currentCodon?.codonId || "none"
      }, hasRunner=${hasRunner}`,
      "info",
    );
    this.logger.log(`[cleanupCurrentCodon] Stack trace:\n${new Error().stack}`, "debug");

    // Clean up runner (handles both logParser and processManager)
    // Remove from runner map first (before clearing currentCodon)
    if (this.currentCodon?.codonId) {
      const runner = this.codonRunners.get(this.currentCodon.codonId);
      if (runner) {
        this.logger.log(
          `[cleanupCurrentCodon] Calling cleanup() on runner for codon ${this.currentCodon.codonId}`,
          "info",
        );
        runner
          .cleanup()
          .catch((err) =>
            this.logger.log(
              `Error cleaning up runner for codon ${this.currentCodon?.codonId}: ${err}`,
              "error",
            ),
          );
        this.codonRunners.delete(this.currentCodon.codonId);
        this.logger.log(
          `[cleanupCurrentCodon] Runner for codon ${this.currentCodon.codonId} cleaned up and removed from map`,
          "info",
        );
      } else {
        this.logger.log(
          `[cleanupCurrentCodon] No runner found in map for codon ${this.currentCodon.codonId}`,
          "info",
        );
      }
    }

    this.currentCodon = undefined;
    this.codonFailureReason = undefined;
    this.codonFailureError = undefined;
    this.isForceStopping = false;
    this.isSkippingCodon = false; // Reset skip flag after codon completion

    // Clear any pending tool uses
    this.pendingToolUses.clear();
  }

  private classifyRigSetupFailureType(
    error: unknown,
    operationType: "copy" | "command",
  ): "command_failed" | "timeout" | "other" {
    const errorText = toError(error).message.toLowerCase();
    const stderrText =
      error instanceof CommandError && typeof error.stderr === "string"
        ? error.stderr.toLowerCase()
        : "";

    // Timeout-like failures should be categorized separately even for command operations.
    if (
      errorText.includes("timed out") ||
      errorText.includes("timeout") ||
      errorText.includes("etimedout") ||
      stderrText.includes("timed out") ||
      stderrText.includes("timeout") ||
      stderrText.includes("etimedout")
    ) {
      return "timeout";
    }

    if (error instanceof CommandError || operationType === "command") {
      return "command_failed";
    }

    return "other";
  }

  /**
   * Check if either the codon's individual budget or its parent loop's budget is exceeded.
   */
  private isLoopOrCodonBudgetExceeded(codonId: string): boolean {
    const codonExceeded = this.budget?.isExceeded(codonId) ?? false;
    const entry = this.stateManager.getState().executionPlan.find((e) => e.codonId === codonId);
    const loopExceeded = entry?.loopContext
      ? (this.budget?.isLoopBudgetExceeded(String(entry.loopContext.loopId)) ?? false)
      : false;
    return codonExceeded || loopExceeded;
  }

  private emitLoopIterationCompletedEvent(params: {
    codonId: CodonId;
    isContextExceeded: boolean;
  }): void {
    const codon = this.stateManager.getCodonInCurrentRun(params.codonId);
    if (!codon?.loopContext) return;

    const { loopId, iteration, codonIndexInLoop } = codon.loopContext;
    const loopConfig = this.config.codons.find(
      (item): item is Extract<CodonConfig, { type: "loop" }> =>
        item.type === "loop" && item.id === loopId,
    );
    if (!loopConfig) return;

    const isLastCodonInIteration = codonIndexInLoop === loopConfig.codons.length - 1;
    const contextExceededTermination =
      params.isContextExceeded && loopConfig.terminateOn.type === "contextExceeded";
    const isIterationCompleted = contextExceededTermination || isLastCodonInIteration;
    if (!isIterationCompleted) return;

    let isFinal = false;
    let terminationReason:
      | "iteration_limit"
      | "context_exceeded"
      | "sentinel_skip"
      | "failure"
      | undefined;

    if (contextExceededTermination) {
      isFinal = true;
      terminationReason = "context_exceeded";
    } else if (
      loopConfig.terminateOn.type === "iterationLimit" &&
      iteration >= loopConfig.terminateOn.limit - 1
    ) {
      isFinal = true;
      terminationReason = "iteration_limit";
    }

    const currentRun = this.currentRunId ? this.stateManager.getRunById(this.currentRunId) : null;
    if (!currentRun) return;

    const iterationCodons = currentRun.codons.filter(
      (entry) =>
        entry.loopContext?.loopId === loopId &&
        entry.loopContext?.iteration === iteration &&
        isTerminalCodonStatus(entry.status),
    );

    const durationMs = iterationCodons.reduce((sum, entry) => {
      const startMs = new Date(entry.startTime).getTime();
      const endMs = "endTime" in entry ? new Date(entry.endTime).getTime() : startMs;
      return sum + Math.max(0, endMs - startMs);
    }, 0);
    const costUsd = iterationCodons.reduce((sum, entry) => sum + getCodonCost(entry), 0);
    const tokensUsed = iterationCodons.reduce((sum, entry) => {
      const tokens = getCodonTokens(entry);
      return sum + tokens.inputTokens + tokens.outputTokens;
    }, 0);

    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "loop.iteration.completed",
      data: {
        loopId,
        iteration,
        durationMs,
        costUsd,
        tokensUsed,
        isFinal,
        terminationReason,
      },
    } as LoopIterationCompletedEvent);
  }

  private async runCommand(
    shellCommand: ShellCommand | RigShellCommand | string,
    lastCopiedPath?: string,
    env?: Record<string, string>,
    rigContext?: { codonId: string; commandIndex: number },
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
        // Fallback to agentRootPath if lastCopiedPath not provided
        workingDir = this.config.agentRootPath;
      }
    } else {
      // Default to agentRootPath for "agentRoot" (formerly "project")
      workingDir = this.config.agentRootPath;
    }

    // Diagnostic logging: log working directory and its contents
    this.logger.log(`[DEBUG] Running command: ${cmd.command.run}`, "info");
    this.logger.log(`[DEBUG] Working directory: ${workingDir}`, "info");
    try {
      const dirContents = await fs.promises.readdir(workingDir);
      this.logger.log(`[DEBUG] Directory contents: ${dirContents.join(", ")}`, "info");
    } catch (e) {
      this.logger.log(`[DEBUG] Could not read directory contents: ${toError(e).message}`, "error");
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(cmd.command.run, {
        shell: true,
        cwd: workingDir,
        env: env ? { ...process.env, ...env } : undefined,
      });

      // Capture stdout and stderr for diagnostic purposes
      let stdout = "";
      let stderr = "";

      // Throttle rig.output events: max 1 per second per stream
      let lastStdoutEmit = 0;
      let lastStderrEmit = 0;
      let pendingStdoutLine: string | null = null;
      let pendingStderrLine: string | null = null;

      const emitRigOutput = (stream: "stdout" | "stderr", line: string) => {
        if (!rigContext || !line.trim()) return;
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "rig.output",
          data: {
            codonId: rigContext.codonId,
            stream,
            line: line.trim().slice(0, 500),
            commandIndex: rigContext.commandIndex,
          },
        } as RigOutputEvent);
      };

      proc.stdout?.on("data", (data) => {
        const chunk = data.toString();
        stdout += chunk;
        this.logger.log(`[DEBUG] Command stdout: ${chunk.trim()}`, "info");

        if (rigContext) {
          const lastLine = chunk.trim().split("\n").pop() ?? "";
          const now = Date.now();
          if (now - lastStdoutEmit >= 1000) {
            emitRigOutput("stdout", lastLine);
            lastStdoutEmit = now;
            pendingStdoutLine = null;
          } else {
            pendingStdoutLine = lastLine;
          }
        }
      });

      proc.stderr?.on("data", (data) => {
        const chunk = data.toString();
        stderr += chunk;
        this.logger.log(`[DEBUG] Command stderr: ${chunk.trim()}`, "error");

        if (rigContext) {
          const lastLine = chunk.trim().split("\n").pop() ?? "";
          const now = Date.now();
          if (now - lastStderrEmit >= 1000) {
            emitRigOutput("stderr", lastLine);
            lastStderrEmit = now;
            pendingStderrLine = null;
          } else {
            pendingStderrLine = lastLine;
          }
        }
      });

      // Flush pending lines every second
      const flushInterval = rigContext
        ? setInterval(() => {
            if (pendingStdoutLine) {
              emitRigOutput("stdout", pendingStdoutLine);
              lastStdoutEmit = Date.now();
              pendingStdoutLine = null;
            }
            if (pendingStderrLine) {
              emitRigOutput("stderr", pendingStderrLine);
              lastStderrEmit = Date.now();
              pendingStderrLine = null;
            }
          }, 1000)
        : null;

      proc.on("exit", (code) => {
        if (flushInterval) clearInterval(flushInterval);
        if (code === 0) {
          this.logger.log(`[DEBUG] Command completed successfully`, "info");
          resolve();
        } else {
          // Handle null exit code (killed by signal)
          const exitCode = code ?? -1;
          this.logger.log(`[DEBUG] Command failed with exit code ${exitCode}`, "error");
          this.logger.log(`[DEBUG] Full stdout: ${stdout}`, "info");
          this.logger.log(`[DEBUG] Full stderr: ${stderr}`, "error");

          // Create CommandError with exit code and output
          const error = new CommandError(
            `Command failed with exit code ${exitCode}`,
            exitCode,
            stdout,
            stderr,
          );
          reject(error);
        }
      });

      proc.on("error", (err) => {
        if (flushInterval) clearInterval(flushInterval);
        this.logger.log(`[DEBUG] Command error: ${err.message}`, "error");
        reject(err);
      });
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

  /**
   * Decide what run this boot continues with, given execution history that
   * was not (or could not be) rolled back: a continuation from the newest
   * completed codon when git holds its checkpoint, otherwise a fresh run.
   * The state manager picks the seed; this method only acts on it. The
   * checkpoint repository is reused whole or rebuilt empty, never partially,
   * so if the newest completed codon's checkpoint is missing no older one is
   * held either; there is no older seed to fall back to. A fresh run over
   * existing history is snapshotted first: rig setup deletes its copy.to
   * directories and every codon re-runs.
   *
   * On return `currentRunId` is set. Throws when checkpoint storage cannot
   * be read.
   */
  private async establishRunFromHistory(): Promise<void> {
    const seed = await this.stateManager.findContinuationSeed();

    if (seed?.confirmed) {
      this.logger.log(`Resuming from last completed codon: ${seed.codonId} in run ${seed.runId}`);
      await this.startNewRun({
        type: "continuation",
        source: { runId: seed.runId, afterCodon: seed.codonId, checkpointSha: seed.sha },
        reason: "continue",
      });
      return;
    }

    if (seed) {
      const message =
        `Recovery degraded: newest completed codon ${seed.codonId} (run ${seed.runId}) has no ` +
        `git-confirmed completion checkpoint (reference ${JSON.stringify(seed.sha)}); ` +
        "starting fresh instead";
      this.logger.log(message, "error");
      this.emitErrorEvent(message);
    }

    // No seedable completed codon — start fresh. A fresh run's rig setup
    // deletes its copy.to directories and every codon re-runs, so when there
    // is history on disk snapshot the work tree first. The failed-thread
    // ladder does this in rung 2; this is the non-failed counterpart. Any run
    // at all counts as history: a kill during the first rig setup, before
    // CodonStarted was persisted, leaves a zero-codon run and a partly
    // mutated tree.
    if (this.stateManager.getState().runs.length > 0 && !this.bootRecoverySnapshot) {
      await this.snapshotWorkspaceForRecovery("fresh run over existing history");
    }
    await this.startNewRun();
  }

  /** Emit a non-fatal `error` event with the given message. */
  private emitErrorEvent(
    message: string,
    extra: Partial<Omit<ErrorEvent["data"], "message">> = {},
  ): void {
    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "error",
      data: { fatal: false, ...extra, message },
    } as ErrorEvent);
  }

  /** Emit an `info` event with the given message. */
  private emitInfoEvent(message: string): void {
    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "info",
      data: { message },
    } as InfoEvent);
  }

  /**
   * The error start() stops with when recovery cannot safely go on. What it
   * says about the work tree follows from the error's type: a rollback that
   * failed after changing files leaves the tree half-restored (the
   * pre-rollback tree is on a recovery/* branch); unreadable storage or a
   * target rejected up front left it untouched.
   */
  private recoveryStoppedError(context: string, error: unknown): Error {
    const mutated = error instanceof RollbackMutatedWorkspaceError;
    const why = mutated
      ? "the work tree may be half-restored"
      : error instanceof CheckpointStorageError
        ? "checkpoint storage is unreadable"
        : "the checkpoint could not be restored";
    const state = mutated
      ? "Rig directories may have been removed; the pre-rollback work tree is on the recovery/* branch"
      : "Nothing has been changed";
    const message =
      `Recovery stopped: ${context}: ${why} (${toError(error).message}). ${state}; ` +
      "see .hankweave/logs/server.log and the recovery/* branches in the checkpoint repository.";
    this.logger.log(message, "error");
    return new Error(message, { cause: error });
  }

  /**
   * Decide which archive-manifest entries a rollback to `targetSha` restores:
   * exactly the entries archived strictly after the target on the line being
   * abandoned (`git rev-list target..originHead`), plus 'orphan' entries.
   * Entries at or before the target, on unrelated timelines, or with SHAs the
   * repository does not know stay archived (the last with a warning). The
   * manifest is not a checkpoint registry — most checkpoints never appear in
   * it — so its list order says nothing about what to restore (#228).
   *
   * Read-only git work: call it BEFORE the first mutation, with `originHead`
   * captured before any intermediate checkout moves HEAD. Storage trouble
   * surfaces as CheckpointStorageError so start() stops rather than restoring
   * an incomplete selection.
   */
  private async planArchiveRestore(
    targetSha: string,
    originHead?: string | null,
  ): Promise<import("./archive-manifest.js").ArchiveEntry[]> {
    if (this.archiveManifest.getManifest().entries.length === 0) {
      return [];
    }
    const head = originHead ?? (await this.checkpointGit.getHeadSha());
    if (!head) {
      throw new CheckpointStorageError(
        "Could not resolve checkpoint HEAD to select archive entries for rollback",
      );
    }
    const reachableAfterTarget = await this.checkpointGit.shasBetween(targetSha, head);
    const knownShas = await this.checkpointGit.getAllCheckpointShas();
    const entries = this.archiveManifest.selectEntriesToRestore(reachableAfterTarget, knownShas);
    if (entries.length > 0) {
      this.logger.log(`Found ${entries.length} archive entries to restore during rollback`);
    }
    return entries;
  }

  /**
   * Put the work tree at a checkpoint: check the commit out, copy the
   * archived files `planArchiveRestore` selected back into place, and drop
   * exactly the restored entries from the manifest (which lives outside the
   * work tree, so the checkout never touches it). Every rollback path ends
   * with this; it is the one place the archive-rewind protocol lives. The
   * caller has already preflighted `sha` (a full, git-confirmed id),
   * planned the restore, and snapshotted the tree, so this changes files
   * from its first step.
   */
  private async restoreWorkTreeToCheckpoint(
    sha: string,
    entriesToRestore: import("./archive-manifest.js").ArchiveEntry[],
  ): Promise<void> {
    await this.checkpointGit.resetToCheckpoint(sha);

    // Archive restoration must not START once shutdown has begun.
    if (this.isShuttingDown) {
      throw new Error("Rollback aborted after reset: shutdown in progress");
    }
    if (entriesToRestore.length > 0) {
      const results = await this.restoreArchiveEntries(entriesToRestore, sha);
      await this.archiveManifest.removeEntries(
        results.filter((r) => r.success).map((r) => r.entry),
      );
    }
  }

  /**
   * Fail a codon that is in `starting` (rig work done, no runner yet) with a
   * non-retriable reason, applying the codon's failure policy exactly as the
   * missing-continuation-session path does.
   */
  private async failCodonAtStart(
    codonId: CodonId,
    codon: Codon,
    message: string,
    error: Error,
  ): Promise<void> {
    this.logger.log(message, "error");
    this.codonFailureError = error;
    this.codonFailureReason = { type: "unknown", retriable: false, message };

    if (this.currentRunId) {
      this.stateManager.transition({
        type: "CodonTransitioned",
        data: {
          runId: this.currentRunId,
          codonId,
          from: "starting",
          to: "failed",
          // exitCode is required by the failed-transition guard; -1 marks
          // "no runner ever ran", as the missing-session path records it.
          metadata: {
            exitCode: -1,
            failedDuring: "starting",
            failureReason: this.codonFailureReason,
          },
        },
      });
    }

    this.emitErrorEvent(message, { codon: codon.id, fatal: true, severity: ErrorSeverity.CODON });

    const { action } = this.retryCoordinator.decide(codonId, codon, this.codonFailureReason);

    if (action === "continue") {
      this.emit("event", {
        id: EventId(generateId()),
        timestamp: new Date().toISOString(),
        type: "codon.completed",
        data: {
          codonId,
          success: false,
          cost: 0,
          duration: Date.now() - (this.currentCodon?.startTime?.getTime() || Date.now()),
          exitStatus: { type: "error", code: -1 },
          failureReason: this.codonFailureReason,
          failureIgnored: true,
        },
      } as CodonCompletedEvent);
      this.emitInfoEvent(`Codon ${codonId} failed at start, continuing (onFailure=ignore)`);
      this.cleanupCurrentCodon();
      await this.stateManager.waitForPendingTransitions();
      await this.stateManager.expandNextIterationForCodon({
        codonId: CodonId(codonId),
        contextExceeded: false,
        budgetExceeded: this.isLoopOrCodonBudgetExceeded(codonId),
      });
      if (this.config.autostart) {
        await this.autoStartNextCodon();
      }
      return;
    }

    this.cleanupCurrentCodon();
    if (action === "shutdown") {
      if (this.currentRunId) {
        this.stateManager.transition({ type: "RunFailed", data: { runId: this.currentRunId } });
        await this.stateManager.waitForPendingTransitions();
      }
      await this.shutdown("codon failed at start");
    }
  }

  // -------------
  // Checkpoint Methods
  // -------------

  /**
   * Initialize checkpoint system. git must be runnable: a missing git fails
   * the boot here (GitUnavailableError) rather than silently downgrading to a
   * run without rollback or crash recovery. The CLI proves the same thing
   * even earlier, before the execution directory is set up.
   */
  private async initializeCheckpoints(): Promise<void> {
    await assertGitAvailable();

    // initialize() returns a real HEAD or throws; a repository on disk that
    // git cannot use is rebuilt there.
    await this.checkpointGit.initialize();

    // Load the archive manifest (for archiveOnSuccess feature)
    // Note: The manifest is NOT checkpointed because it lives outside the git work tree
    // (at .hankweave/archive-manifest.json, sibling to agentRoot/). Instead, its state
    // is managed programmatically during rollback: planArchiveRestore() selects entries
    // by git reachability and removeEntries() drops exactly the restored ones.
    await this.archiveManifest.load();

    this.logger.log("Checkpoint system initialized");
  }

  /**
   * Add checkpoint patterns for a codon (cumulative)
   */
  /**
   * Register the checkpoint patterns in force at `codonId` (plan order,
   * loop iterations included). Not being in the plan is a programming error
   * worth a loud log, not a silent empty pattern set.
   */
  private async registerCheckpointPatternsThrough(
    codonId: CodonId,
    includeSelf: boolean,
  ): Promise<void> {
    const patterns = checkpointPatternsThrough(
      this.stateManager.getState().executionPlan,
      codonId,
      includeSelf,
    );
    if (patterns === null) {
      this.logger.log(
        `Codon ${codonId} is not in the execution plan; no checkpoint patterns registered`,
        "error",
      );
      return;
    }
    await this.addCheckpointPatterns(patterns);
  }

  private async addCheckpointPatterns(patterns: string[]): Promise<void> {
    if (patterns.length === 0) return;

    // Add new patterns
    await this.checkpointGit.addPatterns(patterns);
    this.logger.log(`Added checkpoint patterns: ${patterns.join(", ")}`);
  }

  /**
   * Create a checkpoint commit. Returns the commit SHA; throws on any failure
   * (never returns without a checkpoint).
   */
  private async createCheckpoint(info: CheckpointInfo): Promise<string> {
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
      }
      throw new Error("checkpoint commit returned no SHA");
    } catch (error) {
      // Disk full, a broken repo, a stale lock — whatever it is, it must be
      // loud and it must reach the caller. Swallowing it here (and switching
      // checkpointing off for the rest of the run) is exactly how a completed
      // codon ends up with an empty checkpoint reference that recovery later
      // trips over.
      const message = `Checkpoint creation failed for codon ${info.codonId} (${info.status}): ${
        toError(error).message
      }`;
      this.logger.log(`[CHECKPOINT-DEBUG] ${message}`, "error");
      this.emitErrorEvent(message, { codon: info.codonId });
      throw new Error(message, { cause: error });
    }
  }

  // -------------
  // Shutdown & Cleanup
  // -------------

  /**
   * Shutdown the Hankweave server gracefully.
   *
   * 1. Set shutting down flag to prevent new codons
   * 2. Kill Claude process if running
   * 3. Wait for pending transitions
   * 4. Create final checkpoint if needed
   * 5. Exit process with appropriate code
   *
   * @param reason - Reason for shutdown (for logging)
   * @param exitProcess - Whether to call process.exit() (default: true, false for tests)
   * @param exitCode - Optional exit code override. If undefined, determined from run status
   */
  async shutdown(reason: string, exitProcess = true, exitCode?: number): Promise<void> {
    // Second call during shutdown escalates to force shutdown
    if (this.isShuttingDown) {
      this.logger.log(`Shutdown already in progress, escalating to force shutdown: ${reason}`);
      await this.forceShutdown(reason, exitProcess);
      return;
    }
    this.logger.log(`Shutting down server: ${reason}`);
    this.isShuttingDown = true;

    // Arm the force-exit backstop BEFORE any awaited cleanup, so a wedged step
    // can never leave the process hanging after a fatal condition was detected.
    if (shutdownWatchdogWanted(exitProcess, reason)) {
      this.watchdog.arm(reason, this.computeExitCode(reason, exitCode));
    }

    // Notify clients that we're shutting down and waiting for the agent process
    this.emit("event", {
      id: EventId(generateId()),
      timestamp: new Date().toISOString(),
      type: "info",
      data: {
        message:
          "Shutting down: waiting for agent process to exit. Send server.force_shutdown to force quit.",
      },
    } as InfoEvent);

    // Kill any running process — this now properly waits for the child to die
    // (up to PROCESS_KILL_GRACE_MS with SIGKILL escalation for shims)
    if (this.currentCodon) {
      const runner = this.codonRunners.get(this.currentCodon.codonId);
      if (runner) {
        this.logger.log("Killing current codon runner for shutdown");
        await runner.kill("SIGTERM");
      }
    }

    // Create exit checkpoint if not shutting down normally (all codons completed)
    if (reason !== "all codons completed" && this.currentCodon) {
      try {
        await this.createCheckpoint({
          status: "exit",
          codonId: CodonId(this.currentCodon.codon.id),
          codonName: this.currentCodon.codon.name,
          runId: this.currentRunId || RunId("unknown"),
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        // Already logged and emitted by createCheckpoint; must not block shutdown.
        this.logger.log(`Exit checkpoint skipped: ${toError(error).message}`, "error");
      }
    }

    this.cleanupCurrentCodon();

    // Shutdown sentinel manager
    if (this.sentinelManager) {
      this.logger.log("Shutting down sentinel manager...", "info");
      await this.sentinelManager.shutdown();
      this.logger.log("Sentinel manager shutdown complete", "info");
    }

    // Capture the current run BEFORE transitioning to completed/failed,
    // because RunCompleted/RunFailed clears currentRunId in state, which
    // would make getCurrentRun() return null when telemetry needs it.
    const runForTelemetry = this.stateManager.getCurrentRun();

    // Emit budget summary event BEFORE RunCompleted/RunFailed so that
    // clients watching for RunCompleted as the terminal event will have
    // already received the budget summary.
    if (this.budget && runForTelemetry) {
      const summary = this.budget.getBudgetSummary(runForTelemetry);
      if (summary) {
        this.emit("event", {
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "budget.summary",
          data: summary,
        } as import("./types/types.js").BudgetSummaryEvent);
      }
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

    // Ensure file-backed event journal writes are fully drained before shutdown
    // returns. Tests may replace or delete the execution directory immediately
    // after this method resolves.
    await this.eventJournalAppendQueue;

    // Send telemetry and flush Sentry before closing connections
    if (this.telemetryCollector) {
      try {
        // Use the run snapshot captured before the RunCompleted/RunFailed transition.
        // After those transitions, getCurrentRun() returns null (currentRunId is cleared).
        // We need the run data to generate run_started, run_completed, and $ai_trace events.
        //
        // Re-fetch from state to get the final status (completed/failed) and endTime,
        // falling back to the pre-transition snapshot if not found.
        const finalRun = runForTelemetry
          ? (this.stateManager.getState().runs.find((r) => r.runId === runForTelemetry.runId) ??
            runForTelemetry)
          : null;
        await this.telemetryCollector.sendRunTelemetry(finalRun);
        await this.telemetryCollector.shutdown();
      } catch {
        // Silent fail - telemetry should never block shutdown
      }
    }

    // Flush PostHog error tracking
    try {
      const { flushErrorTracking } = await import("./telemetry/error-tracking.js");
      await flushErrorTracking(2000);
    } catch {
      // Silent fail
    }

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

    // Close event journal: drains pending writes, flushes the meta sidecar,
    // and releases the held file descriptor. Re-drain the append queue first:
    // teardown between the drain above and here (client close, server stop)
    // can still have enqueued events, and close() rejects appends submitted
    // after it starts.
    try {
      await this.eventJournalAppendQueue;
      await this.eventJournal.close();
      this.logger.log("Event journal closed");
    } catch (error) {
      this.logger.log(`Error closing event journal: ${error}`, "error");
    }

    // Finalize-time journal diet (events.jsonl diet P4): shrink the finished
    // run's journal now that the storage is closed. Gated on a terminal run
    // state (RunCompleted/RunFailed — never an attach-disconnect that left
    // no run), skipped when the shutdown watchdog is close to firing (the
    // diet is verify-before-unlink and re-runnable offline, so skipping is
    // always safe), and never allowed to fail the shutdown itself.
    // The cached fence flag is not enough here: shutdown cancels the
    // heartbeat, so a takeover landing after the last tick would go
    // undetected and this diet would unlink the successor's live journal.
    // Prove ownership FRESH, at the decision point: the lock on disk must
    // still carry this runtime's own acquisition token.
    const lockStillOurs = (): boolean => {
      if (this.lockLostToSuccessor || this.lockId === null) return false;
      try {
        const lock = JSON.parse(fs.readFileSync(this.config.lockFile, "utf-8")) as {
          lockId?: unknown;
        };
        return lock.lockId === this.lockId;
      } catch {
        return false; // Absent, unreadable, or unparseable: not provably ours.
      }
    };
    if (this.config.dietOnFinalize && !lockStillOurs()) {
      // Fenced, taken over after the last heartbeat tick, or ownership
      // unprovable. Dieting would risk unlinking a successor's live
      // journal; the offline CLI can always diet later.
      this.logger.log("Journal diet skipped: this runtime cannot prove it still owns runtime.lock");
    } else if (this.config.dietOnFinalize) {
      // Resolve the run being finalized. `runForTelemetry` is null on the
      // codon-failure paths (RunFailed transitioned BEFORE shutdown() was
      // called, clearing the state's currentRunId), so fall back to the
      // runtime's own retained run id — failed runs are explicitly in scope
      // for the diet.
      const finalRunId = runForTelemetry?.runId ?? this.currentRunId;
      const finalRun = finalRunId ? this.stateManager.getRun(finalRunId) : null;
      const runIsTerminal = finalRun?.status === "completed" || finalRun?.status === "failed";
      if (!runIsTerminal) {
        this.logger.log("Journal diet skipped: run did not reach a terminal state");
      } else {
        // The trace uploader spawns hankweave-trace, which reads
        // events.jsonl straight off disk — it must run BEFORE the diet
        // removes that file (spawnSync + the uploadDone guard: the upload
        // completes here and the later shutdown call becomes a no-op).
        try {
          this.uploadTrace?.();
        } catch (error) {
          this.logger.log(`Trace upload before journal diet failed: ${error}`, "error");
        }
        // That upload is synchronous: it blocks the event loop for its whole
        // duration (bounded only by its own 60 s spawnSync timeout), so the
        // watchdog armed at shutdown start cannot fire during it — but it
        // does not disappear. An overdue timer fires at the diet's first
        // await and kills the diet mid-flight. Observed in production: a
        // five-run execution's upload took 39 s and the diet was skipped
        // with "-9382ms of headroom". The upload is a separately bounded
        // phase; give the diet its own full watchdog window instead of
        // inheriting the upload's debt. Shutdown stays hard-bounded
        // (pre-upload cleanup ≤ watchdog, upload ≤ its spawnSync timeout,
        // diet ≤ watchdog) — it is just three windows instead of one.
        this.watchdog.reset(reason, this.computeExitCode(reason, exitCode));
        try {
          const report = await dietJournal(this.layout.eventsDir, {
            thresholdBytes: this.config.journalDietThresholdBytes,
          });
          if (report.dieted) {
            this.logger.log(
              `Event journal dieted: ${report.originalBytes} → ${report.dietedBytes} bytes ` +
                `(${report.uniqueCasBodies} bodies in CAS, restore with --restore-journal)`,
            );
          }
        } catch (error) {
          this.logger.log(`Journal diet failed (original journal left intact): ${error}`, "error");
        }
      }
    }

    this.removeOwnLockFile();

    this.logger.log("Server shutdown complete");

    // Conditionally exit the process based on the exitProcess parameter
    // In production, we want to exit the process after shutdown
    // In tests, we don't want to exit to allow other tests to run
    if (exitProcess && reason !== "running integration test") {
      // Pass the pre-transition run snapshot: by this point RunCompleted/
      // RunFailed has cleared currentRunId, so getCurrentRun() inside
      // computeExitCode returns null and would report success for a run that
      // was already marked failed/crashed.
      const finalExitCode = this.computeExitCode(reason, exitCode, runForTelemetry);

      this.logger.log(`Shutdown: ${reason} (exit code: ${finalExitCode})`);

      // Fallback trace upload. In the common case (dietOnFinalize on, lock
      // still ours, terminal run) the finalize block above already ran the
      // upload ahead of the journal diet and this is a no-op via the
      // uploadDone guard. It is the real upload only when that block was
      // skipped. Synchronous, so it completes before exit rather than
      // racing an exit handler; the watchdog is cleared synchronously right
      // after, so a long upload here cannot be interrupted by it.
      this.uploadTrace?.();

      // Graceful shutdown completed — cancel the watchdog and exit normally.
      this.watchdog.clear();
      // Small delay to ensure log is written before process exits
      setTimeout(() => {
        process.exit(finalExitCode);
      }, TIMEOUTS.CODON_CLEANUP_DELAY_MS);
    }
  }

  /**
   * Determine the process exit code for a shutdown reason. Shared by the normal
   * exit and the shutdown watchdog so a forced exit uses the same code.
   */
  private computeExitCode(reason: string, exitCode?: number, runSnapshot?: Run | null): number {
    if (exitCode !== undefined) return exitCode;
    if (reason === "all codons completed") {
      // Query state manager for run status (source of truth). After the
      // terminal RunCompleted/RunFailed transition currentRunId is cleared and
      // getCurrentRun() returns null, so fall back to the snapshot captured
      // in shutdown() before that transition.
      const currentRun = this.stateManager.getCurrentRun() ?? runSnapshot;
      return currentRun?.status === "failed" || currentRun?.status === "crashed" ? 1 : 0;
    }
    if (reason === "codon failure") return 1;
    // Default to error exit code for unexpected/crash shutdown reasons.
    // Only user-initiated shutdowns are non-failures.
    const gracefulReasons = ["SIGINT", "SIGTERM", "client request"];
    return gracefulReasons.includes(reason) ? 0 : 1;
  }

  /**
   * Force shutdown the Hankweave server immediately.
   * Called when the user presses q/Ctrl+C a second time during graceful shutdown,
   * or when a client sends the server.force_shutdown command.
   *
   * This sends SIGKILL to shim processes (or abort to SDK sessions),
   * performs minimal cleanup, and exits immediately.
   *
   * @param reason - Reason for force shutdown (for logging)
   * @param exitProcess - Whether to call process.exit() (default: true, false for tests)
   */
  async forceShutdown(reason: string, exitProcess = true): Promise<void> {
    this.logger.log(`Force shutting down server: ${reason}`);

    // Arm the backstop here too: forceShutdown still awaits forceKill, which can
    // wedge on an in-flight SDK stream. forceShutdown always exits with code 1,
    // but a graceful shutdown() that escalated here may have already armed the
    // watchdog with a success code (e.g. 0). Clear and re-arm with code 1 so a
    // wedged force-kill exits 1 — not the stale code, which would misreport a
    // forced/failed shutdown as success.
    if (shutdownWatchdogWanted(exitProcess, reason)) {
      this.watchdog.clear();
      this.watchdog.arm(reason, 1);
    }

    // Force kill any running process immediately
    if (this.currentCodon) {
      const runner = this.codonRunners.get(this.currentCodon.codonId);
      if (runner) {
        this.logger.log("Force killing current codon runner");
        await runner.forceKill();
      }
    }

    // Minimal cleanup — skip checkpoints, telemetry, state transitions
    this.cleanupCurrentCodon();

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

    // Remove lock file (only if this runtime acquired it)
    this.removeOwnLockFile();

    this.logger.log("Force shutdown complete");

    // Best-effort trace upload on force shutdown (e.g. second Ctrl+C).
    // The uploadDone guard prevents double-upload if shutdown() already ran it.
    this.uploadTrace?.();

    if (shutdownWatchdogWanted(exitProcess, reason)) {
      // Force shutdown completed — cancel the watchdog and exit immediately.
      this.watchdog.clear();
      setTimeout(() => {
        process.exit(1);
      }, TIMEOUTS.CODON_CLEANUP_DELAY_MS);
    }
  }
}
