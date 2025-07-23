// server/state-manager.ts
import fs from "node:fs";
import path from "node:path";
import { PhaseId, RunId } from "./branded-types.js";
import type { CheckpointGit } from "./checkpoint-git.js";
import { analyzeExecutionThread, type ExecutionThread } from "./execution-thread.js";
import { MetadataValidationError, validateTransitionMetadata } from "./state-transition-guards.js";
import type * as ST from "./state-types.js";
import { getPhaseCost, isTerminalPhaseStatus, PhaseTransitions } from "./state-types.js";
import { type StateManagerEvents, TypedEventEmitter } from "./typed-event-emitter.js";
import type { PhaseConfig } from "./types.js";
import type { Logger } from "./utils.js";

// Error types for state management
export class InvalidTransitionError extends Error {
  constructor(from: ST.PhaseStatus, to: ST.PhaseStatus) {
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

export class StateManager extends TypedEventEmitter<StateManagerEvents> implements ST.StateManager {
  private state: ST.LangtonState;
  private readonly statePath: string;
  private readonly stateBackupPath: string;
  private readonly logger: Logger;

  // Enhanced transition queue system
  private transitionQueue: ST.StateTransition[] = [];
  private isProcessing = false;

  // Running cost tallies for performance
  private costCache = {
    total: 0,
    currentRun: 0,
    lastUpdated: null as string | null,
  };

  constructor(
    private readonly langtonDir: string,
    logger: Logger,
    private readonly phaseConfigs?: PhaseConfig[],
  ) {
    super();
    this.logger = logger;
    this.statePath = path.join(langtonDir, "state.json");
    this.stateBackupPath = path.join(langtonDir, "state.json.bak");

    // Initialize empty state
    this.state = {
      runs: [],
      currentRunId: null,
    };
  }

  async initialize(): Promise<void> {
    try {
      if (fs.existsSync(this.statePath)) {
        const content = await fs.promises.readFile(this.statePath, "utf-8");
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

        this.state = parsedState;
        this.rebuildCostCache();
        this.logger.log("Loaded existing state file");
      } else {
        this.logger.log("No state file found, starting fresh");
      }

      // Detect any crashed runs
      await this.detectCrashedRuns();
    } catch (error) {
      this.logger.log(`Failed to load state: ${error}`, "error");

      // Try backup
      if (fs.existsSync(this.stateBackupPath)) {
        try {
          const content = await fs.promises.readFile(this.stateBackupPath, "utf-8");
          const parsedState = JSON.parse(content);

          // Validate backup too
          const validation = this.validate(parsedState);
          if (validation.valid) {
            this.state = parsedState;
            this.rebuildCostCache();
            this.logger.log("Recovered from backup state file");
          } else {
            this.logger.log("Backup also invalid, starting fresh", "error");
          }
        } catch {
          this.logger.log("Backup also corrupted, starting fresh", "error");
        }
      }
    }
  }

  getState(): Readonly<ST.LangtonState> {
    return this.state;
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
        const _oldState = this.state;
        const newState = this.applyTransition(this.state, event);
        this.state = newState;

        // Update cost cache if needed
        this.updateCostCache(event);

        await this.save();

        // Log transition for debugging
        await this.logTransitionEvent(event);

        // Emit event AFTER state is persisted
        this.emit("stateChanged", event);
        this.logger.log(`State transition: ${event.type}`);

        // Emit specific events for important transitions
        if (event.type === "PhaseTransitioned" && event.data.to === "running") {
          this.emit("phaseRunning", {
            runId: event.data.runId,
            phaseId: event.data.phaseId,
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
      event.type === "PhaseFinalCostSet"
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

  private rebuildCostCache(): void {
    this.costCache.total = this.state.runs.reduce((total, run) => {
      return (
        total +
        run.phases.reduce((runTotal, phase) => {
          return runTotal + getPhaseCost(phase);
        }, 0)
      );
    }, 0);

    const currentRun = this.getCurrentRun();
    if (currentRun) {
      this.costCache.currentRun = currentRun.phases.reduce((total, phase) => {
        return total + getPhaseCost(phase);
      }, 0);
    }
  }

  // Event logging for debugging
  private async logTransitionEvent(event: ST.StateTransition): Promise<void> {
    const eventLog = path.join(this.langtonDir, "events.jsonl");
    const logEntry = {
      timestamp: new Date().toISOString(),
      serverPid: process.pid,
      event,
      resultingState: {
        currentRunId: this.state.currentRunId,
        runCount: this.state.runs.length,
        totalCost: this.costCache.total,
        currentRunCost: this.costCache.currentRun,
      },
    };

    try {
      await fs.promises.appendFile(eventLog, `${JSON.stringify(logEntry)}\n`);
    } catch (error) {
      // Don't fail transitions due to logging errors
      this.logger.log(`Failed to log event: ${error}`, "debug");
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
    const typedState = state as ST.LangtonState;
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
    const runsDir = path.join(this.langtonDir, "runs");
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

  private isValidStateStructure(state: unknown): state is ST.LangtonState {
    // Basic type checking - can be expanded
    if (!state || typeof state !== "object") return false;
    const s = state as Record<string, unknown>;
    return Array.isArray(s.runs) && (s.currentRunId === null || typeof s.currentRunId === "string");
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

  getCurrentlyRunningPhase(): ST.PhaseExecution | null {
    const currentRun = this.getCurrentRun();
    if (!currentRun) return null;

    // Find the last non-terminal phase
    for (let i = currentRun.phases.length - 1; i >= 0; i--) {
      const phase = currentRun.phases[i];
      if (!isTerminalPhaseStatus(phase.status)) {
        return phase;
      }
    }

    return null;
  }

  getPhaseInCurrentRun(phaseId: PhaseId): ST.PhaseExecution | null {
    const currentRun = this.getCurrentRun();
    if (!currentRun) return null;

    return currentRun.phases.find((p) => p.phaseId === phaseId) || null;
  }

  /**
   * Get the next phase that should be executed based on current state.
   * Uses the execution thread to determine where we are in the workflow.
   *
   * @returns PhaseId of next phase to execute, or null if all phases are complete
   */
  async getNextPhaseToExecute(): Promise<PhaseId | null> {
    // Use the execution thread for a cleaner implementation
    const thread = await this.getExecutionThread();

    this.logger.log(
      `[getNextPhaseToExecute] Execution thread determined next phase: ${
        thread.nextPhaseId || "none"
      }`,
      "debug",
    );

    return thread.nextPhaseId || null;
  }

  getRun(runId: RunId): ST.Run | null {
    return this.state.runs.find((r) => r.runId === runId) || null;
  }

  getLastSuccessfulPhase(phaseId: PhaseId): { run: ST.Run; phase: ST.CompletedPhase } | null {
    // Search all runs in reverse chronological order
    for (const run of this.state.runs) {
      for (const phase of run.phases) {
        if (phase.phaseId === phaseId && phase.status === "completed") {
          return { run, phase };
        }
      }
    }
    return null;
  }

  getPhaseHistory(phaseId: PhaseId): Array<{ run: ST.Run; phase: ST.PhaseExecution }> {
    const history: Array<{ run: ST.Run; phase: ST.PhaseExecution }> = [];

    for (const run of this.state.runs) {
      for (const phase of run.phases) {
        if (phase.phaseId === phaseId) {
          history.push({ run, phase });
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
        for (const phase of run.phases) {
          total += getPhaseCost(phase);
        }
      }
    }

    return total;
  }

  canContinueFrom(runId: RunId, afterPhase: PhaseId | null): boolean {
    const run = this.getRun(runId);
    if (!run) return false;

    if (afterPhase) {
      // Check if the phase exists and is completed
      const phase = run.phases.find((p) => p.phaseId === afterPhase);
      return phase?.status === "completed" || false;
    }

    // Can continue from beginning of any run
    return true;
  }

  getCheckpointForContinuation(runId: RunId, afterPhase: PhaseId | null): string | null {
    const run = this.getRun(runId);
    if (!run) return null;

    if (!afterPhase) {
      // Continue from beginning - use first phase's workspace setup checkpoint if available
      const firstPhase = run.phases[0];
      if (
        firstPhase &&
        "workspaceSetupCheckpoint" in firstPhase &&
        firstPhase.workspaceSetupCheckpoint
      ) {
        return firstPhase.workspaceSetupCheckpoint;
      }
      return null;
    }

    // Find the specified phase
    const phase = run.phases.find((p) => p.phaseId === afterPhase);
    if (!phase || phase.status !== "completed") return null;

    return phase.completionCheckpoint;
  }

  getRunById(runId: RunId): ST.Run | null {
    return this.state.runs.find((r) => r.runId === runId) || null;
  }

  /**
   * Get the latest phase execution across all runs.
   * This is the core function for determining "where we are" in the workflow.
   *
   * Algorithm:
   * 1. First check for any running (non-terminal) phase - that's always the latest
   * 2. If no running phase, find the most recent terminal phase that exists in git
   * 3. Fallback to most recent phase if git is unavailable
   * 4. Determine next phase to execute based on current position
   *
   * @returns Latest phase info with execution planning details, or null if no phases exist
   */
  async getLatestPhase(): Promise<ST.LatestPhaseInfo | null> {
    // Step 1: Fast path - check for any running phase in current run
    // A running phase is always the "latest" regardless of timestamps
    const currentRun = this.getCurrentRun();
    if (currentRun) {
      // Search from end of phases array (most recent first)
      const runningPhase = currentRun.phases
        .slice()
        .reverse()
        .find((phase) => !isTerminalPhaseStatus(phase.status));

      if (runningPhase) {
        this.logger.log(
          `[getLatestPhase] Found running phase: ${runningPhase.phaseId} (${runningPhase.status})`,
          "debug",
        );
        // For running phases, we can't start a new phase yet
        return {
          phase: runningPhase,
          runId: currentRun.runId,
          status: runningPhase.status,
          nextPhaseId: null,
          continueInCurrentRun: true,
        };
      }
    }

    // Step 2: Check current run for continuation logic
    if (currentRun && currentRun.startingConditions.type === "continuation") {
      // Handle continuation run that hasn't started any phases yet
      if (currentRun.phases.length === 0) {
        const { afterPhase, checkpointSha } = currentRun.startingConditions.source;

        // Determine next phase based on continuation point
        const nextPhaseId = this.determineNextPhaseForContinuation(afterPhase, checkpointSha);

        this.logger.log(
          `[getLatestPhase] Continuation run with no phases. After phase: ${afterPhase}, next: ${nextPhaseId}`,
          "debug",
        );

        // Log more details about the synthetic response
        this.logger.log(
          `[getLatestPhase] Creating synthetic latest phase info for continuation run:` +
            `\n  - Run ID: ${currentRun.runId}` +
            `\n  - Source run: ${currentRun.startingConditions.source.runId}` +
            `\n  - After phase: ${afterPhase || "(from beginning)"}` +
            `\n  - Checkpoint SHA: ${checkpointSha.substring(0, 7)}` +
            `\n  - Next phase to execute: ${nextPhaseId || "(none - all complete)"}` +
            `\n  - Continue in current run: true`,
          "debug",
        );

        // Return a synthetic latest phase info based on continuation source
        return {
          phase: {
            phaseId: afterPhase || PhaseId(""),
            status: "completed",
          } as ST.PhaseExecution,
          runId: currentRun.runId,
          status: "completed",
          nextPhaseId,
          continueInCurrentRun: true,
        };
      }
    }

    // Step 3: Get checkpoint validation set from git (if available)
    let validCheckpoints: Set<string> | null = null;
    if (this.checkpointGit?.isInitialized()) {
      try {
        validCheckpoints = await this.checkpointGit.getAllCheckpointShas();
        this.logger.log(
          `[getLatestPhase] Got ${validCheckpoints.size} valid checkpoints from git`,
          "debug",
        );
      } catch (error) {
        this.logger.log(`[getLatestPhase] Failed to get checkpoints from git: ${error}`, "info");
      }
    }

    // Step 4: Get all terminal phases sorted by end time (latest first)
    const terminalPhases = this.state.runs
      .flatMap((run) =>
        run.phases
          .filter((phase) => isTerminalPhaseStatus(phase.status) && "endTime" in phase)
          .map((phase) => ({
            phase,
            run,
            runId: run.runId,
            status: phase.status,
            endTime: (phase as ST.CompletedPhase | ST.FailedPhase | ST.SkippedPhase).endTime,
            checkpoints: (() => {
              // Get all checkpoint SHAs for this phase in priority order
              const checkpoints: string[] = [];

              // Completed checkpoint has highest priority
              if (phase.status === "completed" && phase.completionCheckpoint) {
                checkpoints.push(phase.completionCheckpoint);
              }

              // Error checkpoint
              if (
                phase.status === "failed" &&
                "errorCheckpoint" in phase &&
                phase.errorCheckpoint
              ) {
                checkpoints.push(phase.errorCheckpoint);
              }

              // Skip checkpoint
              if (phase.status === "skipped" && "skipCheckpoint" in phase && phase.skipCheckpoint) {
                checkpoints.push(phase.skipCheckpoint);
              }

              // Workspace setup checkpoint
              if ("workspaceSetupCheckpoint" in phase && phase.workspaceSetupCheckpoint) {
                checkpoints.push(phase.workspaceSetupCheckpoint);
              }

              return checkpoints;
            })(),
          })),
      )
      .sort((a, b) => {
        // Sort by endTime descending (latest first)
        const timeDiff = new Date(b.endTime).getTime() - new Date(a.endTime).getTime();
        if (timeDiff !== 0) return timeDiff;

        // Tiebreaker: Use phase ID comparison (later phases come after earlier ones)
        return b.phase.phaseId.localeCompare(a.phase.phaseId);
      });

    if (terminalPhases.length === 0) {
      this.logger.log("[getLatestPhase] No terminal phases found", "debug");
      // No phases executed yet - start from the beginning
      const firstPhaseId = this.phaseConfigs?.[0]?.id ? PhaseId(this.phaseConfigs[0].id) : null;
      return firstPhaseId
        ? {
            phase: {
              phaseId: PhaseId(""),
              status: "completed",
            } as ST.PhaseExecution,
            runId: currentRun?.runId || RunId(""),
            status: "completed",
            nextPhaseId: firstPhaseId,
            continueInCurrentRun: !!currentRun,
          }
        : null;
    }

    // Step 5: Find the latest phase that exists in git (or just return latest if no git)
    let latestValidPhase: (typeof terminalPhases)[0] | null = null;

    if (!validCheckpoints) {
      // No git validation available - just use the most recent phase
      this.logger.log(
        "[getLatestPhase] No checkpoint validation available, using latest phase by timestamp",
        "debug",
      );
      latestValidPhase = terminalPhases[0];
    } else {
      // Find first phase with a valid checkpoint in git
      for (const phaseInfo of terminalPhases) {
        const validCheckpoint = phaseInfo.checkpoints.find((sha) => validCheckpoints.has(sha));
        if (validCheckpoint) {
          this.logger.log(
            `[getLatestPhase] Found valid phase: ${phaseInfo.phase.phaseId} ` +
              `(${phaseInfo.status}) ended at ${phaseInfo.endTime} ` +
              `with checkpoint ${validCheckpoint.substring(0, 7)}`,
            "debug",
          );
          latestValidPhase = phaseInfo;
          break;
        }
      }
    }

    if (!latestValidPhase) {
      this.logger.log(
        "[getLatestPhase] No phases with valid checkpoints found - possible after aggressive rollback",
        "info",
      );
      return null;
    }

    // Step 6: Determine next phase and whether to continue in current run
    const { nextPhaseId, continueInCurrentRun } = this.determineNextPhaseAndRun(
      latestValidPhase.phase,
      latestValidPhase.run,
      currentRun,
    );

    return {
      phase: latestValidPhase.phase,
      runId: latestValidPhase.runId,
      status: latestValidPhase.status,
      nextPhaseId,
      continueInCurrentRun,
    };
  }

  // Add reference to CheckpointGit for git operations
  private checkpointGit?: CheckpointGit;

  /**
   * Set the checkpoint git instance for git operations.
   * Called by LangtonServer after initializing CheckpointGit.
   */
  setCheckpointGit(checkpointGit: CheckpointGit): void {
    this.checkpointGit = checkpointGit;
  }

  /**
   * Get the execution thread for the current state.
   * This provides a unified view of phase execution across all runs.
   *
   * @param targetRunId - Optional run ID to start from (defaults to latest)
   * @param includeCheckpointValidation - Whether to validate checkpoints against git
   * @returns Complete execution thread with all metadata
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

    return analyzeExecutionThread(
      this.state,
      this.phaseConfigs || [],
      checkpointData,
      targetRunId,
      this.logger,
    );
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
    if (event.type === "PhaseTransitioned") {
      const { from, to, metadata } = event.data;
      const validTransitions = PhaseTransitions[from];

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

  private applyTransition(state: ST.LangtonState, event: ST.StateTransition): ST.LangtonState {
    // Deep clone state to ensure immutability
    const newState = JSON.parse(JSON.stringify(state)) as ST.LangtonState;

    switch (event.type) {
      case "RunStarted": {
        const newRun: ST.Run = {
          runId: event.data.runId,
          runFolder: event.data.runFolder,
          gitBranch: event.data.gitBranch,
          startingConditions: event.data.startingConditions,
          phases: [],
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

          // Mark any running phase as failed
          const runningPhase = run.phases.find((p) => !isTerminalPhaseStatus(p.status));
          if (runningPhase) {
            const failedPhase: ST.FailedPhase = {
              ...runningPhase,
              status: "failed",
              endTime: event.data.detectedAt,
              failedDuring: runningPhase.status as
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
              partialCost: "currentCost" in runningPhase ? runningPhase.currentCost : 0,
              partialTokens:
                "currentTokens" in runningPhase
                  ? runningPhase.currentTokens
                  : {
                      inputTokens: 0,
                      outputTokens: 0,
                      cacheCreationTokens: 0,
                      cacheReadTokens: 0,
                    },
            };

            // Replace the phase
            const phaseIndex = run.phases.indexOf(runningPhase);
            run.phases[phaseIndex] = failedPhase;
          }
        }
        break;
      }

      case "PhaseStarted": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (run) {
          const newPhase: ST.PreparingPhase = {
            phaseId: event.data.phaseId,
            startTime: new Date().toISOString(),
            status: "preparing",
          };
          run.phases.push(newPhase);
        }
        break;
      }

      case "PhaseTransitioned": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        // Find the phase by ID, preferring non-terminal phases
        let phaseIndex = -1;

        // First, try to find a non-terminal phase with this ID
        for (let i = run.phases.length - 1; i >= 0; i--) {
          const phase = run.phases[i];
          if (phase.phaseId === event.data.phaseId && !isTerminalPhaseStatus(phase.status)) {
            phaseIndex = i;
            break;
          }
        }

        // If no non-terminal phase found, look for any phase with this ID and matching status
        if (phaseIndex === -1) {
          phaseIndex = run.phases.findIndex(
            (p) => p.phaseId === event.data.phaseId && p.status === event.data.from,
          );
        }

        if (phaseIndex === -1) break;

        // Validate the transition is valid from current state
        const currentPhase = run.phases[phaseIndex];
        if (currentPhase.status !== event.data.from) {
          throw new InvalidTransitionError(currentPhase.status, event.data.to);
        }

        const { to, metadata } = event.data;

        // Apply transition based on target status
        switch (to) {
          case "starting": {
            const startingPhase: ST.StartingPhase = {
              ...currentPhase,
              status: "starting",
              workspaceSetupCheckpoint: metadata?.checkpointSha,
            };
            run.phases[phaseIndex] = startingPhase;
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
            const initializingPhase: ST.InitializingPhase = {
              ...(currentPhase as ST.StartingPhase),
              status: "initializing",
              claudePid: metadata.claudePid as number,
              claudeLogPath: metadata.claudeLogPath as string,
              previousSessionId:
                metadata.previousSessionId ||
                ("previousSessionId" in currentPhase ? currentPhase.previousSessionId : undefined),
            };
            run.phases[phaseIndex] = initializingPhase;
            break;
          }

          case "running": {
            // TypeScript knows metadata is valid from validateTransition
            if (!metadata || typeof metadata !== "object" || !("claudeSessionId" in metadata)) {
              throw new Error("Invalid metadata for running transition");
            }
            const runningPhase: ST.RunningPhase = {
              ...(currentPhase as ST.InitializingPhase),
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
            };
            run.phases[phaseIndex] = runningPhase;
            break;
          }

          case "completed": {
            const completedPhase: ST.CompletedPhase = {
              ...(currentPhase as ST.RunningPhase),
              status: "completed",
              endTime: new Date().toISOString(),
              exitCode: 0,
              finalCost: "currentCost" in currentPhase ? currentPhase.currentCost : 0,
              finalTokens:
                "currentTokens" in currentPhase
                  ? currentPhase.currentTokens
                  : {
                      inputTokens: 0,
                      outputTokens: 0,
                      cacheCreationTokens: 0,
                      cacheReadTokens: 0,
                    },
              resultMessageReceived: metadata?.resultMessageReceived || false,
              completionCheckpoint: metadata?.checkpointSha || "",
            };
            run.phases[phaseIndex] = completedPhase;
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
            const failedPhase: ST.FailedPhase = {
              phaseId: currentPhase.phaseId,
              startTime: currentPhase.startTime,
              status: "failed",
              endTime: new Date().toISOString(),
              failedDuring: metadata.failedDuring as
                | "preparing"
                | "starting"
                | "initializing"
                | "running",
              exitCode: metadata.exitCode as number,
              failureReason: metadata.failureReason as ST.FailureReason,
              partialCost: "currentCost" in currentPhase ? currentPhase.currentCost : 0,
              partialTokens:
                "currentTokens" in currentPhase
                  ? currentPhase.currentTokens
                  : {
                      inputTokens: 0,
                      outputTokens: 0,
                      cacheCreationTokens: 0,
                      cacheReadTokens: 0,
                    },
            };

            // Copy optional fields if they exist
            if ("workspaceSetupCheckpoint" in currentPhase) {
              failedPhase.workspaceSetupCheckpoint = currentPhase.workspaceSetupCheckpoint;
            }
            if ("claudePid" in currentPhase) {
              failedPhase.claudePid = currentPhase.claudePid;
            }
            if ("claudeSessionId" in currentPhase) {
              failedPhase.claudeSessionId = currentPhase.claudeSessionId;
            }
            if ("claudeLogPath" in currentPhase) {
              failedPhase.claudeLogPath = currentPhase.claudeLogPath;
            }
            if ("previousSessionId" in currentPhase) {
              failedPhase.previousSessionId = currentPhase.previousSessionId;
            }
            if (metadata?.checkpointSha) {
              failedPhase.errorCheckpoint = metadata.checkpointSha;
            }

            run.phases[phaseIndex] = failedPhase;
            break;
          }

          case "skipped": {
            // TypeScript knows metadata is valid from validateTransition
            if (!metadata || typeof metadata !== "object" || !("skippedDuring" in metadata)) {
              throw new Error("Invalid metadata for skipped transition");
            }
            const skippedPhase: ST.SkippedPhase = {
              phaseId: currentPhase.phaseId,
              startTime: currentPhase.startTime,
              status: "skipped",
              endTime: new Date().toISOString(),
              skippedDuring: metadata.skippedDuring as
                | "preparing"
                | "starting"
                | "initializing"
                | "running",
              // Preserve any accumulated costs and tokens from when the phase was running
              partialCost: "currentCost" in currentPhase ? currentPhase.currentCost : 0,
              partialTokens:
                "currentTokens" in currentPhase
                  ? currentPhase.currentTokens
                  : {
                      inputTokens: 0,
                      outputTokens: 0,
                      cacheCreationTokens: 0,
                      cacheReadTokens: 0,
                    },
            };

            // Copy optional fields if they exist
            if ("workspaceSetupCheckpoint" in currentPhase) {
              skippedPhase.workspaceSetupCheckpoint = currentPhase.workspaceSetupCheckpoint;
            }
            if ("claudePid" in currentPhase) {
              skippedPhase.claudePid = currentPhase.claudePid;
            }
            if ("claudeSessionId" in currentPhase) {
              skippedPhase.claudeSessionId = currentPhase.claudeSessionId;
            }
            if ("claudeLogPath" in currentPhase) {
              skippedPhase.claudeLogPath = currentPhase.claudeLogPath;
            }
            if ("previousSessionId" in currentPhase) {
              skippedPhase.previousSessionId = currentPhase.previousSessionId;
            }
            if ("assistantMessageCount" in currentPhase) {
              skippedPhase.assistantMessageCount = currentPhase.assistantMessageCount;
            }
            if (metadata?.checkpointSha) {
              skippedPhase.skipCheckpoint = metadata.checkpointSha;
            }

            run.phases[phaseIndex] = skippedPhase;
            break;
          }
        }
        break;
      }

      case "CostsUpdated": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        const phase = run.phases.find((p) => p.phaseId === event.data.phaseId);
        if (!phase) break;

        if (phase.status === "running") {
          phase.currentCost = event.data.cost;
          phase.currentTokens = event.data.tokens;
        }
        break;
      }

      case "CostsIncremented": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        // Find the most recent running phase with this ID
        const phase = run.phases
          .slice()
          .reverse()
          .find((p) => p.phaseId === event.data.phaseId && p.status === "running");

        if (phase && phase.status === "running") {
          phase.currentCost += event.data.costDelta;
          phase.currentTokens.inputTokens += event.data.tokensDelta.inputTokens;
          phase.currentTokens.outputTokens += event.data.tokensDelta.outputTokens;
          phase.currentTokens.cacheCreationTokens += event.data.tokensDelta.cacheCreationTokens;
          phase.currentTokens.cacheReadTokens += event.data.tokensDelta.cacheReadTokens;
        }
        break;
      }

      case "AssistantMessageCountUpdated": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        const phase = run.phases.find((p) => p.phaseId === event.data.phaseId);
        if (!phase) break;

        if (phase.status === "running") {
          phase.assistantMessageCount = event.data.newCount;
        } else if (phase.status === "skipped" && "assistantMessageCount" in phase) {
          // Update count for skipped phases that were running before skip
          phase.assistantMessageCount = event.data.newCount;
        }
        break;
      }

      case "CheckpointCreated": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        const phase = run.phases.find((p) => p.phaseId === event.data.phaseId);
        if (!phase) break;

        switch (event.data.checkpointType) {
          case "workspace-setup":
            if (
              "workspaceSetupCheckpoint" in phase ||
              phase.status === "preparing" ||
              phase.status === "starting"
            ) {
              (
                phase as ST.PreparingPhase & {
                  workspaceSetupCheckpoint?: string;
                }
              ).workspaceSetupCheckpoint = event.data.sha;
            }
            break;
          case "completed":
            if (phase.status === "completed") {
              phase.completionCheckpoint = event.data.sha;
            }
            break;
          case "error":
            if (phase.status === "failed") {
              phase.errorCheckpoint = event.data.sha;
            }
            break;
          case "skipped":
            if (phase.status === "skipped") {
              phase.skipCheckpoint = event.data.sha;
            }
            break;
        }
        break;
      }

      case "PhaseFinalCostSet": {
        const run = newState.runs.find((r) => r.runId === event.data.runId);
        if (!run) break;

        const phase = run.phases
          .slice()
          .reverse()
          .find((p) => p.phaseId === event.data.phaseId && p.status === "running");

        if (phase && phase.status === "running") {
          phase.currentCost = event.data.finalCost;
          phase.currentTokens = event.data.finalTokens;
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

      // Atomic rename
      await fs.promises.rename(tempPath, this.statePath);
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
          const lastPhase = run.phases[run.phases.length - 1];
          const lastPhaseStatus = lastPhase?.status || ("unknown" as ST.PhaseStatus);

          this.transition({
            type: "RunCrashed",
            data: {
              runId: run.runId,
              detectedAt: new Date().toISOString(),
              lastPhaseStatus,
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

  /**
   * Determine the next phase to execute for a continuation run.
   *
   * @param afterPhase - The phase after which to continue (null means from beginning)
   * @param checkpointSha - The checkpoint SHA we're continuing from
   * @returns The next phase ID to execute, or null if all phases are complete
   */
  private determineNextPhaseForContinuation(
    afterPhase: PhaseId | null,
    checkpointSha: string,
  ): PhaseId | null {
    if (!this.phaseConfigs || this.phaseConfigs.length === 0) {
      return null;
    }

    // If afterPhase is null, we're continuing from the beginning
    if (!afterPhase) {
      return PhaseId(this.phaseConfigs[0].id);
    }

    // Find the index of afterPhase
    const afterPhaseIndex = this.phaseConfigs.findIndex((p) => p.id === afterPhase);

    if (afterPhaseIndex === -1) {
      this.logger.log(
        `[determineNextPhaseForContinuation] Phase ${afterPhase} not found in configs`,
        "error",
      );
      return null;
    }

    // Check if we need to determine checkpoint type
    const currentRunConditions = this.getCurrentRun()?.startingConditions;
    const sourceRun =
      currentRunConditions?.type === "continuation"
        ? this.getRunById(currentRunConditions.source.runId)
        : null;

    if (sourceRun && checkpointSha) {
      // Find the phase in the source run
      const sourcePhase = sourceRun.phases.find((p) => p.phaseId === afterPhase);

      // Check if this is a workspace-setup checkpoint
      if (
        sourcePhase &&
        "workspaceSetupCheckpoint" in sourcePhase &&
        sourcePhase.workspaceSetupCheckpoint === checkpointSha
      ) {
        // Workspace setup checkpoint - re-run the same phase
        return afterPhase;
      }
    }

    // For completed/error/skipped checkpoints, continue to next phase
    if (afterPhaseIndex >= this.phaseConfigs.length - 1) {
      // No more phases
      return null;
    }

    return PhaseId(this.phaseConfigs[afterPhaseIndex + 1].id);
  }

  /**
   * Determine the next phase and whether to continue in the current run.
   *
   * @param latestPhase - The latest phase that was executed
   * @param latestRun - The run containing the latest phase
   * @param currentRun - The current active run (if any)
   * @returns Object with nextPhaseId and continueInCurrentRun
   */
  private determineNextPhaseAndRun(
    latestPhase: ST.PhaseExecution,
    latestRun: ST.Run,
    currentRun: ST.Run | null,
  ): { nextPhaseId: PhaseId | null; continueInCurrentRun: boolean } {
    if (!this.phaseConfigs || this.phaseConfigs.length === 0) {
      return { nextPhaseId: null, continueInCurrentRun: false };
    }

    // Find the index of the latest phase
    const latestPhaseIndex = this.phaseConfigs.findIndex((p) => p.id === latestPhase.phaseId);

    if (latestPhaseIndex === -1) {
      this.logger.log(
        `[determineNextPhaseAndRun] Phase ${latestPhase.phaseId} not found in configs`,
        "error",
      );
      return { nextPhaseId: null, continueInCurrentRun: false };
    }

    // Check if we've reached the end
    if (latestPhaseIndex >= this.phaseConfigs.length - 1) {
      return { nextPhaseId: null, continueInCurrentRun: false };
    }

    // Determine next phase
    const nextPhaseId = PhaseId(this.phaseConfigs[latestPhaseIndex + 1].id);

    // Determine if we can continue in current run
    if (!currentRun) {
      // No current run - need a new one
      return { nextPhaseId, continueInCurrentRun: false };
    }

    // If the latest phase is in the current run, we can continue
    if (latestRun.runId === currentRun.runId) {
      return { nextPhaseId, continueInCurrentRun: true };
    }

    // If current run is a continuation of the run containing latest phase, we can continue
    if (
      currentRun.startingConditions.type === "continuation" &&
      currentRun.startingConditions.source.runId === latestRun.runId
    ) {
      return { nextPhaseId, continueInCurrentRun: true };
    }

    // Otherwise, we need a new run
    return { nextPhaseId, continueInCurrentRun: false };
  }
}
