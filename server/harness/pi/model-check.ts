import type {
  HarnessCheckOptions,
  HarnessCheckResult,
  HarnessModelCheck,
  HarnessRow,
  ModelInfo,
} from "../../llm/index.js";
import {
  createPiModelRuntime,
  injectPiModel,
  startPiCatalogRefresh,
  storeModels,
} from "../../pi-model-catalog.js";
import { checkPiModel, PI_VERSION } from "../../pi-sdk-manager.js";
import { PI_HARNESS } from "../../provider-ids.js";
import type { Logger } from "../../utils.js";
import { baseModelId, piProviders, piUserModels, piVendoredModels, runsOnPi } from "./routing.js";

/** The fields of a pi model row parse mode uses; rows are read defensively. */
interface PiRow {
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  input?: unknown;
  contextWindow?: unknown;
  maxTokens?: unknown;
  cost?: { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
}

const num = (value: unknown) => (typeof value === "number" ? value : undefined);

/**
 * One model as Pi composes it offline: vendored, replaced by the cached
 * pi.dev store, replaced by the user's models.json rows, then the user's
 * modelOverrides on top (pi-coding-agent's provider-composer order).
 */
function composedPiRow(provider: string, modelId: string): PiRow | undefined {
  const user = piUserModels(provider);
  const layers = [user.models, storeModels(provider), piVendoredModels(provider)] as PiRow[][];
  const row = firstRow(layers, modelId);
  const override = user.overrides[modelId] as PiRow | undefined;
  if (!row || !override || typeof override !== "object") return row;
  return withOverride(row, override);
}

/** The model's row in the first layer that has one. */
function firstRow(layers: readonly PiRow[][], modelId: string): PiRow | undefined {
  for (const layer of layers) {
    const row = layer.find((r) => r.id === modelId);
    if (row) return row;
  }
  return undefined;
}

/** A row with the user's modelOverrides entry on top (cost merged field by field). */
function withOverride(row: PiRow, override: PiRow): PiRow {
  return {
    ...row,
    name: override.name ?? row.name,
    reasoning: override.reasoning ?? row.reasoning,
    input: override.input ?? row.input,
    contextWindow: override.contextWindow ?? row.contextWindow,
    maxTokens: override.maxTokens ?? row.maxTokens,
    cost: override.cost ? { ...row.cost, ...override.cost } : row.cost,
  };
}

function toHarnessRow(row: PiRow): HarnessRow {
  return {
    id: typeof row.id === "string" ? row.id : undefined,
    name: typeof row.name === "string" ? row.name : undefined,
    cost: row.cost && {
      input: num(row.cost.input),
      output: num(row.cost.output),
      cache_read: num(row.cost.cacheRead),
      cache_write: num(row.cost.cacheWrite),
    },
    limit: { context: num(row.contextWindow), output: num(row.maxTokens) },
    reasoning: row.reasoning === true,
    input: Array.isArray(row.input) ? row.input.filter((i) => typeof i === "string") : undefined,
  };
}

/**
 * Pi's answer to "can you run provider/model here?" (spec 72, stage 2):
 * credentials from Pi's own resolution (env, codon env, auth store — for
 * every provider), then Pi's catalog (vendored, frozen pi.dev store, the
 * user's models.json), refreshed from pi.dev on a miss when online. Pi
 * runs every provider its catalog has; `adopt` adds a model Pi lacks from
 * hankweave's record of it (sibling injection).
 */
export class PiModelCheck implements HarnessModelCheck {
  readonly harness = PI_HARNESS;
  readonly label = "Pi";

  providers(): readonly string[] {
    return piProviders();
  }

  runs(provider: string): boolean {
    return runsOnPi(provider);
  }

  /**
   * Pi's offline row for a model (vendored snapshot, the user's models.json,
   * the cached pi.dev store), effort suffix allowed on a reasoning model —
   * the same row a run's check would find, without a runtime.
   */
  offlineRow(provider: string, modelId: string): HarnessRow | undefined {
    const row = (id: string) => composedPiRow(provider, id);
    const exact = row(modelId);
    if (exact) return toHarnessRow(exact);
    const base = baseModelId(modelId);
    const reasoning = base !== modelId ? row(base) : undefined;
    return reasoning?.reasoning === true ? toHarnessRow(reasoning) : undefined;
  }

  check(
    provider: string,
    modelId: string,
    env: NodeJS.ProcessEnv,
    opts: HarnessCheckOptions,
  ): Promise<HarnessCheckResult> {
    return checkPiModel(provider, modelId, env, {
      network: opts.network,
      timeoutMs: opts.timeoutMs,
      logger: opts.logger,
    });
  }

  async adopt(
    provider: string,
    _modelId: string,
    record: ModelInfo,
    siblings: readonly ModelInfo[],
    logger?: Logger,
  ): Promise<{ ok: true; evidence: string } | { ok: false; reason: string }> {
    try {
      const runtime = await createPiModelRuntime();
      // The record is what to inject: the base's for an effort spelling.
      const injected = injectPiModel(runtime, provider, record.modelId, record, siblings, logger);
      return injected.ok
        ? { ok: true, evidence: `adopted from ${injected.sibling}` }
        : { ok: false, reason: injected.reason };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  // fallow-ignore-next-line unused-class-member -- called through HarnessModelCheck
  info() {
    return {
      shim: { name: "pi-sdk-manager", version: PI_VERSION },
      agent: { name: "pi-coding-agent", version: PI_VERSION },
    };
  }

  // fallow-ignore-next-line unused-class-member -- called through HarnessModelCheck
  startBackgroundRefresh(logger?: Logger): void {
    void startPiCatalogRefresh(logger);
  }
}
