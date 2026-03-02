import fs from "node:fs";
import path from "node:path";
import type { HankweaveState } from "./types/state-types.js";
import type { Logger } from "./utils.js";

/** Codon runner replay configuration derived from replay manifest. */
export interface ReplayCodonConfig {
  sourceLogPath: string;
  replaySpeed: number;
}

/** Internal manifest describing a replay execution directory. */
interface ReplayManifest {
  codonLogPaths: Map<string, string>;
  state: HankweaveState;
}

const DEFAULT_REPLAY_SPEED = 5;

/**
 * Load and validate a replay execution directory.
 *
 * Reads state.json to discover runs and codon log paths, then maps each codon's
 * claudeLogPath to an absolute path.
 */
function loadReplayManifest(replayDir: string, runId?: string): ReplayManifest {
  const statePath = path.join(replayDir, ".hankweave", "state.json");

  if (!fs.existsSync(statePath)) {
    throw new Error(`Replay state file not found: ${statePath}`);
  }

  const stateContent = fs.readFileSync(statePath, "utf-8");
  const state: HankweaveState = JSON.parse(stateContent);

  if (!state.runs || state.runs.length === 0) {
    throw new Error(`No runs found in replay state: ${statePath}`);
  }

  const targetRun = runId ? state.runs.find((r) => r.runId === runId) : state.runs[0];

  if (!targetRun) {
    throw new Error(
      runId ? `Run ${runId} not found in replay state` : "No runs found in replay state",
    );
  }

  const codonLogPaths = new Map<string, string>();
  const missingLogs: string[] = [];

  for (const codon of targetRun.codons) {
    if ("claudeLogPath" in codon && codon.claudeLogPath) {
      // Normalize separators so replays are portable across OSes.
      const normalizedLogPath = codon.claudeLogPath.replace(/\\/g, path.sep);
      const absoluteLogPath = path.resolve(replayDir, normalizedLogPath);

      if (!fs.existsSync(absoluteLogPath)) {
        missingLogs.push(`${codon.codonId}: ${absoluteLogPath}`);
        continue;
      }

      codonLogPaths.set(codon.codonId, absoluteLogPath);
    }
  }

  if (missingLogs.length > 0) {
    throw new Error(
      `[ReplayLoader] ${missingLogs.length} codon log file(s) not found:\n  ${missingLogs.join("\n  ")}\n` +
        `Replay mode requires all codon logs to be present.`,
    );
  }

  if (codonLogPaths.size === 0) {
    throw new Error(
      `No valid codon log files found in replay directory for run ${targetRun.runId}`,
    );
  }

  return { codonLogPaths, state };
}

/**
 * Encapsulates replay-mode decisions and manifest-backed lookups.
 */
export class Replay {
  private manifest?: ReplayManifest;

  constructor(private readonly replayDir?: string) {}

  /**
   * Initialize replay startup state.
   * Loads replay manifest and resets runtime state when replay mode is enabled.
   */
  async initializeForStartup(params: { executionPath: string; logger: Logger }): Promise<void> {
    if (!this.replayDir) return;

    params.logger.log(`[REPLAY] Loading replay manifest from ${params.executionPath}`);
    this.manifest = loadReplayManifest(params.executionPath);
    params.logger.log(
      `[REPLAY] Loaded manifest with ${this.manifest.codonLogPaths.size} codon log(s)`,
    );
  }

  isReplayMode(): boolean {
    return !!this.replayDir;
  }

  /** Replay mode always starts a fresh run. */
  shouldForceFreshRunOnStartup(): boolean {
    return this.isReplayMode();
  }

  /**
   * Normal startup recovery path is only active outside replay mode.
   */
  shouldUseNormalStartupRecoveryPath(params: {
    threadFailed: boolean;
    hasCurrentRun: boolean;
  }): boolean {
    return !this.isReplayMode() && !params.threadFailed && !params.hasCurrentRun;
  }

  /**
   * Resolve replay source log for the target runtime codon.
   * Falls back to base codon id for compatibility with older runs.
   */
  resolveCodonConfig(runtimeCodonId: string, baseCodonId: string): ReplayCodonConfig | undefined {
    if (!this.isReplayMode()) return undefined;
    if (!this.manifest) {
      throw new Error(
        "[REPLAY] Replay is not initialized. Call initializeForStartup() before codon execution.",
      );
    }

    const sourceLogPath =
      this.manifest.codonLogPaths.get(runtimeCodonId) ||
      this.manifest.codonLogPaths.get(baseCodonId);

    if (!sourceLogPath) {
      throw new Error(
        `[REPLAY] No log found for codon ${runtimeCodonId} (base: ${baseCodonId}). ` +
          `Available logs: [${[...this.manifest.codonLogPaths.keys()].join(", ")}]. ` +
          `Replay mode requires all codon logs to be present — cannot fall back to real execution.`,
      );
    }

    return { sourceLogPath, replaySpeed: DEFAULT_REPLAY_SPEED };
  }

  /** Replay mode skips rig setup because replay copies a post-setup execution directory. */
  shouldSkipRigSetup(): boolean {
    return this.isReplayMode();
  }

  /** Replay mode skips sentinel loading to avoid new nondeterministic/costly LLM calls. */
  shouldSkipSentinels(): boolean {
    return this.isReplayMode();
  }
}
