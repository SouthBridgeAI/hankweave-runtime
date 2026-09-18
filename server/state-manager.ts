// server/state-manager.ts
import fs from "node:fs";
import type {
  PreparationFailure,
  PreparationProgress,
  PreparationResult,
  PrepareCodonOptions,
} from "./codon-preparation.js";
import { normalizeLegacyProviderModelInfo } from "./config-validation/model-validator.js";
import type { ExecutionLayout } from "./execution-layout.js";
import {
  checkpointPatternsThrough,
  type ExecutionCodonEntry,
  ExecutionPlanner,
} from "./execution-planner.js";
import {
  analyzeExecutionThread,
  bestConfirmedCheckpoint,
  type ContinuationSeed,
  decideRollback,
  type ExecutionThread,
  seedFromState,
  seedFromThread,
  type ThreadCodon,
} from "./execution-thread.js";
import { LlmProviderRegistry } from "./llm/llm-provider-registry.js";
import {
  type RollbackCheckpointType,
  RollbackMutatedWorkspaceError,
  type RollbackOptions,
  type RollbackProgress,
  RollbackRejectedError,
  type RollbackResult,
  type RollbackTarget,
} from "./rollback-types.js";
import { MetadataValidationError, validateTransitionMetadata } from "./state-transition-guards.js";
import { type StateManagerEvents, TypedEventEmitter } from "./typed-event-emitter.js";
import { type CodonId, CodonId as CodonIdConstructor, type RunId } from "./types/branded-types.js";
import type * as ST from "./types/state-types.js";
import {
  CodonTransitions,
  getCodonCost,
  getCodonTokens,
  isTerminalCodonStatus,
} from "./types/state-types.js";
import type { CheckpointInfo, CheckpointQueryInfo, CodonConfig } from "./types/types.js";
import { type Logger, renameWithRetry, toError } from "./utils.js";
import type { ArchiveOperationOptions, ArchiveOutcome, ArchiveOwner } from "./workspace/archive.js";
import type { WorkspaceCheckpoints } from "./workspace/checkpoints.js";
import {
  CheckpointId,
  CheckpointNotFoundError,
  CheckpointStorageError,
  type RecoverySnapshot,
} from "./workspace/checkpoints.js";
import type { Workspace } from "./workspace/index.js";
import type { PreparedRecovery } from "./workspace/recovery.js";
import { normalizeRigOperationFailure } from "./workspace/rigs.js";

/** Recorded checkpoint history and the run whose metadata accompanies it. */
export interface CheckpointQueryResult {
  runId: RunId;
  currentBranch: string;
  checkpoints: CheckpointQueryInfo[];
}

/** The checkpoints a rollback abandons, with the full set it can be
 * checked against (see StateManager.checkpointsAbandonedBy). */
export interface AbandonedCheckpoints {
  /** Reachable from the current HEAD but not from (or equal to) the target. */
  abandoned: Set<CheckpointId>;
  /** Every checkpoint id the store holds, on every checkpoints. */
  known: Set<CheckpointId>;
}

// Error types for state management
export class InvalidTransitionError extends Error {
  constructor(from: ST.CodonStatus, to: ST.CodonStatus) {
    super(`Invalid transition from ${from} to ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class PersistenceError extends Error {
  constructor(operation: string, cause: Error) {
    super(`State persistence failed during ${operation}: ${cause.message}`);
    this.name = "PersistenceError";
    this.cause = cause;
  }
}

/**
 * Result of expanding the next iteration of a loop.
 * If a loop terminated, includes its identity and iteration count.
 */
export interface ExpandIterationResult {
  loopTerminated?: {
    loopId: string;
    completedIterations: number;
  };
}

/** Archive outcomes for the runtime to translate into client events. */
export interface ArchiveResult {
  codonId: string;
  outcomes: ArchiveOutcome[];
}

export interface FinalizeCodonOptions {
  contextExceeded?: boolean;
  budgetExceeded?: boolean;
  /** Runtime failure policy has selected continuation for a failed codon. */
  failureIgnored?: boolean;
  shouldAbort?: () => boolean;
}

export interface LoopIterationCompletion {
  loopId: CodonId;
  iteration: number;
  durationMs: number;
  costUsd: number;
  tokensUsed: number;
  isFinal: boolean;
  terminationReason?: "iteration_limit" | "context_exceeded" | "sentinel_skip" | "failure";
}

export class StateManager extends TypedEventEmitter<StateManagerEvents> implements ST.StateManager {
  private state: ST.HankweaveState;
  private readonly statePath: string;
  private readonly stateBackupPath: string;
  private readonly logger: Logger;

  // Enhanced transition queue system
  private transitionQueue: ST.StateTransition[] = [];
  private isProcessing = false;

  private readonly planner: ExecutionPlanner;

  // Running cost tallies for performance
  private costCache = {
    total: 0,
    currentRun: 0,
    lastUpdated: null as string | null,
  };

  constructor(
    private readonly layout: ExecutionLayout,
    logger: Logger,
    private readonly codonConfigs?: CodonConfig[],
  ) {
    super();
    this.logger = logger;
    this.statePath = layout.statePath;
    this.stateBackupPath = layout.stateBackupPath;

    // Initialize execution planner
    this.planner = new ExecutionPlanner(codonConfigs || []);

    // Initialize empty state
    this.state = {
      runs: [],
      currentRunId: null,
      executionPlan: [],
    };
  }

  /** Load execution state and detect crashes using already opened capabilities. */
  async initialize(): Promise<void> {
    try {
      if (fs.existsSync(this.statePath)) {
        const parsedState = await this.loadAndValidateStateFile(this.statePath);
        this.restoreStateFromParsed(parsedState, "primary");
      } else {
        this.logger.log("No state file found, starting fresh");
      }
    } catch (error) {
      this.logger.log(`Failed to load state: ${error}`, "error");
      await this.tryRestoreFromBackup();
    }

    // Detect any crashed runs
    await this.detectCrashedRuns();
  }

  /**
   * Load and validate a state file from disk.
   * @throws Error if file is corrupted or cannot be read
   */
  private async loadAndValidateStateFile(filePath: string): Promise<ST.HankweaveState> {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const parsedState = JSON.parse(content);

    // Validate before using
    const validation = this.validate(parsedState);
    if (!validation.valid) {
      this.logger.log("State validation errors found:", "error");
      validation.errors.forEach((e) => this.logger.log(`  - ${e.type}: ${e.message}`, "error"));

      if (validation.errors.some((e) => e.type === "corrupted_data")) {
        throw new Error("State file corrupted");
      }
    }

    // Log warnings but continue
    validation.warnings.forEach((w) =>
      this.logger.log(`Warning - ${w.type}: ${w.message}`, "info"),
    );

    return parsedState;
  }

  /**
   * Restore state from a parsed and validated state object.
   */
  private restoreStateFromParsed(
    parsedState: ST.HankweaveState,
    source: "primary" | "backup",
  ): void {
    // Continuation runs reuse this plan verbatim (no re-validation), so codons
    // persisted by a pre-upgrade version with providerId google/openai/opencode
    // must be migrated to the pi passthrough or CodonRunner refuses them.
    for (const entry of parsedState.executionPlan) {
      const normalized = normalizeLegacyProviderModelInfo(
        entry.codon.model,
        LlmProviderRegistry.getInstance(),
      );
      if (normalized !== entry.codon.model) {
        this.logger.log(
          `Migrated legacy provider model for codon ${entry.codonId}: ` +
            `${entry.codon.model.providerId}/${entry.codon.model.modelId} -> ` +
            `${normalized.providerId}/${normalized.modelId}`,
        );
        entry.codon.model = normalized;
      }
    }

    this.state = parsedState;
    this.rebuildCostCache();

    // Log execution plan restoration
    const sourceLabel = source === "primary" ? "" : " from backup";
    this.logger.log(
      `Restored execution plan${sourceLabel} with ${parsedState.executionPlan.length} codons`,
    );

    const successMessage =
      source === "primary" ? "Loaded existing state file" : "Recovered from backup state file";
    this.logger.log(successMessage);
  }

  /**
   * Attempt to restore state from backup file.
   */
  private async tryRestoreFromBackup(): Promise<void> {
    if (!fs.existsSync(this.stateBackupPath)) {
      return;
    }

    try {
      const parsedState = await this.loadAndValidateStateFile(this.stateBackupPath);
      this.restoreStateFromParsed(parsedState, "backup");
    } catch {
      this.logger.log("Backup also corrupted, starting fresh", "error");
    }
  }

  getState(): Readonly<ST.HankweaveState> {
    return this.state;
  }

  /**
   * Get codon entry from execution plan by codon ID.
   * This handles generated IDs like "review#0", "review#1" from loop expansion.
   *
   * @param codonId - The codon ID to look up
   * @returns The execution codon entry, or null if not found
   */
  getCodonById(codonId: CodonId): ExecutionCodonEntry | null {
    return this.state.executionPlan.find((e) => e.codonId === codonId) || null;
  }

  /**
   * Build initial execution plan for a fresh start.
   * Expands only the first iteration of each loop.
   * Automatically validates and stores the plan.
   * Called automatically when RunStarted transition occurs (unless continuation mode).
   */
  private buildInitialPlan(): void {
    const plan = this.planner.buildInitialPlan();
    this.planner.validatePlan(plan);
    this.state.executionPlan = plan;
    this.logger.log(`Built execution plan with ${plan.length} codons`, "debug");
  }

  /**
   * Expand next iteration of a loop after codon completion.
   * Checks if this completed codon is part of a loop and expands the next iteration if needed.
   * Automatically validates and stores the updated plan.
   *
   * @returns Information about loop termination if a loop ended
   */
  async expandNextIterationForCodon(params: {
    codonId: CodonId;
    contextExceeded?: boolean;
    budgetExceeded?: boolean;
  }): Promise<ExpandIterationResult> {
    const { codonId, contextExceeded = false, budgetExceeded = false } = params;
    const plan = this.state.executionPlan;
    const entry = plan.find((e) => e.codonId === codonId);
    const loopContext = entry?.loopContext;

    // Early exit if codon is not part of a loop
    if (!loopContext) {
      return {};
    }

    const newPlan = this.planner.expandNextIteration({
      currentPlan: plan,
      completedCodonId: codonId,
      contextExceeded,
      budgetExceeded,
    });

    let result: ExpandIterationResult = {};

    // Enhanced logging with loop context
    if (newPlan.length > plan.length) {
      // Iteration was expanded
      const addedCount = newPlan.length - plan.length;
      const loopConfig = this.codonConfigs?.find(
        (c) => c.type === "loop" && c.id === loopContext.loopId,
      );
      const loopName = loopConfig?.name ?? loopContext.loopId;
      const nextIteration = loopContext.iteration + 1;
      this.logger.log(
        `[STATE-MANAGER] Expanded loop '${loopName}' - added iteration ${nextIteration} (${addedCount} codons)`,
        "info",
      );
    } else if (
      !newPlan
        .slice(newPlan.findIndex((entry) => entry.codonId === codonId) + 1)
        .some((entry) => entry.loopContext?.loopId === loopContext.loopId)
    ) {
      // No pending codons remain in this loop. An unchanged plan mid-iteration
      // is not termination and must not trigger the loop's archive policy.
      const loopConfig = this.codonConfigs?.find(
        (c) => c.type === "loop" && c.id === loopContext.loopId,
      );

      if (loopConfig && loopConfig.type === "loop") {
        const terminationType = loopConfig.terminateOn.type;
        const completedIterations = loopContext.iteration + 1; // iteration is 0-indexed

        let reason: string;
        if (budgetExceeded) {
          reason = "budget exceeded";
        } else if (contextExceeded && terminationType === "contextExceeded") {
          reason = "context exceeded";
        } else if (terminationType === "iterationLimit") {
          reason = `reached iteration limit (${loopConfig.terminateOn.limit})`;
        } else {
          reason = "termination condition met";
        }

        this.logger.log(
          `[STATE-MANAGER] Loop '${loopConfig.name}' terminated after ${completedIterations} iteration(s) - ${reason}`,
          "info",
        );

        // Return loop termination identity for post-expansion processing.
        result = {
          loopTerminated: {
            loopId: loopContext.loopId,
            completedIterations,
          },
        };
      }
    }

    this.planner.validatePlan(newPlan);
    this.state.executionPlan = newPlan;
    await this.save();
    this.emit("executionPlanChanged", this.getState().executionPlan);

    return result;
  }

  private canFinalizeCodon(codonId: CodonId, options: FinalizeCodonOptions): boolean {
    const codon = this.getCodonInCurrentRun(codonId);
    if (
      !codon ||
      (codon.status !== "completed" &&
        codon.status !== "skipped" &&
        !(codon.status === "failed" && options.failureIgnored))
    )
      return false;
    return true;
  }

  /**
   * Finalize a persisted terminal codon after output publication. Notifications
   * preserve the order: codon archive, saved plan, loop archive, iteration summary.
   * Failed codons wait for the runtime's failure-policy decision before advancing.
   */
  async finalizeCodon(codonId: CodonId, options: FinalizeCodonOptions = {}): Promise<void> {
    if (!this.canFinalizeCodon(codonId, options)) return;

    // Archives gate themselves on shouldAbort (archiveFiles). The plan
    // expansion is not gated: it is persisted state, and a continuation run
    // reuses the plan verbatim, so skipping it under shutdown would drop the
    // loop's remaining iterations.
    const archive = await this.archiveCompletedCodon(codonId, options);
    if (archive) this.emit("archivesProcessed", archive);

    const expansion = await this.expandNextIterationForCodon({
      codonId,
      contextExceeded: options.contextExceeded,
      budgetExceeded: options.budgetExceeded,
    });
    if (options.shouldAbort?.()) return;

    await this.finalizeLoop(codonId, expansion, options);
  }

  private async finalizeLoop(
    codonId: CodonId,
    expansion: ExpandIterationResult,
    options: FinalizeCodonOptions,
  ): Promise<void> {
    const loopArchive = await this.archiveTerminatedLoop(codonId, expansion, options);
    if (loopArchive) this.emit("archivesProcessed", loopArchive);
    if (options.shouldAbort?.()) return;
    this.emitLoopIterationCompletedEvent({
      codonId,
      isContextExceeded: options.contextExceeded ?? false,
    });
  }

  private loopIterationMetrics(currentRun: ST.Run, loopId: string, iteration: number) {
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

    return { durationMs, costUsd, tokensUsed };
  }

  private findLoopConfig(loopId: string) {
    const loopConfig = this.codonConfigs?.find(
      (item): item is Extract<CodonConfig, { type: "loop" }> =>
        item.type === "loop" && item.id === loopId,
    );
    return loopConfig;
  }

  private loopTermination(
    loopConfig: Extract<CodonConfig, { type: "loop" }>,
    iteration: number,
    contextExceededTermination: boolean,
  ) {
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

    return { isFinal, terminationReason };
  }

  private emitLoopIterationCompletedEvent(params: {
    codonId: CodonId;
    isContextExceeded: boolean;
  }): void {
    const codon = this.getCodonInCurrentRun(params.codonId);
    if (!codon?.loopContext) return;

    const { loopId, iteration, codonIndexInLoop } = codon.loopContext;
    const loopConfig = this.findLoopConfig(loopId);
    if (!loopConfig) return;

    const isLastCodonInIteration = codonIndexInLoop === loopConfig.codons.length - 1;
    const contextExceededTermination =
      params.isContextExceeded && loopConfig.terminateOn.type === "contextExceeded";
    const isIterationCompleted = contextExceededTermination || isLastCodonInIteration;
    if (!isIterationCompleted) return;

    const { isFinal, terminationReason } = this.loopTermination(
      loopConfig,
      iteration,
      contextExceededTermination,
    );

    const currentRun = this.getCurrentRun();
    if (!currentRun) return;

    const { durationMs, costUsd, tokensUsed } = this.loopIterationMetrics(
      currentRun,
      loopId,
      iteration,
    );

    this.emit("loopIterationCompleted", {
      loopId,
      iteration,
      durationMs,
      costUsd,
      tokensUsed,
      isFinal,
      terminationReason,
    });
  }

  /** Called after output publication; derive archive policy from completed state. */
  private async archiveCompletedCodon(
    codonId: CodonId,
    options: ArchiveOperationOptions = {},
  ): Promise<ArchiveResult | null> {
    const codon = this.getCodonInCurrentRun(codonId);
    if (codon?.status !== "completed") return null;
    const entry = this.state.executionPlan.find((entry) => entry.codonId === codonId);
    const owner: ArchiveOwner = codon.loopContext
      ? { kind: "iteration", codonId, ...codon.loopContext }
      : { kind: "codon", codonId };
    return this.archiveFiles(
      entry?.codon.archiveOnSuccess,
      owner,
      codon.completionCheckpoint,
      options,
    );
  }

  private codonCompletingLoop(endingCodonId: CodonId, loopId: string) {
    const codon = this.getCodonInCurrentRun(endingCodonId);
    if (
      !codon ||
      (codon.status !== "completed" && codon.status !== "skipped") ||
      codon.loopContext?.loopId !== loopId
    )
      return null;
    return codon;
  }

  /** Called after expansion; only a terminated loop can archive its shared files. */
  private async archiveTerminatedLoop(
    endingCodonId: CodonId,
    expansion: ExpandIterationResult,
    options: ArchiveOperationOptions = {},
  ): Promise<ArchiveResult | null> {
    const terminated = expansion.loopTerminated;
    if (!terminated) return null;
    const codon = this.codonCompletingLoop(endingCodonId, terminated.loopId);
    if (!codon) return null;
    const loop = this.codonConfigs?.find(
      (config) => config.type === "loop" && config.id === terminated.loopId,
    );
    if (!loop?.archiveOnSuccess?.length) return null;
    this.logger.log(
      `Loop '${terminated.loopId}' terminated after ${terminated.completedIterations} iterations, executing archiveOnSuccess`,
    );
    // A skipped codon can lack a checkpoint when checkpoint creation failed.
    // Preserve the existing orphan policy: rollback always selects that archive.
    const checkpoint =
      codon.status === "completed" ? codon.completionCheckpoint : codon.skipCheckpoint;
    return this.archiveFiles(
      loop.archiveOnSuccess,
      { kind: "loop", loopId: terminated.loopId },
      checkpoint,
      options,
    );
  }

  private async archiveFiles(
    patterns: string[] | undefined,
    owner: ArchiveOwner,
    checkpoint: string | undefined,
    options: ArchiveOperationOptions,
  ): Promise<ArchiveResult | null> {
    if (!patterns?.length) return null;
    const codonId = owner.kind === "loop" ? owner.loopId : owner.codonId;
    if (options.shouldAbort?.()) {
      this.logger.log(`Archive rigs skipped for codon ${codonId}: shutdown in progress`);
      return null;
    }
    this.logger.log(`Executing archiveOnSuccess for ${codonId}: ${patterns.join(", ")}`);
    try {
      const workspace = this.workspace;
      if (!workspace) throw new Error("StateManager has no workspace wired");
      const outcomes = await workspace.archives.archive(
        workspace.files.select(patterns),
        owner,
        CheckpointId(checkpoint || "orphan"),
        options,
      );
      return { codonId, outcomes };
    } catch (error) {
      // Completion is already persisted. Archive failures remain best effort
      // and must not escape the runner's exit listener.
      this.logger.log(`archiveOnSuccess failed for ${codonId}: ${toError(error).message}`, "error");
      return null;
    }
  }

  /**
   * Checks if context exceeded is an acceptable termination condition for the given codon.
   *
   * Returns true only if:
   * - Codon is part of a loop (has loopContext)
   * - That loop terminates on contextExceeded
   *
   * This is a pure query method with no side effects.
   *
   * @param codonId - The codon to check
   * @returns true if context exceeded is acceptable, false otherwise
   */
  isContextExceededAcceptable(codonId: CodonId): boolean {
    const plan = this.state.executionPlan;
    const codonEntry = plan.find((p) => p.codonId === codonId);

    // Check 1: Extension codons accept context exceeded
    // Extract base codon ID (remove loop instance suffix like #0, #1)
    const baseCodonId = codonId.includes("#") ? codonId.split("#")[0] : codonId;
    const codonConfig = this.codonConfigs?.find((c) => c.type === "codon" && c.id === baseCodonId);
    if (codonConfig && codonConfig.type === "codon" && codonConfig.exhaustWithPrompt) {
      return true; // Extension codons accept context exceeded as success
    }

    // Check 2: Loop codons that terminate on context exceeded
    if (!codonEntry?.loopContext) {
      // Not in a loop and not an extension codon
      return false;
    }

    // Find the loop configuration
    const { loopId } = codonEntry.loopContext;
    const loopConfig = this.codonConfigs?.find((p) => p.type === "loop" && p.id === loopId);

    if (!loopConfig || loopConfig.type !== "loop") {
      return false;
    }

    // Check if loop terminates on context exceeded
    return loopConfig.terminateOn.type === "contextExceeded";
  }

  // Public API - fire and forget!
  transition(event: ST.StateTransition): void {
    this.transitionQueue.push(event);
    this.processQueue(); // Don't await - let it run
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;

    this.isProcessing = true;

    while (this.transitionQueue.length > 0) {
      const event = this.transitionQueue.shift();
      if (!event) break; // Should never happen, but satisfies linter

      try {
        this.validateTransition(event);
        const newState = this.applyTransition(this.state, event);
        this.state = newState;

        // Update cost cache if needed
        this.updateCostCache(event);

        // Update execution plan if needed
        this.updateExecutionPlan(event);

        await this.save();

        this.emit("stateChanged", event);
        this.logger.log(`State transition: ${event.type}`);

        // Emit specific events for important transitions
        if (event.type === "CodonTransitioned" && event.data.to === "running") {
          this.emit("codonRunning", {
            runId: event.data.runId,
            codonId: event.data.codonId,
            from: event.data.from,
            to: "running" as const,
            metadata: event.data.metadata,
          });
        }
      } catch (error) {
        this.logger.log(`State transition failed: ${error}`, "error");
        this.emit("transitionError", { event, error: error as Error });

        if (error instanceof InvalidTransitionError) {
        } else {
          break; // Fatal error
        }
      }
    }

    this.isProcessing = false;
  }

  // Cost cache management
  private updateCostCache(event: ST.StateTransition): void {
    if (
      event.type === "CostsUpdated" ||
      event.type === "CostsIncremented" ||
      event.type === "CodonFinalCostSet"
    ) {
      // Just rebuild the cache from scratch to ensure accuracy
      this.rebuildCostCache();
    } else if (event.type === "RunStarted") {
      this.costCache.currentRun = 0;
      // Also reset total since we're starting fresh
      this.rebuildCostCache();
    } else if (event.type === "RunCompleted" || event.type === "RunFailed") {
      // Current run cost already in total, just reset current
      this.costCache.currentRun = 0;
    }
  }

  // Execution plan management
  private updateExecutionPlan(event: ST.StateTransition): void {
    if (event.type === "RunStarted") {
      this.bootRecoverySnapshot = null;
      // Build initial execution plan if we are not in a continuation mode
      if (event.data.startingConditions.type !== "continuation") {
        this.buildInitialPlan();
      }
    }
  }

  private rebuildCostCache(): void {
    this.costCache.total = this.state.runs.reduce((total, run) => {
      return (
        total +
        run.codons.reduce((runTotal, codon) => {
          return runTotal + getCodonCost(codon);
        }, 0)
      );
    }, 0);

    const currentRun = this.getCurrentRun();
    if (currentRun) {
      this.costCache.currentRun = currentRun.codons.reduce((total, codon) => {
        return total + getCodonCost(codon);
      }, 0);
    }
  }

  // State validation implementation
  validate(state: unknown): ST.StateValidation {
    const errors: ST.ValidationError[] = [];
    const warnings: ST.ValidationWarning[] = [];

    // Type structure validation
    if (!this.isValidStateStructure(state)) {
      errors.push({
        type: "corrupted_data",
        message: "State file has invalid structure",
      });
      return { valid: false, errors, warnings };
    }

    // Referential integrity
    const typedState = state as ST.HankweaveState;
    if (
      typedState.currentRunId &&
      !typedState.runs.find((r) => r.runId === typedState.currentRunId)
    ) {
      errors.push({
        type: "missing_run",
        message: `Current run ${typedState.currentRunId} not found`,
      });
    }

    // Check for orphaned run folders
    const runsDir = this.layout.runsDir;
    if (fs.existsSync(runsDir)) {
      const runFolders = fs.readdirSync(runsDir);
      const stateRunIds = new Set(typedState.runs.map((r) => r.runId));

      for (const folder of runFolders) {
        if (!stateRunIds.has(folder as RunId)) {
          warnings.push({
            type: "orphaned_folder",
            message: `Found run folder without state entry: ${folder}`,
          });
        }
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  private isValidStateStructure(state: unknown): state is ST.HankweaveState {
    // Basic type checking - can be expanded
    if (!state || typeof state !== "object") return false;
    const s = state as Record<string, unknown>;

    // Check required fields
    const hasValidRuns = Array.isArray(s.runs);
    const hasValidCurrentRunId = s.currentRunId === null || typeof s.currentRunId === "string";
    const hasValidExecutionPlan = Array.isArray(s.executionPlan);

    return hasValidRuns && hasValidCurrentRunId && hasValidExecutionPlan;
  }

  // Query methods with cached costs
  getCurrentRunCost(): number {
    return this.costCache.currentRun;
  }

  getTotalCost(): number {
    return this.costCache.total;
  }

  // Implement all query methods
  getCurrentRun(): ST.Run | null {
    if (!this.state.currentRunId) return null;
    return this.state.runs.find((r) => r.runId === this.state.currentRunId) || null;
  }

  getCurrentlyRunningCodon(): ST.CodonExecution | null {
    const currentRun = this.getCurrentRun();
    if (!currentRun) return null;

    // Find the last non-terminal codon
    for (let i = currentRun.codons.length - 1; i >= 0; i--) {
      const codon = currentRun.codons[i];
      if (!isTerminalCodonStatus(codon.status)) {
        return codon;
      }
    }

    return null;
  }

  getCodonInCurrentRun(codonId: CodonId): ST.CodonExecution | null {
    const currentRun = this.getCurrentRun();
    if (!currentRun) return null;

    // Return the LATEST record for this codonId, not the first. A retried codon
    // appends a new execution record (CodonStarted pushes — see the reducer)
    // while the failed attempt's record stays in place as terminal history. A
    // naive find-first would return that stale terminal record, so callers like
    // handleCodonComplete would see status="failed" (terminal) and early-return
    // — wedging the run after a retry SUCCEEDS (the running record never
    // advances to completed). Scanning from the end mirrors the CodonTransitioned
    // reducer, which also targets the latest record for the codon.
    for (let i = currentRun.codons.length - 1; i >= 0; i--) {
      if (currentRun.codons[i].codonId === codonId) return currentRun.codons[i];
    }
    return null;
  }

  /**
   * Get the next codon that should be executed based on current state.
   * Uses the execution thread to determine where we are in the workflow.
   *
   * @returns CodonId of next codon to execute, or null if all codons are complete
   */
  async getNextCodonToExecute(): Promise<CodonId | null> {
    const thread = await this.getExecutionThread();

    this.logger.log(
      `[getNextCodonToExecute] Execution thread determined next codon: ${
        thread.nextCodonId || "none"
      }`,
      "debug",
    );

    return thread.nextCodonId || null;
  }

  getRun(runId: RunId): ST.Run | null {
    return this.state.runs.find((r) => r.runId === runId) || null;
  }

  /**
   * Query recorded rig, completion, error, and skip checkpoints, newest first.
   * Without a run id, includes every run (including abandoned timelines),
   * with metadata from the current run. Returns null if that run is missing.
   */
  queryCheckpoints(runId?: RunId): CheckpointQueryResult | null {
    const targetRun = runId ? this.getRun(runId) : this.getCurrentRun();
    if (!targetRun) return null;

    const checkpoints: CheckpointQueryInfo[] = [];

    // If a specific runId is provided, only list that run's checkpoints
    // Otherwise, list ALL checkpoints from ALL runs (not just current thread)
    const runsToProcess = runId
      ? this.state.runs.filter((r) => r.runId === runId)
      : this.state.runs;

    // Process runs in reverse order (oldest first) so checkpoints are in chronological order
    // Then we'll reverse at the end to show most recent first
    for (const run of [...runsToProcess].reverse()) {
      for (const codon of run.codons) {
        checkpoints.push(...this.codonCheckpoints(codon));
      }
    }

    // Reverse to show most recent first
    checkpoints.reverse();

    return {
      runId: targetRun.runId,
      checkpoints,
      currentBranch: targetRun.gitBranch,
    };
  }

  private codonCheckpoints(codon: ST.CodonExecution): CheckpointQueryInfo[] {
    const checkpoints: CheckpointQueryInfo[] = [];
    const codonConfig = this.codonConfigs?.find((p) => p.id === codon.codonId);
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

    this.appendTerminalCheckpoints(codon, codonName, checkpoints);

    return checkpoints;
  }

  private appendTerminalCheckpoints(
    codon: ST.CodonExecution,
    codonName: string,
    checkpoints: CheckpointQueryInfo[],
  ): void {
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

  async getCodonHistory(
    codonId: CodonId,
  ): Promise<Array<{ run: ST.Run; codon: ST.CodonExecution }>> {
    const history: Array<{ run: ST.Run; codon: ST.CodonExecution }> = [];

    // Search all runs in reverse chronological order (newest first)
    for (const run of this.state.runs) {
      for (const codon of run.codons) {
        if (codon.codonId === codonId) {
          history.push({ run, codon });
        }
      }
    }

    return history;
  }

  /**
   * The rig-setup checkpoint for `codonId` recorded in `runId`, or null.
   *
   * Same-run retries can reuse this checkpoint. Earlier-run history alone
   * does not prove setup is present in the work tree: prepareCodon also
   * checks the continuation's exact restored SHA before reusing an earlier
   * rig checkpoint. Matching uses the runtime id recorded by CodonStarted
   * (e.g. "plan#2"), so each loop iteration has its own setup history.
   */
  getRigSetupCheckpointInRun(codonId: CodonId, runId: RunId): string | null {
    const run = this.getRun(runId);
    if (!run) return null;
    for (const codon of run.codons) {
      if (codon.codonId !== codonId) continue;
      if ("rigSetupCheckpoint" in codon && codon.rigSetupCheckpoint) {
        return codon.rigSetupCheckpoint;
      }
    }
    return null;
  }

  private reusableRigCheckpoint(codonId: CodonId, run: ST.Run): string | undefined {
    let checkpointSha = this.getRigSetupCheckpointInRun(codonId, run.runId) ?? undefined;
    // A restored rig checkpoint is reusable for the first attempt of this
    // continuation, including a delayed/manual start after rollback.
    const origin = run.startingConditions;
    if (!checkpointSha && run.codons.length === 0 && origin.type === "continuation") {
      const restored = this.getRun(origin.source.runId)?.codons.some(
        (attempt) =>
          attempt.codonId === codonId &&
          "rigSetupCheckpoint" in attempt &&
          attempt.rigSetupCheckpoint === origin.source.checkpointSha,
      );
      if (restored && origin.source.checkpointSha) checkpointSha = origin.source.checkpointSha;
    }
    return checkpointSha;
  }

  private shouldPrepareRig(
    options: PrepareCodonOptions,
    checkpointSha: string | undefined,
    codon: ExecutionCodonEntry["codon"],
  ): boolean {
    return Boolean(
      !options.replay && !options.skipRequested && !checkpointSha && codon.rigSetup?.length,
    );
  }

  private async startPreparingCodon(codonId: CodonId, options: PrepareCodonOptions) {
    await this.waitForPendingTransitions();
    const run = this.getCurrentRun();
    const entry = this.getCodonById(codonId);
    const workspace = this.workspace;
    if (!run || !entry || !workspace) {
      throw new Error(`Cannot prepare codon ${codonId}: missing run, codon, or workspace`);
    }
    if (this.getCurrentlyRunningCodon()) {
      throw new Error(`Cannot prepare codon ${codonId}: a codon is already running`);
    }
    const codon = entry.codon;
    const attemptCount = run.codons.length + 1;
    const report = (progress: PreparationProgress) => options.onProgress?.(progress);
    // Check ownership as well as shutdown: force-stop can terminate preparation
    // while a local shell is in flight, before a successor starts.
    const aborted = () => {
      const current = this.getCurrentlyRunningCodon();
      return Boolean(
        options.shouldAbort?.() ||
          this.state.currentRunId !== run.runId ||
          this.getCurrentRun()?.codons.length !== attemptCount ||
          !current ||
          current.codonId !== codonId,
      );
    };
    if (options.shouldAbort?.()) return null;

    const checkpointSha = this.reusableRigCheckpoint(codonId, run);
    const runRig = this.shouldPrepareRig(options, checkpointSha, codon);
    if (checkpointSha) {
      this.logger.log(`Reusing rig setup checkpoint ${checkpointSha} for codon ${codonId}`);
    }
    await this.transitionAndWait({
      type: "CodonStarted",
      data: { runId: run.runId, codonId, loopContext: entry.loopContext },
    });
    return { run, codon, workspace, aborted, report, runRig, checkpointSha };
  }

  /**
   * Prepare the codon in the already-established current run. Rig work is
   * followed by sentinel loading in `starting`, then its checkpoint. The
   * runtime owns sentinel services, progress reporting, and failure policy.
   */
  async prepareCodon(codonId: CodonId, options: PrepareCodonOptions): Promise<PreparationResult> {
    const context = await this.startPreparingCodon(codonId, options);
    if (!context) return { status: "aborted" };
    const { run, codon, workspace, aborted, report, runRig } = context;
    let { checkpointSha } = context;
    const fail = async (
      failure: PreparationFailure,
      from: "preparing" | "starting",
    ): Promise<PreparationResult> => {
      if (aborted()) return { status: "aborted" };
      await this.transitionAndWait({
        type: "CodonTransitioned",
        data: {
          runId: run.runId,
          codonId,
          from,
          to: "failed",
          metadata: {
            exitCode: failure.exitCode,
            failedDuring: from,
            failureReason: failure.failureReason,
          },
        },
      });
      return failure;
    };

    let durationMs = 0;
    const prepareRig = async (): Promise<PreparationResult | undefined> => {
      const items = codon.rigSetup ?? [];
      const started = Date.now();
      let lastCopiedPath: string | undefined;
      let succeeded = 0;
      let failed = 0;
      const performOperation = async (
        item: NonNullable<typeof codon.rigSetup>[number],
        index: number,
      ): Promise<PreparationResult | undefined> => {
        report({ type: "rig-operation", index, operationCount: items.length, item });
        try {
          if (item.type === "copy") {
            const planted = await workspace.rigs.plantCopy(
              options.hankDir,
              item.copy.from,
              item.copy.to,
              { shouldAbort: aborted },
            );
            if (planted.aborted) return { status: "aborted" };
            if (planted.ignored.length > 0) {
              report({
                type: "rig-copy-excluded",
                index,
                from: item.copy.from,
                ignored: planted.ignored,
              });
            }
            lastCopiedPath = planted.target;
          } else {
            await workspace.rigs.runCommand(item, lastCopiedPath, codon.env, (stream, line) => {
              if (!aborted()) report({ type: "rig-output", index, stream, line });
            });
          }
          succeeded++;
        } catch (error) {
          if (aborted()) return { status: "aborted" };
          const failure = normalizeRigOperationFailure(error, item.type);
          const ignored = Boolean(item.allowFailure || options.ignoreRigFailures);
          report({ type: "rig-operation-failed", index, item, ignored, ...failure });
          if (ignored) {
            failed++;
            return;
          }
          return await fail(
            {
              status: "failed",
              phase: "rig",
              index,
              item,
              error: failure.error,
              exitCode: failure.exitCode ?? -1,
              failureReason: {
                type: "unknown",
                retriable: true,
                message: `Rig setup failed at ${item.type} operation: ${failure.error.message}`,
              },
            },
            "preparing",
          );
        }
      };
      report({ type: "rig-started", operationCount: items.length });
      for (const [index, item] of items.entries()) {
        if (aborted()) return { status: "aborted" };
        const result = await performOperation(item, index);
        if (result) return result;
      }
      if (aborted()) return { status: "aborted" };
      durationMs = Date.now() - started;
      report({ type: "rig-operations-completed", durationMs, succeeded, failed });
    };
    if (runRig) {
      const result = await prepareRig();
      if (result) return result;
    }
    const finishPreparation = async (): Promise<PreparationResult> => {
      if (aborted()) return { status: "aborted" };
      await this.transitionAndWait({
        type: "CodonTransitioned",
        data: {
          runId: run.runId,
          codonId,
          from: "preparing",
          to: "starting",
          metadata: { checkpointSha },
        },
      });
      if (aborted()) return { status: "aborted" };
      const prepareSentinels = async (): Promise<PreparationResult | undefined> => {
        const sentinels = await options.loadSentinels();
        if (aborted()) return { status: "aborted" };
        if (sentinels.sentinelStates?.length) {
          await this.transitionAndWait({
            type: "SentinelStatesUpdated",
            data: {
              runId: run.runId,
              codonId,
              sentinelStates: sentinels.sentinelStates,
              totalCost: sentinels.sentinelStates.reduce((sum, state) => sum + state.totalCost, 0),
            },
          });
        }
        const refs = sentinels.errors.filter((error) => error.fatal).map((error) => error.ref);
        if (refs.length) {
          const message = `Required sentinels failed to load (failCodonIfNotLoaded=true): ${refs.join(", ")}`;
          return await fail(
            {
              status: "failed",
              phase: "sentinels",
              refs,
              error: new Error(message),
              exitCode: -1,
              failureReason: {
                type: "sentinel-load-failure",
                retriable: false,
                message,
                sentinelRefs: refs,
              },
            },
            "starting",
          );
        }
        for (const error of sentinels.errors) report({ type: "sentinel-warning", ...error });
      };
      if (!options.replay) {
        const result = await prepareSentinels();
        if (result) return result;
      }
      if (aborted()) return { status: "aborted" };
      const publishRigCheckpoint = async (): Promise<PreparationResult | undefined> => {
        try {
          checkpointSha = await this.createCheckpoint({
            status: "rig-setup",
            codonId,
            codonName: codon.name,
            runId: run.runId,
            timestamp: new Date().toISOString(),
          });
          await this.waitForPendingTransitions();
        } catch (error) {
          const message = `Rig-setup checkpoint failed for codon ${codonId}: ${toError(error).message}`;
          return await fail(
            {
              status: "failed",
              phase: "checkpoint",
              error: toError(error),
              exitCode: -1,
              failureReason: { type: "unknown", retriable: false, message },
            },
            "starting",
          );
        }
        if (aborted()) return { status: "aborted" };
        report({
          type: "rig-completed",
          operationCount: codon.rigSetup?.length ?? 0,
          durationMs,
          createdCheckpoint: true,
        });
      };
      if (runRig) {
        const result = await publishRigCheckpoint();
        if (result) return result;
      }
      return { status: "ready", checkpointSha };
    };
    return finishPreparation();
  }

  getCostSince(runId: RunId): number {
    let found = false;
    let total = 0;

    for (const run of this.state.runs) {
      if (run.runId === runId) {
        found = true;
      }

      if (found) {
        for (const codon of run.codons) {
          total += getCodonCost(codon);
        }
      }
    }

    return total;
  }

  canContinueFrom(runId: RunId, afterCodon: CodonId | null): boolean {
    const run = this.getRun(runId);
    if (!run) return false;

    if (afterCodon) {
      const codon = run.codons.find((c) => c.codonId === afterCodon);
      return codon?.status === "completed";
    }

    // Can continue from beginning of any run
    return true;
  }

  getCheckpointForContinuation(runId: RunId, afterCodon: CodonId | null): string | null {
    const run = this.getRun(runId);
    if (!run) return null;

    if (!afterCodon) {
      // Continue from beginning - use first codon's rig setup checkpoint if available
      const firstCodon = run.codons[0];
      if (firstCodon && "rigSetupCheckpoint" in firstCodon && firstCodon.rigSetupCheckpoint) {
        return firstCodon.rigSetupCheckpoint;
      }
      return null;
    }

    // Find the specified codon
    const codon = run.codons.find((p) => p.codonId === afterCodon);
    if (!codon || codon.status !== "completed") return null;

    return codon.completionCheckpoint;
  }

  private workspace?: Pick<Workspace, "checkpoints" | "recovery" | "archives" | "rigs" | "files">;
  private rollbackInProgress = false;
  private bootRecoverySnapshot: RecoverySnapshot | null = null;

  setWorkspace(
    workspace: Pick<Workspace, "checkpoints" | "recovery" | "archives" | "rigs" | "files">,
  ): void {
    this.workspace = workspace;
    this.setWorkspaceCheckpoints(workspace.checkpoints);
  }

  /** Resolve, preserve, restore, and finish the abandoned run as one operation.
   * The caller owns stopping runners and starting the returned continuation.
   * Returns null when last-success has no target, after preserving the files
   * for prepareRunFromHistory() to safely choose the startup fallback. */
  async rollback(
    target: RollbackTarget,
    options: RollbackOptions = {},
  ): Promise<RollbackResult | null> {
    if (this.rollbackInProgress) throw new RollbackRejectedError("Rollback already in progress");
    const running = this.getCurrentlyRunningCodon();
    if (running && !isTerminalCodonStatus(running.status)) {
      throw new RollbackRejectedError(
        "Cannot rollback while codon is running. Use 'codon.forceStop' first.",
      );
    }
    const workspace = this.workspace;
    if (!workspace) throw new Error("StateManager has no workspace wired");
    this.rollbackInProgress = true;
    let mutated = false;
    const assertActive = () => {
      if (options.shouldAbort?.()) throw new Error("Rollback aborted: shutdown in progress");
    };
    const report = (progress: RollbackProgress) => options.onProgress?.(progress);
    try {
      assertActive();
      const plan = await this.planRollback(target);
      assertActive();
      if (!plan) {
        const snapshot = await this.preserveForRecovery("no restorable checkpoint", options);
        assertActive();
        this.reportRecoveryDiagnostic(
          "Recovery degraded: no git-confirmed checkpoint in execution history; falling back to " +
            `continuation or a fresh run (work tree snapshotted to ${snapshot.branch})`,
          options,
        );
        return null;
      }
      const executePlan = async (): Promise<RollbackResult> => {
        const reason = `rollback to ${plan.id}`;
        const prepareRecovery = async (): Promise<PreparedRecovery> => {
          try {
            return await workspace.recovery.prepare({
              baseline: await this.requireExecutionCheckpoint(),
              target: plan.id,
              reason,
              patterns: await this.recoveryCheckpointPatterns(),
            });
          } catch (error) {
            if (error instanceof CheckpointNotFoundError) throw error;
            throw this.recoverySnapshotFailed(reason, error, options);
          }
        };
        const recovery = await prepareRecovery();
        report({ type: "snapshot", snapshot: recovery.snapshot, reason });
        assertActive();
        // Plan against the history being abandoned, before intermediate restores move it.
        const history = await this.checkpointsAbandonedBy(recovery.target);
        assertActive();
        const archives = await workspace.archives.planRestore(history);
        assertActive();
        const checkpoint = {
          codonId: plan.target.codon.codonId,
          codonName:
            this.rollbackCodonConfig(plan.target.codon.codonId)?.name || plan.target.codon.codonId,
          checkpoint: recovery.target,
          checkpointType: plan.checkpointType,
        };
        report({
          type: "started",
          fromRun: plan.fromRun,
          fromCodon: plan.fromCodon,
          toCodon: checkpoint.codonId,
          toCheckpoint: checkpoint.checkpoint,
          checkpointType: checkpoint.checkpointType,
          codonsToProcess: plan.direct
            ? [checkpoint.codonId]
            : plan.steps.map((step) => step.codon.codonId),
        });
        let currentStep = 0;
        const totalSteps = plan.steps.length + 1;
        const cleanupDirectories = async (
          step: ThreadCodon,
          config: ReturnType<StateManager["rollbackCodonConfig"]>,
          directories: string[],
        ): Promise<void> => {
          const cleanup = {
            codonId: step.codon.codonId,
            codonName: config?.name || step.codon.codonId,
            directories,
          };
          report({ type: "rig-cleanup", ...cleanup, status: "started" });
          const successfulCleanups: string[] = [];
          const failedCleanups: { directory: string; error: string }[] = [];
          for (const directory of directories) {
            assertActive();
            mutated = true;
            try {
              await workspace.rigs.removePath(directory);
              successfulCleanups.push(directory);
            } catch (error) {
              const message = toError(error).message;
              this.logger.log(`Failed to remove rig directory ${directory}: ${message}`, "error");
              failedCleanups.push({ directory, error: message });
            }
          }
          report({
            type: "rig-cleanup",
            ...cleanup,
            successfulCleanups,
            failedCleanups,
            status: failedCleanups.length
              ? successfulCleanups.length
                ? "partial"
                : "failed"
              : "completed",
          });
        };
        const restoreStep = async (step: ThreadCodon): Promise<void> => {
          assertActive();
          report({
            type: "step",
            currentStep: ++currentStep,
            totalSteps,
            codonId: step.codon.codonId,
          });
          const intermediate = bestConfirmedCheckpoint(step);
          if (intermediate) {
            assertActive();
            mutated = true;
            await recovery.restoreIntermediate(CheckpointId(intermediate.sha));
            this.executionCheckpoint = CheckpointId(intermediate.sha);
            report({
              type: "checkpoint",
              final: false,
              codonId: step.codon.codonId,
              codonName: this.rollbackCodonConfig(step.codon.codonId)?.name || step.codon.codonId,
              checkpoint: intermediate.sha,
              checkpointType: intermediate.type,
            });
          }
          assertActive();
          const config = this.rollbackCodonConfig(step.codon.codonId);
          const directories = (config?.rigSetup ?? []).flatMap((item) =>
            item.type === "copy" ? [item.copy.to] : [],
          );
          if (directories.length === 0) return;
          await cleanupDirectories(step, config, directories);
        };
        for (const step of plan.steps) {
          await restoreStep(step);
        }
        assertActive();
        report({ type: "step", currentStep: ++currentStep, totalSteps });
        assertActive();
        mutated = true;
        await recovery.restore();
        this.executionCheckpoint = recovery.target;
        assertActive();
        if (archives.count > 0) {
          const outcomes = await workspace.archives.restore(archives, {
            shouldAbort: options.shouldAbort,
          });
          report({ type: "archives", checkpoint: recovery.target, outcomes });
        }
        assertActive();
        report({ type: "checkpoint", final: true, ...checkpoint });
        assertActive();
        const currentRun = this.getCurrentRun();
        if (currentRun) {
          await this.transitionAndWait({ type: "RunCompleted", data: { runId: currentRun.runId } });
        }
        assertActive();
        return {
          ...checkpoint,
          fromRun: plan.fromRun,
          continuation: {
            type: "continuation",
            reason: "rollback",
            source: {
              runId: plan.target.runId,
              afterCodon: checkpoint.checkpointType === "rig-setup" ? null : checkpoint.codonId,
              checkpointSha: recovery.target,
            },
          },
        };
      };
      return await executePlan();
    } catch (error) {
      throw mutated ? new RollbackMutatedWorkspaceError(error) : error;
    } finally {
      this.rollbackInProgress = false;
    }
  }

  private rollbackCodonConfig(id: CodonId) {
    const planned = this.state.executionPlan.find((entry) => entry.codonId === id)?.codon;
    if (planned) return planned;
    const configured = this.codonConfigs?.find((codon) => codon.id === id);
    return configured?.type === "loop" ? undefined : configured;
  }

  private async planRollback(request: RollbackTarget) {
    const thread = await this.getExecutionThreadForRecovery();
    type Candidate = { target: ThreadCodon; id: string; checkpointType: RollbackCheckpointType };
    const candidates = (target: ThreadCodon): Candidate[] => {
      const codon = target.codon;
      const result: Candidate[] = [];
      const add = (checkpointType: RollbackCheckpointType, id: string | null | undefined) => {
        if (id) result.push({ target, id, checkpointType });
      };
      if ("rigSetupCheckpoint" in codon) add("rig-setup", codon.rigSetupCheckpoint);
      if (codon.status === "completed") add("completed", codon.completionCheckpoint);
      if (codon.status === "failed") add("error", codon.errorCheckpoint);
      if (codon.status === "skipped") add("skipped", codon.skipCheckpoint);
      return result;
    };
    const chooseLastSuccess = (): Candidate | null => {
      const { target, passedOverCompletion } = decideRollback(thread);
      if (passedOverCompletion?.codon.status === "completed") {
        this.logger.log(
          `Completed codon ${passedOverCompletion.codon.codonId} (run ${passedOverCompletion.runId}) ` +
            `has no git-confirmed completion checkpoint (reference ${JSON.stringify(passedOverCompletion.codon.completionCheckpoint)}) — not a rollback target`,
          "error",
        );
      }
      if (!target) return null;
      return { target: thread.codons[target.index], id: target.sha, checkpointType: target.type };
    };
    const chooseCodon = (request: Extract<RollbackTarget, { type: "codon" }>): Candidate => {
      const target = thread.codons.find((step) => step.codon.codonId === request.codonId);
      if (!target)
        throw new RollbackRejectedError(`Codon ${request.codonId} not found in execution history`);
      const choices = candidates(target);
      const selected =
        request.checkpointType === "start"
          ? choices[0]
          : request.checkpointType === "end"
            ? choices.at(-1)
            : choices.find((choice) => choice.checkpointType === request.checkpointType);
      if (!selected)
        throw new RollbackRejectedError(
          `No ${request.checkpointType} checkpoint found for codon ${request.codonId}`,
        );
      return selected;
    };
    const chooseCheckpoint = (
      request: Exclude<RollbackTarget, { type: "codon" | "last-success" }>,
    ): Candidate => {
      let matches = thread.codons
        .flatMap(candidates)
        .filter((candidate) => candidate.id.startsWith(request.id));
      if (matches.length === 0) {
        matches = this.state.runs
          .flatMap((run, runIndex) =>
            run.codons.flatMap((codon, codonIndex) =>
              candidates({
                codon,
                runId: run.runId,
                runStatus: run.status,
                runStartTime: run.startTime,
                runEndTime: run.endTime || null,
                gitBranch: run.gitBranch,
                globalIndex: -1,
                runIndex,
                codonIndexInRun: codonIndex,
                validatedCheckpoints: [],
                continuationSessionId: null,
              }),
            ),
          )
          .filter((candidate) => candidate.id.startsWith(request.id));
      }
      if (matches.length === 0)
        throw new RollbackRejectedError(
          `Checkpoint ${request.id} not found in any run (current or historical)`,
        );
      if (matches.length > 1) {
        const details = matches
          .map(
            (match) =>
              `  - ${match.id} (${this.rollbackCodonConfig(match.target.codon.codonId)?.name || match.target.codon.codonId} - ${match.checkpointType}) in run ${match.target.runId}`,
          )
          .join("\n");
        throw new RollbackRejectedError(
          `Ambiguous checkpoint SHA '${request.id}'. Multiple checkpoints match:\n${details}\nPlease provide more characters to uniquely identify the checkpoint.`,
        );
      }
      return matches[0];
    };
    const selected =
      request.type === "last-success"
        ? chooseLastSuccess()
        : request.type === "codon"
          ? chooseCodon(request)
          : chooseCheckpoint(request);
    if (!selected) return null;
    const chosen = selected;
    const describePlan = () => {
      const index = thread.codons.findIndex(
        (step) =>
          step.runId === chosen.target.runId && step.codon.codonId === chosen.target.codon.codonId,
      );
      const currentRun = this.getCurrentRun();
      const origin = () => ({
        fromRun: (index < 0 ? currentRun?.runId : thread.codons[0]?.runId) || chosen.target.runId,
        fromCodon:
          (index < 0 ? currentRun?.codons[0]?.codonId : thread.codons[0]?.codon.codonId) ||
          chosen.target.codon.codonId,
      });
      this.logger.log(
        index < 0
          ? `Executing direct rollback to historical checkpoint ${chosen.id} (${chosen.checkpointType}) from run ${chosen.target.runId}`
          : `Executing rollback to ${chosen.id} (${chosen.checkpointType}) at thread index ${index}`,
      );
      return {
        ...chosen,
        direct: index < 0,
        steps: index < 0 ? [] : thread.codons.slice(0, index),
        ...origin(),
      };
    };
    return describePlan();
  }

  /** Decide the next run and preserve existing files before a fresh fallback. */
  async prepareRunFromHistory(
    options: RollbackOptions = {},
  ): Promise<ST.StartingConditions | undefined> {
    if (options.shouldAbort?.()) throw new Error("Recovery aborted: shutdown in progress");
    // Reconcile against the run being left before publishing a new run whose
    // continuation metadata may name an older checkpoint.
    await this.requireExecutionCheckpoint();
    const seed = await this.findContinuationSeed();
    if (options.shouldAbort?.()) throw new Error("Recovery aborted: shutdown in progress");
    if (seed?.confirmed)
      return {
        type: "continuation",
        reason: "continue",
        source: { runId: seed.runId, afterCodon: seed.codonId, checkpointSha: seed.sha },
      };
    return this.prepareFreshFallback(seed, options);
  }

  private async prepareFreshFallback(
    seed: ContinuationSeed | null,
    options: RollbackOptions,
  ): Promise<undefined> {
    if (seed)
      this.reportRecoveryDiagnostic(
        `Recovery degraded: newest completed codon ${seed.codonId} (run ${seed.runId}) has no ` +
          `git-confirmed completion checkpoint (reference ${JSON.stringify(seed.sha)}); starting fresh instead`,
        options,
      );
    if (this.state.runs.length > 0 && !this.bootRecoverySnapshot) {
      await this.preserveForRecovery("fresh run over existing history", options);
    }
    if (options.shouldAbort?.()) throw new Error("Recovery aborted: shutdown in progress");
    return undefined;
  }

  private async preserveForRecovery(
    reason: string,
    options: RollbackOptions,
  ): Promise<RecoverySnapshot> {
    if (options.shouldAbort?.()) throw new Error("Recovery aborted: shutdown in progress");
    let snapshot: RecoverySnapshot;
    try {
      snapshot = await this.snapshotBeforeRecovery(reason);
    } catch (error) {
      throw this.recoverySnapshotFailed(reason, error, options);
    }
    this.bootRecoverySnapshot = snapshot;
    options.onProgress?.({ type: "snapshot", snapshot, reason });
    return snapshot;
  }

  private reportRecoveryDiagnostic(message: string, options: RollbackOptions): void {
    this.logger.log(message, "error");
    options.onProgress?.({ type: "diagnostic", message });
  }

  private recoverySnapshotFailed(
    reason: string,
    error: unknown,
    options: RollbackOptions,
  ): CheckpointStorageError {
    const message = `Recovery snapshot failed before ${reason}: ${toError(error).message}`;
    this.reportRecoveryDiagnostic(message, options);
    return error instanceof CheckpointStorageError
      ? error
      : new CheckpointStorageError(message, error);
  }

  /** The workspace's checkpoint store: where checkpoint history is kept. */
  private checkpoints?: WorkspaceCheckpoints;
  /** Execution position, reconciled once from named histories on startup.
   * History handles never use or mutate this cursor. */
  private executionCheckpoint?: CheckpointId;

  /**
   * Wire ready checkpoint storage for consumers that do not need rollback.
   * Runtime recovery uses setWorkspace() to supply all required capabilities.
   */
  setWorkspaceCheckpoints(checkpoints: WorkspaceCheckpoints): void {
    this.checkpoints = checkpoints;
    this.executionCheckpoint = undefined;
  }

  private requireCheckpoints(): WorkspaceCheckpoints {
    if (!this.checkpoints) throw new Error("StateManager has no workspace checkpoints wired");
    return this.checkpoints;
  }

  /**
   * Cut a checkpoint on the current run's branch and record its id on the
   * codon it belongs to (rig-setup, completion, error, or skipped). Returns
   * the id; throws when git could not record it — a checkpoint never
   * masquerades as complete behind an empty reference.
   */
  async createCheckpoint(info: CheckpointInfo): Promise<CheckpointId> {
    // Derive the complete policy for this checkpoint, including the codon's
    // own files even at rig setup. Rollback and restart need no registration.
    const patterns = checkpointPatternsThrough(this.state.executionPlan, info.codonId, true);
    if (patterns === null) {
      throw new Error(`Cannot checkpoint codon ${info.codonId}: not in the execution plan`);
    }
    const firstLine = `${info.status}:${info.codonId} [run:${info.runId}] ${info.codonName}`;
    const body = [
      "",
      `Codon: ${info.codonName}`,
      `Status: ${info.status}`,
      `Timestamp: ${info.timestamp}`,
    ];
    if (info.duration !== undefined) body.push(`Duration: ${info.duration}ms`);
    const commitMessage = `${firstLine}\n${body.join("\n")}`;

    const currentRun = this.getCurrentRun();
    const branchName = currentRun?.gitBranch || `run-${info.runId}`;
    this.logger.log(`[CHECKPOINT-DEBUG] Using branch: ${branchName}`);

    const checkpoints = this.requireCheckpoints();
    const sha = await checkpoints.history(branchName).checkpoint({
      parent: await this.requireExecutionCheckpoint(),
      message: commitMessage,
      patterns,
    });
    this.executionCheckpoint = sha;
    if (!sha) throw new Error("checkpoint commit returned no SHA");
    this.logger.log(
      `[CHECKPOINT-DEBUG] Created checkpoint: ${sha} (${info.status}) on branch ${branchName}`,
    );

    this.recordCreatedCheckpoint(info, currentRun, branchName, sha);
    return sha;
  }

  private recordCreatedCheckpoint(
    info: CheckpointInfo,
    currentRun: ST.Run | null,
    branchName: string,
    sha: CheckpointId,
  ): void {
    const checkpointType =
      info.status === "rig-setup"
        ? "rig-setup"
        : info.status === "completed"
          ? "completed"
          : info.status === "error"
            ? "error"
            : "skipped";
    if (currentRun) {
      this.transition({
        type: "CheckpointCreated",
        data: {
          runId: currentRun.runId,
          codonId: info.codonId,
          checkpointType,
          sha,
          branch: branchName,
        },
      });
    }
  }

  /** The execution's explicit parent for its next write. On reopening, a
   * published branch tip wins over state.json, which may lag a completed write.
   * A new continuation without checkpoints starts at its recorded source. */
  async currentCheckpoint(): Promise<CheckpointId | null> {
    if (this.executionCheckpoint) return this.executionCheckpoint;
    const repository = this.requireCheckpoints();
    for (const run of this.state.runs) {
      const id = await this.checkpointFromRun(run, repository);
      if (id) return id;
    }
    const initial = await repository.history("main").tip();
    if (initial) this.executionCheckpoint = initial;
    return initial;
  }

  private async checkpointFromRun(
    run: ST.Run,
    repository: WorkspaceCheckpoints,
  ): Promise<CheckpointId | null> {
    if (run.gitBranch) {
      const tip = await repository.history(run.gitBranch).tip();
      if (tip) {
        this.executionCheckpoint = tip;
        return tip;
      }
    }
    if (run.startingConditions.type === "continuation") {
      const source = run.startingConditions.source.checkpointSha;
      if (source) {
        try {
          const checkpoint = await repository.get(CheckpointId(source));
          this.executionCheckpoint = checkpoint.id;
          return checkpoint.id;
        } catch (error) {
          if (!(error instanceof CheckpointNotFoundError)) throw error;
        }
      }
    }
    return null;
  }

  private async requireExecutionCheckpoint(): Promise<CheckpointId> {
    const parent = await this.currentCheckpoint();
    if (!parent) throw new CheckpointStorageError("No checkpoint baseline for execution");
    return parent;
  }

  async snapshotBeforeRecovery(reason: string): Promise<RecoverySnapshot> {
    if (!this.workspace) throw new Error("StateManager has no workspace wired");
    return this.workspace.recovery.preserve({
      baseline: await this.requireExecutionCheckpoint(),
      reason,
      patterns: await this.recoveryCheckpointPatterns(),
    });
  }

  /** Capture ownership at the position being abandoned, including a failed
   * codon and its loop iteration. The target may precede those patterns.
   * Use the continuation thread so an empty new run does not broaden the
   * policy to codons from an abandoned timeline. No git history is needed. */
  private async recoveryCheckpointPatterns(): Promise<string[]> {
    const thread = await this.buildExecutionThread(undefined, undefined);
    const codonId = thread.codons[0]?.codon.codonId;
    if (!codonId) return [];
    const patterns = checkpointPatternsThrough(this.state.executionPlan, codonId, true);
    if (patterns === null) {
      throw new Error(
        `Cannot snapshot recovery policy: codon ${codonId} is not in the execution plan`,
      );
    }
    return patterns;
  }

  /**
   * What a rollback to `target` abandons: the checkpoints reachable from
   * the explicit execution position but not from the target, alongside every checkpoint
   * the store holds. Read-only; call it BEFORE the first restore moves
   * the execution position. Throws CheckpointStorageError when it cannot be resolved, so a
   * caller stops rather than restoring an incomplete selection.
   */
  async checkpointsAbandonedBy(target: CheckpointId): Promise<AbandonedCheckpoints> {
    const checkpoints = this.requireCheckpoints();
    const head = await this.currentCheckpoint();
    if (!head) {
      throw new CheckpointStorageError(
        "Could not resolve execution checkpoint to select archive entries for rollback",
      );
    }
    return {
      abandoned: await checkpoints.reachableDifference(head, target),
      known: await checkpoints.allReachableIds(),
    };
  }

  /**
   * Get the execution thread for the current state.
   * This provides a unified view of codon execution across all runs.
   *
   * @param targetRunId - Optional run ID to start from (defaults to latest)
   * @param includeCheckpointValidation - Whether to validate checkpoints against git
   * @returns Complete execution thread with all metadata
   *
   * NOTE: The codonConfigs fallback exists for initialization timing issues where the plan
   * hasn't been built yet (e.g., during HankweaveRuntime.start() before startNewRun()).
   */
  async getExecutionThread(
    targetRunId?: RunId,
    includeCheckpointValidation = true,
  ): Promise<ExecutionThread> {
    // A transient git read failure is tolerated here and shows as "no
    // confirmed checkpoints": this thread feeds display and bookkeeping,
    // which must not start failing over it. Recovery uses
    // getExecutionThreadForRecovery.
    const checkpointData =
      includeCheckpointValidation && this.checkpoints
        ? await this.getCheckpointDataMap(false)
        : undefined;
    return this.buildExecutionThread(targetRunId, checkpointData);
  }

  /**
   * The execution thread recovery decides on. validatedCheckpoints is built
   * from what git actually holds, and a repository that cannot be read throws
   * CheckpointStorageError: recovery must never mistake "unreadable" for
   * "empty", which would fail forward to a fresh run over a good history.
   */
  async getExecutionThreadForRecovery(): Promise<ExecutionThread> {
    const checkpointData = this.checkpoints ? await this.getCheckpointDataMap(true) : undefined;
    return this.buildExecutionThread(undefined, checkpointData);
  }

  /**
   * The codon a continuation may seed from, or null when no run has completed
   * one: the newest completed codon in the strict thread, or — when the
   * thread is empty because the latest run is an empty fresh run — anywhere
   * in state. `confirmed` says whether git holds its completion checkpoint.
   * Throws CheckpointStorageError when the repository cannot be read, so an
   * unreadable store is never mistaken for "nothing to seed".
   */
  async findContinuationSeed(): Promise<ContinuationSeed | null> {
    const checkpointData = this.checkpoints ? await this.getCheckpointDataMap(true) : undefined;
    const thread = await this.buildExecutionThread(undefined, checkpointData);
    return thread.codons.length > 0
      ? seedFromThread(thread)
      : seedFromState(this.state, checkpointData);
  }

  private async buildExecutionThread(
    targetRunId: RunId | undefined,
    checkpointData: Map<string, { message: string; timestamp: string; branch: string }> | undefined,
  ): Promise<ExecutionThread> {
    let effectivePlan: ExecutionCodonEntry[];

    if (this.state.executionPlan.length > 0) {
      effectivePlan = this.state.executionPlan;
    } else {
      // Fallback: Convert codonConfigs to ExecutionCodonEntry format
      // This treats each config as a single execution entry with no loop context
      effectivePlan = (this.codonConfigs || []).map((config) => ({
        codon: config.type === "loop" ? config.codons[0] : config,
        codonId: CodonIdConstructor(config.id),
        loopContext: undefined,
      }));
    }

    // If using a custom plan different from stored state, create temporary state
    const stateToAnalyze: ST.HankweaveState =
      effectivePlan !== this.state.executionPlan
        ? { ...this.state, executionPlan: effectivePlan }
        : this.state;

    return analyzeExecutionThread(stateToAnalyze, checkpointData, targetRunId, this.logger);
  }

  /**
   * Helper to convert checkpoint array to map for execution thread
   */
  private async getCheckpointDataMap(failOnStorageError = false): Promise<
    Map<
      string,
      {
        message: string;
        timestamp: string;
        branch: string;
      }
    >
  > {
    const checkpoints = await this.getAllCheckpoints(failOnStorageError);
    if (!checkpoints) return new Map();

    const map = new Map<
      string,
      {
        message: string;
        timestamp: string;
        branch: string;
      }
    >();

    for (const cp of checkpoints) {
      map.set(cp.sha, {
        message: cp.message,
        timestamp: cp.timestamp,
        branch: cp.branch,
      });
    }

    return map;
  }

  /**
   * Get all checkpoints with detailed information, ordered by time.
   * This exposes the checkpoint history for advanced use cases.
   *
   * @returns Array of checkpoint information ordered by timestamp (newest first), or null if no checkpoint capability is wired
   */
  async getAllCheckpoints(failOnStorageError = false): Promise<Array<{
    sha: string;
    message: string;
    timestamp: string;
    branch: string;
  }> | null> {
    if (!this.checkpoints) {
      return null;
    }

    try {
      // Preserve the existing query shape used by execution-thread metadata.
      const records = new Map<
        string,
        { sha: string; message: string; timestamp: string; branch: string }
      >();
      for (const history of await this.checkpoints.histories()) {
        for (const checkpoint of await history.list()) {
          if (!records.has(checkpoint.id))
            records.set(checkpoint.id, {
              sha: checkpoint.id,
              message: checkpoint.message,
              timestamp: checkpoint.timestamp,
              branch: history.name,
            });
        }
      }
      // Detached legacy checkpoints are readable too; they have no containing history.
      for (const id of await this.checkpoints.allReachableIds()) {
        if (records.has(id)) continue;
        const checkpoint = await this.checkpoints.get(id);
        records.set(id, {
          sha: id,
          message: checkpoint.message,
          timestamp: checkpoint.timestamp,
          branch: "",
        });
      }
      return [...records.values()].sort(
        (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp),
      );
    } catch (error) {
      this.logger.log(`Failed to get all checkpoints: ${error}`, "error");
      // Tolerated by default: dozens of non-recovery callers (state
      // snapshots, handshake, codon completion) reach this map and must not
      // start failing on a transient read. Recovery opts into the error.
      if (failOnStorageError && error instanceof CheckpointStorageError) throw error;
      return null;
    }
  }

  // State modification internals
  private validateTransition(event: ST.StateTransition): void {
    if (event.type === "CodonTransitioned") {
      const { from, to, metadata } = event.data;
      const validTransitions = CodonTransitions[from];

      if (!validTransitions.includes(to)) {
        throw new InvalidTransitionError(from, to);
      }

      // Validate metadata for specific transitions
      try {
        validateTransitionMetadata(to, metadata);
      } catch (error) {
        if (error instanceof MetadataValidationError) {
          // Log the actual metadata validation error for debugging
          this.logger.log(
            `Metadata validation failed for ${from} → ${to}: ${error.message}`,
            "error",
          );
          // Re-throw the original error so we know what's missing
          throw error;
        }
        throw error;
      }
    }

    // Add more validation as needed
  }

  private findTransitionCodon(
    state: ST.HankweaveState,
    data: { runId: RunId; codonId: CodonId },
  ): ST.CodonExecution | undefined {
    return state.runs
      .find((run) => run.runId === data.runId)
      ?.codons.find((codon) => codon.codonId === data.codonId);
  }

  private applyTransition(state: ST.HankweaveState, event: ST.StateTransition): ST.HankweaveState {
    // Deep clone state to ensure immutability
    const newState = JSON.parse(JSON.stringify(state)) as ST.HankweaveState;

    switch (event.type) {
      case "RunStarted": {
        const newRun: ST.Run = {
          runId: event.data.runId,
          runFolder: event.data.runFolder,
          gitBranch: event.data.gitBranch,
          startingConditions: event.data.startingConditions,
          codons: [],
          status: "running",
          startTime: new Date().toISOString(),
          serverPid: event.data.serverPid,
        };

        newState.runs.unshift(newRun); // Add to beginning
        newState.currentRunId = event.data.runId;
        break;
      }

      case "InitialCheckpointSet": {
        newState.initialCheckpoint = event.data.sha;
        break;
      }

      case "RunCompleted": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (run) {
          run.status = "completed";
          run.endTime = new Date().toISOString();
        }
        newState.currentRunId = null;
        break;
      }

      case "RunFailed": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (run) {
          run.status = "failed";
          run.endTime = new Date().toISOString();
        }
        newState.currentRunId = null;
        break;
      }

      case "RunCrashed": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (run) {
          run.status = "crashed";
          run.endTime = event.data.detectedAt;

          // Mark any running codon as failed
          const runningCodon = run.codons.find((p) => !isTerminalCodonStatus(p.status));
          if (runningCodon) {
            const isRunningStatus = runningCodon.status === "running";
            const runningCodonTyped = isRunningStatus ? (runningCodon as ST.RunningCodon) : null;

            const failedCodon: ST.FailedCodon = {
              codonId: runningCodon.codonId,
              startTime: runningCodon.startTime,
              status: "failed",
              endTime: event.data.detectedAt,
              failedDuring: runningCodon.status as
                | "preparing"
                | "starting"
                | "initializing"
                | "running",
              exitCode: -1,
              failureReason: {
                type: "unknown",
                retriable: false,
                message: "Server crashed",
              },
              partialCost: "currentCost" in runningCodon ? runningCodon.currentCost : 0,
              partialTokens:
                "currentTokens" in runningCodon
                  ? runningCodon.currentTokens
                  : {
                      inputTokens: 0,
                      outputTokens: 0,
                      cacheCreationTokens: 0,
                      cacheReadTokens: 0,
                    },
              sentinels: runningCodonTyped?.sentinels
                ? {
                    executed: runningCodonTyped.sentinels.loaded,
                    totalCost: runningCodonTyped.sentinels.totalCost,
                  }
                : undefined,
            };

            // Copy optional fields if they exist
            if ("rigSetupCheckpoint" in runningCodon) {
              failedCodon.rigSetupCheckpoint = runningCodon.rigSetupCheckpoint;
            }
            if ("claudePid" in runningCodon) {
              failedCodon.claudePid = runningCodon.claudePid;
            }
            if ("claudeSessionId" in runningCodon) {
              failedCodon.claudeSessionId = runningCodon.claudeSessionId;
            }
            if ("claudeLogPath" in runningCodon) {
              failedCodon.claudeLogPath = runningCodon.claudeLogPath;
            }
            if ("previousSessionId" in runningCodon) {
              failedCodon.previousSessionId = runningCodon.previousSessionId;
            }
            if ("loopContext" in runningCodon) {
              failedCodon.loopContext = runningCodon.loopContext;
            }

            // Replace the codon
            const codonIndex = run.codons.indexOf(runningCodon);
            run.codons[codonIndex] = failedCodon;
          }
        }
        break;
      }

      case "CodonStarted": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (run) {
          const newCodon: ST.PreparingCodon = {
            codonId: event.data.codonId,
            startTime: new Date().toISOString(),
            status: "preparing",
            loopContext: event.data.loopContext,
          };
          run.codons.push(newCodon);
        }
        break;
      }

      case "CodonTransitioned": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        // Find the codon by ID, preferring non-terminal codons
        let codonIndex = -1;

        // First, try to find a non-terminal codon with this ID
        for (let i = run.codons.length - 1; i >= 0; i--) {
          const codon = run.codons[i];
          if (codon.codonId === event.data.codonId && !isTerminalCodonStatus(codon.status)) {
            codonIndex = i;
            break;
          }
        }

        // If no non-terminal codon found, look for any codon with this ID and matching status
        if (codonIndex === -1) {
          codonIndex = run.codons.findIndex(
            (p) => p.codonId === event.data.codonId && p.status === event.data.from,
          );
        }

        if (codonIndex === -1) break;

        // Validate the transition is valid from current state
        const currentCodon = run.codons[codonIndex];
        if (currentCodon.status !== event.data.from) {
          throw new InvalidTransitionError(currentCodon.status, event.data.to);
        }

        const { to, metadata } = event.data;

        // Apply transition based on target status
        switch (to) {
          case "starting": {
            const startingCodon: ST.StartingCodon = {
              codonId: currentCodon.codonId,
              startTime: currentCodon.startTime,
              status: "starting",
              rigSetupCheckpoint: metadata?.checkpointSha,
              loopContext: currentCodon.loopContext,
            };
            run.codons[codonIndex] = startingCodon;
            break;
          }

          case "initializing": {
            // TypeScript knows metadata is valid from validateTransition
            if (
              !metadata ||
              typeof metadata !== "object" ||
              !("claudePid" in metadata) ||
              !("claudeLogPath" in metadata)
            ) {
              throw new Error("Invalid metadata for initializing transition");
            }
            const initializingCodon: ST.InitializingCodon = {
              ...(currentCodon as ST.StartingCodon),
              status: "initializing",
              claudePid: metadata.claudePid as number,
              claudeLogPath: metadata.claudeLogPath as string,
              previousSessionId:
                metadata.previousSessionId ||
                ("previousSessionId" in currentCodon ? currentCodon.previousSessionId : undefined),
            };
            run.codons[codonIndex] = initializingCodon;
            break;
          }

          case "running": {
            // TypeScript knows metadata is valid from validateTransition
            if (!metadata || typeof metadata !== "object" || !("claudeSessionId" in metadata)) {
              throw new Error("Invalid metadata for running transition");
            }
            const runningCodon: ST.RunningCodon = {
              ...(currentCodon as ST.InitializingCodon),
              status: "running",
              claudeSessionId: metadata.claudeSessionId as ST.SessionId,
              currentCost: 0,
              currentTokens: {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
              },
              assistantMessageCount: 0,
              extensionCount: 0,
            };
            run.codons[codonIndex] = runningCodon;
            break;
          }

          case "completing-sentinels": {
            // Transition from running to completing-sentinels
            const runningCodon = currentCodon as ST.RunningCodon;
            const completingCodon: ST.CompletingSentinelsCodon = {
              ...runningCodon,
              status: "completing-sentinels",
            };
            run.codons[codonIndex] = completingCodon;
            break;
          }

          case "completed": {
            // Can transition from running OR completing-sentinels
            // validateTransition already rejected a blank SHA; this narrows the
            // type and keeps the reducer honest if it is ever called directly.
            if (!metadata?.checkpointSha) {
              throw new Error("Invalid metadata for completed transition: checkpointSha required");
            }
            const sourceCodon = currentCodon as ST.RunningCodon | ST.CompletingSentinelsCodon;
            const completedCodon: ST.CompletedCodon = {
              ...sourceCodon,
              status: "completed",
              endTime: new Date().toISOString(),
              exitCode: 0,
              finalCost: "currentCost" in currentCodon ? currentCodon.currentCost : 0,
              finalTokens:
                "currentTokens" in currentCodon
                  ? currentCodon.currentTokens
                  : {
                      inputTokens: 0,
                      outputTokens: 0,
                      cacheCreationTokens: 0,
                      cacheReadTokens: 0,
                    },
              resultMessageReceived: metadata?.resultMessageReceived || false,
              completionCheckpoint: metadata.checkpointSha,
              sentinels: sourceCodon.sentinels
                ? {
                    executed: sourceCodon.sentinels.loaded,
                    totalCost: sourceCodon.sentinels.totalCost,
                  }
                : undefined,
              budgetExceeded: metadata?.budgetExceeded,
            };
            run.codons[codonIndex] = completedCodon;
            break;
          }

          case "failed": {
            // TypeScript knows metadata is valid from validateTransition
            if (
              !metadata ||
              typeof metadata !== "object" ||
              !("failedDuring" in metadata) ||
              !("exitCode" in metadata) ||
              !("failureReason" in metadata)
            ) {
              throw new Error("Invalid metadata for failed transition");
            }
            // Can transition from running OR completing-sentinels
            const sourceCodon =
              currentCodon.status === "running" || currentCodon.status === "completing-sentinels"
                ? (currentCodon as ST.RunningCodon | ST.CompletingSentinelsCodon)
                : null;
            const failedCodon: ST.FailedCodon = {
              codonId: currentCodon.codonId,
              startTime: currentCodon.startTime,
              status: "failed",
              endTime: new Date().toISOString(),
              failedDuring: metadata.failedDuring as
                | "preparing"
                | "starting"
                | "initializing"
                | "running"
                | "completing-sentinels",
              exitCode: metadata.exitCode as number,
              failureReason: metadata.failureReason as ST.FailureReason,
              partialCost: "currentCost" in currentCodon ? currentCodon.currentCost : 0,
              partialTokens:
                "currentTokens" in currentCodon
                  ? currentCodon.currentTokens
                  : {
                      inputTokens: 0,
                      outputTokens: 0,
                      cacheCreationTokens: 0,
                      cacheReadTokens: 0,
                    },
              // Rename sentinels.loaded → sentinels.executed for terminal state
              sentinels: sourceCodon?.sentinels
                ? {
                    executed: sourceCodon.sentinels.loaded,
                    totalCost: sourceCodon.sentinels.totalCost,
                  }
                : undefined,
            };

            // Copy optional fields if they exist
            if ("rigSetupCheckpoint" in currentCodon) {
              failedCodon.rigSetupCheckpoint = currentCodon.rigSetupCheckpoint;
            }
            if ("claudePid" in currentCodon) {
              failedCodon.claudePid = currentCodon.claudePid;
            }
            if ("claudeSessionId" in currentCodon) {
              failedCodon.claudeSessionId = currentCodon.claudeSessionId;
            }
            if ("claudeLogPath" in currentCodon) {
              failedCodon.claudeLogPath = currentCodon.claudeLogPath;
            }
            if ("previousSessionId" in currentCodon) {
              failedCodon.previousSessionId = currentCodon.previousSessionId;
            }
            if ("loopContext" in currentCodon) {
              failedCodon.loopContext = currentCodon.loopContext;
            }
            // Copy extensionCount if codon reached running state with extensions
            if ("extensionCount" in currentCodon) {
              failedCodon.extensionCount = (currentCodon as ST.RunningCodon).extensionCount;
            }
            if (metadata?.checkpointSha) {
              failedCodon.errorCheckpoint = metadata.checkpointSha;
            }

            run.codons[codonIndex] = failedCodon;
            break;
          }

          case "skipped": {
            // TypeScript knows metadata is valid from validateTransition
            if (!metadata || typeof metadata !== "object" || !("skippedDuring" in metadata)) {
              throw new Error("Invalid metadata for skipped transition");
            }
            // Can transition from running OR completing-sentinels
            const sourceCodon =
              currentCodon.status === "running" || currentCodon.status === "completing-sentinels"
                ? (currentCodon as ST.RunningCodon | ST.CompletingSentinelsCodon)
                : null;
            const skippedCodon: ST.SkippedCodon = {
              codonId: currentCodon.codonId,
              startTime: currentCodon.startTime,
              status: "skipped",
              endTime: new Date().toISOString(),
              skippedDuring: metadata.skippedDuring as
                | "preparing"
                | "starting"
                | "initializing"
                | "running",
              // Preserve any accumulated costs and tokens from when the codon was running
              partialCost: "currentCost" in currentCodon ? currentCodon.currentCost : 0,
              partialTokens:
                "currentTokens" in currentCodon
                  ? currentCodon.currentTokens
                  : {
                      inputTokens: 0,
                      outputTokens: 0,
                      cacheCreationTokens: 0,
                      cacheReadTokens: 0,
                    },
              sentinels: sourceCodon?.sentinels
                ? {
                    executed: sourceCodon.sentinels.loaded,
                    totalCost: sourceCodon.sentinels.totalCost,
                  }
                : undefined,
            };

            // Copy optional fields if they exist
            if ("rigSetupCheckpoint" in currentCodon) {
              skippedCodon.rigSetupCheckpoint = currentCodon.rigSetupCheckpoint;
            }
            if ("claudePid" in currentCodon) {
              skippedCodon.claudePid = currentCodon.claudePid;
            }
            if ("claudeSessionId" in currentCodon) {
              skippedCodon.claudeSessionId = currentCodon.claudeSessionId;
            }
            if ("claudeLogPath" in currentCodon) {
              skippedCodon.claudeLogPath = currentCodon.claudeLogPath;
            }
            if ("previousSessionId" in currentCodon) {
              skippedCodon.previousSessionId = currentCodon.previousSessionId;
            }
            if ("loopContext" in currentCodon) {
              skippedCodon.loopContext = currentCodon.loopContext;
            }
            if ("assistantMessageCount" in currentCodon) {
              skippedCodon.assistantMessageCount = currentCodon.assistantMessageCount;
            }
            if (metadata?.checkpointSha) {
              skippedCodon.skipCheckpoint = metadata.checkpointSha;
            }

            run.codons[codonIndex] = skippedCodon;
            break;
          }
        }
        break;
      }

      case "CostsUpdated": {
        const codon = this.findTransitionCodon(newState, event.data);
        if (!codon) break;

        if (codon.status === "running") {
          codon.currentCost = event.data.cost;
          codon.currentTokens = event.data.tokens;
        }
        break;
      }

      case "CostsIncremented": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        // Find the most recent running codon with this ID
        const codon = run.codons
          .slice()
          .reverse()
          .find((c) => c.codonId === event.data.codonId && c.status === "running");

        if (codon && codon.status === "running") {
          codon.currentCost += event.data.costDelta;
          codon.currentTokens.inputTokens += event.data.tokensDelta.inputTokens;
          codon.currentTokens.outputTokens += event.data.tokensDelta.outputTokens;
          codon.currentTokens.cacheCreationTokens += event.data.tokensDelta.cacheCreationTokens;
          codon.currentTokens.cacheReadTokens += event.data.tokensDelta.cacheReadTokens;
        }
        break;
      }

      case "AssistantMessageCountUpdated": {
        const codon = this.findTransitionCodon(newState, event.data);
        if (!codon) break;

        if (codon.status === "running") {
          codon.assistantMessageCount = event.data.newCount;
        } else if (codon.status === "skipped" && "assistantMessageCount" in codon) {
          // Update count for skipped codons that were running before skip
          codon.assistantMessageCount = event.data.newCount;
        }
        break;
      }

      case "ExtensionCountUpdated": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        const codon = run.codons.find((c) => c.codonId === event.data.codonId);
        if (codon && codon.status === "running") {
          (codon as ST.RunningCodon).extensionCount = event.data.extensionCount;
        }
        break;
      }

      case "CheckpointCreated": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        // Retries append attempts. The checkpoint belongs to the latest one,
        // including when an earlier attempt failed before it had a checkpoint.
        const codon = run.codons
          .slice()
          .reverse()
          .find((p) => p.codonId === event.data.codonId);
        if (!codon) break;

        switch (event.data.checkpointType) {
          case "rig-setup":
            if (
              "rigSetupCheckpoint" in codon ||
              codon.status === "preparing" ||
              codon.status === "starting"
            ) {
              (
                codon as ST.PreparingCodon & {
                  rigSetupCheckpoint?: string;
                }
              ).rigSetupCheckpoint = event.data.sha;
            }
            break;
          case "completed":
            if (codon.status === "completed") {
              codon.completionCheckpoint = event.data.sha;
            }
            break;
          case "error":
            if (codon.status === "failed") {
              codon.errorCheckpoint = event.data.sha;
            }
            break;
          case "skipped":
            if (codon.status === "skipped") {
              codon.skipCheckpoint = event.data.sha;
            }
            break;
        }
        break;
      }

      case "CodonFinalCostSet": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        const codon = run.codons
          .slice()
          .reverse()
          .find((c) => c.codonId === event.data.codonId && c.status === "running");

        if (codon && codon.status === "running") {
          codon.currentCost = event.data.finalCost;
          codon.currentTokens = event.data.finalTokens;
        }
        break;
      }

      case "SentinelStatesUpdated": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        // Find the codon - can be starting, initializing, running, or completing-sentinels
        // We need to support starting/initializing because the first update happens right after loading
        const codon = run.codons
          .slice()
          .reverse()
          .find(
            (p) =>
              p.codonId === event.data.codonId &&
              (p.status === "starting" ||
                p.status === "initializing" ||
                p.status === "running" ||
                p.status === "completing-sentinels"),
          );

        if (
          codon &&
          (codon.status === "starting" ||
            codon.status === "initializing" ||
            codon.status === "running" ||
            codon.status === "completing-sentinels")
        ) {
          codon.sentinels = {
            loaded: event.data.sentinelStates,
            totalCost: event.data.totalCost,
          };
        }
        break;
      }
    }

    return newState;
  }

  async save(): Promise<void> {
    try {
      // Create backup of current state
      if (fs.existsSync(this.statePath)) {
        await fs.promises.copyFile(this.statePath, this.stateBackupPath);
      }

      // Write to temp file first
      const tempPath = `${this.statePath}.tmp`;
      await fs.promises.writeFile(tempPath, JSON.stringify(this.state, null, 2), "utf-8");
      await renameWithRetry(tempPath, this.statePath, { logger: this.logger });
    } catch (error) {
      throw new PersistenceError("save", error as Error);
    }
  }

  async detectCrashedRuns(): Promise<void> {
    // Find any runs with status="running"
    for (const run of this.state.runs) {
      if (run.status === "running" && run.runId !== this.state.currentRunId) {
        // Check if the server is still running
        try {
          process.kill(run.serverPid, 0); // Signal 0 = check if process exists
        } catch {
          // Process doesn't exist - mark as crashed
          const lastCodon = run.codons[run.codons.length - 1];
          const lastCodonStatus = lastCodon?.status || ("unknown" as ST.CodonStatus);

          this.transition({
            type: "RunCrashed",
            data: {
              runId: run.runId,
              detectedAt: new Date().toISOString(),
              lastCodonStatus,
            },
          });
        }
      }
    }
  }

  async recover(): Promise<ST.RecoveryResult> {
    // Simple recovery - just start fresh
    this.state = {
      runs: [],
      currentRunId: null,
      executionPlan: [],
    };

    await this.save();

    return {
      success: true,
      method: "fresh",
      dataLoss: true,
      message: "Started with fresh state",
    };
  }

  /** Await a queued transition and propagate its persistence failure to recovery. */
  private async transitionAndWait(event: ST.StateTransition): Promise<void> {
    let failure: Error | undefined;
    const onError = (result: { event: ST.StateTransition; error: Error }) => {
      if (result.event === event) failure = result.error;
    };
    this.on("transitionError", onError);
    try {
      this.transition(event);
      await this.waitForPendingTransitions();
      if (failure) throw failure;
    } finally {
      this.off("transitionError", onError);
    }
  }

  async waitForPendingTransitions(): Promise<void> {
    while (this.isProcessing || this.transitionQueue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
