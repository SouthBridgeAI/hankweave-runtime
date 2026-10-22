import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { probeModel, probeProviderAccess } from "../../server/provider-probe.js";

/** One mock server standing in for several providers' model APIs. */
let server: ReturnType<typeof Bun.serve>;
let env: NodeJS.ProcessEnv;
const seen: { path: string; headers: Record<string, string> }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, headers: Object.fromEntries(req.headers) });
      if (
        req.headers.get("x-api-key") === "revoked" ||
        req.headers.get("authorization") === "Bearer revoked"
      ) {
        return new Response("unauthorized", { status: 401 });
      }
      switch (url.pathname) {
        case "/v1/models/claude-new-1":
          return Response.json({
            id: "claude-new-1",
            display_name: "Claude New 1",
            created_at: "2026-09-28T00:00:00Z",
            max_input_tokens: 1000000,
            max_tokens: 128000,
          });
        case "/v1/models":
          return Response.json({ data: [] });
        case "/openai/v1/models/gpt-new-1":
          return Response.json({ id: "gpt-new-1", created: 1790000000, owned_by: "openai" });
        case "/deepseek/models":
          return Response.json({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v5" }] });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  env = {
    ANTHROPIC_BASE_URL: base,
    OPENAI_BASE_URL: `${base}/openai/v1`,
    DEEPSEEK_BASE_URL: `${base}/deepseek`,
  };
});

afterAll(() => {
  server.stop(true);
});

describe("probeModel", () => {
  it("records what the provider's model endpoint reports", async () => {
    const outcome = await probeModel("anthropic", "claude-new-1", "sk-test", { env });
    expect(outcome.status).toBe("found");
    if (outcome.status !== "found") return;
    expect(outcome.record).toMatchObject({
      providerId: "anthropic",
      modelId: "claude-new-1",
      name: "Claude New 1",
      releaseDate: "2026-09-28",
      limit: { context: 1000000, output: 128000 },
      source: "anthropic GET /v1/models/claude-new-1",
    });
    expect(seen.at(-1)?.headers["x-api-key"]).toBe("sk-test");
  });

  it("reports a model the provider does not serve as absent", async () => {
    const outcome = await probeModel("anthropic", "claude-imaginary", "sk-test", { env });
    expect(outcome).toEqual({
      status: "absent",
      source: "anthropic GET /v1/models/claude-imaginary",
    });
  });

  it("searches the list for providers without a per-model endpoint", async () => {
    expect((await probeModel("deepseek", "deepseek-v5", "sk-test", { env })).status).toBe("found");
    expect((await probeModel("deepseek", "deepseek-v6", "sk-test", { env })).status).toBe("absent");
  });

  it("reads an OpenAI-compatible creation timestamp as the release date", async () => {
    const outcome = await probeModel("openai", "gpt-new-1", "sk-test", { env });
    expect(outcome.status === "found" && outcome.record.releaseDate).toBe("2026-09-21");
  });

  it("distinguishes rejected credentials, missing keys, and unsupported providers", async () => {
    const rejected = await probeModel("anthropic", "claude-new-1", "revoked", { env });
    expect(rejected.status === "failed" && rejected.reason).toContain("HTTP 401");
    const noKey = await probeModel("anthropic", "claude-new-1", undefined, { env });
    expect(noKey.status === "skipped" && noKey.reason).toContain("ANTHROPIC_API_KEY");
    const bedrock = await probeModel("amazon-bedrock", "x", "key", { env });
    expect(bedrock.status).toBe("skipped");
  });

  it("gives up on a slow provider after the timeout", async () => {
    const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const outcome = await probeModel("anthropic", "claude-new-1", "sk-test", {
        env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${hang.port}` },
        timeoutMs: 100,
      });
      expect(outcome.status === "failed" && outcome.reason).toContain("timed out");
    } finally {
      hang.stop(true);
    }
  });
});

describe("probeProviderAccess", () => {
  it("reaches /v1/models whether ANTHROPIC_BASE_URL ends in /v1 or not", async () => {
    // Claude Code reads the variable as the host; the AI SDK (sentinels) as
    // ending in /v1. A proxy configured for either must pass the health check.
    for (const suffix of ["", "/v1", "/v1/"]) {
      seen.length = 0;
      const access = await probeProviderAccess("anthropic", "sk-test", {
        env: { ANTHROPIC_BASE_URL: `${env.ANTHROPIC_BASE_URL}${suffix}` },
      });
      expect(access).toEqual({ ok: true });
      expect(seen.map((r) => r.path)).toEqual(["/v1/models"]);
    }
  });

  it("passes on a successful model listing and fails on rejected credentials", async () => {
    expect(await probeProviderAccess("anthropic", "sk-test", { env })).toEqual({ ok: true });
    const rejected = await probeProviderAccess("anthropic", "revoked", { env });
    expect(rejected.ok).toBe(false);
    // The status tells a rejected key apart from an unreachable provider.
    expect(!rejected.ok && rejected.status).toBe(401);
  });
});
