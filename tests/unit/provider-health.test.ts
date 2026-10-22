import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelInfo, Models } from "../../server/llm/index.js";
import { PROVIDER_DEFINITIONS } from "../../server/sentinels/provider-config.js";
import {
  isModelAccessDenialError,
  ProviderHealth,
  type ProviderHealthConfig,
} from "../../server/sentinels/provider-health.js";
import { Logger } from "../../server/utils.js";
import { captureEnv, restoreEnv } from "../utils/env-test-helpers.js";

/**
 * ProviderHealth is the sentinel half of the former LlmProviderRegistry
 * (spec 72): credentials per AI SDK provider, health checks, blocklists,
 * pricing, and the LanguageModel a sentinel calls. Model records come from an
 * injected exact "provider/model" lookup, so nothing here depends on the
 * bundled catalog. Every outbound request goes to a stubbed globalThis.fetch.
 */

const BEDROCK_HAIKU = "anthropic.claude-haiku-4-5-20251001-v1:0";

function model(providerId: string, modelId: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    providerId,
    modelId,
    name: modelId,
    attachment: false,
    reasoning: false,
    tool_call: true,
    temperature: true,
    cost: { input: 1, output: 2 },
    limit: { context: 100_000, output: 8_000 },
    modalities: { input: ["text"], output: ["text"] },
    release_date: "2025-01-01",
    last_updated: "2025-01-01",
    ...overrides,
  };
}

const FIXTURE_MODELS: ModelInfo[] = [
  model("anthropic", "claude-sonnet-4-5-20250929", {
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    limit: { context: 200_000, output: 64_000 },
  }),
  model("openai", "gpt-4o-2024-08-06", {
    cost: { input: 2.5, output: 10, cache_read: 1.25 },
  }),
  model("openai", "gpt-4o-2024-05-13"),
  model("openai", "o-no-temperature", {
    temperature: false,
    limit: { context: 100_000, output: 1_000 },
  }),
  model("groq", "llama-3.1-8b-instant"),
  model("google", "gemini-2.5-pro"),
  model("amazon-bedrock", `us.${BEDROCK_HAIKU}`, { cost: { input: 1, output: 5 } }),
  model("anthropic", "claude-unpriced", { cost: undefined }),
  model("anthropic", "claude-disputed", {
    cost: { input: 1, output: 2 },
    provenance: {
      confidence: "registry",
      source: "test",
      priceStatus: "disputed",
      budgetCost: { input: 2, output: 4 },
    },
  }),
  // A model id that itself contains a slash: the provider is the first segment.
  model("openai", "org/nested-model"),
];

/** An exact, case-sensitive lookup that records every query. */
function fixtureModels(records: ModelInfo[] = FIXTURE_MODELS) {
  const calls: Array<[string, string]> = [];
  const byKey = new Map(records.map((r) => [`${r.providerId}/${r.modelId}`, r]));
  return {
    calls,
    get(provider: string, id: string): ModelInfo | undefined {
      calls.push([provider, id]);
      return byKey.get(`${provider}/${id}`);
    },
  };
}

/** Every env var a provider definition reads, plus base-URL overrides. */
const PROVIDER_ENV_KEYS = [
  ...PROVIDER_DEFINITIONS.flatMap((d) => [d.apiKeyEnvVar, `HANKWEAVE_SENTINEL_${d.apiKeyEnvVar}`]),
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "DEEPSEEK_BASE_URL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
];

type FetchInput = Parameters<typeof fetch>[0];
type FetchHandler = (url: string, init: RequestInit | undefined) => Promise<Response> | Response;

interface SeenRequest {
  url: string;
  headers: Record<string, string>;
}

let originalEnv: Record<string, string | undefined>;
let originalFetch: typeof fetch;
let fetchHandler: FetchHandler;
let seen: SeenRequest[];
let logs: Array<{ message: string; level: string }>;
let awsDir: string;

const logger = new Logger("/tmp/provider-health-test.log");
logger.log = (message: string, level = "info") => {
  logs.push({ message, level });
};

function headersOf(input: FetchInput, init: RequestInit | undefined) {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  for (const [k, v] of new Headers(init?.headers)) headers.set(k, v);
  return Object.fromEntries(headers);
}

function health(config: Partial<ProviderHealthConfig> = {}) {
  return new ProviderHealth({ logger, models: fixtureModels(), ...config });
}

/** A Bedrock Converse reply carrying one text block. */
function converseReply(text = "Hi") {
  return Response.json({
    output: { message: { role: "assistant", content: [{ text }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  });
}

function bedrockError(status: number, message: string) {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The (URL-decoded) model id in a Bedrock /model/<id>/converse request, if any. */
function bedrockModelOf(url: string): string | undefined {
  const match = /\/model\/([^/]+)\/converse/.exec(url);
  return match ? decodeURIComponent(match[1]) : undefined;
}

beforeEach(() => {
  logs = [];
  seen = [];
  originalEnv = captureEnv();
  for (const key of PROVIDER_ENV_KEYS) delete process.env[key];
  // Point the file-backed AWS sources at an empty temp dir so the developer's
  // real ~/.aws never decides these assertions.
  awsDir = mkdtempSync(join(tmpdir(), "provider-health-test-"));
  process.env.AWS_SHARED_CREDENTIALS_FILE = join(awsDir, "credentials");
  process.env.AWS_CONFIG_FILE = join(awsDir, "config");

  originalFetch = globalThis.fetch;
  fetchHandler = (url) => {
    throw new Error(`unexpected network request: ${url}`);
  };
  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    seen.push({ url, headers: headersOf(input, init) });
    return fetchHandler(url, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv(originalEnv);
  rmSync(awsDir, { recursive: true, force: true });
});

describe("ProviderHealth — credentials and provider status", () => {
  it("covers every provider definition, all not-configured without credentials", () => {
    const statuses = health().getProviderStatus();
    expect(statuses.size).toBe(PROVIDER_DEFINITIONS.length);
    for (const def of PROVIDER_DEFINITIONS) {
      expect(statuses.get(def.id.toLowerCase())?.status).toBe("not-configured");
    }
  });

  it("names both env vars it checked for a single-key provider", () => {
    const status = health().getProviderStatus().get("anthropic");
    expect(status?.status).toBe("not-configured");
    if (status?.status === "not-configured") {
      expect(status.error).toContain("No API key found");
      expect(status.error).toContain("HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY");
      expect(status.error).toContain("ANTHROPIC_API_KEY");
    }
    expect(logs.some((l) => l.message.includes("No API key"))).toBe(true);
  });

  it("is available (not yet healthy) with a standard API key, and logs the source", () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.OPENAI_API_KEY = "test-openai-key";
    const statuses = health().getProviderStatus();
    for (const id of ["anthropic", "openai"]) {
      const status = statuses.get(id);
      expect(status?.status).toBe("available");
      if (status?.status === "available") expect(status.healthy).toBe(false);
    }
    expect(statuses.get("groq")?.status).toBe("not-configured");
    expect(
      logs.some((l) => l.message === "Provider anthropic: Initialized (using ANTHROPIC_API_KEY)"),
    ).toBe(true);
  });

  it("honors a HANKWEAVE_SENTINEL_ override with no standard key set", () => {
    process.env.HANKWEAVE_SENTINEL_OPENAI_API_KEY = "sentinel-only";
    expect(health().getProviderStatus().get("openai")?.status).toBe("available");
    expect(
      logs.some(
        (l) =>
          l.message === "Provider openai: Initialized (using HANKWEAVE_SENTINEL_OPENAI_API_KEY)",
      ),
    ).toBe(true);
  });

  it("prefers the HANKWEAVE_SENTINEL_ override over the standard key", () => {
    process.env.ANTHROPIC_API_KEY = "standard";
    process.env.HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY = "override";
    health();
    expect(
      logs.some(
        (l) =>
          l.message ===
          "Provider anthropic: Initialized (using HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY)",
      ),
    ).toBe(true);
  });

  it("returns a copy of the status map", () => {
    const registry = health();
    registry.getProviderStatus().clear();
    expect(registry.getProviderStatus().size).toBe(PROVIDER_DEFINITIONS.length);
  });
});

/**
 * amazon-bedrock is the one provider authenticated by a credential chain
 * instead of a single API key: availability must follow the explicit env
 * sources (bearer token, key pair) and the not-configured error must say the
 * chain was consulted — not "missing API key".
 */
describe("ProviderHealth — amazon-bedrock availability", () => {
  const bedrockStatus = () => health().getProviderStatus().get("amazon-bedrock");

  it("is not-configured with no credential source, and names the accepted sources", () => {
    const status = bedrockStatus();
    expect(status?.status).toBe("not-configured");
    if (status?.status === "not-configured") {
      expect(status.error).toContain("No credentials found");
      expect(status.error).toContain("ambient detection");
      expect(status.error).toContain("AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY");
      expect(status.error).toContain("not sentinels");
    }
  });

  it("is available with AWS_BEARER_TOKEN_BEDROCK", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-bearer-token";
    expect(bedrockStatus()?.status).toBe("available");
  });

  it("is available with an explicit env key pair (ambient detection)", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
    process.env.AWS_SECRET_ACCESS_KEY = "testsecret";
    expect(bedrockStatus()?.status).toBe("available");
    expect(
      logs.some((l) =>
        l.message.includes(
          "Provider amazon-bedrock: Initialized (using AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY)",
        ),
      ),
    ).toBe(true);
  });

  it("is not available with half a key pair", () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
    expect(bedrockStatus()?.status).toBe("not-configured");
  });

  it("is NOT available via a credentials-file profile — codon-only source (dependency-trim asymmetry)", () => {
    // Sentinels deliberately skip the file/SSO/container chain: resolving it
    // needs @aws-sdk/credential-providers (~6MB transitive tree), which is
    // kept out of the bundle. Codons on this machine still run Bedrock fine.
    writeFileSync(
      process.env.AWS_SHARED_CREDENTIALS_FILE as string,
      "[default]\naws_access_key_id = AKIATEST\naws_secret_access_key = testsecret\n",
    );
    process.env.AWS_PROFILE = "default";
    expect(bedrockStatus()?.status).toBe("not-configured");
  });

  it("honors the HANKWEAVE_SENTINEL_ bearer override", () => {
    process.env.HANKWEAVE_SENTINEL_AWS_BEARER_TOKEN_BEDROCK = "override-token";
    expect(bedrockStatus()?.status).toBe("available");
  });

  it("looks up the bedrock haiku inference profile and names it as the health-check model", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-bearer-token";
    const registry = health();
    const info = registry.getModelInfo(`amazon-bedrock/us.${BEDROCK_HAIKU}`);
    expect(info.success).toBe(true);
    if (info.success) {
      expect(info.info.providerId).toBe("amazon-bedrock");
      expect(info.info.cost).toBeDefined();
    }
    expect(registry.getHealthCheckModel("amazon-bedrock")).toBe(`us.${BEDROCK_HAIKU}`);
  });

  it("health-check candidates follow the configured region's geo profile", () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-bearer-token";
    const candidatesFor = (region?: string) => {
      if (region) process.env.AWS_REGION = region;
      else delete process.env.AWS_REGION;
      return health().getHealthCheckModelCandidates("amazon-bedrock");
    };

    // No region → default (us-east-1) → us. profile, global. as fall-through
    expect(candidatesFor()).toEqual([`us.${BEDROCK_HAIKU}`, `global.${BEDROCK_HAIKU}`]);
    expect(candidatesFor("eu-west-1")).toEqual([`eu.${BEDROCK_HAIKU}`, `global.${BEDROCK_HAIKU}`]);
    expect(candidatesFor("ap-northeast-1")[0]).toBe(`jp.${BEDROCK_HAIKU}`);
    expect(candidatesFor("ap-southeast-2")[0]).toBe(`au.${BEDROCK_HAIKU}`);
    // No geo-specific Anthropic profile → global. only
    expect(candidatesFor("ap-south-1")).toEqual([`global.${BEDROCK_HAIKU}`]);
    // GovCloud partition: us-gov. only — commercial us. and global. aren't
    // callable from it, and no catalog record is needed for the candidate.
    expect(candidatesFor("us-gov-east-1")).toEqual([`us-gov.${BEDROCK_HAIKU}`]);
  });

  it("falls back to AWS_DEFAULT_REGION for the candidates", () => {
    process.env.AWS_DEFAULT_REGION = "eu-central-1";
    expect(health().getHealthCheckModel("amazon-bedrock")).toBe(`eu.${BEDROCK_HAIKU}`);
  });
});

describe("ProviderHealth — health-check candidates", () => {
  it("are only the provider definition's list: none for list-probe providers or unknown ids", () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    // The fixture has priced anthropic/openai records; no cheapest-model
    // fallback may turn them into candidates.
    const registry = health();
    for (const id of ["anthropic", "openai", "google", "groq", "deepseek", "no-such-provider"]) {
      expect(registry.getHealthCheckModelCandidates(id)).toEqual([]);
      expect(registry.getHealthCheckModel(id)).toBeUndefined();
    }
  });
});

describe("ProviderHealth — performHealthChecks", () => {
  it("does nothing on the network when no provider has credentials", async () => {
    const statuses = await health().performHealthChecks();
    expect(statuses.size).toBe(PROVIDER_DEFINITIONS.length);
    expect(seen).toEqual([]);
  });

  it("checks list-probe providers by listing models, never by generating", async () => {
    process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
    process.env.OPENAI_API_KEY = "test-openai-key";
    fetchHandler = () => Response.json({ data: [] });

    const statuses = await health().performHealthChecks();

    for (const id of ["anthropic", "openai"]) {
      const status = statuses.get(id);
      expect(status?.status).toBe("available");
      if (status?.status === "available") {
        expect(status.healthy).toBe(true);
        expect(status.error).toBeUndefined();
        expect(status.lastChecked).toBeInstanceOf(Date);
      }
    }
    const urls = seen.map((r) => r.url).sort();
    expect(urls).toEqual([
      "https://api.anthropic.com/v1/models?limit=1",
      "https://api.openai.com/v1/models",
    ]);
    const anthropic = seen.find((r) => r.url.includes("anthropic"));
    expect(anthropic?.headers["x-api-key"]).toBe("test-anthropic-key");
  });

  it("probes with the HANKWEAVE_SENTINEL_ override key, not the standard one", async () => {
    process.env.OPENAI_API_KEY = "standard";
    process.env.HANKWEAVE_SENTINEL_OPENAI_API_KEY = "override";
    fetchHandler = () => Response.json({ data: [] });

    await health().performHealthChecks();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.headers.authorization).toBe("Bearer override");
  });

  it("follows the provider base-URL override for the list probe", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_BASE_URL = "http://proxy.invalid";
    fetchHandler = () => Response.json({ data: [] });

    await health().performHealthChecks();

    expect(seen.map((r) => r.url)).toEqual(["http://proxy.invalid/v1/models?limit=1"]);
  });

  it("marks a provider unhealthy when its key is rejected, carrying the HTTP status", async () => {
    process.env.ANTHROPIC_API_KEY = "revoked";
    fetchHandler = () => new Response("unauthorized", { status: 401 });

    const registry = health();
    const statuses = await registry.performHealthChecks();

    const status = statuses.get("anthropic");
    expect(status?.status).toBe("available");
    if (status?.status === "available") {
      expect(status.healthy).toBe(false);
      expect(status.error).toBe("Health check failed: anthropic GET /v1/models: HTTP 401");
      expect(status.lastChecked).toBeInstanceOf(Date);
    }
    expect(logs.some((l) => l.level === "error" && l.message.includes("HTTP 401"))).toBe(true);
    // An unhealthy provider refuses sentinel models.
    const result = registry.getProviderForModel("anthropic/claude-sonnet-4-5-20250929");
    expect(result).toEqual({ success: false, reason: "provider-unhealthy" });
  });

  it("marks a provider unhealthy when its list probe cannot be reached", async () => {
    process.env.GROQ_API_KEY = "test-key";
    fetchHandler = () => {
      throw new Error("connect ECONNREFUSED");
    };

    const status = (await health().performHealthChecks()).get("groq");
    expect(status?.status).toBe("available");
    if (status?.status === "available") {
      expect(status.healthy).toBe(false);
      expect(status.error).toContain("ECONNREFUSED");
    }
  });

  it("reports a list-probe timeout as a failure and still completes", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    fetchHandler = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });

    const status = (await health({ healthCheckTimeout: 20 }).performHealthChecks()).get(
      "anthropic",
    );
    expect(status?.status).toBe("available");
    if (status?.status === "available") {
      expect(status.healthy).toBe(false);
      expect(status.error).toBe("Health check failed: anthropic GET /v1/models: timed out");
    }
  });

  it("checks one provider's failure without affecting another's success", async () => {
    process.env.ANTHROPIC_API_KEY = "good";
    process.env.OPENAI_API_KEY = "bad";
    fetchHandler = (url) =>
      url.includes("openai") ? new Response("nope", { status: 403 }) : Response.json({ data: [] });

    const statuses = await health().performHealthChecks();
    const anthropic = statuses.get("anthropic");
    const openai = statuses.get("openai");
    expect(anthropic?.status === "available" && anthropic.healthy).toBe(true);
    expect(openai?.status === "available" && openai.healthy).toBe(false);
  });

  it("returns a snapshot and records it for getProviderStatus and getProviderForModel", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    fetchHandler = () => Response.json({ data: [] });
    const registry = health();

    // Before any check, an available provider is not yet healthy.
    expect(registry.getProviderForModel("anthropic/claude-sonnet-4-5-20250929")).toEqual({
      success: false,
      reason: "provider-unhealthy",
    });
    expect(registry.isModelAvailable("anthropic/claude-sonnet-4-5-20250929")).toBe(false);

    const snapshot = await registry.performHealthChecks();
    snapshot.clear();
    const status = registry.getProviderStatus().get("anthropic");
    expect(status?.status === "available" && status.healthy).toBe(true);
    expect(registry.isModelAvailable("anthropic/claude-sonnet-4-5-20250929")).toBe(true);
  });

  it("runs in the background when performHealthCheckOnInit is set", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    let release: () => void = () => {};
    const probed = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchHandler = () => {
      release();
      return Response.json({ data: [] });
    };

    const registry = health({ performHealthCheckOnInit: true });
    await probed;
    // Let the status update settle after the probe resolves.
    for (let i = 0; i < 20; i++) {
      const s = registry.getProviderStatus().get("anthropic");
      if (s?.status === "available" && s.healthy) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const status = registry.getProviderStatus().get("anthropic");
    expect(status?.status === "available" && status.healthy).toBe(true);
  });

  describe("amazon-bedrock (generation against the candidates)", () => {
    beforeEach(() => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = "test-bearer-token";
      process.env.AWS_REGION = "eu-west-1";
    });

    const bedrockStatusAfterCheck = async (timeout?: number) =>
      (await health({ healthCheckTimeout: timeout }).performHealthChecks()).get("amazon-bedrock");

    it("is healthy when the first candidate answers, and tries no other", async () => {
      fetchHandler = () => converseReply();

      const status = await bedrockStatusAfterCheck();
      expect(status?.status === "available" && status.healthy).toBe(true);
      expect(seen.map((r) => bedrockModelOf(r.url))).toEqual([`eu.${BEDROCK_HAIKU}`]);
      expect(seen[0]?.url).toContain("bedrock-runtime.eu-west-1.amazonaws.com");
      expect(seen[0]?.headers.authorization).toBe("Bearer test-bearer-token");
    });

    it("falls through to the next candidate when one fails", async () => {
      fetchHandler = (url) =>
        bedrockModelOf(url)?.startsWith("eu.")
          ? bedrockError(400, "The provided model identifier is invalid.")
          : converseReply();

      const status = await bedrockStatusAfterCheck();
      expect(status?.status === "available" && status.healthy).toBe(true);
      expect(seen.map((r) => bedrockModelOf(r.url))).toEqual([
        `eu.${BEDROCK_HAIKU}`,
        `global.${BEDROCK_HAIKU}`,
      ]);
    });

    it("is unhealthy with the last candidate's error when every candidate fails", async () => {
      fetchHandler = (url) =>
        bedrockError(
          400,
          bedrockModelOf(url)?.startsWith("eu.") ? "first failure" : "last failure",
        );

      const status = await bedrockStatusAfterCheck();
      expect(status?.status).toBe("available");
      if (status?.status === "available") {
        expect(status.healthy).toBe(false);
        expect(status.error).toStartWith("Health check failed:");
        expect(status.error).toContain("last failure");
        expect(status.error).not.toContain("first failure");
      }
      expect(seen).toHaveLength(2);
    });

    it("treats a per-model access denial as proof the credentials work", async () => {
      fetchHandler = () =>
        bedrockError(403, "You don't have access to the model with the specified model ID.");

      const status = await bedrockStatusAfterCheck();
      expect(status?.status === "available" && status.healthy).toBe(true);
      // The first candidate's denial is enough; the fallback is never billed.
      expect(seen).toHaveLength(1);
      expect(logs.some((l) => l.message.includes("not enabled for this account"))).toBe(true);
    });

    it("does not treat an IAM invoke denial as healthy", async () => {
      fetchHandler = () =>
        bedrockError(
          403,
          "User: arn:aws:iam::123:user/x is not authorized to perform: bedrock:InvokeModel",
        );

      const status = await bedrockStatusAfterCheck();
      expect(status?.status).toBe("available");
      if (status?.status === "available") {
        expect(status.healthy).toBe(false);
        expect(status.error).toContain("not authorized");
      }
    });

    it("aborts a hung candidate on timeout and reports it", async () => {
      fetchHandler = (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });

      const status = await bedrockStatusAfterCheck(20);
      expect(status?.status).toBe("available");
      if (status?.status === "available") {
        expect(status.healthy).toBe(false);
        expect(status.error).toBe("Health check failed: Error: Health check timeout");
      }
      // Each candidate was tried once and aborted, in order.
      expect(seen.map((r) => bedrockModelOf(r.url))).toEqual([
        `eu.${BEDROCK_HAIKU}`,
        `global.${BEDROCK_HAIKU}`,
      ]);
    });

    it("signs with the env key pair when there is no bearer token", async () => {
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
      process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
      process.env.AWS_SECRET_ACCESS_KEY = "testsecret";
      fetchHandler = () => converseReply();

      const status = await bedrockStatusAfterCheck();
      expect(status?.status === "available" && status.healthy).toBe(true);
      expect(seen[0]?.headers.authorization).toStartWith("AWS4-HMAC-SHA256");
    });
  });
});

describe("ProviderHealth — getModelInfo / getProviderForModel lookups", () => {
  it("looks up a full provider/model id exactly", () => {
    const models = fixtureModels();
    const result = health({ models }).getModelInfo("anthropic/claude-sonnet-4-5-20250929");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.info.providerId).toBe("anthropic");
      expect(result.info.modelId).toBe("claude-sonnet-4-5-20250929");
      expect(result.info.cost).toHaveProperty("input");
      expect(result.info.limit).toHaveProperty("context");
    }
    expect(models.calls).toEqual([["anthropic", "claude-sonnet-4-5-20250929"]]);
  });

  it("splits on the first slash only", () => {
    const models = fixtureModels();
    const result = health({ models }).getModelInfo("openai/org/nested-model");
    expect(result.success).toBe(true);
    expect(models.calls).toEqual([["openai", "org/nested-model"]]);
  });

  it("returns model-not-found for a bare id without consulting the lookup", () => {
    const models = fixtureModels();
    const registry = health({ models });
    for (const spelling of ["claude-sonnet-4-5-20250929", "", "/claude-sonnet-4-5-20250929"]) {
      expect(registry.getModelInfo(spelling)).toEqual({
        success: false,
        reason: "model-not-found",
      });
      expect(registry.getProviderForModel(spelling)).toEqual({
        success: false,
        reason: "model-not-found",
      });
    }
    expect(models.calls).toEqual([]);
  });

  it("returns model-not-found for unknown, empty, odd and wrong-case ids", () => {
    const registry = health();
    for (const spelling of [
      "anthropic/unknown-model",
      "anthropic/",
      "no-such-provider/claude-sonnet-4-5-20250929",
      "anthropic/!@#$%^&*()",
      `anthropic/${"a".repeat(1000)}`,
      "ANTHROPIC/CLAUDE-SONNET-4-5-20250929",
    ]) {
      expect(registry.getModelInfo(spelling)).toEqual({
        success: false,
        reason: "model-not-found",
      });
      expect(registry.getProviderForModel(spelling)).toEqual({
        success: false,
        reason: "model-not-found",
      });
    }
    expect(logs.some((l) => l.message.startsWith("Model not found:"))).toBe(true);
  });

  it("reads Models.current() when no lookup is injected", () => {
    const holder = Models as unknown as { installed?: Models };
    const previous = holder.installed;
    const models = fixtureModels();
    try {
      Models.install(models as unknown as Models);
      const result = new ProviderHealth({ logger }).getModelInfo("groq/llama-3.1-8b-instant");
      expect(result.success).toBe(true);
      expect(models.calls).toEqual([["groq", "llama-3.1-8b-instant"]]);
    } finally {
      holder.installed = previous;
    }
  });

  it("trims a sentinel spelling, as model validation does", () => {
    // The installed (parse-mode) Models over the bundled catalog.
    const result = new ProviderHealth({ logger }).getModelInfo("  anthropic/claude-haiku-4-5  ");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.info.providerId).toBe("anthropic");
      expect(result.info.modelId).toBe("claude-haiku-4-5");
    }
  });

  it("is provider-unavailable when the model's provider has no credentials", () => {
    const result = health().getProviderForModel("anthropic/claude-sonnet-4-5-20250929");
    expect(result).toEqual({ success: false, reason: "provider-unavailable" });
    expect(logs.some((l) => l.message.includes("Provider not available: anthropic"))).toBe(true);
  });

  it("is provider-unavailable for a catalog provider with no AI SDK definition", () => {
    const registry = health({
      models: fixtureModels([model("mistral", "mistral-large")]),
    });
    expect(registry.getModelInfo("mistral/mistral-large").success).toBe(true);
    expect(registry.getProviderForModel("mistral/mistral-large")).toEqual({
      success: false,
      reason: "provider-unavailable",
    });
  });

  it("returns the provider's LanguageModel for the record's model id once healthy", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    fetchHandler = () => Response.json({ data: [] });
    const registry = health();
    await registry.performHealthChecks();

    const result = registry.getProviderForModel("openai/gpt-4o-2024-08-06");
    expect(result.success).toBe(true);
    if (result.success && typeof result.model !== "string") {
      expect(result.model.modelId).toBe("gpt-4o-2024-08-06");
      expect(result.model.provider).toStartWith("openai");
    }
  });

  describe("llmParams adjustment", () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = "test-key";
      fetchHandler = () => Response.json({ data: [] });
    });

    it("trims maxOutputTokens to the model's output limit", async () => {
      const registry = health();
      await registry.performHealthChecks();
      const params = { maxOutputTokens: 50_000 };
      expect(registry.getProviderForModel("openai/o-no-temperature", params).success).toBe(true);
      expect(params.maxOutputTokens).toBe(1_000);
      expect(logs.some((l) => l.message.includes("Trimming maxOutputTokens from 50000 to"))).toBe(
        true,
      );
    });

    it("leaves maxOutputTokens within the limit alone", async () => {
      const registry = health();
      await registry.performHealthChecks();
      const params = { maxOutputTokens: 500 };
      registry.getProviderForModel("openai/o-no-temperature", params);
      expect(params.maxOutputTokens).toBe(500);
    });

    it("logs (but keeps) a temperature the model cannot honor", async () => {
      const registry = health();
      await registry.performHealthChecks();
      const params = { temperature: 0.5 };
      expect(registry.getProviderForModel("openai/o-no-temperature", params).success).toBe(true);
      expect(params.temperature).toBe(0.5);
      expect(logs.some((l) => l.message.includes("doesn't support temperature control"))).toBe(
        true,
      );
    });
  });
});

describe("ProviderHealth — blocklists", () => {
  const blocked = { success: false, reason: "model-blocked" } as const;

  describe("getModelInfo", () => {
    const registry = () =>
      health({
        blockList: {
          providers: ["groq"],
          models: ["claude-sonnet-4-5-20250929", "gpt-4o-2024-05-13"],
        },
      });

    it("blocks a listed model", () => {
      expect(registry().getModelInfo("anthropic/claude-sonnet-4-5-20250929")).toEqual(blocked);
      expect(registry().getModelInfo("openai/gpt-4o-2024-05-13")).toEqual(blocked);
    });

    it("blocks a listed model whatever the blocklist entry's case", () => {
      const r = health({ blockList: { models: ["CLAUDE-SONNET-4-5-20250929"] } });
      expect(r.getModelInfo("anthropic/claude-sonnet-4-5-20250929")).toEqual(blocked);
    });

    it("allows models not on the list", () => {
      const result = registry().getModelInfo("openai/gpt-4o-2024-08-06");
      expect(result.success).toBe(true);
    });

    it("returns model-not-found, not model-blocked, for unknown models", () => {
      expect(registry().getModelInfo("anthropic/unknown-model")).toEqual({
        success: false,
        reason: "model-not-found",
      });
    });

    it("blocks every model of a blocked provider", () => {
      expect(registry().getModelInfo("groq/llama-3.1-8b-instant")).toEqual(blocked);
      const r = health({ blockList: { providers: ["google"] } });
      expect(r.getModelInfo("google/gemini-2.5-pro")).toEqual(blocked);
    });

    it("matches blocked providers case-insensitively", () => {
      const r = health({ blockList: { providers: ["ANTHROPIC"] } });
      expect(r.getModelInfo("anthropic/claude-sonnet-4-5-20250929")).toEqual(blocked);
      expect(r.getModelInfo("openai/gpt-4o-2024-08-06").success).toBe(true);
    });

    it("blocks nothing with an empty blocklist", () => {
      const r = health({ blockList: {} });
      expect(r.getModelInfo("groq/llama-3.1-8b-instant").success).toBe(true);
    });
  });

  describe("getProviderForModel", () => {
    const registry = () =>
      health({
        blockList: {
          providers: ["groq"],
          models: ["claude-sonnet-4-5-20250929", "gpt-4o-2024-05-13"],
        },
      });

    it("blocks a listed model and logs it", () => {
      expect(registry().getProviderForModel("anthropic/claude-sonnet-4-5-20250929")).toEqual(
        blocked,
      );
      expect(logs.some((l) => l.level === "error" && l.message.includes("Model blocked"))).toBe(
        true,
      );
    });

    it("blocks a listed OpenAI model", () => {
      expect(registry().getProviderForModel("openai/gpt-4o-2024-05-13")).toEqual(blocked);
    });

    it("blocks a listed model whatever the blocklist entry's case", () => {
      const r = health({ blockList: { models: ["GPT-4O-2024-05-13"] } });
      expect(r.getProviderForModel("openai/gpt-4o-2024-05-13")).toEqual(blocked);
    });

    it("returns model-not-found for unknown models", () => {
      expect(registry().getProviderForModel("anthropic/unknown-model")).toEqual({
        success: false,
        reason: "model-not-found",
      });
    });

    it("reports model-blocked before provider-unavailable", () => {
      // No credentials anywhere: the block still wins.
      const r = health({ blockList: { models: ["claude-sonnet-4-5-20250929"] } });
      expect(r.getProviderForModel("anthropic/claude-sonnet-4-5-20250929")).toEqual(blocked);
    });

    it("reports model-blocked before provider-unhealthy, even with credentials", () => {
      process.env.ANTHROPIC_API_KEY = "test-key";
      const r = health({ blockList: { providers: ["anthropic"] } });
      expect(r.getProviderForModel("anthropic/claude-sonnet-4-5-20250929")).toEqual(blocked);
    });

    it("blocks every model of a blocked provider", () => {
      expect(registry().getProviderForModel("groq/llama-3.1-8b-instant")).toEqual(blocked);
      const r = health({ blockList: { providers: ["google"] } });
      expect(r.getProviderForModel("google/gemini-2.5-pro")).toEqual(blocked);
    });

    it("matches blocked providers case-insensitively", () => {
      const r = health({ blockList: { providers: ["OPENAI"] } });
      expect(r.getProviderForModel("openai/gpt-4o-2024-05-13")).toEqual(blocked);
    });

    it("makes isModelAvailable false for a blocked model of a healthy provider", async () => {
      process.env.OPENAI_API_KEY = "test-key";
      fetchHandler = () => Response.json({ data: [] });
      const r = health({ blockList: { models: ["gpt-4o-2024-05-13"] } });
      await r.performHealthChecks();
      expect(r.isModelAvailable("openai/gpt-4o-2024-05-13")).toBe(false);
      expect(r.isModelAvailable("openai/gpt-4o-2024-08-06")).toBe(true);
    });
  });
});

describe("ProviderHealth — calculateCost", () => {
  it("prices fresh input and output per million tokens", () => {
    const cost = health().calculateCost("anthropic/claude-sonnet-4-5-20250929", {
      inputTokens: 1000,
      outputTokens: 500,
    });
    // (1000/1M * 3.00) + (500/1M * 15.00) = 0.003 + 0.0075
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it("returns null for unknown and bare model ids", () => {
    const registry = health();
    const usage = { inputTokens: 1000, outputTokens: 500 };
    expect(registry.calculateCost("anthropic/unknown-model", usage)).toBeNull();
    expect(registry.calculateCost("claude-sonnet-4-5-20250929", usage)).toBeNull();
    expect(logs.some((l) => l.message.includes("Cannot calculate cost: model not found"))).toBe(
      true,
    );
  });

  it("returns null for a blocked model", () => {
    const registry = health({ blockList: { models: ["claude-sonnet-4-5-20250929"] } });
    expect(
      registry.calculateCost("anthropic/claude-sonnet-4-5-20250929", {
        inputTokens: 1000,
        outputTokens: 500,
      }),
    ).toBeNull();
  });

  it("returns null for a model with no pricing data", () => {
    const registry = health();
    expect(
      registry.calculateCost("anthropic/claude-unpriced", { inputTokens: 1000, outputTokens: 500 }),
    ).toBeNull();
    expect(
      logs.some((l) => l.message.includes("no pricing data for anthropic/claude-unpriced")),
    ).toBe(true);
  });

  it("is zero for zero tokens", () => {
    expect(
      health().calculateCost("anthropic/claude-sonnet-4-5-20250929", {
        inputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
  });

  it("prices at the budget rates when the catalog set them (disputed price)", () => {
    const cost = health().calculateCost("anthropic/claude-disputed", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    // budgetCost 2 + 4, not the listed 1 + 2
    expect(cost).toBeCloseTo(6, 6);
  });

  describe("cache token semantics (fresh input, additive cache — every provider)", () => {
    it("adds cache reads on top of fresh input for Anthropic", () => {
      const cost = health().calculateCost("anthropic/claude-sonnet-4-5-20250929", {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 2000,
      });
      // 0.003 + 0.0075 + (2000/1M * 0.30) = 0.0111
      expect(cost).toBeCloseTo(0.0111, 6);
    });

    it("prices OpenAI-family usage additively too — the boundary already reports fresh-only input", () => {
      // pi subtracts cached (and cache-write) tokens out of OpenAI's
      // cache-inclusive input_tokens before usage reaches the runtime, so
      // `inputTokens` here is fresh input exactly as for Anthropic. A second
      // subtraction here would under-count every codon with cache hits.
      const cost = health().calculateCost("openai/gpt-4o-2024-08-06", {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 2000,
      });
      // (1000/1M * 2.50) + (500/1M * 10.00) + (2000/1M * 1.25) = 0.0025 + 0.005 + 0.0025
      expect(cost).toBeCloseTo(0.01, 6);
    });

    it("handles OpenAI with no cache tokens", () => {
      const cost = health().calculateCost("openai/gpt-4o-2024-08-06", {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
      });
      expect(cost).toBeCloseTo(0.0075, 6);
    });

    it("adds cache reads and cache writes for Anthropic", () => {
      const cost = health().calculateCost("anthropic/claude-sonnet-4-5-20250929", {
        inputTokens: 10000,
        outputTokens: 2000,
        cacheReadTokens: 50000,
        cacheCreationTokens: 1000,
      });
      // 0.03 + 0.03 + (50000/1M * 0.30) + (1000/1M * 3.75) = 0.07875
      expect(cost).toBeCloseTo(0.07875, 6);
    });

    it("ignores cache tokens a model has no cache rate for", () => {
      const cost = health().calculateCost("openai/gpt-4o-2024-08-06", {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 1_000_000,
      });
      expect(cost).toBe(0);
    });
  });
});

describe("ProviderHealth — formatCost", () => {
  it("formats sub-cent costs in cents", () => {
    expect(health().formatCost(0.0001)).toBe("$0.0100¢");
  });

  it("formats costs from one cent up in four-decimal dollars", () => {
    const registry = health();
    expect(registry.formatCost(0.01)).toBe("$0.0100");
    expect(registry.formatCost(0.1234)).toBe("$0.1234");
    expect(registry.formatCost(1.5)).toBe("$1.5000");
  });

  it("formats zero as dollars", () => {
    expect(health().formatCost(0)).toBe("$0.0000");
  });
});

describe("isModelAccessDenialError", () => {
  it("classifies Bedrock's per-model access denial, not IAM invoke denials", () => {
    expect(
      isModelAccessDenialError(
        new Error("You don't have access to the model with the specified model ID."),
      ),
    ).toBe(true);
    // AI SDK APICallError carries the service message in responseBody
    const apiError = Object.assign(new Error("Forbidden"), {
      responseBody:
        '{"message":"You don\'t have access to the model with the specified model ID."}',
    });
    expect(isModelAccessDenialError(apiError)).toBe(true);
    expect(
      isModelAccessDenialError(
        new Error(
          "User: arn:aws:iam::123:user/x is not authorized to perform: bedrock:InvokeModel",
        ),
      ),
    ).toBe(false);
    expect(isModelAccessDenialError(new Error("The security token included is invalid"))).toBe(
      false,
    );
  });

  it("finds the denial in an error's cause", () => {
    const wrapped = new Error("request failed", {
      cause: new Error("You don't have access to the model with the specified model ID."),
    });
    expect(isModelAccessDenialError(wrapped)).toBe(true);
  });

  it("matches case-insensitively and accepts non-Error values", () => {
    expect(isModelAccessDenialError("YOU DON'T HAVE ACCESS TO THE MODEL")).toBe(true);
    expect(isModelAccessDenialError(undefined)).toBe(false);
    expect(isModelAccessDenialError(null)).toBe(false);
    expect(isModelAccessDenialError({ responseBody: 42 })).toBe(false);
  });
});
