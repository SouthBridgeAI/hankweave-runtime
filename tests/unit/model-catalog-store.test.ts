import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelCatalogStore } from "../../server/llm/internal/catalog-store.js";

/** A models.dev api.json with one model the bundled snapshot does not have. */
const MODELS_DEV_BODY = {
  anthropic: {
    name: "Anthropic",
    models: {
      "claude-test-9": {
        name: "Claude Test 9",
        attachment: true,
        reasoning: true,
        tool_call: true,
        release_date: "2026-09-28",
        last_updated: "2026-09-28",
        cost: { input: 2, output: 10 },
        limit: { context: 1000000, output: 128000 },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  },
};

interface MockState {
  requests: { path: string; ifNoneMatch: string | null }[];
  modelsDevStatus: number;
}

const state: MockState = { requests: [], modelsDevStatus: 200 };
let server: ReturnType<typeof Bun.serve>;
let dir: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const ifNoneMatch = req.headers.get("if-none-match");
      state.requests.push({ path: url.pathname, ifNoneMatch });
      if (url.pathname === "/api.json") {
        if (state.modelsDevStatus !== 200)
          return new Response("down", { status: state.modelsDevStatus });
        if (ifNoneMatch === '"v1"') return new Response(null, { status: 304 });
        return Response.json(MODELS_DEV_BODY, { headers: { etag: '"v1"' } });
      }
      if (url.pathname === "/litellm.json") {
        return Response.json({
          "claude-test-9": {
            litellm_provider: "anthropic",
            mode: "chat",
            input_cost_per_token: 2e-6,
            output_cost_per_token: 1e-5,
          },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-catalog-store-"));
});

afterEach(() => {
  state.requests = [];
  state.modelsDevStatus = 200;
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeStore(options: { offline?: boolean; now?: () => Date } = {}): ModelCatalogStore {
  const base = `http://127.0.0.1:${server.port}`;
  return new ModelCatalogStore({
    dir,
    offline: options.offline ?? false,
    urls: {
      "models.dev": `${base}/api.json`,
      litellm: `${base}/litellm.json`,
    },
    ...(options.now ? { now: options.now } : {}),
  });
}

const liveModel = (store: ModelCatalogStore) =>
  store.build().rows.find((r) => r.providerId === "anthropic" && r.modelId === "claude-test-9");

describe("ModelCatalogStore", () => {
  it("adds refreshed models.dev rows to the catalog and remembers the ETag", async () => {
    const store = makeStore();
    expect(liveModel(store)).toBeUndefined();

    const [result] = await store.refresh(["models.dev"]);
    expect(result.outcome).toBe("updated");
    expect(liveModel(store)?.provenance?.source).toStartWith("models.dev live ");
    expect(store.isStale("models.dev")).toBe(false);
  });

  it("skips a fresh source unless forced, and a forced refresh of an unchanged source costs one 304", async () => {
    const store = makeStore();
    await store.refresh(["models.dev"]);
    state.requests = [];

    expect((await store.refresh(["models.dev"]))[0].outcome).toBe("fresh");
    expect(state.requests).toHaveLength(0);

    expect((await store.refresh(["models.dev"], { force: true }))[0].outcome).toBe("not-modified");
    expect(state.requests).toEqual([{ path: "/api.json", ifNoneMatch: '"v1"' }]);
    expect(liveModel(store)).toBeDefined();
  });

  it("refreshes again once the cache is older than the TTL", async () => {
    let now = new Date("2026-09-29T00:00:00Z");
    const store = makeStore({ now: () => now });
    await store.refresh(["models.dev"]);
    now = new Date("2026-09-29T07:00:00Z");
    expect(store.isStale("models.dev")).toBe(true);
  });

  it("keeps the cached rows when a refresh fails", async () => {
    const store = makeStore();
    await store.refresh(["models.dev"]);
    state.modelsDevStatus = 500;

    const [result] = await store.refresh(["models.dev"], { force: true });
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("HTTP 500");
    expect(liveModel(store)).toBeDefined();
  });

  it("makes no request at all when offline", async () => {
    const store = makeStore({ offline: true });
    const results = await store.refresh(["models.dev", "litellm"], { force: true });
    expect(results.map((r) => r.outcome)).toEqual(["offline", "offline"]);
    expect(state.requests).toHaveLength(0);
  });

  it("ignores a corrupt cache file instead of failing", () => {
    const store = makeStore();
    fs.writeFileSync(path.join(dir, "models-dev.json"), "{ not json");
    const built = store.build();
    expect(built.rows.length).toBeGreaterThan(1000);
    expect(liveModel(store)).toBeUndefined();
  });

  it("cross-checks prices with the cached LiteLLM map", async () => {
    const store = makeStore();
    await store.refresh(["models.dev", "litellm"]);
    expect(liveModel(store)?.provenance?.priceStatus).toBe("known");
  });

  it("records probe results and drops them after the retention window", () => {
    let now = new Date("2026-09-29T00:00:00Z");
    const store = makeStore({ now: () => now });
    store.recordProbe({
      providerId: "anthropic",
      modelId: "claude-probed-1",
      probedAt: now.toISOString(),
      source: "anthropic GET /v1/models/claude-probed-1",
    });
    expect(store.loadProbes().map((p) => p.modelId)).toEqual(["claude-probed-1"]);
    expect(
      store.build().rows.find((r) => r.modelId === "claude-probed-1")?.provenance?.confidence,
    ).toBe("provisional");

    now = new Date("2026-11-15T00:00:00Z");
    expect(store.loadProbes()).toEqual([]);
  });

  it("writes cache files atomically, leaving no temp files behind", async () => {
    const store = makeStore();
    await store.refresh(["models.dev", "litellm"]);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
