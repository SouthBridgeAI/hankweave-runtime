import { z } from "zod";

/**
 * Provider probes (spec 70, "Provider probes"): ask a provider, with the
 * user's own key, whether it serves a model id — through its model-list API,
 * never a generation request, so a probe costs nothing. Used on a catalog
 * miss (a model newer than every registry) and for provider health checks.
 *
 * Bedrock is not probed: SigV4 signing would pull in the AWS SDK the project
 * deliberately keeps out; Bedrock ids arrive through models.dev instead.
 */

/** What a provider's model endpoint confirmed about one model. */
export interface ProbeRecord {
  providerId: string;
  modelId: string;
  /** ISO timestamp. */
  probedAt: string;
  /** e.g. "anthropic GET /v1/models/claude-sonnet-6". */
  source: string;
  name?: string;
  limit?: { context?: number; output?: number };
  reasoning?: boolean;
  attachment?: boolean;
  /** YYYY-MM-DD, when the provider reports a creation date. */
  releaseDate?: string;
}

export type ProbeOutcome =
  | { status: "found"; record: ProbeRecord }
  | { status: "absent"; source: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export interface ProbeOptions {
  /** Environment for base-URL overrides. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface ProbeRequest {
  url: string;
  headers: Record<string, string>;
  /** Method + path, for provenance ("GET /v1/models/x"). */
  label: string;
}

type ProbeFields = Omit<ProbeRecord, "providerId" | "modelId" | "probedAt" | "source">;

interface ProviderProbe {
  /** Env vars holding the provider's API key, in precedence order. */
  keyEnvVars: readonly string[];
  baseUrl(env: NodeJS.ProcessEnv): string;
  /** One-model lookup (a list endpoint where the provider has no per-model one). */
  model(base: string, modelId: string, key: string): ProbeRequest;
  /** Cheapest authenticated call, for health checks. */
  list(base: string, key: string): ProbeRequest;
  /** Fields from a 200 response; undefined when a list response lacks the id. */
  parse(body: unknown, modelId: string): ProbeFields | undefined;
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const positiveInt = z.number().int().positive();
const isoDay = (date: Date) => date.toISOString().substring(0, 10);

const anthropicModel = z.object({
  id: z.string(),
  display_name: z.string().optional(),
  created_at: z.string().optional(),
  max_input_tokens: positiveInt.optional(),
  max_tokens: positiveInt.optional(),
});
const openAiModel = z.object({ id: z.string(), created: z.number().optional() });
const openAiList = z.object({ data: z.array(z.object({ id: z.string() })) });
const googleModel = z.object({
  displayName: z.string().optional(),
  inputTokenLimit: positiveInt.optional(),
  outputTokenLimit: positiveInt.optional(),
  thinking: z.boolean().optional(),
});
const groqModel = z.object({
  id: z.string(),
  context_window: positiveInt.optional(),
  max_completion_tokens: positiveInt.optional(),
});
const mistralModel = z.object({
  id: z.string(),
  max_context_length: positiveInt.optional(),
  capabilities: z.object({ vision: z.boolean().optional() }).optional(),
});

const openAiCompatible = (
  defaultBase: string,
  baseEnvVar?: string,
): Omit<ProviderProbe, "keyEnvVars"> => ({
  baseUrl: (env) => trimSlash((baseEnvVar && env[baseEnvVar]) || defaultBase),
  model: (base, modelId, key) => ({
    url: `${base}/models/${encodeURIComponent(modelId)}`,
    headers: bearer(key),
    label: `GET /models/${modelId}`,
  }),
  list: (base, key) => ({ url: `${base}/models`, headers: bearer(key), label: "GET /models" }),
  parse: (body) => {
    const model = openAiModel.safeParse(body);
    if (!model.success) return {};
    return model.data.created ? { releaseDate: isoDay(new Date(model.data.created * 1000)) } : {};
  },
});

const PROBES: Record<string, ProviderProbe> = {
  anthropic: {
    keyEnvVars: ["ANTHROPIC_API_KEY"],
    // Claude Code reads ANTHROPIC_BASE_URL as the host and appends /v1; the
    // AI SDK client that sentinels use reads it as already ending in /v1.
    // Accept both spellings, so the health check that gates sentinels agrees
    // with whichever client the user configured the proxy for.
    baseUrl: (env) => {
      const base = trimSlash(env.ANTHROPIC_BASE_URL || "https://api.anthropic.com");
      return base.endsWith("/v1") ? base : `${base}/v1`;
    },
    model: (base, modelId, key) => ({
      url: `${base}/models/${encodeURIComponent(modelId)}`,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      label: `GET /v1/models/${modelId}`,
    }),
    list: (base, key) => ({
      url: `${base}/models?limit=1`,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      label: "GET /v1/models",
    }),
    parse: (body) => {
      const model = anthropicModel.safeParse(body);
      if (!model.success) return {};
      const { display_name, created_at, max_input_tokens, max_tokens } = model.data;
      return {
        ...(display_name ? { name: display_name } : {}),
        ...(created_at ? { releaseDate: created_at.substring(0, 10) } : {}),
        ...(max_input_tokens || max_tokens
          ? { limit: { context: max_input_tokens, output: max_tokens } }
          : {}),
      };
    },
  },
  openai: {
    keyEnvVars: ["OPENAI_API_KEY"],
    ...openAiCompatible("https://api.openai.com/v1", "OPENAI_BASE_URL"),
  },
  google: {
    keyEnvVars: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    baseUrl: () => "https://generativelanguage.googleapis.com/v1beta",
    model: (base, modelId, key) => ({
      url: `${base}/models/${encodeURIComponent(modelId)}`,
      headers: { "x-goog-api-key": key },
      label: `GET /v1beta/models/${modelId}`,
    }),
    list: (base, key) => ({
      url: `${base}/models?pageSize=1`,
      headers: { "x-goog-api-key": key },
      label: "GET /v1beta/models",
    }),
    parse: (body) => {
      const model = googleModel.safeParse(body);
      if (!model.success) return {};
      const { displayName, inputTokenLimit, outputTokenLimit, thinking } = model.data;
      return {
        ...(displayName ? { name: displayName } : {}),
        ...(inputTokenLimit || outputTokenLimit
          ? { limit: { context: inputTokenLimit, output: outputTokenLimit } }
          : {}),
        ...(thinking !== undefined ? { reasoning: thinking } : {}),
      };
    },
  },
  deepseek: {
    keyEnvVars: ["DEEPSEEK_API_KEY"],
    baseUrl: (env) => trimSlash(env.DEEPSEEK_BASE_URL || "https://api.deepseek.com"),
    // DeepSeek has no per-model endpoint; search the list.
    model: (base, _modelId, key) => ({
      url: `${base}/models`,
      headers: bearer(key),
      label: "GET /models",
    }),
    list: (base, key) => ({ url: `${base}/models`, headers: bearer(key), label: "GET /models" }),
    parse: (body, modelId) => {
      const list = openAiList.safeParse(body);
      if (!list.success) return undefined;
      return list.data.data.some((m) => m.id === modelId) ? {} : undefined;
    },
  },
  groq: {
    keyEnvVars: ["GROQ_API_KEY"],
    ...openAiCompatible("https://api.groq.com/openai/v1"),
    parse: (body) => {
      const model = groqModel.safeParse(body);
      if (!model.success) return {};
      const { context_window, max_completion_tokens } = model.data;
      return context_window || max_completion_tokens
        ? { limit: { context: context_window, output: max_completion_tokens } }
        : {};
    },
  },
  xai: {
    keyEnvVars: ["XAI_API_KEY"],
    ...openAiCompatible("https://api.x.ai/v1"),
  },
  mistral: {
    keyEnvVars: ["MISTRAL_API_KEY"],
    ...openAiCompatible("https://api.mistral.ai/v1"),
    parse: (body) => {
      const model = mistralModel.safeParse(body);
      if (!model.success) return {};
      return {
        ...(model.data.max_context_length
          ? { limit: { context: model.data.max_context_length } }
          : {}),
        ...(model.data.capabilities?.vision !== undefined
          ? { attachment: model.data.capabilities.vision }
          : {}),
      };
    },
  },
};

/** Whether hankweave can probe this provider's model list. */
export function isProbeableProvider(providerId: string): boolean {
  return providerId.toLowerCase() in PROBES;
}

/** The provider's API key from an environment, per the probe's env vars. */
export function probeApiKey(providerId: string, env: NodeJS.ProcessEnv): string | undefined {
  const probe = PROBES[providerId.toLowerCase()];
  for (const name of probe?.keyEnvVars ?? []) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

async function send(request: ProbeRequest, options: ProbeOptions): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  return doFetch(request.url, {
    headers: request.headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  });
}

function describeFailure(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timed out";
  }
  // Callers end the sentence themselves: drop the message's own full stop or
  // question mark (Bun's "… access the url?") so it does not read "?.".
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[.?!]+$/, "");
}

/**
 * Ask a provider whether it serves `modelId`, with `apiKey`. A 404 (or a list
 * without the id) is "absent"; any other failure is "failed" and says why.
 */
export async function probeModel(
  providerId: string,
  modelId: string,
  apiKey: string | undefined,
  options: ProbeOptions = {},
): Promise<ProbeOutcome> {
  const provider = providerId.toLowerCase();
  const probe = PROBES[provider];
  if (!probe)
    return { status: "skipped", reason: `no model-list probe for provider '${provider}'` };
  if (!apiKey) {
    return {
      status: "skipped",
      reason: `no API key for '${provider}' (${probe.keyEnvVars.join(" or ")})`,
    };
  }

  const request = probe.model(probe.baseUrl(options.env ?? process.env), modelId, apiKey);
  const source = `${provider} ${request.label}`;
  let response: Response;
  try {
    response = await send(request, options);
  } catch (error) {
    return { status: "failed", reason: `${source}: ${describeFailure(error)}` };
  }
  if (response.status === 404) return { status: "absent", source };
  if (!response.ok) {
    return { status: "failed", reason: `${source}: HTTP ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { status: "failed", reason: `${source}: response is not JSON` };
  }
  const fields = probe.parse(body, modelId);
  if (!fields) return { status: "absent", source };
  return {
    status: "found",
    record: {
      providerId: provider,
      modelId,
      probedAt: new Date().toISOString(),
      source,
      ...fields,
    },
  };
}

/**
 * The cheapest authenticated call a provider accepts — its model list. Used
 * by provider health checks in place of a billable generation request. A
 * failure carries the HTTP status when the provider answered, so a rejected
 * key (401/403) is distinguishable from an unreachable provider.
 */
export async function probeProviderAccess(
  providerId: string,
  apiKey: string,
  options: ProbeOptions = {},
): Promise<{ ok: true } | { ok: false; reason: string; status?: number }> {
  const provider = providerId.toLowerCase();
  const probe = PROBES[provider];
  if (!probe) return { ok: false, reason: `no model-list probe for provider '${provider}'` };
  const request = probe.list(probe.baseUrl(options.env ?? process.env), apiKey);
  try {
    const response = await send(request, options);
    if (response.ok) return { ok: true };
    return {
      ok: false,
      reason: `${provider} ${request.label}: HTTP ${response.status}`,
      status: response.status,
    };
  } catch (error) {
    return { ok: false, reason: `${provider} ${request.label}: ${describeFailure(error)}` };
  }
}
