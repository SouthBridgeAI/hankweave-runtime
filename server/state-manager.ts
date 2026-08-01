// server/state-manager.ts
import fs from "node:fs";
import path from "node:path";
import type { CheckpointGit } from "./checkpoint-git.js";
import { normalizeLegacyProviderModelInfo } from "./config-validation/model-validator.js";
import { type ExecutionCodonEntry, ExecutionPlanner } from "./execution-planner.js";
import { analyzeExecutionThread, type ExecutionThread } from "./execution-thread.js";
import { LlmProviderRegistry } from "./llm/llm-provider-registry.js";
import { MetadataValidationError, validateTransitionMetadata } from "./state-transition-guards.js";
import { type StateManagerEvents, TypedEventEmitter } from "./typed-event-emitter.js";
import { type CodonId, CodonId as CodonIdConstructor, type RunId } from "./types/branded-types.js";
import type * as ST from "./types/state-types.js";
import { CodonTransitions, getCodonCost, isTerminalCodonStatus } from "./types/state-types.js";
import type { CodonConfig } from "./types/types.js";
import { type Logger, renameWithRetry } from "./utils.js";

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
 * If a loop terminated, includes the loop ID and its archiveOnSuccess paths.
 */
export interface ExpandIterationResult {
  loopTerminated?: {
    loopId: string;
    archiveOnSuccess?: string[];
    completedIterations: number;
  };
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
    private readonly hankweaveDir: string,
    logger: Logger,
    private readonly codonConfigs?: CodonConfig[],
  ) {
    super();
    this.logger = logger;
    this.statePath = path.join(hankweaveDir, "state.json");
    this.stateBackupPath = path.join(hankweaveDir, "state.json.bak");

    // Initialize execution planner
    this.planner = new ExecutionPlanner(codonConfigs || []);

    // Initialize empty state
    this.state = {
      runs: [],
      currentRunId: null,
      executionPlan: [],
    };
  }

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
    } else {
      // Loop terminated (plan didn't grow)
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

        // Return loop termination info for archiveOnSuccess processing
        result = {
          loopTerminated: {
            loopId: loopContext.loopId,
            archiveOnSuccess: loopConfig.archiveOnSuccess,
            completedIterations,
          },
        };
      }
    }

    this.planner.validatePlan(newPlan);
    this.state.executionPlan = newPlan;
    await this.save();

    return result;
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
    const runsDir = path.join(this.hankweaveDir, "runs");
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
      // Check if the codon exists and is completed
      const codon = run.codons.find((c) => c.codonId === afterCodon);
      return codon?.status === "completed" || false;
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

  getRunById(runId: RunId): ST.Run | null {
    return this.state.runs.find((r) => r.runId === runId) || null;
  }

  // Add reference to CheckpointGit for git operations
  private checkpointGit?: CheckpointGit;

  /**
   * Set the checkpoint git instance for git operations.
   * Called by HankweaveRuntime after initializing CheckpointGit.
   */
  setCheckpointGit(checkpointGit: CheckpointGit): void {
    this.checkpointGit = checkpointGit;
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
    // Get checkpoint data if requested and available
    const checkpointData =
      includeCheckpointValidation && this.checkpointGit?.isInitialized()
        ? await this.getCheckpointDataMap()
        : undefined;

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
  private async getCheckpointDataMap(): Promise<
    Map<
      string,
      {
        message: string;
        timestamp: string;
        branch: string;
      }
    >
  > {
    const checkpoints = await this.getAllCheckpoints();
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
   * @returns Array of checkpoint information ordered by timestamp (newest first), or null if git unavailable
   */
  async getAllCheckpoints(): Promise<Array<{
    sha: string;
    message: string;
    timestamp: string;
    branch: string;
  }> | null> {
    if (!this.checkpointGit?.isInitialized()) {
      return null;
    }

    try {
      return await this.checkpointGit.getAllCheckpoints();
    } catch (error) {
      this.logger.log(`Failed to get all checkpoints: ${error}`, "error");
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
              completionCheckpoint: metadata?.checkpointSha || "",
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
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        const codon = run.codons.find((c) => c.codonId === event.data.codonId);
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
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        const codon = run.codons.find((c) => c.codonId === event.data.codonId);
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

        const codon = run.codons.find((p) => p.codonId === event.data.codonId);
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

  async waitForPendingTransitions(): Promise<void> {
    while (this.isProcessing || this.transitionQueue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
