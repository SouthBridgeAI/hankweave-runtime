import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  baseModelId,
  readUserModelsJson,
  type UserModelsFile,
  userModelsJsonPath,
} from "./harness/pi/routing.js";
import type { ModelInfo } from "./llm/index.js";
import {
  getModelCatalogDir,
  isModelCatalogOffline,
  writeFileAtomic,
} from "./model-catalog-settings.js";
import type { Logger } from "./utils.js";

/**
 * Pi's own catalog (spec 70, "Feeding the Pi route"; spec 72).
 *
 * Pi decides runnability from its own catalog: a vendored snapshot, an
 * overlay refreshed from pi.dev into a models store, and a models.json of
 * user providers. Hankweave owns two of those inputs:
 * - the models store lives in the model catalog directory, so a standalone
 *   `pi` run can no longer change what hankweave accepts (and hankweave never
 *   writes under ~/.pi). A run reads its own copy of the store, taken when
 *   the first model is checked (freezePiModelsStore), so pi's prices and
 *   limits cannot shift between codons;
 * - when Pi does not know a model but hankweave's catalog has a record for
 *   it, hankweave writes a models.json for this process — the user's own file
 *   plus an injected row — and points pi at it (injectPiModel).
 */

type PiModel = Model<Api>;

/** How long a codon start waits for pi.dev on a catalog miss. */
const MISS_REFRESH_TIMEOUT_MS = 8_000;
/** Background refresh of pi's hosted catalog at startup. */
const BACKGROUND_REFRESH_TIMEOUT_MS = 15_000;

/** Pi's hosted-catalog overlay, in hankweave's model catalog directory, shared by every run. */
function piModelsStorePath(): string {
  return path.join(getModelCatalogDir(), "pi-models-store.json");
}

/** Rows injected into pi's catalog by this process, keyed "provider/model". */
const injectedRows = new Map<string, { provider: string; row: Record<string, unknown> }>();
/** The generated models.json, once any row has been injected. */
let generatedModelsPath: string | undefined;
/** This run's copy of pi's store, once the pre-pass has taken it. */
let frozenStorePath: string | undefined;
/** The shared store frozenStorePath was copied from. */
let frozenFrom: string | undefined;
let scratchDir: string | undefined;
let backgroundRefresh: Promise<void> | undefined;

/** This process's directory for its generated models.json and store copy; removed on exit. */
function processScratchDir(): string {
  if (scratchDir) return scratchDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-pi-models-"));
  process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  scratchDir = dir;
  return dir;
}

/**
 * The shared store's content, or "{}" when there is none or it is not JSON.
 * pi rewrites the store in place (under its own lock, not temp-and-rename),
 * so a process killed mid-write leaves it truncated, and pi never repairs it:
 * each write re-reads the file first and fails. A store that does not parse
 * is reset to "{}" for the background refresh to fill again; at worst that
 * drops another process's refresh being written at this moment, which the
 * next one redoes.
 */
function readSharedStore(logger?: Logger): string {
  const sharedPath = piModelsStorePath();
  let shared: string;
  try {
    shared = fs.readFileSync(sharedPath, "utf-8");
  } catch {
    return "{}";
  }
  try {
    JSON.parse(shared);
    return shared;
  } catch {
    // The reset is best effort: this run proceeds on an empty copy either
    // way (pi's vendored catalog, pi.dev on a miss), and the background
    // refresh fails on the corrupt file until a later run resets it.
    try {
      writeFileAtomic(sharedPath, "{}");
      logger?.log(`Reset pi's model store ${sharedPath}: it was not valid JSON`, "info");
    } catch (error) {
      logger?.log(
        `Could not reset pi's model store ${sharedPath} (not valid JSON): ${error}; ` +
          "this run uses pi's vendored catalog instead",
        "error",
      );
    }
    return "{}";
  }
}

/**
 * Fix pi's hosted catalog for the rest of this process (spec 70, "When the
 * catalog refreshes"): copy the shared store to a per-process file that every
 * later self-test and codon spawn reads. A model fetched on a miss
 * (ensurePiModel) is written to the copy, so later codons see it too; the
 * background refresh keeps updating the shared store, for the next run. A
 * copy of an empty or reset store leaves pi on its vendored catalog, and a
 * miss still asks pi.dev.
 */
export function freezePiModelsStore(logger?: Logger): void {
  // Once per shared store: a process that moves the catalog directory
  // (HANKWEAVE_MODEL_CATALOG_DIR) freezes the store found there.
  const sharedPath = piModelsStorePath();
  if (frozenStorePath && frozenFrom === sharedPath) return;
  const content = readSharedStore(logger);
  frozenStorePath = path.join(processScratchDir(), "models-store.json");
  frozenFrom = sharedPath;
  fs.writeFileSync(frozenStorePath, content);
}

/**
 * The models pi's hosted-catalog store holds for a provider (this run's
 * frozen copy once taken, else the shared store), read without a runtime:
 * parse mode's view of the cached pi.dev layer. Rows are as pi stored them.
 */
let storeCache: { key: string; parsed: unknown } | undefined;

export function storeModels(provider: string): readonly unknown[] {
  // Parsed once per file version: suggestion ranking asks per model id.
  const file = frozenStorePath ?? piModelsStorePath();
  let parsed: unknown;
  try {
    const stat = fs.statSync(file);
    const key = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (storeCache?.key !== key) {
      storeCache = { key, parsed: JSON.parse(fs.readFileSync(file, "utf-8")) };
    }
    parsed = storeCache.parsed;
  } catch {
    return [];
  }
  const entry = (parsed as Record<string, { models?: unknown; lastModified?: unknown }> | null)?.[
    provider
  ];
  // Pi uses a stored catalog only when it is newer than its vendored data
  // (remoteModels in pi-coding-agent's remote-catalog-provider); entries it
  // wrote after a 404 carry lastModified 0 and are ignored.
  const generatedAt = getBuiltinModelDataGeneratedAt();
  const lastModified = typeof entry?.lastModified === "number" ? entry.lastModified : undefined;
  if (generatedAt !== undefined && (lastModified === undefined || lastModified <= generatedAt)) {
    return [];
  }
  // Rows for another provider are ignored, as pi's remote provider does.
  return Array.isArray(entry?.models)
    ? entry.models.filter(
        (row: { provider?: unknown }) => row?.provider === undefined || row.provider === provider,
      )
    : [];
}

/**
 * A ModelRuntime for a self-test or codon spawn: the run's frozen store once
 * the pre-pass has taken it (else the shared store), this process's
 * models.json, and no network at creation (ensurePiModel asks pi.dev on a
 * miss).
 */
export async function createPiModelRuntime(): Promise<ModelRuntime> {
  fs.mkdirSync(getModelCatalogDir(), { recursive: true });
  // Every runtime of a run reads one frozen copy, even when no Pi model was
  // checked at startup (a resumed plan's Pi codon under an all-Claude hank).
  freezePiModelsStore();
  // Re-merge the user's current models.json under this process's injected
  // rows, so an edit (or another PI_CODING_AGENT_DIR) is seen as routing sees it.
  if (generatedModelsPath && injectedRows.size > 0) writeGeneratedModelsJson();
  return ModelRuntime.create({
    modelsPath: generatedModelsPath ?? userModelsJsonPath(),
    modelsStorePath: frozenStorePath ?? piModelsStorePath(),
  });
}

/**
 * Refresh pi's hosted catalog into the shared store, once per process, in the
 * background. pi skips providers whose stored overlay is still fresh. The
 * running process does not read the result (see freezePiModelsStore).
 */
export function startPiCatalogRefresh(logger?: Logger): Promise<void> {
  if (isModelCatalogOffline()) return Promise.resolve();
  fs.mkdirSync(getModelCatalogDir(), { recursive: true });
  backgroundRefresh ??= ModelRuntime.create({
    modelsPath: userModelsJsonPath(),
    modelsStorePath: piModelsStorePath(),
    allowModelNetwork: true,
    modelRefreshTimeoutMs: BACKGROUND_REFRESH_TIMEOUT_MS,
  }).then(
    () => logger?.log("Refreshed pi's model catalog from pi.dev", "debug"),
    (error: unknown) => logger?.log(`Background pi catalog refresh failed: ${error}`, "info"),
  );
  return backgroundRefresh;
}

/**
 * Write this process's models.json: the user's own file with every injected
 * row appended under its provider. Returns false (and injects nothing) when
 * the user's file exists but cannot be parsed — dropping their providers
 * would break the codons that use them.
 */
function writeGeneratedModelsJson(logger?: Logger): boolean {
  const read = readUserModelsJson();
  if (read === "invalid") {
    logger?.log(
      `Cannot merge ${userModelsJsonPath()} (not valid models.json); not injecting pi rows`,
      "error",
    );
    return false;
  }
  const user: UserModelsFile = read ?? {};

  const providers = { ...user.providers };
  for (const { provider, row } of injectedRows.values()) {
    const existing = providers[provider] ?? {};
    providers[provider] = { ...existing, models: [...(existing.models ?? []), row] };
  }

  generatedModelsPath ??= path.join(processScratchDir(), "models.json");
  // Atomic: other model checks may be creating a runtime that reads it.
  writeFileAtomic(generatedModelsPath, `${JSON.stringify({ ...user, providers }, null, 2)}\n`);
  return true;
}

/**
 * The model in pi's catalog to copy request settings from: the newest of
 * hankweave's same-provider records (`siblings`, newest first, same family
 * first) that pi also has, else pi's own first model of the same line
 * ("claude", "gpt", …).
 */
function pickSibling(
  models: readonly PiModel[],
  modelId: string,
  siblings: readonly Pick<ModelInfo, "modelId">[],
  reasoning: boolean,
): PiModel | undefined {
  // A sibling that reasons like the model first: its request settings
  // (thinking-level map) are the ones the model needs.
  const ordered = [
    ...models.filter((m) => m.reasoning === reasoning),
    ...models.filter((m) => m.reasoning !== reasoning),
  ];
  const byId = (id: string) => ordered.find((m) => m.id === id);
  const fromRecords = siblings
    .map((s) => byId(s.modelId))
    .filter((m): m is PiModel => m !== undefined)
    .sort((a, b) => Number(b.reasoning === reasoning) - Number(a.reasoning === reasoning))[0];
  if (fromRecords) return fromRecords;
  const line = modelId.toLowerCase().split(/[-_.]/)[0];
  return ordered.find((m) => m.id.toLowerCase().split(/[-_.]/)[0] === line);
}

/**
 * pi's cost rates for an injected row. pi reports cost from these, so for an
 * unknown price they are the same ceiling estimate hankweave budgets with;
 * a rate nobody publishes is 0.
 */
function piCostRates(record: ModelInfo) {
  const {
    input = 0,
    output = 0,
    cache_read: cacheRead = 0,
    cache_write: cacheWrite = 0,
  } = record.provenance?.budgetCost ?? record.cost ?? {};
  return { input, output, cacheRead, cacheWrite };
}

/** A models.json row for `record`, behaving like `sibling` (same API and request quirks). */
function injectedRow(
  modelId: string,
  record: ModelInfo,
  sibling: PiModel,
): Record<string, unknown> {
  // Undefined sibling fields are dropped when the row is serialized.
  return {
    id: modelId,
    name: record.name,
    api: sibling.api,
    // hankweave's record says whether the model reasons (an effort suffix
    // resolves only on a reasoning row); the sibling only lends settings.
    reasoning: record.reasoning,
    thinkingLevelMap: sibling.thinkingLevelMap,
    input: sibling.input,
    compat: sibling.compat,
    headers: sibling.headers,
    cost: piCostRates(record),
    contextWindow: record.limit.context,
    maxTokens: record.limit.output,
  };
}

/** Whether pi's catalog has the model; an effort suffix only on a reasoning base. */
function piHas(runtime: ModelRuntime, provider: string, modelId: string): boolean {
  if (runtime.getModel(provider, modelId)) return true;
  const base = baseModelId(modelId);
  return base !== modelId && runtime.getModel(provider, base)?.reasoning === true;
}

/**
 * A bounded pi.dev refresh of one provider, when online model checks are on
 * and pi's catalog lacks the model. Returns whether pi has it afterwards (the
 * same runtime sees the refresh).
 */
export async function refreshPiProvider(
  runtime: ModelRuntime,
  provider: string,
  modelId: string,
  options: {
    network: boolean;
    timeoutMs?: number;
    logger?: Logger;
    /** Told when pi.dev could not be asked (timeout, network error). */
    onError?: (error: unknown) => void;
  },
): Promise<boolean> {
  if (piHas(runtime, provider, modelId)) return true;
  if (!options.network || isModelCatalogOffline()) return false;
  // pi reports a failed fetch or a timeout in the result, not by throwing.
  let failure: unknown;
  try {
    const result = await runtime.refresh({
      providers: [provider],
      allowNetwork: true,
      signal: AbortSignal.timeout(options.timeoutMs ?? MISS_REFRESH_TIMEOUT_MS),
    });
    failure = result.errors.get(provider) ?? (result.aborted ? new Error("timed out") : undefined);
  } catch (error) {
    failure = error;
  }
  if (failure !== undefined) {
    options.logger?.log(`pi.dev refresh for '${provider}' failed: ${failure}`, "info");
    options.onError?.(failure);
  }
  return piHas(runtime, provider, modelId);
}

/**
 * Add a model pi lacks to this process's pi catalog from hankweave's record
 * of it, with the request settings of a sibling pi has. Runtimes created
 * after this (createPiModelRuntime) see the row.
 */
export function injectPiModel(
  runtime: ModelRuntime,
  provider: string,
  modelId: string,
  record: ModelInfo,
  siblings: readonly Pick<ModelInfo, "modelId">[],
  logger?: Logger,
): { ok: true; sibling: string } | { ok: false; reason: string } {
  // The id to inject is the caller's: the base for an effort variant, the
  // literal id for a model whose own id ends in "-high".
  const baseId = modelId;
  // Never replace a row pi has: its own answer about that model stands.
  if (runtime.getModel(provider, baseId)) {
    return { ok: false, reason: `pi's catalog already lists '${provider}/${baseId}' as it is` };
  }
  const sibling = pickSibling([...runtime.getModels(provider)], baseId, siblings, record.reasoning);
  if (!sibling) {
    return {
      ok: false,
      reason: `pi's catalog has no '${provider}' model of the same family to copy request settings from`,
    };
  }
  const key = `${provider}/${baseId}`;
  injectedRows.set(key, { provider, row: injectedRow(baseId, record, sibling) });
  if (!writeGeneratedModelsJson(logger)) {
    injectedRows.delete(key);
    return { ok: false, reason: "the user's pi models.json could not be merged" };
  }
  logger?.log(
    `Injected ${provider}/${baseId} into pi's catalog (request settings from ${sibling.id})`,
    "info",
  );
  return { ok: true, sibling: `${provider}/${sibling.id}` };
}
