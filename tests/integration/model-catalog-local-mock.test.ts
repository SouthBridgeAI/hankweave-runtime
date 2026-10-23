#!/usr/bin/env bun
/**
 * A model no catalog lists, run for real on both harnesses against local mock
 * providers — offline, keyless, deterministic (spec 70).
 *
 * The hank declares the model in its own `models` block, the way an author
 * runs a model released after every catalog source was last refreshed:
 *
 * - Claude route: the pinned Claude Code does not know the id either, so it
 *   prices the codon at its default model's rate and marks the usage
 *   `costBasis: "unknown"`. The codon's final cost must come from the catalog
 *   price instead.
 * - Pi route: Pi's catalog lacks the id, so the startup model check (spec 72:
 *   Pi says unknown-model, hankweave's catalog has the block's record) has Pi
 *   adopt it: a row copied from the newest same-family sibling
 *   (deepseek-flash) goes into this process's models.json. The user's own
 *   models.json — here, one that points pi's built-in deepseek provider at the
 *   mock — must survive that merge.
 *
 * A second pair declares a price for a model each harness already prices
 * (anthropic/claude-haiku-4-5 and deepseek/deepseek-flash): a declared price
 * is what the run records, over the harness's own total.
 *
 * The last block runs Models.load in process against local mocks of the
 * catalog's network sources: Anthropic's model list (asked only on a catalog
 * miss, cached in probes.json), models.dev (the background refresh of stale
 * sources), and the switches that keep all of it off the network.
 *
 * Prices are set absurdly high ($1000 per million tokens) so a catalog-priced
 * cost cannot be confused with a guessed one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeModelCheck } from "../../server/harness/claude/model-check.js";
import { modelHarnesses } from "../../server/harnesses.js";
import {
  type ModelCheck,
  type ModelInfo,
  Models,
  type ModelsLoadOptions,
} from "../../server/llm/index.js";
import { CATALOG_SOURCE_URLS } from "../../server/llm/internal/catalog-store.js";
import {
  isModelCatalogOffline,
  recordConfiguredNoOnlineModelChecks,
} from "../../server/model-catalog-settings.js";
import { type LaunchedServer, launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

const REPLY = "MOCK NEW MODEL OK";
const USAGE = { input_tokens: 40, output_tokens: 7 };
/** 47 tokens at $1000 per million. */
const CATALOG_PRICED_CALL = (USAGE.input_tokens + USAGE.output_tokens) * 0.001;

function startMockAnthropic(): { server: ReturnType<typeof Bun.serve>; models: string[] } {
  const models: string[] = [];
  const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || !url.pathname.includes("/v1/messages")) {
        return Response.json(
          { type: "error", error: { type: "not_found_error", message: "mock" } },
          { status: 404 },
        );
      }
      const body = (await req.json().catch(() => ({}))) as { stream?: boolean; model?: string };
      const model = body.model ?? "unknown";
      models.push(model);
      const message = {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model,
        stop_sequence: null,
      };
      if (!body.stream) {
        return Response.json({
          ...message,
          content: [{ type: "text", text: REPLY }],
          stop_reason: "end_turn",
          usage: USAGE,
        });
      }
      return new Response(
        [
          sse("message_start", {
            type: "message_start",
            message: {
              ...message,
              content: [],
              stop_reason: null,
              usage: { input_tokens: USAGE.input_tokens, output_tokens: 1 },
            },
          }),
          sse("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
          sse("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: REPLY },
          }),
          sse("content_block_stop", { type: "content_block_stop", index: 0 }),
          sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: USAGE.output_tokens },
          }),
          sse("message_stop", { type: "message_stop" }),
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { server, models };
}

function startMockOpenAiCompatible(): { server: ReturnType<typeof Bun.serve>; models: string[] } {
  const models: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const body = (await req.json().catch(() => ({}))) as { model?: string };
      models.push(body.model ?? "unknown");
      const base = {
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        created: 0,
        model: body.model,
      };
      const chunk = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
      return new Response(
        [
          chunk({
            ...base,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          }),
          chunk({
            ...base,
            choices: [{ index: 0, delta: { content: REPLY }, finish_reason: null }],
          }),
          chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
          chunk({
            ...base,
            choices: [],
            usage: {
              prompt_tokens: USAGE.input_tokens,
              completion_tokens: USAGE.output_tokens,
              total_tokens: USAGE.input_tokens + USAGE.output_tokens,
            },
          }),
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return { server, models };
}

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      // best-effort
    }
  }
});

/**
 * A one-codon hank whose models block declares `model` at $1000 per million
 * tokens.
 */
function writeHank(model: string, options: { basedOn?: string } = {}): string {
  const hankDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-mock-hank-"));
  cleanups.push(() => fs.rmSync(hankDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(hankDir, "hank.json"),
    JSON.stringify({
      models: [{ id: model, basedOn: options.basedOn, cost: { input: 1000, output: 1000 } }],
      hank: [
        {
          id: "new-model-codon",
          name: "New Model Codon",
          promptText: `Reply with exactly: ${REPLY}`,
          model,
          continuationMode: "fresh",
        },
      ],
    }),
  );
  return hankDir;
}

async function runToCompletion(hankDir: string, env: Record<string, string>, prefix: string) {
  const port = await getFreePort();
  // A catalog cache of its own, so a direct `bun test` run neither reads nor
  // writes the developer's ~/.hankweave/model-catalog.
  const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-mock-cache-"));
  cleanups.push(() => fs.rmSync(catalogDir, { recursive: true, force: true }));
  let server: LaunchedServer | undefined;
  try {
    server = await launchHankweave({
      port,
      configPath: path.join(hankDir, "hank.json"),
      executionDir: hankDir,
      reuseTestDirectory: true,
      logPrefix: prefix,
      extraArgs: ["--force"],
      env: {
        HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS: "1",
        HANKWEAVE_MODEL_CATALOG_DIR: catalogDir,
        ...env,
      },
    });
    await server.waitForEvent("server.ready", 30_000);
    await server.waitForRunToComplete(90_000);
    await server.waitForState(
      (s) => s.runs[0]?.codons.find((c) => c.codonId === "new-model-codon")?.status === "completed",
      15_000,
    );
    const codon = server.getState().runs[0]?.codons.find((c) => c.codonId === "new-model-codon");
    return codon?.status === "completed" ? codon.finalCost : undefined;
  } finally {
    await server?.stop(10_000).catch(() => {});
  }
}

/** Run the hank's codon on the Claude Agent SDK against a local Anthropic mock. */
async function runOnClaude(model: string, options: { basedOn?: string } = {}) {
  const mock = startMockAnthropic();
  cleanups.push(() => mock.server.stop(true));
  const finalCost = await runToCompletion(
    writeHank(model, options),
    {
      ANTHROPIC_API_KEY: "sk-ant-test-never-valid",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.server.port}`,
    },
    "[catalog-claude-mock]",
  );
  return { finalCost, models: mock.models };
}

/** Run the hank's codon on pi against a local OpenAI-compatible mock. */
async function runOnPi(model: string, options: { basedOn?: string } = {}) {
  const mock = startMockOpenAiCompatible();
  cleanups.push(() => mock.server.stop(true));
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-mock-pi-"));
  cleanups.push(() => fs.rmSync(piDir, { recursive: true, force: true }));
  // The user's own pi config: point the built-in deepseek provider at the mock.
  const mockBaseUrl = `http://127.0.0.1:${mock.server.port}/v1`;
  fs.writeFileSync(
    path.join(piDir, "models.json"),
    JSON.stringify({ providers: { deepseek: { baseUrl: mockBaseUrl } } }),
  );
  const finalCost = await runToCompletion(
    writeHank(model, options),
    {
      PI_CODING_AGENT_DIR: piDir,
      PI_OFFLINE: "1",
      DEEPSEEK_API_KEY: "sk-test-never-valid",
      // Hankweave's own DeepSeek client (the startup health check) reads this;
      // without it the fake key goes to the real api.deepseek.com.
      DEEPSEEK_BASE_URL: mockBaseUrl,
    },
    "[catalog-pi-mock]",
  );
  return { finalCost, models: mock.models };
}

describe("a model no catalog lists, declared in the hank's models block", () => {
  test("runs on the Claude Agent SDK and is costed from the catalog, not Claude Code's guess", async () => {
    const { finalCost, models } = await runOnClaude("anthropic/claude-mock-new-1", {
      basedOn: "anthropic/claude-haiku-4-5",
    });
    expect(models).toContain("claude-mock-new-1");
    // Claude Code's default-model guess would be ~$0.0003 per call.
    expect(finalCost).toBeGreaterThanOrEqual(CATALOG_PRICED_CALL);
  }, 120_000);

  test("runs on pi via a row injected from its same-family sibling", async () => {
    const { finalCost, models } = await runOnPi("deepseek/deepseek-mock-9", {
      basedOn: "deepseek/deepseek-flash",
    });
    expect(models).toContain("deepseek-mock-9");
    expect(finalCost).toBeCloseTo(CATALOG_PRICED_CALL, 6);
  }, 120_000);
});

describe("a declared price for a model the harness prices itself", () => {
  test("Claude Code's own price is replaced by the declared one", async () => {
    const { finalCost, models } = await runOnClaude("anthropic/claude-haiku-4-5");
    expect(models).toContain("claude-haiku-4-5");
    // Claude Code's list price would be ~$0.0001 for the call.
    expect(finalCost).toBeGreaterThanOrEqual(CATALOG_PRICED_CALL);
  }, 120_000);

  test("pi's own price for deepseek-flash is replaced by the declared one", async () => {
    const { finalCost, models } = await runOnPi("deepseek/deepseek-flash");
    expect(models).toContain("deepseek-flash");
    expect(finalCost).toBeCloseTo(CATALOG_PRICED_CALL, 6);
  }, 120_000);
});

describe("Models.load against local mocks of the catalog's network sources", () => {
  const upstreamModel = (name: string) => ({
    name,
    attachment: false,
    reasoning: true,
    tool_call: true,
    release_date: "2026-09-28",
    last_updated: "2026-09-28",
    cost: { input: 2, output: 10 },
    limit: { context: 1000000, output: 128000 },
    modalities: { input: ["text"], output: ["text"] },
  });

  let server: ReturnType<typeof Bun.serve>;
  let requests: string[] = [];
  let tmp: string;
  /** Model-list requests in flight at once, and the most seen since the last reset. */
  let probesInFlight = 0;
  let maxProbesInFlight = 0;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        requests.push(url.pathname);
        if (url.pathname.startsWith("/v1/models/claude-slow-")) {
          probesInFlight += 1;
          maxProbesInFlight = Math.max(maxProbesInFlight, probesInFlight);
          await new Promise((resolve) => setTimeout(resolve, 100));
          probesInFlight -= 1;
          const id = url.pathname.substring("/v1/models/".length);
          return Response.json({ id, display_name: id });
        }
        if (url.pathname === "/v1/models/claude-probed-1") {
          return Response.json({ id: "claude-probed-1", display_name: "Claude Probed 1" });
        }
        if (url.pathname === "/v1/models/claude-gateway-1") {
          return new Response("bad gateway", { status: 502 });
        }
        if (url.pathname === "/api.json") {
          return Response.json({
            anthropic: {
              name: "Anthropic",
              models: { "claude-refreshed-1": upstreamModel("Claude Refreshed 1") },
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
    requests = [];
    maxProbesInFlight = 0;
    catalogFetch.mockClear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hw-models-mock-"));
  });

  afterEach(() => {
    Models.loadForParsing({}, { harnesses: modelHarnesses(), bundledOnly: true });
    recordConfiguredNoOnlineModelChecks(false);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const base = () => `http://127.0.0.1:${server.port}`;
  /** The catalog store's fetch: the real source URLs, answered by the mock. */
  const catalogFetch = mock((url: string | URL | Request, init?: RequestInit) =>
    fetch(
      String(url)
        .replace(CATALOG_SOURCE_URLS["models.dev"], `${base()}/api.json`)
        .replace(CATALOG_SOURCE_URLS.litellm, `${base()}/litellm.json`),
      init,
    ),
  );

  function load(models: string[], options: Partial<ModelsLoadOptions> = {}): Promise<Models> {
    return Models.load({
      raw: {
        hank: {
          hank: models.map((model, i) => ({
            id: `c${i}`,
            name: `Codon ${i}`,
            model,
            continuationMode: "fresh",
            promptText: "hi",
          })),
        },
      },
      harnesses: { codon: [new ClaudeModelCheck()], sentinel: [] },
      env: { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: base() },
      network: true,
      prerequisites: true,
      background: false,
      catalogDir: path.join(tmp, "catalog"),
      fetch: catalogFetch as unknown as typeof fetch,
      ...options,
    });
  }

  function confirmed(result: ModelCheck): ModelInfo {
    if (!result.ok) throw new Error(`expected a model, got ${result.kind}: ${result.message}`);
    return result.model;
  }

  function failed(result: ModelCheck) {
    if (result.ok) throw new Error(`expected a failure, got ${result.model.modelId}`);
    return result;
  }

  test("asks Anthropic's model list only on a catalog miss, and the next load asks nothing", async () => {
    const models = await load(["anthropic/claude-haiku-4-5", "anthropic/claude-probed-1"]);

    expect(requests).toEqual(["/v1/models/claude-probed-1"]);
    expect(confirmed(models.check("anthropic/claude-haiku-4-5")).provenance?.evidence).toBe(
      "catalog",
    );
    const probed = confirmed(models.check("anthropic/claude-probed-1"));
    expect(probed.provenance).toMatchObject({
      confidence: "provisional",
      priceStatus: "unknown",
      evidence: "anthropic GET /v1/models",
    });
    expect(fs.existsSync(path.join(tmp, "catalog", "probes.json"))).toBe(true);

    requests = [];
    const again = await load(["anthropic/claude-probed-1"]);
    expect(requests).toEqual([]);
    expect(confirmed(again.check("anthropic/claude-probed-1")).provenance).toMatchObject({
      confidence: "provisional",
      evidence: "catalog",
    });
  });

  test("asks about every missing model at once, not one after another", async () => {
    const models = await load([
      "anthropic/claude-slow-1",
      "anthropic/claude-slow-2",
      "anthropic/claude-slow-3",
    ]);

    expect(maxProbesInFlight).toBe(3);
    for (const id of ["claude-slow-1", "claude-slow-2", "claude-slow-3"]) {
      expect(models.check(`anthropic/${id}`).ok).toBe(true);
    }
  });

  test("rejects a model Anthropic does not list, and says when the list could not be asked", async () => {
    const models = await load(["anthropic/claude-imaginary-7", "anthropic/claude-gateway-1"]);

    const imaginary = failed(models.check("anthropic/claude-imaginary-7"));
    expect(imaginary).toMatchObject({ kind: "unknown-model", stage: "harness" });
    // The Claude route has no list of its own: the catalog's newest ids follow.
    expect(imaginary.message).toStartWith(
      "Anthropic's API does not list 'anthropic/claude-imaginary-7' (anthropic GET /v1/models/claude-imaginary-7). Closest: anthropic/",
    );
    expect(imaginary.suggestions.length).toBeGreaterThan(0);
    const gateway = failed(models.check("anthropic/claude-gateway-1"));
    expect(gateway.kind).toBe("unreachable");
    expect(gateway.message).toContain("HTTP 502");
    expect(gateway.message).toContain("'models' block");
    // Both misses share one refresh of the missing models.dev cache before rejecting.
    expect(catalogFetch).toHaveBeenCalledTimes(1);
  });

  test("makes no request with the network off", async () => {
    const models = await load(["anthropic/claude-probed-1"], { network: false, background: true });

    expect(requests).toEqual([]);
    expect(catalogFetch).not.toHaveBeenCalled();
    expect(failed(models.check("anthropic/claude-probed-1")).message).toContain(
      "online model checks are off",
    );
  });

  test("follows hankweave.json's noOnlineModelChecks, and the environment variable overrides it", async () => {
    const offline = { noOnlineModelChecks: true };
    const loadWith = (env: NodeJS.ProcessEnv, runtime: unknown) =>
      Models.load({
        raw: {
          hank: {
            hank: [
              {
                id: "c0",
                name: "Codon 0",
                model: "anthropic/claude-probed-1",
                continuationMode: "fresh",
                promptText: "hi",
              },
            ],
          },
          runtime,
        },
        harnesses: { codon: [new ClaudeModelCheck()], sentinel: [] },
        env: { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: base(), ...env },
        network: true,
        prerequisites: true,
        background: true,
        catalogDir: path.join(tmp, "catalog"),
        fetch: catalogFetch as unknown as typeof fetch,
      });
    catalogFetch.mockClear();

    await loadWith({}, offline);
    expect(requests).toEqual([]);
    expect(catalogFetch).not.toHaveBeenCalled();
    // Pi's refreshes run later, from another directory, and see it without the file.
    expect(isModelCatalogOffline({})).toBe(true);

    await loadWith({ HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS: "1" }, {});
    expect(requests).toEqual([]);

    const online = await loadWith({ HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS: "0" }, offline);
    expect(requests).toContain("/v1/models/claude-probed-1");
    expect(online.check("anthropic/claude-probed-1").ok).toBe(true);
    await waitForFile(path.join(tmp, "catalog", "models-dev.json"));
  });

  test("refreshes stale catalog sources in the background, for the next load", async () => {
    catalogFetch.mockClear();
    await load(["anthropic/claude-haiku-4-5"], { background: true });
    await waitForFile(path.join(tmp, "catalog", "models-dev.json"));
    expect(catalogFetch.mock.calls.map(([url]) => String(url))).toContain(
      CATALOG_SOURCE_URLS["models.dev"],
    );

    requests = [];
    const next = await load(["anthropic/claude-refreshed-1"]);
    expect(requests).toEqual([]);
    const refreshed = confirmed(next.check("anthropic/claude-refreshed-1"));
    expect(refreshed.provenance?.source).toStartWith("models.dev live ");
    expect(refreshed.provenance?.evidence).toBe("catalog");
  });
});

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() > deadline)
      throw new Error(`${filePath} was not written within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
