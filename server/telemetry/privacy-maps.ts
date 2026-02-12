/**
 * Privacy Maps - Type-safe privacy enforcement
 *
 * When someone adds a field to any Hankweave type, TypeScript should fail
 * until they decide how to handle it for telemetry.
 *
 * Each privacy map declares how each field of a source type is handled.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import type { Codon, CodonConfig, Loop } from "../config.js";
import type {
  CodonExecution,
  CompletedCodon,
  FailedCodon,
  Run,
  SentinelState,
  SkippedCodon,
} from "../types/state-types.js";
import type {
  PrivacyPreservingCodon,
  PrivacyPreservingCodonExecution,
  PrivacyPreservingHank,
  PrivacyPreservingHankItem,
  PrivacyPreservingLoop,
  PrivacyPreservingRun,
  PrivacyPreservingTokenUsage,
} from "./telemetry-types.js";

// =============================================================================
// Hashing Utilities
// =============================================================================

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// =============================================================================
// Duration Buckets
// =============================================================================

export function getDurationBucket(ms: number): "<1m" | "1-5m" | "5-15m" | "15m+" {
  const minutes = ms / 60000;
  if (minutes < 1) return "<1m";
  if (minutes < 5) return "1-5m";
  if (minutes < 15) return "5-15m";
  return "15m+";
}

function computeDuration(startTime: string, endTime?: string): number | undefined {
  if (!endTime) return undefined;
  return new Date(endTime).getTime() - new Date(startTime).getTime();
}

// =============================================================================
// Privacy-Preserving Transformations
// =============================================================================

/**
 * Transform a prompt field to privacy-preserving form.
 * Content → size, paths → counts.
 */
function toPrivacyPreservingPrompt(codon: Codon): PrivacyPreservingCodon["prompt"] {
  if (codon.promptText) {
    return {
      source: "inline",
      length_chars: codon.promptText.length,
    };
  }

  if (codon.promptFile) {
    const files = Array.isArray(codon.promptFile) ? codon.promptFile : [codon.promptFile];

    const totalBytes = files.reduce((sum, f) => {
      try {
        return sum + fs.statSync(f).size;
      } catch {
        return sum;
      }
    }, 0);

    return {
      source: files.length > 1 ? "files" : "file",
      file_count: files.length,
      total_size_bytes: totalBytes,
    };
  }

  return { source: "inline", length_chars: 0 };
}

/**
 * Transform a system prompt field to privacy-preserving form.
 */
function toPrivacyPreservingSystemPrompt(codon: Codon): PrivacyPreservingCodon["system_prompt"] {
  if (codon.appendSystemPromptText) {
    return {
      source: "inline",
      length_chars: codon.appendSystemPromptText.length,
    };
  }

  if (codon.appendSystemPromptFile) {
    const files = Array.isArray(codon.appendSystemPromptFile)
      ? codon.appendSystemPromptFile
      : [codon.appendSystemPromptFile];

    const totalBytes = files.reduce((sum, f) => {
      try {
        return sum + fs.statSync(f).size;
      } catch {
        return sum;
      }
    }, 0);

    return {
      source: files.length > 1 ? "files" : "file",
      file_count: files.length,
      total_size_bytes: totalBytes,
    };
  }

  return null;
}

/**
 * Transform rig setup to privacy-preserving form.
 */
function toPrivacyPreservingRigSetup(
  rigSetup: Codon["rigSetup"],
): PrivacyPreservingCodon["rig_setup"] {
  if (!rigSetup || rigSetup.length === 0) return null;

  return {
    operation_count: rigSetup.length,
    operations: rigSetup.map((item) => ({
      type: "command" in item ? "command" : "copy",
    })),
  };
}

/**
 * Transform sentinels to privacy-preserving form.
 */
function toPrivacyPreservingSentinels(
  sentinels: Codon["sentinels"],
): PrivacyPreservingCodon["sentinels"] {
  if (!sentinels || sentinels.length === 0) return null;

  return {
    count: sentinels.length,
    sources: sentinels.map((s) => (typeof s.sentinelConfig === "string" ? "file" : "inline")),
  };
}

/**
 * Transform a Codon config to privacy-preserving form.
 */
export function toPrivacyPreservingCodon(codon: Codon, position: number): PrivacyPreservingCodon {
  return {
    type: "codon",
    position,
    id_hash: sha256(codon.id),
    prompt: toPrivacyPreservingPrompt(codon),
    system_prompt: toPrivacyPreservingSystemPrompt(codon),
    description: codon.description
      ? { present: true, length_chars: codon.description.length }
      : null,
    model: typeof codon.model === "string" ? codon.model : codon.model.name || codon.model.modelId,
    continuation_mode: codon.continuationMode || "fresh",
    checkpointed_files: codon.checkpointedFiles
      ? { pattern_count: codon.checkpointedFiles.length }
      : null,
    env_vars: codon.env ? { count: Object.keys(codon.env).length } : null,
    rig_setup: toPrivacyPreservingRigSetup(codon.rigSetup),
    sentinels: toPrivacyPreservingSentinels(codon.sentinels),
    output_files: codon.outputFiles ? { count: codon.outputFiles.length } : null,
  };
}

/**
 * Transform a Loop config to privacy-preserving form.
 */
export function toPrivacyPreservingLoop(loop: Loop, position: number): PrivacyPreservingLoop {
  return {
    type: "loop",
    position,
    id_hash: sha256(loop.id),
    description: loop.description ? { present: true, length_chars: loop.description.length } : null,
    termination: {
      type: loop.terminateOn.type,
      limit: loop.terminateOn.type === "iterationLimit" ? loop.terminateOn.limit : undefined,
    },
    codons: loop.codons.map((c, i) => toPrivacyPreservingCodon(c, i)),
  };
}

/**
 * Transform a hank item (codon or loop) to privacy-preserving form.
 */
function toPrivacyPreservingHankItem(
  item: CodonConfig,
  position: number,
): PrivacyPreservingHankItem {
  if ("type" in item && item.type === "loop") {
    return toPrivacyPreservingLoop(item as Loop, position);
  }
  return toPrivacyPreservingCodon(item as Codon, position);
}

/**
 * Compute aggregate summary from privacy-preserving items.
 */
function computeHankSummary(items: PrivacyPreservingHankItem[]): PrivacyPreservingHank["summary"] {
  let totalCodons = 0;
  let loopCount = 0;
  const modelsUsed = new Set<string>();
  let hasSentinels = false;
  let hasCheckpointing = false;
  let hasRigSetup = false;
  let hasCustomEnv = false;
  let totalPromptChars = 0;
  let totalPromptFiles = 0;
  let totalPromptFileBytes = 0;

  function processCodon(codon: PrivacyPreservingCodon): void {
    totalCodons++;
    modelsUsed.add(codon.model);
    if (codon.sentinels) hasSentinels = true;
    if (codon.checkpointed_files) hasCheckpointing = true;
    if (codon.rig_setup) hasRigSetup = true;
    if (codon.env_vars) hasCustomEnv = true;
    if (codon.prompt.length_chars) totalPromptChars += codon.prompt.length_chars;
    if (codon.prompt.file_count) totalPromptFiles += codon.prompt.file_count;
    if (codon.prompt.total_size_bytes) totalPromptFileBytes += codon.prompt.total_size_bytes;
  }

  for (const item of items) {
    if (item.type === "loop") {
      loopCount++;
      for (const codon of item.codons) {
        processCodon(codon);
      }
    } else {
      processCodon(item);
    }
  }

  return {
    total_items: items.length,
    total_codons: totalCodons,
    loop_count: loopCount,
    models_used: [...modelsUsed],
    has_sentinels: hasSentinels,
    has_checkpointing: hasCheckpointing,
    has_rig_setup: hasRigSetup,
    has_custom_env: hasCustomEnv,
    total_prompt_chars: totalPromptChars,
    total_prompt_files: totalPromptFiles,
    total_prompt_file_bytes: totalPromptFileBytes,
  };
}

/**
 * Transform a full hank to privacy-preserving form.
 */
export function toPrivacyPreservingHank(hank: CodonConfig[]): PrivacyPreservingHank {
  const hankHash = sha256(JSON.stringify(hank));
  const items = hank.map((item, i) => toPrivacyPreservingHankItem(item, i));

  return {
    hank_hash: hankHash,
    items,
    summary: computeHankSummary(items),
  };
}

// =============================================================================
// Run State Transformations
// =============================================================================

function toPrivacyPreservingTokens(
  tokens:
    | {
        inputTokens: number;
        outputTokens: number;
        cacheCreationTokens: number;
        cacheReadTokens: number;
      }
    | undefined,
): PrivacyPreservingTokenUsage {
  if (!tokens) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    };
  }
  return {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_creation_tokens: tokens.cacheCreationTokens,
    cache_read_tokens: tokens.cacheReadTokens,
  };
}

function toPrivacyPreservingSentinelMetrics(
  sentinels:
    | {
        loaded?: SentinelState[];
        executed?: SentinelState[];
        totalCost: number;
      }
    | undefined,
): PrivacyPreservingCodonExecution["sentinels"] {
  if (!sentinels) return null;

  const states = sentinels.loaded || sentinels.executed || [];

  return {
    count: states.length,
    total_cost_usd: sentinels.totalCost,
    total_triggers: states.reduce((sum, s) => sum + s.totalTriggers, 0),
    total_llm_calls: states.reduce((sum, s) => sum + s.llmCallCount, 0),
    failed_llm_calls: states.reduce((sum, s) => sum + s.failedLLMCalls, 0),
    models_used: [...new Set(states.map((s) => s.model))],
  };
}

/**
 * Transform a CodonExecution to privacy-preserving form.
 */
export function toPrivacyPreservingCodonExecution(
  codon: CodonExecution,
  position: number,
): PrivacyPreservingCodonExecution {
  const base: PrivacyPreservingCodonExecution = {
    position,
    codon_id_hash: sha256(codon.codonId),
    loop_context: codon.loopContext
      ? {
          loop_id_hash: sha256(codon.loopContext.loopId),
          iteration: codon.loopContext.iteration,
          position_in_loop: codon.loopContext.codonIndexInLoop,
        }
      : null,
    status: codon.status,
    start_time: codon.startTime,
    tokens: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
    },
    cost_usd: 0,
    sentinels: null,
    has_rig_setup_checkpoint: false,
    has_completion_checkpoint: false,
    has_error_checkpoint: false,
    has_skip_checkpoint: false,
  };

  if (codon.status === "completed") {
    const c = codon as CompletedCodon;
    return {
      ...base,
      end_time: c.endTime,
      duration_ms: computeDuration(c.startTime, c.endTime),
      tokens: toPrivacyPreservingTokens(c.finalTokens),
      cost_usd: c.finalCost,
      sentinels: toPrivacyPreservingSentinelMetrics(c.sentinels),
      has_rig_setup_checkpoint: !!c.rigSetupCheckpoint,
      has_completion_checkpoint: !!c.completionCheckpoint,
    };
  }

  if (codon.status === "failed") {
    const c = codon as FailedCodon;
    return {
      ...base,
      end_time: c.endTime,
      duration_ms: computeDuration(c.startTime, c.endTime),
      failure: {
        failed_during: c.failedDuring,
        failure_type: c.failureReason.type,
        retriable: c.failureReason.retriable,
        exit_code: c.exitCode,
      },
      tokens: toPrivacyPreservingTokens(c.partialTokens),
      cost_usd: c.partialCost,
      sentinels: toPrivacyPreservingSentinelMetrics(c.sentinels),
      has_rig_setup_checkpoint: !!c.rigSetupCheckpoint,
      has_error_checkpoint: !!c.errorCheckpoint,
    };
  }

  if (codon.status === "skipped") {
    const c = codon as SkippedCodon;
    return {
      ...base,
      end_time: c.endTime,
      duration_ms: computeDuration(c.startTime, c.endTime),
      skipped: {
        skipped_during: c.skippedDuring,
      },
      tokens: toPrivacyPreservingTokens(c.partialTokens),
      cost_usd: c.partialCost,
      sentinels: toPrivacyPreservingSentinelMetrics(c.sentinels),
      has_rig_setup_checkpoint: !!c.rigSetupCheckpoint,
      has_skip_checkpoint: !!c.skipCheckpoint,
    };
  }

  // For non-terminal states (running, preparing, etc.)
  if (codon.status === "running" || codon.status === "completing-sentinels") {
    const c = codon as {
      currentCost: number;
      currentTokens: typeof base.tokens extends PrivacyPreservingTokenUsage
        ? {
            inputTokens: number;
            outputTokens: number;
            cacheCreationTokens: number;
            cacheReadTokens: number;
          }
        : never;
      sentinels?: { loaded?: SentinelState[]; totalCost: number };
      rigSetupCheckpoint?: string;
    };
    return {
      ...base,
      tokens: toPrivacyPreservingTokens(c.currentTokens),
      cost_usd: c.currentCost,
      sentinels: toPrivacyPreservingSentinelMetrics(c.sentinels),
      has_rig_setup_checkpoint: !!c.rigSetupCheckpoint,
    };
  }

  return base;
}

/**
 * Transform a Run to privacy-preserving form.
 */
export function toPrivacyPreservingRun(run: Run): PrivacyPreservingRun {
  const durationMs = computeDuration(run.startTime, run.endTime);
  const codons = run.codons.map((c, i) => toPrivacyPreservingCodonExecution(c, i));

  // Compute aggregate metrics
  let totalCostUsd = 0;
  let codonsCompleted = 0;
  let codonsFailed = 0;
  let codonsSkipped = 0;
  let totalCheckpoints = 0;
  let totalSentinelsLoaded = 0;
  let totalSentinelCostUsd = 0;
  let totalSentinelTriggers = 0;
  let totalSentinelLlmCalls = 0;
  const totalTokens: PrivacyPreservingTokenUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
  };

  for (const c of codons) {
    totalCostUsd += c.cost_usd;
    totalTokens.input_tokens += c.tokens.input_tokens;
    totalTokens.output_tokens += c.tokens.output_tokens;
    totalTokens.cache_creation_tokens += c.tokens.cache_creation_tokens;
    totalTokens.cache_read_tokens += c.tokens.cache_read_tokens;

    if (c.status === "completed") codonsCompleted++;
    if (c.status === "failed") codonsFailed++;
    if (c.status === "skipped") codonsSkipped++;

    if (c.has_rig_setup_checkpoint) totalCheckpoints++;
    if (c.has_completion_checkpoint) totalCheckpoints++;
    if (c.has_error_checkpoint) totalCheckpoints++;
    if (c.has_skip_checkpoint) totalCheckpoints++;

    if (c.sentinels) {
      totalSentinelsLoaded += c.sentinels.count;
      totalSentinelCostUsd += c.sentinels.total_cost_usd;
      totalSentinelTriggers += c.sentinels.total_triggers;
      totalSentinelLlmCalls += c.sentinels.total_llm_calls;
    }
  }

  return {
    run_id_hash: sha256(run.runId),
    start_time: run.startTime,
    end_time: run.endTime,
    duration_ms: durationMs,
    duration_bucket: getDurationBucket(durationMs || 0),
    status: run.status,
    starting_conditions: {
      type: run.startingConditions.type,
      reason:
        run.startingConditions.type === "continuation" ? run.startingConditions.reason : undefined,
    },
    codons,
    metrics: {
      total_codons: codons.length,
      codons_completed: codonsCompleted,
      codons_failed: codonsFailed,
      codons_skipped: codonsSkipped,
      total_cost_usd: totalCostUsd,
      total_tokens: totalTokens,
      total_checkpoints: totalCheckpoints,
      total_rollbacks: 0, // TODO: track rollbacks
      total_sentinels_loaded: totalSentinelsLoaded,
      total_sentinel_cost_usd: totalSentinelCostUsd,
      total_sentinel_triggers: totalSentinelTriggers,
      total_sentinel_llm_calls: totalSentinelLlmCalls,
    },
  };
}
