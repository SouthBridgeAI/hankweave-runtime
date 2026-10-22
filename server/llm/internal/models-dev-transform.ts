import { type ZodError, z } from "zod";
import {
  type ModelInfo,
  type ModelsData,
  modelInfoSchema,
  modelsDevModelSchema,
} from "./models-dev-schema.js";

/**
 * Row-by-row parsing for model data (spec 70). Both the bundled snapshot and
 * the live models.dev catalog are validated one model at a time: a malformed
 * row is skipped and reported, never allowed to discard every other row. (The
 * previous loader parsed the whole file with one schema, so a single bad
 * custom row left the registry empty and every model "not found".)
 *
 * The envelope schemas below are deliberately loose — they only establish the
 * shape needed to reach each row; the rows themselves are validated strictly.
 */

export interface SkippedRow {
  /** "provider/model", or a path when the row has no usable key. */
  key: string;
  reason: string;
}

export interface ParsedRows {
  rows: ModelInfo[];
  skipped: SkippedRow[];
  /** Provider id → display name, as the source published it. */
  providerNames: Map<string, string>;
  /** The source's own timestamp, when it carries one (our file format does). */
  lastUpdated?: string;
}

/** hankweave's model-data file: { version, lastUpdated, providers: [...] }. */
const dataFileEnvelope = z.object({
  lastUpdated: z.string().optional(),
  providers: z.array(z.unknown()),
});
const dataFileProvider = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  models: z.array(z.unknown()),
});
/** models.dev api.json: { [providerId]: { name, models: { [modelId]: row } } }. */
const apiEnvelope = z.record(z.string(), z.unknown());
const apiProvider = z.object({
  name: z.string().optional(),
  models: z.record(z.string(), z.unknown()),
});
const rowKey = z.object({ modelId: z.string() });

function firstIssue(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid";
  const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue.message}`;
}

/**
 * Parse hankweave's own model-data file format — the bundled snapshot and the
 * catalog's cached copy of models.dev.
 */
export function parseModelsDataRows(raw: unknown): ParsedRows {
  const result: ParsedRows = { rows: [], skipped: [], providerNames: new Map() };
  const envelope = dataFileEnvelope.safeParse(raw);
  if (!envelope.success) {
    result.skipped.push({ key: "(file)", reason: firstIssue(envelope.error) });
    return result;
  }
  result.lastUpdated = envelope.data.lastUpdated;

  for (const [index, entry] of envelope.data.providers.entries()) {
    const provider = dataFileProvider.safeParse(entry);
    if (!provider.success) {
      result.skipped.push({ key: `providers[${index}]`, reason: firstIssue(provider.error) });
      continue;
    }
    const { id, name, models } = provider.data;
    if (name) result.providerNames.set(id, name);
    for (const model of models) {
      const parsed = modelInfoSchema.safeParse(model);
      if (parsed.success) {
        result.rows.push(parsed.data);
      } else {
        const modelId = rowKey.safeParse(model).data?.modelId ?? "?";
        result.skipped.push({ key: `${id}/${modelId}`, reason: firstIssue(parsed.error) });
      }
    }
  }
  return result;
}

/**
 * Transform models.dev's api.json into ModelInfo rows. Rows with
 * non-positive limits are skipped, as the fetch script always did:
 * hankweave's limit schema requires positive integers, and a zero limit
 * means "unknown" upstream.
 */
export function transformModelsDevApi(raw: unknown): ParsedRows {
  const result: ParsedRows = { rows: [], skipped: [], providerNames: new Map() };
  const envelope = apiEnvelope.safeParse(raw);
  if (!envelope.success) {
    result.skipped.push({ key: "(file)", reason: firstIssue(envelope.error) });
    return result;
  }

  for (const [providerId, entry] of Object.entries(envelope.data)) {
    const provider = apiProvider.safeParse(entry);
    if (!provider.success) {
      result.skipped.push({ key: providerId, reason: firstIssue(provider.error) });
      continue;
    }
    if (provider.data.name) result.providerNames.set(providerId, provider.data.name);
    for (const [modelId, model] of Object.entries(provider.data.models)) {
      const row = toModelInfo(providerId, modelId, model);
      if (typeof row === "string")
        result.skipped.push({ key: `${providerId}/${modelId}`, reason: row });
      else result.rows.push(row);
    }
  }
  return result;
}

/** One models.dev row as a ModelInfo, or the reason it was skipped. */
function toModelInfo(providerId: string, modelId: string, model: unknown): ModelInfo | string {
  const upstream = modelsDevModelSchema.safeParse(model);
  if (!upstream.success) return firstIssue(upstream.error);
  const data = upstream.data;
  if (data.limit.context <= 0 || data.limit.output <= 0) {
    return "non-positive limits (unknown upstream)";
  }
  const row = modelInfoSchema.safeParse({
    providerId,
    modelId,
    name: data.name,
    family: data.family,
    attachment: data.attachment,
    reasoning: data.reasoning,
    tool_call: data.tool_call,
    temperature: data.temperature,
    cost: data.cost || undefined,
    limit: { context: data.limit.context, output: data.limit.output },
    modalities: { input: data.modalities.input, output: data.modalities.output },
    knowledge: data.knowledge,
    release_date: data.release_date,
    last_updated: data.last_updated,
  });
  return row.success ? row.data : firstIssue(row.error);
}

/**
 * Group rows back into the file format (fetch script output, catalog cache).
 * Rows are grouped by provider in first-seen order; provenance is stripped —
 * it is catalog state, not source data.
 */
export function toModelsData(parsed: ParsedRows, lastUpdated: string): ModelsData {
  const byProvider = new Map<string, ModelInfo[]>();
  for (const row of parsed.rows) {
    const { provenance: _provenance, ...data } = row;
    const list = byProvider.get(row.providerId);
    if (list) list.push(data);
    else byProvider.set(row.providerId, [data]);
  }
  return {
    version: "1.0.0",
    lastUpdated,
    providers: [...byProvider].map(([id, models]) => ({
      id,
      name: parsed.providerNames.get(id) ?? id,
      models,
    })),
  };
}
