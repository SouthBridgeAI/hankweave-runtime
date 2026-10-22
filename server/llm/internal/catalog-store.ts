import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  getModelCatalogDir,
  isModelCatalogOffline,
  writeFileAtomic,
} from "../../model-catalog-settings.js";
import type { ProbeRecord } from "../../provider-probe.js";
import type { Logger } from "../../utils.js";
import { type BuiltCatalog, buildCatalogSnapshot, type CatalogLayers } from "./catalog-build.js";
import { normalizeLiteLlmPrices, type PriceReference } from "./litellm-prices.js";
import modelsDataRaw from "./models-dev-data.json" with { type: "json" };
import {
  parseModelsDataRows,
  toModelsData,
  transformModelsDevApi,
} from "./models-dev-transform.js";
import { BUNDLED_OVERLAY } from "./overlay.js";
import type { UserModelLayer } from "./user-models.js";

/**
 * Where the model catalog's layers live on disk and how they refresh (spec
 * 70, "Layers" and "When the catalog refreshes").
 *
 * The catalog directory holds one cache file per remote source plus the
 * probe results and pi's model store. Every write is atomic (temp file +
 * rename), so concurrent hankweave processes never read a torn file; a cache
 * that fails to parse is ignored, never fatal. With online model checks off
 * (see isModelCatalogOffline) every fetch is skipped: the catalog is then the
 * bundled data plus whatever is cached. Calls to the models are unaffected.
 *
 * The model overlay is not a remote source: it ships inside each release
 * (server/llm/internal/model-overlay.json) and changes only with one.
 */

export type CatalogSource = "models.dev" | "litellm";

export const CATALOG_SOURCE_URLS: Readonly<Record<CatalogSource, string>> = {
  "models.dev": "https://models.dev/api.json",
  litellm:
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
};

const CACHE_FILES: Readonly<Record<CatalogSource, string>> = {
  "models.dev": "models-dev.json",
  litellm: "litellm-prices.json",
};

const BUNDLED_OVERLAY_LAYER: CatalogLayers["overlay"] = {
  data: BUNDLED_OVERLAY,
  source: "bundled overlay",
};

/** A cached source is refreshed in the background once it is this old. */
const CATALOG_TTL_MS = 6 * 3600 * 1000;

/**
 * The default bound on one source's refresh, and the least a source without a
 * cache gets: a cold models.dev download is several megabytes, while a
 * caller's shorter bound is sized for revalidating a cached copy (one 304).
 */
const FULL_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Probe results older than this are dropped (registries catch up well within it). */
const PROBE_RETENTION_MS = 30 * 24 * 3600 * 1000;

function describeFetchError(error: unknown, timeoutMs: number): string {
  if (!(error instanceof Error)) return String(error);
  const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
  return timedOut ? `timed out after ${timeoutMs} ms` : error.message;
}

const cacheEnvelopeSchema = z.object({
  url: z.string(),
  etag: z.string().optional(),
  /** When the cached body was downloaded. */
  fetchedAt: z.string(),
  /** When the source last confirmed the body (a 200 or a 304). Drives the TTL. */
  checkedAt: z.string(),
  data: z.unknown(),
});
type CacheEnvelope = z.infer<typeof cacheEnvelopeSchema>;

const probeRecordSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  probedAt: z.string(),
  source: z.string(),
  name: z.string().optional(),
  limit: z
    .object({
      context: z.number().int().positive().optional(),
      output: z.number().int().positive().optional(),
    })
    .optional(),
  reasoning: z.boolean().optional(),
  attachment: z.boolean().optional(),
  releaseDate: z.string().optional(),
});
const probeFileSchema = z.object({ records: z.array(z.unknown()) });
const priceMapSchema = z.record(
  z.string(),
  z.object({
    input: z.number(),
    output: z.number(),
    cache_read: z.number().optional(),
    cache_write: z.number().optional(),
  }),
);

let bundledLayer: CatalogLayers["bundled"] | undefined;

/** The compiled-in models.dev snapshot, parsed once per process, row by row. */
export function loadBundledLayer(logger?: Logger): CatalogLayers["bundled"] {
  if (!bundledLayer) {
    const parsed = parseModelsDataRows(modelsDataRaw);
    if (parsed.skipped.length > 0) {
      const first = parsed.skipped[0];
      logger?.log(
        `Skipped ${parsed.skipped.length} malformed row(s) in the bundled model snapshot ` +
          `(first: ${first.key}: ${first.reason})`,
        "error",
      );
    }
    bundledLayer = { rows: parsed.rows, lastUpdated: parsed.lastUpdated };
  }
  return bundledLayer;
}

let bundledCatalog: BuiltCatalog | undefined;

/**
 * The catalog with no cache, network, or user layers: the bundled snapshot
 * plus the bundled overlay. What tests and a catalog-only lookup resolve
 * against. Built once per process.
 */
export function bundledCatalogSnapshot(logger?: Logger): BuiltCatalog {
  bundledCatalog ??= buildCatalogSnapshot({
    bundled: loadBundledLayer(logger),
    overlay: BUNDLED_OVERLAY_LAYER,
  });
  return bundledCatalog;
}

export interface RefreshResult {
  source: CatalogSource;
  outcome: "updated" | "not-modified" | "fresh" | "failed" | "offline";
  detail?: string;
}

export interface ModelCatalogStoreOptions {
  dir?: string;
  offline?: boolean;
  fetch?: typeof fetch;
  logger?: Logger;
  urls?: Partial<Record<CatalogSource, string>>;
  now?: () => Date;
}

/** Reads and refreshes the catalog's on-disk layers. */
export class ModelCatalogStore {
  readonly dir: string;
  readonly offline: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: Logger;
  private readonly urls: Record<CatalogSource, string>;
  private readonly now: () => Date;

  constructor(options: ModelCatalogStoreOptions = {}) {
    this.dir = options.dir ?? getModelCatalogDir();
    this.offline = options.offline ?? isModelCatalogOffline();
    this.fetchImpl = options.fetch ?? fetch;
    this.logger = options.logger;
    this.urls = { ...CATALOG_SOURCE_URLS, ...options.urls };
    this.now = options.now ?? (() => new Date());
  }

  private cachePath(source: CatalogSource): string {
    return path.join(this.dir, CACHE_FILES[source]);
  }

  private readJson(filePath: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger?.log(`Ignoring unreadable model catalog file ${filePath}: ${error}`, "info");
      }
      return undefined;
    }
  }

  private readEnvelope(source: CatalogSource): CacheEnvelope | undefined {
    const raw = this.readJson(this.cachePath(source));
    if (raw === undefined) return undefined;
    const parsed = cacheEnvelopeSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }

  /** Whether a source's cache is missing or older than the TTL. */
  isStale(source: CatalogSource): boolean {
    const envelope = this.readEnvelope(source);
    if (!envelope) return true;
    return this.now().getTime() - Date.parse(envelope.checkedAt) > CATALOG_TTL_MS;
  }

  private loadLive(): CatalogLayers["live"] {
    const envelope = this.readEnvelope("models.dev");
    if (!envelope) return undefined;
    const parsed = parseModelsDataRows(envelope.data);
    if (parsed.skipped.length > 0) {
      this.logger?.log(
        `Skipped ${parsed.skipped.length} malformed cached models.dev row(s)`,
        "info",
      );
    }
    return parsed.rows.length > 0
      ? { rows: parsed.rows, fetchedAt: envelope.fetchedAt }
      : undefined;
  }

  private loadLiteLlm(): CatalogLayers["litellm"] {
    const envelope = this.readEnvelope("litellm");
    const prices = envelope ? priceMapSchema.safeParse(envelope.data) : undefined;
    return envelope && prices?.success
      ? { prices: prices.data, fetchedAt: envelope.fetchedAt }
      : undefined;
  }

  /** Probe results still within retention. */
  loadProbes(): ProbeRecord[] {
    const file = probeFileSchema.safeParse(this.readJson(path.join(this.dir, "probes.json")));
    if (!file.success) return [];
    const cutoff = this.now().getTime() - PROBE_RETENTION_MS;
    const records: ProbeRecord[] = [];
    for (const raw of file.data.records) {
      const record = probeRecordSchema.safeParse(raw);
      if (record.success && Date.parse(record.data.probedAt) >= cutoff) records.push(record.data);
    }
    return records;
  }

  /** Persist a probe result (replacing any earlier one for the same model). */
  recordProbe(record: ProbeRecord): void {
    const key = `${record.providerId}/${record.modelId}`;
    const records = this.loadProbes().filter((r) => `${r.providerId}/${r.modelId}` !== key);
    records.push(record);
    writeFileAtomic(
      path.join(this.dir, "probes.json"),
      `${JSON.stringify({ records }, null, 2)}\n`,
    );
  }

  /** Every layer available without the network. */
  loadLayers(user: readonly UserModelLayer[] = []): CatalogLayers {
    return {
      bundled: loadBundledLayer(this.logger),
      live: this.loadLive(),
      litellm: this.loadLiteLlm(),
      probes: this.loadProbes(),
      overlay: BUNDLED_OVERLAY_LAYER,
      user,
      now: this.now(),
    };
  }

  /** Build the catalog from every layer available without the network. */
  build(user: readonly UserModelLayer[] = []): BuiltCatalog {
    return buildCatalogSnapshot(this.loadLayers(user));
  }

  /**
   * Refresh sources from the network. A source whose cache is younger than
   * the TTL is left alone unless `force` is set; a conditional request
   * (If-None-Match) keeps an unchanged source to one small 304. `timeoutMs`
   * bounds a revalidation; a source with no cache waits at least
   * FULL_DOWNLOAD_TIMEOUT_MS. A failed refresh keeps the existing cache.
   */
  async refresh(
    sources: readonly CatalogSource[],
    options: { force?: boolean; timeoutMs?: number } = {},
  ): Promise<RefreshResult[]> {
    return Promise.all(
      sources.map((source) =>
        this.refreshSource(
          source,
          options.force ?? false,
          options.timeoutMs ?? FULL_DOWNLOAD_TIMEOUT_MS,
        ),
      ),
    );
  }

  private async refreshSource(
    source: CatalogSource,
    force: boolean,
    revalidateTimeoutMs: number,
  ): Promise<RefreshResult> {
    if (this.offline) return { source, outcome: "offline" };
    const cached = this.readEnvelope(source);
    const age = cached
      ? this.now().getTime() - Date.parse(cached.checkedAt)
      : Number.POSITIVE_INFINITY;
    if (!force && age <= CATALOG_TTL_MS) return { source, outcome: "fresh" };
    const url = this.urls[source];
    const timeoutMs = cached
      ? revalidateTimeoutMs
      : Math.max(revalidateTimeoutMs, FULL_DOWNLOAD_TIMEOUT_MS);
    try {
      return await this.download(source, url, cached, timeoutMs);
    } catch (error) {
      return {
        source,
        outcome: "failed",
        detail: `${url}: ${describeFetchError(error, timeoutMs)}`,
      };
    }
  }

  /** A conditional GET of one source; the cache is rewritten only on a usable response. */
  private async download(
    source: CatalogSource,
    url: string,
    cached: CacheEnvelope | undefined,
    timeoutMs: number,
  ): Promise<RefreshResult> {
    const nowIso = this.now().toISOString();
    const etag = cached?.url === url ? cached.etag : undefined;
    const response = await this.fetchImpl(url, {
      headers: etag ? { "if-none-match": etag } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 304 && cached) {
      this.writeEnvelope(source, { ...cached, checkedAt: nowIso });
      return { source, outcome: "not-modified" };
    }
    if (!response.ok) {
      return { source, outcome: "failed", detail: `HTTP ${response.status} from ${url}` };
    }
    const data = this.normalize(source, await response.json());
    if (typeof data === "string") return { source, outcome: "failed", detail: data };
    this.writeEnvelope(source, {
      url,
      etag: response.headers.get("etag") ?? undefined,
      fetchedAt: nowIso,
      checkedAt: nowIso,
      data,
    });
    return { source, outcome: "updated" };
  }

  /** The cacheable form of a fetched body, or a string explaining why it was rejected. */
  private normalize(source: CatalogSource, body: unknown): unknown {
    if (source === "models.dev") {
      const parsed = transformModelsDevApi(body);
      if (parsed.rows.length === 0) return "models.dev response contained no usable rows";
      if (parsed.skipped.length > 0) {
        this.logger?.log(
          `models.dev refresh skipped ${parsed.skipped.length} malformed row(s)`,
          "info",
        );
      }
      return toModelsData(parsed, this.now().toISOString());
    }
    const prices: Record<string, PriceReference> = normalizeLiteLlmPrices(body);
    return Object.keys(prices).length > 0 ? prices : "LiteLLM response contained no usable prices";
  }

  private writeEnvelope(source: CatalogSource, envelope: CacheEnvelope): void {
    writeFileAtomic(this.cachePath(source), JSON.stringify(envelope));
  }
}
