import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { piProviders } from "../../server/harness/pi/routing.js";
import type { ModelInfo } from "../../server/llm/index.js";
import {
  createPiModelRuntime,
  freezePiModelsStore,
  injectPiModel,
  refreshPiProvider,
} from "../../server/pi-model-catalog.js";
import { lookupPiModel } from "../../server/pi-sdk-manager.js";
import { Logger } from "../../server/utils.js";
import { captureEnv, restoreEnv } from "../utils/env-test-helpers.js";

let tmp: string;
let userAgentDir: string;
let savedEnv: Record<string, string | undefined>;

function record(modelId: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    providerId: "anthropic",
    modelId,
    name: `Test ${modelId}`,
    attachment: true,
    reasoning: true,
    tool_call: true,
    cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    limit: { context: 1_000_000, output: 128_000 },
    modalities: { input: ["text", "image"], output: ["text"] },
    release_date: "2026-09-28",
    last_updated: "2026-09-28",
    provenance: { confidence: "registry", source: "models.dev live", priceStatus: "known" },
    ...extra,
  };
}

beforeAll(() => {
  savedEnv = captureEnv();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hw-pi-catalog-"));
  userAgentDir = path.join(tmp, "user-pi-agent");
  fs.mkdirSync(userAgentDir, { recursive: true });
  // The user's own models.json is JSONC: comments and trailing commas.
  fs.writeFileSync(
    path.join(userAgentDir, "models.json"),
    `{
  // a local model served by the user's own endpoint
  "providers": {
    "my-local": {
      "baseUrl": "http://127.0.0.1:9/v1", /* not contacted */
      "api": "openai-completions",
      "apiKey": "not-a-real-key",
      "models": [{ "id": "my-model", "contextWindow": 32000, "maxTokens": 4096, },],
    },
  },
}
`,
  );
  process.env.PI_CODING_AGENT_DIR = userAgentDir;
  process.env.HANKWEAVE_MODEL_CATALOG_DIR = path.join(tmp, "catalog");
  process.env.HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS = "1";
});

afterAll(() => {
  restoreEnv(savedEnv);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("injectPiModel", () => {
  it("injects a model pi lacks, copying request settings from the newest sibling pi also has", async () => {
    const userModelsJson = fs.readFileSync(path.join(userAgentDir, "models.json"), "utf-8");
    const runtime = await createPiModelRuntime();
    expect(runtime.getModel("anthropic", "claude-sonnet-6")).toBeUndefined();
    const sibling = runtime.getModel("anthropic", "claude-sonnet-5");
    if (!sibling) throw new Error("pi's vendored catalog no longer has anthropic/claude-sonnet-5");

    const repair = injectPiModel(
      runtime,
      "anthropic",
      "claude-sonnet-6",
      record("claude-sonnet-6"),
      [record("claude-sonnet-5"), record("claude-sonnet-4-5")],
    );
    expect(repair).toEqual({ ok: true, sibling: "anthropic/claude-sonnet-5" });

    const fresh = await createPiModelRuntime();
    expect(fresh.getModel("anthropic", "claude-sonnet-6")).toMatchObject({
      api: sibling.api,
      compat: sibling.compat,
      thinkingLevelMap: sibling.thinkingLevelMap,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    });
    // The user's own providers survive the merge; no model data lands in the
    // user's pi directory (pi's own auth.json is its credential store).
    expect(fresh.getModel("my-local", "my-model")).toBeDefined();
    expect(fresh.getError()).toBeUndefined();
    expect(fs.readFileSync(path.join(userAgentDir, "models.json"), "utf-8")).toBe(userModelsJson);
    expect(fs.existsSync(path.join(userAgentDir, "models-store.json"))).toBe(false);
  });

  it("skips hankweave siblings pi does not have, taking the first one it does", async () => {
    const runtime = await createPiModelRuntime();
    const repair = injectPiModel(
      runtime,
      "anthropic",
      "claude-sonnet-6-1",
      record("claude-sonnet-6-1"),
      [record("claude-sonnet-5-9"), record("claude-sonnet-4-6"), record("claude-sonnet-5")],
    );
    expect(repair).toEqual({ ok: true, sibling: "anthropic/claude-sonnet-4-6" });
  });

  it("falls back to pi's own first model of the same line when no hankweave sibling is in pi", async () => {
    const runtime = await createPiModelRuntime();
    const firstClaude = runtime.getModels("anthropic").find((m) => m.id.startsWith("claude-"));
    if (!firstClaude) throw new Error("pi's vendored catalog has no anthropic claude-* model");
    const repair = injectPiModel(
      runtime,
      "anthropic",
      "claude-sonnet-6-2",
      record("claude-sonnet-6-2"),
      [record("claude-sonnet-5-9")],
    );
    expect(repair).toEqual({ ok: true, sibling: `anthropic/${firstClaude.id}` });
  });

  it("refuses when pi has no model of the same line to copy request settings from", async () => {
    const runtime = await createPiModelRuntime();
    const repair = injectPiModel(runtime, "anthropic", "nova-1", record("nova-1"), []);
    expect(repair.ok).toBe(false);
    const fresh = await createPiModelRuntime();
    expect(fresh.getModel("anthropic", "nova-1")).toBeUndefined();
  });

  it("injects exactly the id it is given: a literal '-high' id stays itself", async () => {
    // The caller passes the base for an effort variant (Models.adopt hands
    // over the base record); a model whose own id ends in "-high" is kept.
    const runtime = await createPiModelRuntime();
    const repair = injectPiModel(
      runtime,
      "anthropic",
      "claude-sonnet-7-high",
      record("claude-sonnet-7-high"),
      [record("claude-sonnet-5")],
    );
    expect(repair.ok).toBe(true);
    const fresh = await createPiModelRuntime();
    expect(fresh.getModel("anthropic", "claude-sonnet-7-high")).toBeDefined();
    expect(fresh.getModel("anthropic", "claude-sonnet-7")).toBeUndefined();
  });

  it("a reasoning model stays reasoning, borrowing settings from a reasoning sibling first", async () => {
    const runtime = await createPiModelRuntime();
    const repair = injectPiModel(
      runtime,
      "openai",
      "gpt-9",
      record("gpt-9", { providerId: "openai", reasoning: true }),
      // Newest first: a non-reasoning sibling ahead of a reasoning one.
      [
        record("gpt-4o", { providerId: "openai", reasoning: false }),
        record("gpt-5.6-sol", { providerId: "openai", reasoning: true }),
      ],
    );
    expect(repair).toEqual({ ok: true, sibling: "openai/gpt-5.6-sol" });
    const fresh = await createPiModelRuntime();
    expect(fresh.getModel("openai", "gpt-9")?.reasoning).toBe(true);
    expect(lookupPiModel(fresh, "openai", "gpt-9-high")).toMatchObject({ thinkingLevel: "high" });
    expect(lookupPiModel(fresh, "openai", "gpt-9-high").model?.id).toBe("gpt-9");
  });

  it("prices an unpriced model at the catalog's ceiling estimate, so pi's reported cost matches budgets", async () => {
    const runtime = await createPiModelRuntime();
    injectPiModel(
      runtime,
      "anthropic",
      "claude-sonnet-8",
      record("claude-sonnet-8", {
        cost: undefined,
        provenance: {
          confidence: "provisional",
          source: "anthropic GET /v1/models/claude-sonnet-8",
          priceStatus: "unknown",
          budgetCost: { input: 3, output: 15 },
        },
      }),
      [record("claude-sonnet-5")],
    );
    const fresh = await createPiModelRuntime();
    expect(fresh.getModel("anthropic", "claude-sonnet-8")?.cost).toEqual({
      input: 3,
      output: 15,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("refreshPiProvider", () => {
  it("reports a model pi already has, including an effort variant of one", async () => {
    const runtime = await createPiModelRuntime();
    expect(
      await refreshPiProvider(runtime, "anthropic", "claude-sonnet-5", { network: true }),
    ).toBe(true);
    expect(
      await refreshPiProvider(runtime, "anthropic", "claude-sonnet-5-high", { network: false }),
    ).toBe(true);
  });

  it("leaves a model missing without asking pi.dev when online checks are off", async () => {
    const runtime = await createPiModelRuntime();
    // HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS is set for this file.
    expect(
      await refreshPiProvider(runtime, "anthropic", "claude-sonnet-99", { network: true }),
    ).toBe(false);
    expect(
      await refreshPiProvider(runtime, "anthropic", "claude-sonnet-99", { network: false }),
    ).toBe(false);
  });
});

describe("piProviders", () => {
  it("equals the providers a constructed runtime has, incl. the user's models.json providers", async () => {
    // Routing answers synchronously, without a runtime; it must not drift from one.
    const runtime = await createPiModelRuntime();
    const fromRuntime = runtime.getProviders().map((p) => p.id);

    expect([...piProviders()].sort()).toEqual([...fromRuntime].sort());
    expect(piProviders()).toContain("my-local");
  });
});

describe("createPiModelRuntime", () => {
  /** pi's models store with one deepseek row, as pi writes it after a pi.dev refresh. */
  function writeStore(catalogDir: string, modelId: string): void {
    fs.mkdirSync(catalogDir, { recursive: true });
    fs.writeFileSync(
      path.join(catalogDir, "pi-models-store.json"),
      JSON.stringify({
        deepseek: {
          models: [
            {
              id: modelId,
              name: `Frozen ${modelId}`,
              api: "openai-completions",
              provider: "deepseek",
              reasoning: false,
              input: ["text"],
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 64_000,
              maxTokens: 8_000,
            },
          ],
          checkedAt: Date.now(),
          lastModified: Date.now(),
        },
      }),
    );
  }

  // A resumed plan's Pi codon under an all-Claude hank creates a runtime
  // with no Pi model checked first: it still reads one frozen copy.
  it("freezes the store itself, so a later change to the shared store is not seen", async () => {
    const u = Math.random().toString(36).slice(2, 8);
    const catalogDir = path.join(tmp, `catalog-frozen-${u}`);
    const saved = process.env.HANKWEAVE_MODEL_CATALOG_DIR;
    process.env.HANKWEAVE_MODEL_CATALOG_DIR = catalogDir;
    try {
      writeStore(catalogDir, `deepseek-frozen-${u}-a`);
      const first = await createPiModelRuntime();
      expect(first.getModel("deepseek", `deepseek-frozen-${u}-a`)).toBeDefined();

      // The background refresh (or another run) rewrites the shared store.
      writeStore(catalogDir, `deepseek-frozen-${u}-b`);
      const second = await createPiModelRuntime();
      expect(second.getModel("deepseek", `deepseek-frozen-${u}-a`)).toBeDefined();
      expect(second.getModel("deepseek", `deepseek-frozen-${u}-b`)).toBeUndefined();
    } finally {
      process.env.HANKWEAVE_MODEL_CATALOG_DIR = saved;
    }
  });
});

// Last: freezing is once per process, so nothing after this sees the shared store.
describe("freezePiModelsStore", () => {
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "continues on an empty store when a corrupt one cannot be reset",
    () => {
      // Its own catalog dir: runtimes created above already froze the first
      // one's store, and freezing is once per shared store.
      const catalogDir = path.join(tmp, "catalog-corrupt");
      process.env.HANKWEAVE_MODEL_CATALOG_DIR = catalogDir;
      fs.mkdirSync(catalogDir, { recursive: true });
      fs.writeFileSync(path.join(catalogDir, "pi-models-store.json"), "{ not json");
      const logPath = path.join(tmp, "freeze.log");
      fs.chmodSync(catalogDir, 0o555);
      try {
        expect(() => freezePiModelsStore(new Logger(logPath))).not.toThrow();
      } finally {
        fs.chmodSync(catalogDir, 0o755);
      }
      const log = fs.readFileSync(logPath, "utf-8");
      expect(log).toContain("Could not reset pi's model store");
      expect(log).toContain("this run uses pi's vendored catalog instead");
      expect(fs.readFileSync(path.join(catalogDir, "pi-models-store.json"), "utf-8")).toBe(
        "{ not json",
      );
    },
  );
});
