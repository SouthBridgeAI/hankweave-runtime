/**
 * Telemetry Collector
 *
 * Listens to runtime events, aggregates data, and builds telemetry payloads.
 * Implements all 21 event types from the telemetry spec.
 *
 * See: intermediates/40-telemetry/TELEMETRY_SPEC.md
 */

import os from "node:os";
import type { CodonConfig } from "../config.js";
import type { ServerEvent } from "../schemas/event-schemas.js";
import type { Run } from "../types/state-types.js";
import { getMetadata } from "../utils.js";
import { initErrorTracking } from "./error-tracking.js";
import {
  getDurationBucket,
  sha256,
  toPrivacyPreservingHank,
  toPrivacyPreservingRun,
} from "./privacy-maps.js";
import { TelemetryClient } from "./telemetry-client.js";
import type { ResolvedTelemetryConfig } from "./telemetry-config.js";
import { isFirstRun } from "./telemetry-identity.js";
import type { TelemetryEventName, TelemetryUserProperties } from "./telemetry-types.js";

// =============================================================================
// Per-codon tracking
// =============================================================================

/** Per-codon LLM usage accumulated from token.usage events */
interface CodonLLMUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCost: number;
  modelId?: string;
  modelUsage?: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      costUSD: number;
    }
  >;
}

/** Per-codon tool usage */
interface CodonToolUsage {
  toolCounts: Record<string, number>;
  toolErrorCounts: Record<string, number>;
}

// =============================================================================
// Run-level accumulated data
// =============================================================================

interface AccumulatedData {
  /** Current run ID hash */
  runIdHash?: string;
  /** Raw run ID (for setRunId) */
  rawRunId?: string;

  /** Per-codon LLM usage (keyed by codonId) */
  codonLLMUsage: Record<string, CodonLLMUsage>;
  /** Per-codon tool usage (keyed by codonId) */
  codonToolUsage: Record<string, CodonToolUsage>;
  /** Current codon being tracked (for tool attribution) */
  currentCodonId?: string;

  /** Run-level tool counts (sum of all codons) */
  runToolCounts: Record<string, number>;
  runToolErrorCounts: Record<string, number>;
  /** Run-level model counts */
  runModelCounts: Record<string, number>;

  /** Checkpoint count */
  checkpointCount: number;
  /** Rollback count */
  rollbackCount: number;

  /** Events queued for batch send at shutdown */
  queuedEvents: Array<{
    event: TelemetryEventName;
    properties: Record<string, unknown>;
  }>;
}

// =============================================================================
// Telemetry Collector
// =============================================================================

/** Privacy-preserved provider info for run_started */
interface TelemetryProvider {
  provider_id: string;
  shim?: { name: string; version: string };
  agent: { name: string; version: string; found: boolean };
  self_test?: { passed: boolean; check_count: number; passed_count: number };
}

export class TelemetryCollector {
  private client: TelemetryClient;
  private config: ResolvedTelemetryConfig;
  private hankConfig: CodonConfig[] | null = null;
  private providers: TelemetryProvider[] = [];
  private accumulated: AccumulatedData;

  constructor(config: ResolvedTelemetryConfig, clientId: string, isCompiled: boolean) {
    this.config = config;

    const userProperties: TelemetryUserProperties = {
      hankweave_version: getMetadata().version,
      os: os.platform(),
      os_version: os.release(),
      arch: os.arch(),
      node_version: process.version,
      is_ci: false,
      is_compiled: isCompiled,
    };

    this.client = new TelemetryClient(config, clientId, userProperties);

    // Initialize error tracking with the same PostHog client
    const posthogClient = this.client.getPostHogClient();
    if (posthogClient) {
      initErrorTracking(posthogClient, clientId);
    }

    this.accumulated = this.freshAccumulated();
  }

  private freshAccumulated(): AccumulatedData {
    return {
      codonLLMUsage: {},
      codonToolUsage: {},
      runToolCounts: {},
      runToolErrorCounts: {},
      runModelCounts: {},
      checkpointCount: 0,
      rollbackCount: 0,
      queuedEvents: [],
    };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  setHankConfig(hank: CodonConfig[]): void {
    this.hankConfig = hank;
  }

  /**
   * Set provider/shim self-test results for the run_started event.
   * Called after validation with shimSelfTests from validateHank().
   */
  setProviders(
    shimSelfTests?: Array<{
      modelId: string;
      modelName: string;
      provider: string;
      passed: boolean;
      result: {
        shim: { name: string; version: string };
        agent: { name: string; version: string; found: boolean };
        checks: Array<{ name: string; passed: boolean }>;
      };
    }>,
  ): void {
    if (!shimSelfTests) return;
    this.providers = shimSelfTests.map((test) => ({
      provider_id: test.provider,
      shim: test.result.shim,
      agent: test.result.agent,
      self_test: {
        passed: test.passed,
        check_count: test.result.checks.length,
        passed_count: test.result.checks.filter((c) => c.passed).length,
      },
    }));
  }

  /**
   * Set the current run ID for correlating events.
   * Called when a new run starts.
   */
  setRunId(runId: string): void {
    this.accumulated.runIdHash = sha256(runId);
    this.accumulated.rawRunId = runId;
  }

  // ===========================================================================
  // Event Handling
  // ===========================================================================

  handleEvent(event: ServerEvent): void {
    if (!this.config.enabled) return;
    try {
      this.processEvent(event);
    } catch {
      // Silent fail
    }
  }

  private processEvent(event: ServerEvent): void {
    const runIdHash = this.accumulated.runIdHash || "unknown";

    switch (event.type) {
      // ===== Tool tracking =====
      case "tool.result": {
        const toolName = event.data.toolName;
        // Per-codon
        if (this.accumulated.currentCodonId) {
          const codonTools = this.getOrCreateCodonTools(this.accumulated.currentCodonId);
          codonTools.toolCounts[toolName] = (codonTools.toolCounts[toolName] || 0) + 1;
          if (event.data.isError) {
            codonTools.toolErrorCounts[toolName] = (codonTools.toolErrorCounts[toolName] || 0) + 1;
          }
        }
        // Run-level
        this.accumulated.runToolCounts[toolName] =
          (this.accumulated.runToolCounts[toolName] || 0) + 1;
        if (event.data.isError) {
          this.accumulated.runToolErrorCounts[toolName] =
            (this.accumulated.runToolErrorCounts[toolName] || 0) + 1;
        }
        break;
      }

      // ===== LLM token tracking =====
      case "token.usage": {
        const codonId = event.data.codonId;
        const existing = this.accumulated.codonLLMUsage[codonId];
        if (existing) {
          existing.inputTokens += event.data.inputTokens;
          existing.outputTokens += event.data.outputTokens;
          existing.cacheReadTokens += event.data.cacheReadTokens;
          existing.cacheCreationTokens += event.data.cacheCreationTokens;
          existing.totalCost += event.data.totalCost;
          if (event.data.modelId) existing.modelId = event.data.modelId;
          if (event.data.modelUsage) {
            if (!existing.modelUsage) existing.modelUsage = {};
            for (const [model, usage] of Object.entries(event.data.modelUsage)) {
              const prev = existing.modelUsage[model];
              if (prev) {
                prev.inputTokens += usage.inputTokens;
                prev.outputTokens += usage.outputTokens;
                prev.cacheReadInputTokens =
                  (prev.cacheReadInputTokens || 0) + (usage.cacheReadInputTokens || 0);
                prev.cacheCreationInputTokens =
                  (prev.cacheCreationInputTokens || 0) + (usage.cacheCreationInputTokens || 0);
                prev.costUSD += usage.costUSD;
              } else {
                existing.modelUsage[model] = { ...usage };
              }
            }
          }
        } else {
          this.accumulated.codonLLMUsage[codonId] = {
            inputTokens: event.data.inputTokens,
            outputTokens: event.data.outputTokens,
            cacheReadTokens: event.data.cacheReadTokens,
            cacheCreationTokens: event.data.cacheCreationTokens,
            totalCost: event.data.totalCost,
            modelId: event.data.modelId,
            modelUsage: event.data.modelUsage ? { ...event.data.modelUsage } : undefined,
          };
        }
        if (event.data.modelId) {
          this.accumulated.runModelCounts[event.data.modelId] =
            (this.accumulated.runModelCounts[event.data.modelId] || 0) + 1;
        }
        break;
      }

      // ===== Category C: Codon Lifecycle =====
      case "codon.started": {
        this.accumulated.currentCodonId = event.data.codonId;

        // Spec: codon_started with full properties
        this.accumulated.queuedEvents.push({
          event: "codon_started",
          properties: {
            run_id_hash: runIdHash,
            codon_id_hash: sha256(event.data.codonId),
            // Note: codon_position, model, continuation_mode, sentinel info
            // are not available on the codon.started runtime event.
            // They would need to come from the hank config (looked up by codonId).
            ...this.lookupCodonMeta(event.data.codonId),
          },
        });
        break;
      }

      case "codon.completed": {
        const codonIdHash = sha256(event.data.codonId);
        const llmUsage = this.accumulated.codonLLMUsage[event.data.codonId];
        const codonTools = this.accumulated.codonToolUsage[event.data.codonId];
        const durationSec = event.data.duration ? event.data.duration / 1000 : undefined;

        // Spec: codon_completed with full properties
        this.accumulated.queuedEvents.push({
          event: "codon_completed",
          properties: {
            run_id_hash: runIdHash,
            codon_id_hash: codonIdHash,
            ...this.lookupCodonMeta(event.data.codonId),
            // Metrics
            duration_ms: event.data.duration,
            cost_usd: event.data.cost,
            input_tokens: llmUsage?.inputTokens || 0,
            output_tokens: llmUsage?.outputTokens || 0,
            cache_read_tokens: llmUsage?.cacheReadTokens || 0,
            cache_creation_tokens: llmUsage?.cacheCreationTokens || 0,
            // Tool usage (this codon only)
            tool_calls: codonTools
              ? Object.values(codonTools.toolCounts).reduce((a, b) => a + b, 0)
              : 0,
            tool_errors: codonTools
              ? Object.values(codonTools.toolErrorCounts).reduce((a, b) => a + b, 0)
              : 0,
            tools_used: codonTools ? Object.keys(codonTools.toolCounts) : [],
          },
        });

        // Emit $ai_generation for LLM analytics
        if (llmUsage) {
          if (llmUsage.modelUsage && Object.keys(llmUsage.modelUsage).length > 0) {
            for (const [modelId, usage] of Object.entries(llmUsage.modelUsage)) {
              this.accumulated.queuedEvents.push({
                event: "$ai_generation",
                properties: {
                  $ai_trace_id: runIdHash,
                  $ai_span_id: codonIdHash,
                  $ai_model: modelId,
                  $ai_provider: this.getProviderFromModel(modelId),
                  $ai_input_tokens: usage.inputTokens,
                  $ai_output_tokens: usage.outputTokens,
                  $ai_cache_read_input_tokens: usage.cacheReadInputTokens || 0,
                  $ai_cache_creation_input_tokens: usage.cacheCreationInputTokens || 0,
                  $ai_total_cost_usd: usage.costUSD,
                  $ai_latency: durationSec,
                },
              });
            }
          } else {
            this.accumulated.queuedEvents.push({
              event: "$ai_generation",
              properties: {
                $ai_trace_id: runIdHash,
                $ai_span_id: codonIdHash,
                $ai_model: llmUsage.modelId || "unknown",
                $ai_provider: llmUsage.modelId
                  ? this.getProviderFromModel(llmUsage.modelId)
                  : "unknown",
                $ai_input_tokens: llmUsage.inputTokens,
                $ai_output_tokens: llmUsage.outputTokens,
                $ai_cache_read_input_tokens: llmUsage.cacheReadTokens,
                $ai_cache_creation_input_tokens: llmUsage.cacheCreationTokens,
                $ai_total_cost_usd: llmUsage.totalCost,
                $ai_latency: durationSec,
              },
            });
          }
        }

        this.accumulated.currentCodonId = undefined;
        break;
      }

      // ===== Category D: Loop Lifecycle =====
      case "loop.iteration.completed": {
        this.accumulated.queuedEvents.push({
          event: "loop_iteration_completed",
          properties: {
            run_id_hash: runIdHash,
            loop_id_hash: sha256(event.data.loopId),
            iteration: event.data.iteration,
            duration_ms: event.data.durationMs,
            cost_usd: event.data.costUsd,
            tokens_used: event.data.tokensUsed,
            is_final: event.data.isFinal,
            termination_reason: event.data.terminationReason,
          },
        });
        break;
      }

      // ===== State transitions: catch codon_failed, codon_skipped, checkpoint, rig, loop =====
      case "state.transition": {
        const transData = event.data.transition?.data as Record<string, unknown> | undefined;
        const codonId = (event.data.codonId as string) || "";

        switch (event.data.transitionType) {
          case "CodonTransitioned": {
            const toStatus = transData?.to as string;
            const metadata = transData?.metadata as Record<string, unknown> | undefined;

            // codon_failed
            if (toStatus === "failed" && codonId) {
              const llmUsage = this.accumulated.codonLLMUsage[codonId];
              this.accumulated.queuedEvents.push({
                event: "codon_failed",
                properties: {
                  run_id_hash: runIdHash,
                  codon_id_hash: sha256(codonId),
                  ...this.lookupCodonMeta(codonId),
                  failed_during: metadata?.failedDuring || "unknown",
                  failure_type:
                    (metadata?.failureReason as Record<string, unknown>)?.type || "unknown",
                  retriable:
                    (metadata?.failureReason as Record<string, unknown>)?.retriable || false,
                  exit_code: metadata?.exitCode as number | undefined,
                  duration_ms: 0, // Will be computed from state
                  cost_usd: llmUsage?.totalCost || 0,
                  tokens_used: (llmUsage?.inputTokens || 0) + (llmUsage?.outputTokens || 0),
                },
              });
              this.accumulated.currentCodonId = undefined;
            }

            // codon_skipped
            if (toStatus === "skipped" && codonId) {
              this.accumulated.queuedEvents.push({
                event: "codon_skipped",
                properties: {
                  run_id_hash: runIdHash,
                  codon_id_hash: sha256(codonId),
                  ...this.lookupCodonMeta(codonId),
                  skip_reason: "continuation_skip", // Default; sentinel skips come from sentinel events
                },
              });
              this.accumulated.currentCodonId = undefined;
            }
            break;
          }

          case "CheckpointCreated": {
            this.accumulated.checkpointCount++;
            this.accumulated.queuedEvents.push({
              event: "checkpoint_created",
              properties: {
                run_id_hash: runIdHash,
                codon_id_hash: codonId ? sha256(codonId) : "unknown",
                checkpoint_type: transData?.checkpointType || "unknown",
              },
            });
            break;
          }

          case "RunCrashed": {
            // run_crashed event
            this.accumulated.queuedEvents.push({
              event: "run_crashed",
              properties: {
                run_id_hash: runIdHash,
                detected_at: new Date().toISOString(),
                last_known: {
                  codon_status: transData?.lastCodonStatus || "unknown",
                },
              },
            });
            break;
          }

          default:
            break;
        }
        break;
      }

      // ===== Rig setup lifecycle =====
      case "rig.setup.completed": {
        this.accumulated.queuedEvents.push({
          event: "rig_setup_completed",
          properties: {
            run_id_hash: runIdHash,
            codon_id_hash: event.data.codonId ? sha256(event.data.codonId) : "unknown",
            rig_type: event.data.rigType,
            command_count: event.data.commandCount,
            duration_ms: event.data.durationMs,
            created_checkpoint: event.data.createdCheckpoint,
          },
        });
        break;
      }

      case "rig.setup.failed": {
        this.accumulated.queuedEvents.push({
          event: "rig_setup_failed",
          properties: {
            run_id_hash: runIdHash,
            codon_id_hash: event.data.codonId ? sha256(event.data.codonId) : "unknown",
            failure_type: event.data.failureType,
            exit_code: event.data.exitCode,
            command_index: event.data.commandIndex,
            ignored: event.data.ignored,
          },
        });
        break;
      }

      // ===== Category G: Sentinel triggered =====
      case "sentinel.triggered": {
        this.accumulated.queuedEvents.push({
          event: "sentinel_triggered",
          properties: {
            run_id_hash: runIdHash,
            codon_id_hash: event.data.codonId ? sha256(event.data.codonId) : "unknown",
            sentinel_index: event.data.triggerNumber,
            trigger_count: event.data.eventCount,
          },
        });
        break;
      }

      // ===== Category F: Rollback completed =====
      case "rollback.completed": {
        this.accumulated.rollbackCount++;
        this.accumulated.queuedEvents.push({
          event: "rollback_completed",
          properties: {
            from_run_id_hash: sha256(event.data.fromRun),
            to_codon_id_hash: sha256(event.data.codonId),
            reason: event.data.autoRestart ? "retry" : "rollback",
          },
        });
        break;
      }

      default:
        break;
    }
  }

  // ===========================================================================
  // Helper: lookup codon metadata from hank config
  // ===========================================================================

  private lookupCodonMeta(codonId: string): Record<string, unknown> {
    if (!this.hankConfig) return {};

    let position = 0;
    for (const item of this.hankConfig) {
      if ("type" in item && item.type === "loop") {
        const loop = item as {
          id: string;
          codons: Array<{
            id: string;
            model: { modelId: string; name: string };
            continuationMode?: string;
            sentinels?: unknown[];
          }>;
        };
        for (let i = 0; i < loop.codons.length; i++) {
          const codon = loop.codons[i];
          if (
            codon.id === codonId ||
            `${codon.id}#${i}` === codonId ||
            codonId.startsWith(codon.id)
          ) {
            return {
              codon_position: position,
              model: codon.model?.name || codon.model?.modelId || "unknown",
              continuation_mode: codon.continuationMode || "fresh",
              has_sentinels: !!codon.sentinels?.length,
              sentinel_count: codon.sentinels?.length || 0,
              loop_context: {
                loop_id_hash: sha256(loop.id),
                iteration: this.extractIteration(codonId),
              },
            };
          }
          position++;
        }
      } else {
        const codon = item as {
          id: string;
          model: { modelId: string; name: string };
          continuationMode?: string;
          sentinels?: unknown[];
        };
        if (codon.id === codonId || codonId.startsWith(codon.id)) {
          return {
            codon_position: position,
            model: codon.model?.name || codon.model?.modelId || "unknown",
            continuation_mode: codon.continuationMode || "fresh",
            has_sentinels: !!codon.sentinels?.length,
            sentinel_count: codon.sentinels?.length || 0,
          };
        }
        position++;
      }
    }
    return {};
  }

  private extractIteration(codonId: string): number {
    // Runtime codon IDs for loops look like "codonId#0", "codonId#1" etc.
    const match = codonId.match(/#(\d+)$/);
    return match ? Number.parseInt(match[1], 10) : 0;
  }

  private getOrCreateCodonTools(codonId: string): CodonToolUsage {
    if (!this.accumulated.codonToolUsage[codonId]) {
      this.accumulated.codonToolUsage[codonId] = {
        toolCounts: {},
        toolErrorCounts: {},
      };
    }
    return this.accumulated.codonToolUsage[codonId];
  }

  private getProviderFromModel(modelId: string): string {
    const lower = modelId.toLowerCase();
    if (
      lower.includes("claude") ||
      lower.includes("sonnet") ||
      lower.includes("opus") ||
      lower.includes("haiku")
    )
      return "anthropic";
    if (
      lower.includes("gpt") ||
      lower.includes("o1") ||
      lower.includes("o3") ||
      lower.includes("o4")
    )
      return "openai";
    if (lower.includes("gemini") || lower.includes("flash") || lower.includes("pro"))
      return "google";
    if (lower.includes("llama") || lower.includes("mixtral") || lower.includes("groq"))
      return "groq";
    return "unknown";
  }

  // ===========================================================================
  // Run Telemetry (sent at shutdown)
  // ===========================================================================

  async sendRunTelemetry(currentRun: Run | null): Promise<void> {
    if (!this.config.enabled) return;

    try {
      const events: Array<{
        event: TelemetryEventName;
        properties: Record<string, unknown>;
      }> = [];

      // ===== run_started =====
      if (this.hankConfig && currentRun) {
        const runIdHash = sha256(currentRun.runId);
        // Ensure runIdHash is set (in case setRunId wasn't called)
        if (!this.accumulated.runIdHash) {
          this.accumulated.runIdHash = runIdHash;
        }

        events.push({
          event: "run_started",
          properties: {
            hank: toPrivacyPreservingHank(this.hankConfig),
            run_id_hash: runIdHash,
            starting_conditions: {
              type: currentRun.startingConditions.type,
              reason:
                currentRun.startingConditions.type === "continuation"
                  ? currentRun.startingConditions.reason
                  : undefined,
            },
            providers: this.providers,
            is_tty: process.stdout.isTTY || false,
            is_first_run: isFirstRun(),
          },
        });
      }

      // ===== All accumulated codon/sentinel/checkpoint events =====
      events.push(...this.accumulated.queuedEvents);

      // ===== run_completed / run_failed =====
      if (currentRun) {
        const privacyRun = toPrivacyPreservingRun(currentRun);
        const durationMs = currentRun.endTime
          ? new Date(currentRun.endTime).getTime() - new Date(currentRun.startTime).getTime()
          : 0;

        if (currentRun.status === "completed") {
          events.push({
            event: "run_completed",
            properties: {
              run: privacyRun,
              duration_ms: durationMs,
              duration_bucket: getDurationBucket(durationMs),
              total_cost_usd: privacyRun.metrics.total_cost_usd,
              total_tokens:
                privacyRun.metrics.total_tokens.input_tokens +
                privacyRun.metrics.total_tokens.output_tokens,
              tools: {
                total_calls: Object.values(this.accumulated.runToolCounts).reduce(
                  (a, b) => a + b,
                  0,
                ),
                by_name: { ...this.accumulated.runToolCounts },
                errors_by_name: { ...this.accumulated.runToolErrorCounts },
              },
              models: {
                total_calls: Object.values(this.accumulated.runModelCounts).reduce(
                  (a, b) => a + b,
                  0,
                ),
                by_model: { ...this.accumulated.runModelCounts },
              },
            },
          });
        } else if (currentRun.status === "failed") {
          // Find the problematic codon - check failed first, then last non-completed
          const failedCodon =
            currentRun.codons.find((c) => c.status === "failed") ||
            [...currentRun.codons]
              .reverse()
              .find((c) => c.status !== "completed" && c.status !== "skipped");
          const failedIndex = failedCodon ? currentRun.codons.indexOf(failedCodon) : -1;

          // Also check queued codon_failed events for failure details
          // (these are captured in real-time via state transitions, more reliable than state at shutdown)
          const queuedFailure = this.accumulated.queuedEvents.find(
            (e) =>
              e.event === "codon_failed" &&
              failedCodon &&
              e.properties.codon_id_hash === sha256(failedCodon.codonId),
          );

          // Build failure details from best available source
          let failureDetails: Record<string, unknown> | undefined;
          if (failedCodon && failedCodon.status === "failed") {
            failureDetails = {
              codon_position: failedIndex,
              codon_id_hash: sha256(failedCodon.codonId),
              failed_during: failedCodon.failedDuring,
              failure_type: failedCodon.failureReason.type,
              retriable: failedCodon.failureReason.retriable,
            };
          } else if (queuedFailure) {
            // Use the real-time failure event data
            failureDetails = {
              codon_position: failedIndex,
              codon_id_hash: queuedFailure.properties.codon_id_hash,
              failed_during: queuedFailure.properties.failed_during,
              failure_type: queuedFailure.properties.failure_type,
              retriable: queuedFailure.properties.retriable,
            };
          } else if (failedCodon) {
            // Codon exists but isn't in "failed" state (e.g. still "running" at shutdown)
            failureDetails = {
              codon_position: failedIndex,
              codon_id_hash: sha256(failedCodon.codonId),
              failed_during: failedCodon.status, // Whatever state it was stuck in
              failure_type: "unknown",
              retriable: false,
            };
          }

          events.push({
            event: "run_failed",
            properties: {
              run: privacyRun,
              failure: failureDetails,
              total_cost_usd: privacyRun.metrics.total_cost_usd,
              duration_ms: durationMs,
              duration_bucket: getDurationBucket(durationMs),
              codons_completed: privacyRun.metrics.codons_completed,
              codons_remaining:
                privacyRun.metrics.total_codons -
                privacyRun.metrics.codons_completed -
                privacyRun.metrics.codons_failed,
            },
          });
        }

        // ===== $ai_trace for the full run =====
        events.push({
          event: "$ai_trace",
          properties: {
            $ai_trace_id: sha256(currentRun.runId),
            $ai_latency: durationMs / 1000,
            $ai_is_error: currentRun.status === "failed" || currentRun.status === "crashed",
          },
        });
      }

      await this.client.captureMany(events);
    } catch {
      // Silent fail
    }
  }

  // ===========================================================================
  // CLI Events (sent immediately, not queued)
  // ===========================================================================

  async trackCliEvent(
    event: TelemetryEventName,
    properties: Record<string, unknown>,
  ): Promise<void> {
    if (!this.config.enabled) return;
    await this.client.capture(event, properties);
  }

  // ===========================================================================
  // Shutdown
  // ===========================================================================

  async shutdown(): Promise<void> {
    await this.client.shutdown();
  }
}
