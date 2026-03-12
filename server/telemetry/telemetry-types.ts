/**
 * Telemetry Types and Schemas
 *
 * Privacy-preserving types for telemetry events.
 * All types follow the principle: content → size, paths → counts, IDs → hashes.
 */

import { z } from "zod";

// =============================================================================
// Schema Version
// =============================================================================

export const TELEMETRY_SCHEMA_VERSION = 1;

// =============================================================================
// Privacy-Preserving Types
// =============================================================================

export interface PrivacyPreservingCodon {
  type: "codon";
  position: number;
  id_hash: string;

  prompt: {
    source: "inline" | "file" | "files";
    length_chars?: number;
    file_count?: number;
    total_size_bytes?: number;
  };

  system_prompt: {
    source: "inline" | "file" | "files";
    length_chars?: number;
    file_count?: number;
    total_size_bytes?: number;
  } | null;

  description: {
    present: boolean;
    length_chars: number;
  } | null;

  model: string;
  continuation_mode: "fresh" | "continue-previous";

  checkpointed_files: {
    pattern_count: number;
  } | null;

  env_vars: {
    count: number;
  } | null;

  rig_setup: {
    operation_count: number;
    operations: Array<{
      type: "command" | "copy";
    }>;
  } | null;

  sentinels: {
    count: number;
    sources: Array<"inline" | "file">;
  } | null;

  output_files: {
    count: number;
  } | null;
}

export interface PrivacyPreservingLoop {
  type: "loop";
  position: number;
  id_hash: string;

  description: {
    present: boolean;
    length_chars: number;
  } | null;

  termination: {
    type: "iterationLimit" | "contextExceeded";
    limit?: number;
  };

  codons: PrivacyPreservingCodon[];
}

export type PrivacyPreservingHankItem = PrivacyPreservingCodon | PrivacyPreservingLoop;

export interface PrivacyPreservingHank {
  hank_hash: string;
  items: PrivacyPreservingHankItem[];
  summary: {
    total_items: number;
    total_codons: number;
    loop_count: number;
    models_used: string[];
    has_sentinels: boolean;
    has_checkpointing: boolean;
    has_rig_setup: boolean;
    has_custom_env: boolean;
    total_prompt_chars: number;
    total_prompt_files: number;
    total_prompt_file_bytes: number;
  };
}

export interface PrivacyPreservingTokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}

export interface PrivacyPreservingCodonExecution {
  position: number;
  codon_id_hash: string;
  loop_context: {
    loop_id_hash: string;
    iteration: number;
    position_in_loop: number;
  } | null;
  status: string;
  start_time: string;
  end_time?: string;
  duration_ms?: number;

  failure?: {
    failed_during: string;
    failure_type: string;
    retriable: boolean;
    exit_code?: number;
  };

  skipped?: {
    skipped_during: string;
  };

  tokens: PrivacyPreservingTokenUsage;
  cost_usd: number;
  assistant_message_count?: number;

  sentinels: {
    count: number;
    total_cost_usd: number;
    total_triggers: number;
    total_llm_calls: number;
    failed_llm_calls: number;
    models_used: string[];
  } | null;

  has_rig_setup_checkpoint: boolean;
  has_completion_checkpoint: boolean;
  has_error_checkpoint: boolean;
  has_skip_checkpoint: boolean;
}

export interface PrivacyPreservingRun {
  run_id_hash: string;
  start_time: string;
  end_time?: string;
  duration_ms?: number;
  duration_bucket: "<1m" | "1-5m" | "5-15m" | "15m+";
  status: "running" | "completed" | "failed" | "crashed";
  starting_conditions: {
    type: "fresh" | "continuation";
    reason?: "retry" | "rollback" | "continue";
  };
  codons: PrivacyPreservingCodonExecution[];
  metrics: {
    total_codons: number;
    codons_completed: number;
    codons_failed: number;
    codons_skipped: number;
    total_cost_usd: number;
    total_tokens: PrivacyPreservingTokenUsage;
    total_checkpoints: number;
    total_rollbacks: number;
    total_sentinels_loaded: number;
    total_sentinel_cost_usd: number;
    total_sentinel_triggers: number;
    total_sentinel_llm_calls: number;
  };
}

export interface PrivacyPreservingProvider {
  provider_id: string;
  shim?: {
    name: string;
    version: string;
  };
  agent: {
    name: string;
    version: string;
    found: boolean;
  };
  self_test?: {
    passed: boolean;
    check_count: number;
    passed_count: number;
  };
}

// =============================================================================
// Telemetry Event Types
// =============================================================================

/** Common fields included in every event via PostHog $set */
export interface TelemetryUserProperties {
  hankweave_version: string;
  os: string;
  os_version: string;
  arch: string;
  node_version: string;
  is_ci: boolean;
  is_compiled: boolean;
}

/** All telemetry event names */
export type TelemetryEventName =
  // CLI events
  | "cli_init"
  | "cli_validate"
  | "cli_cleanup"
  | "cli_run"
  | "cli_help"
  // Run lifecycle
  | "run_started"
  | "run_completed"
  | "run_failed"
  | "run_crashed"
  // Codon lifecycle
  | "codon_started"
  | "codon_completed"
  | "codon_failed"
  | "codon_skipped"
  // Loop lifecycle
  | "loop_iteration_started"
  | "loop_iteration_completed"
  // Rig lifecycle
  | "rig_setup_completed"
  | "rig_setup_failed"
  // Recovery
  | "checkpoint_created"
  | "rollback_completed"
  | "continuation_started"
  // Sentinel
  | "sentinel_triggered"
  // Budget
  | "budget_set"
  | "budget_exceeded"
  // PostHog LLM Analytics (special $ prefixed events)
  | "$ai_generation"
  | "$ai_trace"
  | "$ai_span";

// =============================================================================
// Telemetry Config Schema
// =============================================================================

export const telemetryConfigSchema = z.object({
  enabled: z.boolean().optional().describe("Enable or disable telemetry"),
  endpoint: z.string().url().optional().describe("Custom telemetry endpoint URL"),
  debug: z.boolean().optional().describe("Print payloads to console instead of sending"),
});

export type TelemetryConfig = z.infer<typeof telemetryConfigSchema>;

// =============================================================================
// Telemetry Identity
// =============================================================================

export interface TelemetryIdentity {
  clientId: string;
  createdAt: string;
  noticeShownAt?: string;
  firstSuccessAt?: string; // Tracks first successful hank run (for star nudge)
}

// =============================================================================
// Helper Types
// =============================================================================

export interface TelemetryEvent {
  event: TelemetryEventName;
  properties: Record<string, unknown>;
  timestamp: string;
}
