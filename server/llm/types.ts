import type { ProbeRecord } from "../provider-probe.js";
import type { ShimSelfTestResult } from "../types/types.js";
import type { Logger } from "../utils.js";
import type { ModelInfo } from "./internal/models-dev-schema.js";

export type { ModelInfo, PriceStatus } from "./internal/models-dev-schema.js";
export type { PricedUsage, UsageTokens } from "./internal/pricing.js";

/** What a model spelling is for: a codon (Claude Agent SDK or Pi) or a sentinel (AI SDK). */
export type ModelUse = "codon" | "sentinel";

/**
 * Why a spelling was rejected (spec 72, "Error message catalogue"):
 * - no-provider (A): no "/" — every model is "<provider>/<model>"
 * - unrunnable-provider (B): no harness for this use runs the provider
 * - wrong-case (D): ids and provider names are case-sensitive
 * - bad-prefix (I): "pi/" with no provider after it
 * - unknown-model (C): the harness does not know the model
 * - no-credentials (E): the harness has no credentials for the provider
 * - unreachable (F): the harness could not be asked
 * - harness-unavailable (G): the harness itself could not start
 * - unprepared: a spelling Models.load never collected (a collection bug)
 */
export type ModelFailureKind =
  | "no-provider"
  | "unrunnable-provider"
  | "wrong-case"
  | "bad-prefix"
  | "unknown-model"
  | "no-credentials"
  | "unreachable"
  | "harness-unavailable"
  | "unprepared";

export type ModelCheck =
  | { ok: true; model: ModelInfo }
  | {
      ok: false;
      kind: ModelFailureKind;
      message: string;
      /** Copy-pasteable "provider/model" ids. */
      suggestions: string[];
      /**
       * "name": the spelling itself is wrong (stage 0) — always a config
       * error. "harness": the harness said no (stage 2) — fatal for codons;
       * a sentinel is skipped instead, as sentinels always were.
       */
      stage: "name" | "harness";
    };

/** What a harness knows about a model it confirmed: price and limits, when it has them. */
export interface HarnessRow {
  /** The harness's own id for the row (differs from the spelling for an effort suffix). */
  id?: string;
  name?: string;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
  reasoning?: boolean;
  attachment?: boolean;
  input?: string[];
}

/** One self-test style check, kept for `--validate` output and run telemetry. */
export type HarnessCheckStep = ShimSelfTestResult["checks"][number];

export type HarnessCheckResult =
  | {
      ok: true;
      /** What confirmed it: "catalog", "pi catalog", "pi.dev", "anthropic GET /v1/models", … */
      evidence: string;
      row?: HarnessRow;
      /** A provider model-list answer to cache (30 days) so the next startup stays offline. */
      probe?: ProbeRecord;
      steps?: HarnessCheckStep[];
    }
  | {
      ok: false;
      kind: "unknown-model" | "no-credentials" | "unreachable" | "harness-unavailable";
      message: string;
      /** "provider/model" ids the harness does know, closest first when it can rank them. */
      candidates: string[];
      steps?: HarnessCheckStep[];
    };

export interface HarnessCheckOptions {
  /** May the harness go online (pi.dev refresh, provider model list)? */
  network: boolean;
  /** Bound on each network question. */
  timeoutMs: number;
  /** Whether hankweave's catalog lists the exact id (evidence for routes with no local catalog). */
  knownToCatalog(provider: string, modelId: string): boolean;
  logger?: Logger;
}

/**
 * What a harness tells the model module (spec 72, "Code structure"): which
 * providers it runs, and whether it can run one model here. Defined here,
 * implemented next to each harness; Models asks them in list order and the
 * first whose `runs` is true wins ("pi/" forces Pi).
 */
export interface HarnessModelCheck {
  /** "claude-agent-sdk" and "pi" for codons; "ai-sdk" for sentinels (never a codon harness). */
  readonly harness: string;
  /** For messages: "the Claude Agent SDK", "Pi", "the AI SDK". */
  readonly label: string;
  /** Every provider this harness can run (some only for some ids; see runs). */
  providers(): readonly string[];
  /** The routing predicate: validation and dispatch both use it. */
  runs(provider: string, modelId: string): boolean;
  /**
   * Parse mode: the harness's own offline row for the id (synchronous), when
   * its offline catalog lists it — so replay and pack price a model exactly
   * as the run that checked it did.
   */
  offlineRow?(provider: string, modelId: string): HarnessRow | undefined;
  /** "Can you run provider/model here, with this environment?" */
  check(
    provider: string,
    modelId: string,
    env: NodeJS.ProcessEnv,
    opts: HarnessCheckOptions,
  ): Promise<HarnessCheckResult>;
  /**
   * Optional: take a model the harness lacks from hankweave's record of it.
   * `siblings` are the catalog's records in the same provider, newest first,
   * same family first. Pi implements this as sibling injection.
   */
  adopt?(
    provider: string,
    modelId: string,
    record: ModelInfo,
    siblings: readonly ModelInfo[],
    logger?: Logger,
  ): Promise<{ ok: true; evidence: string } | { ok: false; reason: string }>;
  /** Versions reported in run telemetry. */
  info?(): { shim: { name: string; version: string }; agent: { name: string; version: string } };
  /** Refresh the harness's own catalog for the next run (runs only). */
  startBackgroundRefresh?(logger?: Logger): void;
}
