import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRuntimeConfig, validateHank } from "../../server/config.js";
import { ClaudeModelCheck } from "../../server/harness/claude/model-check.js";
import { PiModelCheck } from "../../server/harness/pi/model-check.js";
import { modelHarnesses } from "../../server/harnesses.js";
import {
  type HarnessCheckOptions,
  type HarnessCheckResult,
  type HarnessCheckStep,
  type HarnessModelCheck,
  type ModelCheck,
  type ModelInfo,
  Models,
  type ModelsLoadOptions,
  type ModelUse,
  type RawModelConfigs,
} from "../../server/llm/index.js";
import { bundledCatalogSnapshot } from "../../server/llm/internal/catalog-store.js";
import { compareNewest } from "../../server/llm/internal/name-hints.js";
import { recordConfiguredNoOnlineModelChecks } from "../../server/model-catalog-settings.js";
import type { ProbeRecord } from "../../server/provider-probe.js";
import { AiSdkModelCheck } from "../../server/sentinels/model-check.js";
import { ProviderHealth } from "../../server/sentinels/provider-health.js";
import { Logger } from "../../server/utils.js";
import { captureEnv, restoreEnv } from "../utils/env-test-helpers.js";

/**
 * Models.load (spec 72, "Order of validation"): stage 0 (the name) →
 * stage 1 (routing) → stage 2 (the harness confirms) → stage 3 (catalog
 * enrichment), with adoption after a harness says it does not know a model
 * hankweave's catalog has. Fake harness checks record every question they
 * are asked, so the tests can say which stages ran.
 */

interface Call {
  harness: string;
  target: string;
  env: NodeJS.ProcessEnv;
  network: boolean;
}

type Answer = (
  provider: string,
  modelId: string,
  env: NodeJS.ProcessEnv,
  opts: HarnessCheckOptions,
) => HarnessCheckResult | Promise<HarnessCheckResult>;

let calls: Call[] = [];
let tmp: string;

/** ok with "catalog" when hankweave's catalog lists the id, else with "<harness> says yes". */
const yes: (harness: string) => Answer = (harness) => (provider, modelId, _env, opts) => ({
  ok: true,
  evidence: opts.knownToCatalog(provider, modelId) ? "catalog" : `${harness} says yes`,
});

function fakeHarness(
  harness: string,
  providers: string[],
  options: {
    label?: string;
    answer?: Answer;
    runs?: (provider: string, modelId: string) => boolean;
    offlineRow?: NonNullable<HarnessModelCheck["offlineRow"]>;
    adopt?: NonNullable<HarnessModelCheck["adopt"]>;
    info?: NonNullable<HarnessModelCheck["info"]>;
  } = {},
): HarnessModelCheck {
  const answer = options.answer ?? yes(harness);
  return {
    harness,
    label: options.label ?? harness,
    providers: () => providers,
    runs: options.runs ?? ((provider) => providers.includes(provider)),
    async check(provider, modelId, env, opts) {
      calls.push({ harness, target: `${provider}/${modelId}`, env, network: opts.network });
      return answer(provider, modelId, env, opts);
    },
    ...(options.offlineRow ? { offlineRow: options.offlineRow } : {}),
    ...(options.adopt ? { adopt: options.adopt } : {}),
    ...(options.info ? { info: options.info } : {}),
  };
}

const PI_PROVIDERS = ["anthropic", "deepseek", "openai", "openai-codex", "zai"];
const claude = (options: Parameters<typeof fakeHarness>[2] = {}) =>
  fakeHarness("claude-agent-sdk", ["anthropic"], { label: "the Claude Agent SDK", ...options });
const pi = (options: Parameters<typeof fakeHarness>[2] = {}) =>
  fakeHarness("pi", PI_PROVIDERS, { label: "Pi", ...options });
const aiSdk = (options: Parameters<typeof fakeHarness>[2] = {}) =>
  fakeHarness("ai-sdk", ["anthropic", "openai"], { label: "the AI SDK", ...options });

const targets = (harness?: string) =>
  calls.filter((c) => harness === undefined || c.harness === harness).map((c) => c.target);

function codon(id: string, model: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, model, continuationMode: "fresh", promptText: "x", ...extra };
}

/** A hank of one codon per model, ids c0, c1, … */
const hankOf = (models: string[], extra: Record<string, unknown> = {}) => ({
  hank: models.map((model, i) => codon(`c${i}`, model)),
  ...extra,
});

function sentinel(id: string, model: string) {
  return {
    id,
    name: id,
    model,
    trigger: { type: "event", on: ["assistant.action"] },
    execution: { strategy: "immediate" },
    userPromptText: "u",
  };
}

function load(raw: RawModelConfigs, options: Partial<ModelsLoadOptions> = {}): Promise<Models> {
  return Models.load({
    raw,
    harnesses: { codon: [claude(), pi()], sentinel: [aiSdk()] },
    env: {},
    network: false,
    prerequisites: true,
    background: false,
    catalogDir: path.join(tmp, "catalog"),
    ...options,
  });
}

/** A suffix for model ids no other test (or test file in this process) uses. */
const uniqueSuffix = () => Math.random().toString(36).slice(2, 8);

function failed(result: ModelCheck) {
  if (result.ok)
    throw new Error(`expected a failure, got ${result.model.providerId}/${result.model.modelId}`);
  return result;
}

function confirmed(result: ModelCheck): ModelInfo {
  if (!result.ok) throw new Error(`expected a model, got ${result.kind}: ${result.message}`);
  return result.model;
}

function bundled(provider: string, modelId: string): ModelInfo {
  const row = bundledCatalogSnapshot().rows.find(
    (r) => r.providerId === provider && r.modelId === modelId,
  );
  if (!row) throw new Error(`the bundled catalog has no ${provider}/${modelId}`);
  return row;
}

beforeEach(() => {
  calls = [];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hw-models-load-"));
});

afterEach(() => {
  Models.loadForParsing({}, { harnesses: modelHarnesses(), bundledOnly: true });
  recordConfiguredNoOnlineModelChecks(false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("Models.load: stage ordering", () => {
  it("asks no harness about a spelling whose name is wrong", async () => {
    const models = await load({
      hank: hankOf([
        "sonnet",
        "Anthropic/claude-haiku-4-5",
        "deepinfra/llama-9",
        "pi/deepseek-v4-pro",
        "anthropic/claude-haiku-4-5",
      ]),
    });

    const kinds = [
      "sonnet",
      "Anthropic/claude-haiku-4-5",
      "deepinfra/llama-9",
      "pi/deepseek-v4-pro",
    ].map((spelling) => {
      const result = failed(models.check(spelling, "codon"));
      expect(result.stage).toBe("name");
      return result.kind;
    });
    expect(kinds).toEqual(["no-provider", "wrong-case", "unrunnable-provider", "bad-prefix"]);
    expect(targets()).toEqual(["anthropic/claude-haiku-4-5"]);
  });

  it("does not adopt a model the harness rejects and a refreshed catalog still lacks", async () => {
    const adopt = mock(async () => ({ ok: true as const, evidence: "adopted" }));
    const fetchSpy = mock(async () => new Response("{}"));
    const models = await load(
      { hank: hankOf(["deepseek/deepseek-imaginary-9"]) },
      {
        harnesses: {
          codon: [
            claude(),
            pi({
              adopt,
              answer: () => ({
                ok: false,
                kind: "unknown-model",
                message: "Pi has no model 'deepseek/deepseek-imaginary-9'.",
                candidates: ["deepseek/deepseek-v4-pro", "deepseek/deepseek-flash"],
              }),
            }),
          ],
          sentinel: [aiSdk()],
        },
        network: true,
        fetch: fetchSpy as unknown as typeof fetch,
      },
    );

    const result = failed(models.check("deepseek/deepseek-imaginary-9", "codon"));
    expect(result).toMatchObject({ kind: "unknown-model", stage: "harness" });
    // Pi's ids come back as candidates; the message carries them ranked and qualified.
    expect(result.message).toStartWith(
      "Pi has no model 'deepseek/deepseek-imaginary-9'. Closest: ",
    );
    expect(result.message).toContain("deepseek/deepseek-v4-pro");
    expect(result.suggestions).toContain("deepseek/deepseek-v4-pro");
    expect(adopt).not.toHaveBeenCalled();
    // The cache is missing, so models.dev is asked once; its useless answer changes nothing.
    expect(fetchSpy.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual([
      "https://models.dev/api.json",
    ]);
  });

  it("asks the harness about a casing its own offline catalog lists, though hankweave's has another", async () => {
    const offlineRow = (provider: string, modelId: string) =>
      `${provider}/${modelId}` === "deepseek/DeepSeek-V4-Pro" ? { name: "Pi's casing" } : undefined;

    const withRow = await load(
      { hank: hankOf(["deepseek/DeepSeek-V4-Pro"]) },
      { harnesses: { codon: [claude(), pi({ offlineRow })], sentinel: [aiSdk()] } },
    );
    expect(targets("pi")).toEqual(["deepseek/DeepSeek-V4-Pro"]);
    expect(confirmed(withRow.check("deepseek/DeepSeek-V4-Pro")).modelId).toBe("DeepSeek-V4-Pro");

    calls = [];
    const withoutRow = await load({ hank: hankOf(["deepseek/DeepSeek-V4-Pro"]) });
    expect(failed(withoutRow.check("deepseek/DeepSeek-V4-Pro"))).toMatchObject({
      kind: "wrong-case",
      stage: "name",
      suggestions: ["deepseek/deepseek-v4-pro"],
    });
    expect(calls).toEqual([]);
  });

  it("routes to the first harness that runs the provider, and 'pi/' forces Pi", async () => {
    const models = await load({
      hank: hankOf([
        "anthropic/claude-haiku-4-5",
        "pi/anthropic/claude-sonnet-4-5",
        "deepseek/deepseek-v4-pro",
      ]),
    });

    expect(calls.map((c) => [c.harness, c.target])).toEqual([
      ["claude-agent-sdk", "anthropic/claude-haiku-4-5"],
      ["pi", "anthropic/claude-sonnet-4-5"],
      ["pi", "deepseek/deepseek-v4-pro"],
    ]);
    expect(confirmed(models.check("anthropic/claude-haiku-4-5")).harnessOverride).toBeUndefined();
    const forced = confirmed(models.check("pi/anthropic/claude-sonnet-4-5"));
    expect(forced.harnessOverride).toBe("pi");
    expect(forced.provenance?.requestedAs).toBe("pi/anthropic/claude-sonnet-4-5");

    // List order breaks the tie: Pi first takes anthropic too.
    calls = [];
    await load(
      { hank: hankOf(["anthropic/claude-haiku-4-5"]) },
      { harnesses: { codon: [pi(), claude()], sentinel: [aiSdk()] } },
    );
    expect(calls.map((c) => c.harness)).toEqual(["pi"]);
  });
});

describe("Models.load: effective spellings", () => {
  it("collects no codon model when --model is set", async () => {
    const models = await load(
      { hank: hankOf(["openai/gpt-5.6-sol"]) },
      { cliModel: "anthropic/claude-haiku-4-5" },
    );

    expect(targets()).toEqual(["anthropic/claude-haiku-4-5"]);
    expect(confirmed(models.check("anthropic/claude-haiku-4-5")).modelId).toBe("claude-haiku-4-5");
    expect(failed(models.check("openai/gpt-5.6-sol")).kind).toBe("unprepared");
  });

  it("checks shadowed override layers by name only", async () => {
    const models = await load(
      {
        hank: hankOf(["openai/gpt-5.6-sol"], {
          overrides: { model: "anthropic/claude-sonnet-4-5" },
        }),
        runtime: { model: "zai/glm-5" },
      },
      {
        cliModel: "anthropic/claude-haiku-4-5",
        env: { HANKWEAVE_RUNTIME_MODEL: "deepseek/deepseek-v4-pro" },
      },
    );

    expect(targets()).toEqual(["anthropic/claude-haiku-4-5"]);
    for (const shadowed of [
      "deepseek/deepseek-v4-pro",
      "anthropic/claude-sonnet-4-5",
      "zai/glm-5",
    ]) {
      expect(confirmed(models.check(shadowed)).provenance?.evidence).toStartWith(
        "not checked: shadowed",
      );
    }
  });

  it("still rejects a malformed shadowed layer", async () => {
    const models = await load(
      {
        hank: hankOf(["openai/gpt-5.6-sol"], {
          overrides: { model: "Anthropic/claude-sonnet-4-5" },
        }),
        runtime: { model: "sonnet" },
      },
      { cliModel: "anthropic/claude-haiku-4-5" },
    );

    expect(targets()).toEqual(["anthropic/claude-haiku-4-5"]);
    expect(failed(models.check("sonnet")).kind).toBe("no-provider");
    expect(failed(models.check("Anthropic/claude-sonnet-4-5")).kind).toBe("wrong-case");
    const report = models.report();
    expect(
      report.some((line) => line.startsWith("! hankweave.json model (shadowed by --model): ")),
    ).toBe(true);
    expect(
      report.some((line) => line.startsWith("! hank.json overrides.model (shadowed by --model): ")),
    ).toBe(true);
  });

  it("checks the effective override once per distinct codon env block, with that env merged in", async () => {
    const models = await load(
      {
        hank: {
          overrides: { model: "deepseek/deepseek-v4-pro" },
          hank: [
            codon("plain", "openai/gpt-5.6-sol"),
            codon("k1-a", "openai/gpt-5.6-sol", { env: { DEEPSEEK_API_KEY: "k1" } }),
            codon("k1-b", "openai/gpt-5.6-sol", { env: { DEEPSEEK_API_KEY: "k1" } }),
            codon("k2", "openai/gpt-5.6-sol", { env: { EXTRA: "x", DEEPSEEK_API_KEY: "k2" } }),
          ],
        },
      },
      { env: { BASE: "1" } },
    );

    expect(targets()).toEqual([
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-pro",
    ]);
    expect(calls.map((c) => c.env)).toEqual([
      { BASE: "1" },
      { BASE: "1", DEEPSEEK_API_KEY: "k1" },
      { BASE: "1", DEEPSEEK_API_KEY: "k2", EXTRA: "x" },
    ]);
    expect(models.check("deepseek/deepseek-v4-pro").ok).toBe(true);
  });

  it("fails the override when one codon's env lacks what another codon's env block has", async () => {
    const models = await load(
      {
        hank: {
          overrides: { model: "deepseek/deepseek-v4-pro" },
          hank: [
            codon("keyed", "openai/gpt-5.6-sol", { env: { DEEPSEEK_API_KEY: "k1" } }),
            codon("keyless", "openai/gpt-5.6-sol"),
          ],
        },
      },
      {
        harnesses: {
          codon: [
            claude(),
            pi({
              answer: (provider, _modelId, env) =>
                env.DEEPSEEK_API_KEY
                  ? { ok: true, evidence: "pi catalog" }
                  : {
                      ok: false,
                      kind: "no-credentials",
                      message: `No credentials for provider '${provider}'.`,
                      candidates: [],
                    },
            }),
          ],
          sentinel: [aiSdk()],
        },
      },
    );

    expect(failed(models.check("deepseek/deepseek-v4-pro"))).toMatchObject({
      kind: "no-credentials",
      stage: "harness",
    });
  });

  /** Pi that has deepseek credentials only when the env it is handed carries DEEPSEEK_API_KEY. */
  const keyedPi = () =>
    pi({
      answer: (provider, _modelId, env) =>
        env.DEEPSEEK_API_KEY
          ? { ok: true, evidence: "pi catalog" }
          : {
              ok: false,
              kind: "no-credentials",
              message: `No credentials for provider '${provider}'.`,
              candidates: [],
            },
    });

  // A codon may leave `model` out when a global override supplies it; its
  // env block still decides the override's credentials for that codon.
  const overrideSources: [string, Partial<ModelsLoadOptions>, Record<string, unknown>][] = [
    ["--model", { cliModel: "deepseek/deepseek-v4-pro" }, {}],
    [
      "HANKWEAVE_RUNTIME_MODEL",
      { env: { HANKWEAVE_RUNTIME_MODEL: "deepseek/deepseek-v4-pro" } },
      {},
    ],
    ["hank.json overrides.model", {}, { overrides: { model: "deepseek/deepseek-v4-pro" } }],
  ];
  for (const [source, options, hankExtra] of overrideSources) {
    it(`checks ${source} with the env block of a codon that writes no model`, async () => {
      const models = await load(
        {
          hank: {
            ...hankExtra,
            hank: [
              {
                id: "modelless",
                name: "modelless",
                continuationMode: "fresh",
                promptText: "x",
                env: { DEEPSEEK_API_KEY: "only-in-codon-env" },
              },
            ],
          },
        },
        { ...options, harnesses: { codon: [claude(), keyedPi()], sentinel: [aiSdk()] } },
      );

      expect(calls.map((c) => [c.target, c.env.DEEPSEEK_API_KEY])).toEqual([
        ["deepseek/deepseek-v4-pro", "only-in-codon-env"],
      ]);
      expect(confirmed(models.check("deepseek/deepseek-v4-pro")).modelId).toBe("deepseek-v4-pro");
    });
  }

  it("names each codon an override applies to in its origin", async () => {
    const models = await load(
      {
        hank: {
          hank: [
            codon("a", "openai/gpt-5.6-sol"),
            { id: "b", name: "b", continuationMode: "fresh", promptText: "x" },
          ],
        },
      },
      {
        cliModel: "deepseek/deepseek-v4-pro",
        harnesses: { codon: [claude(), keyedPi()], sentinel: [aiSdk()] },
      },
    );

    expect(failed(models.check("deepseek/deepseek-v4-pro")).kind).toBe("no-credentials");
    expect(models.report()).toContain(
      "! --model (codon 'a'), --model (codon 'b'): No credentials for provider 'deepseek'.",
    );
  });

  it("names the codon whose env block failed when the override is checked in several", async () => {
    const models = await load(
      {
        hank: {
          hank: [
            codon("a", "openai/gpt-5.6-sol", { env: { DEEPSEEK_API_KEY: "k-a" } }),
            codon("b", "openai/gpt-5.6-sol"),
          ],
        },
      },
      {
        cliModel: "deepseek/deepseek-v4-pro",
        harnesses: { codon: [claude(), keyedPi()], sentinel: [aiSdk()] },
      },
    );

    expect(calls.map((c) => c.env.DEEPSEEK_API_KEY)).toEqual(["k-a", undefined]);
    const result = failed(models.check("deepseek/deepseek-v4-pro"));
    expect(result.kind).toBe("no-credentials");
    expect(result.message).toEndWith("(with the env block of --model (codon 'b'))");
    expect(result.message).toBe(
      "No credentials for provider 'deepseek'. (with the env block of --model (codon 'b'))",
    );
  });

  it("adds no env-block suffix when the override is checked in one env", async () => {
    const models = await load(
      {
        hank: {
          hank: [
            codon("a", "openai/gpt-5.6-sol", { env: { OTHER: "x" } }),
            codon("b", "openai/gpt-5.6-sol", { env: { OTHER: "x" } }),
          ],
        },
      },
      {
        cliModel: "deepseek/deepseek-v4-pro",
        harnesses: { codon: [claude(), keyedPi()], sentinel: [aiSdk()] },
      },
    );

    expect(calls).toHaveLength(1);
    const result = failed(models.check("deepseek/deepseek-v4-pro"));
    expect(result.message).toBe("No credentials for provider 'deepseek'.");
    expect(result.message).not.toContain("with the env block of");
  });
});

describe("Models.get", () => {
  it("returns a harness-confirmed record only for the use that confirmed it", async () => {
    const models = await load({
      hank: {
        hank: [
          codon("c0", "deepseek/pi-only-1", {
            sentinels: [{ sentinelConfig: sentinel("s", "openai/sentinel-only-1") }],
          }),
        ],
      },
    });

    expect(models.get("deepseek", "pi-only-1", "codon")?.provenance?.evidence).toBe("pi says yes");
    expect(models.get("deepseek", "pi-only-1")).toBeDefined();
    expect(models.get("deepseek", "pi-only-1", "sentinel")).toBeUndefined();
    expect(models.get("openai", "sentinel-only-1", "sentinel")?.provenance?.evidence).toBe(
      "ai-sdk says yes",
    );
    expect(models.get("openai", "sentinel-only-1", "codon")).toBeUndefined();
    // Catalog records answer for either use.
    expect(models.get("anthropic", "claude-haiku-4-5", "sentinel")).toBeDefined();
  });

  it("never returns a shadowed spelling's record, which no harness was asked about", async () => {
    const models = await load(
      { hank: hankOf(["openai/gpt-5.6-sol"], { overrides: { model: "deepseek/shadow-only-1" } }) },
      { cliModel: "anthropic/claude-haiku-4-5" },
    );

    expect(targets()).toEqual(["anthropic/claude-haiku-4-5"]);
    expect(confirmed(models.check("deepseek/shadow-only-1")).provenance?.evidence).toStartWith(
      "not checked: shadowed",
    );
    expect(models.get("deepseek", "shadow-only-1")).toBeUndefined();
    expect(models.get("deepseek", "shadow-only-1", "codon")).toBeUndefined();
  });

  it("ProviderHealth asks for sentinel records", async () => {
    await load({
      hank: {
        hank: [
          codon("c0", "deepseek/pi-only-1", {
            sentinels: [{ sentinelConfig: sentinel("s", "openai/sentinel-only-1") }],
          }),
        ],
      },
    });

    // The installed Models: a codon-only record is not a sentinel's.
    const health = new ProviderHealth({ logger: new Logger("/dev/null") });
    expect(health.getModelInfo("deepseek/pi-only-1")).toEqual({
      success: false,
      reason: "model-not-found",
    });
    expect(health.getModelInfo("openai/sentinel-only-1")).toMatchObject({
      success: true,
      info: { providerId: "openai", modelId: "sentinel-only-1" },
    });

    const get = mock((_provider: string, _modelId: string, _use?: ModelUse) => undefined);
    new ProviderHealth({ models: { get } }).getModelInfo(" openai/gpt-4o ");
    expect(get.mock.calls).toEqual([["openai", "gpt-4o", "sentinel"]]);
  });
});

describe("Models.load: sentinel models", () => {
  function sentinelHank() {
    fs.mkdirSync(path.join(tmp, "sentinels"));
    fs.writeFileSync(
      path.join(tmp, "sentinels", "judge.json"),
      JSON.stringify(sentinel("judge", "openai/gpt-5.6-sol")),
    );
    return {
      overrides: { model: "anthropic/claude-haiku-4-5" },
      hank: [
        codon("c0", "zai/glm-5", {
          sentinels: [
            { sentinelConfig: sentinel("inline", "anthropic/claude-sonnet-4-5") },
            { sentinelConfig: "sentinels/judge.json" },
            { sentinelConfig: sentinel("forced", "pi/anthropic/claude-haiku-4-5") },
          ],
        }),
      ],
    };
  }

  const keylessOpenAi = () =>
    aiSdk({
      answer: (provider, modelId, env, opts) =>
        provider === "openai"
          ? {
              ok: false,
              kind: "no-credentials",
              message: "No credentials for sentinel provider 'openai'.",
              candidates: [],
            }
          : yes("ai-sdk")(provider, modelId, env, opts),
    });

  it("collects inline and file-backed sentinel models under an override, on the sentinel list only", async () => {
    const models = await load(
      { hank: sentinelHank(), hankDir: tmp },
      { harnesses: { codon: [claude(), pi()], sentinel: [keylessOpenAi()] } },
    );

    expect(targets("claude-agent-sdk")).toEqual(["anthropic/claude-haiku-4-5"]);
    expect(targets("pi")).toEqual([]);
    expect(targets("ai-sdk")).toEqual(["anthropic/claude-sonnet-4-5", "openai/gpt-5.6-sol"]);
    expect(models.check("anthropic/claude-sonnet-4-5", "sentinel").ok).toBe(true);
    // Results are per use: the same spelling as a codon model was never collected.
    expect(failed(models.check("anthropic/claude-sonnet-4-5", "codon")).kind).toBe("unprepared");
  });

  it("reports a sentinel the harness refused as skipped, and a misspelled one as an error", async () => {
    const models = await load(
      { hank: sentinelHank(), hankDir: tmp },
      { harnesses: { codon: [claude(), pi()], sentinel: [keylessOpenAi()] } },
    );

    expect(failed(models.check("openai/gpt-5.6-sol", "sentinel"))).toMatchObject({
      kind: "no-credentials",
      stage: "harness",
    });
    expect(failed(models.check("pi/anthropic/claude-haiku-4-5", "sentinel"))).toMatchObject({
      kind: "bad-prefix",
      stage: "name",
    });
    const report = models.report();
    expect(report).toContain(
      "! sentinel 'judge' of codon 'c0': No credentials for sentinel provider 'openai'. (the sentinel will be skipped)",
    );
    const forced = report.find((line) => line.startsWith("! sentinel 'forced' of codon 'c0': "));
    expect(forced).toBeDefined();
    expect(forced).not.toContain("will be skipped");
    // Sentinels are not codon harness reports.
    expect(models.harnessReports().map((r) => r.modelId)).toEqual([]);
  });
});

describe("Models.check", () => {
  it("answers a spelling load never saw with 'unprepared' in run mode", async () => {
    const models = await load({ hank: hankOf(["anthropic/claude-haiku-4-5"]) });

    const result = failed(models.check("anthropic/claude-sonnet-4-5", "codon"));
    expect(result).toMatchObject({ kind: "unprepared", stage: "name" });
    expect(result.message).toContain("was not checked at startup");
  });

  it("answers any spelling in parse mode, from catalog membership, asking no harness", async () => {
    const offlineRow = (provider: string, modelId: string) =>
      `${provider}/${modelId}` === "deepseek/pi-only-1"
        ? { cost: { input: 0.5, output: 2 }, limit: { context: 262_144, output: 32_000 } }
        : undefined;
    const harnesses = { codon: [claude(), pi({ offlineRow })], sentinel: [aiSdk()] };
    const models = await load(
      { hank: hankOf(["anthropic/claude-haiku-4-5", "deepseek/pi-only-1"]) },
      { harnesses, prerequisites: false, env: {} },
    );

    expect(confirmed(models.check("anthropic/claude-haiku-4-5")).provenance?.evidence).toBe(
      "catalog (parse mode)",
    );
    const piOnly = confirmed(models.check("deepseek/pi-only-1"));
    expect(piOnly.provenance?.evidence).toBe("pi catalog (parse mode)");
    expect(piOnly.provenance?.confidence).toBe("harness");
    // Priced and limited from the harness's offline row, as the run that checked it was.
    expect(piOnly.cost).toMatchObject({ input: 0.5, output: 2 });
    expect(piOnly.limit.context).toBe(262_144);
    // Never collected, answered on demand.
    expect(confirmed(models.check("anthropic/claude-sonnet-4-5")).provenance?.evidence).toBe(
      "catalog (parse mode)",
    );
    expect(failed(models.check("deepseek/deepseek-imaginary-9"))).toMatchObject({
      kind: "unknown-model",
      stage: "harness",
    });

    const parsing = Models.loadForParsing({}, { harnesses, bundledOnly: true });
    expect(Models.current()).toBe(parsing);
    expect(confirmed(parsing.check("deepseek/deepseek-v4-pro")).provenance?.evidence).toBe(
      "catalog (parse mode)",
    );
    expect(confirmed(parsing.check("anthropic/claude-haiku-4-5", "sentinel")).providerId).toBe(
      "anthropic",
    );
    expect(calls).toEqual([]);
  });

  // The AI SDK sends a sentinel's id verbatim: "<id>-xhigh" is a price the
  // catalog synthesized for Pi's effort suffix, not a model OpenAI serves.
  it("parse mode: a synthesized effort variant is a codon model, not a sentinel model", () => {
    Models.loadForParsing({}, { harnesses: modelHarnesses(), bundledOnly: true });

    const sentinelUse = failed(Models.current().check("openai/gpt-5.6-sol-xhigh", "sentinel"));
    expect(sentinelUse).toMatchObject({ kind: "unknown-model", stage: "harness" });
    expect(confirmed(Models.current().check("openai/gpt-5.6-sol-xhigh", "codon")).modelId).toBe(
      "gpt-5.6-sol-xhigh",
    );
    expect(confirmed(Models.current().check("openai/gpt-5.6-sol", "sentinel")).modelId).toBe(
      "gpt-5.6-sol",
    );
  });
});

describe("Models.load: stage 3 pricing", () => {
  it("prices from the catalog record, else the harness's row, else leaves the price unknown", async () => {
    const rows: Record<string, HarnessCheckResult> = {
      "openai-codex/gpt-5.6-sol": {
        ok: true,
        evidence: "pi catalog",
        row: { cost: { input: 99, output: 99 } },
      },
      "deepseek/pi-priced-1": {
        ok: true,
        evidence: "pi catalog",
        row: {
          name: "Pi Priced",
          cost: { input: 2, output: 8, cache_read: 0.2 },
          limit: { context: 64_000, output: 8_000 },
        },
      },
      "deepseek/pi-free-1": {
        ok: true,
        evidence: "pi catalog",
        row: { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
      },
      "deepseek/pi-bare-1": { ok: true, evidence: "pi.dev" },
    };
    const models = await load(
      {
        hank: hankOf(["anthropic/claude-haiku-4-5", ...Object.keys(rows)]),
      },
      {
        harnesses: {
          codon: [claude(), pi({ answer: (provider, modelId) => rows[`${provider}/${modelId}`] })],
          sentinel: [aiSdk()],
        },
      },
    );

    const haiku = confirmed(models.check("anthropic/claude-haiku-4-5"));
    expect(haiku.provenance?.confidence).toBe("registry");
    expect(haiku.cost).toEqual(bundled("anthropic", "claude-haiku-4-5").cost);
    expect(haiku.provenance?.evidence).toBe("catalog");

    // openai-codex has no catalog rows of its own: priced as openai, run as openai-codex.
    const codex = confirmed(models.check("openai-codex/gpt-5.6-sol"));
    expect(codex.providerId).toBe("openai-codex");
    expect(codex.cost).toEqual(bundled("openai", "gpt-5.6-sol").cost);

    const priced = confirmed(models.check("deepseek/pi-priced-1"));
    expect(priced).toMatchObject({
      name: "Pi Priced",
      cost: { input: 2, output: 8, cache_read: 0.2 },
      limit: { context: 64_000, output: 8_000 },
    });
    expect(priced.provenance).toMatchObject({
      confidence: "harness",
      priceStatus: "known",
      source: "Pi's catalog",
      evidence: "pi catalog",
    });

    const free = confirmed(models.check("deepseek/pi-free-1"));
    expect(free.cost).toBeUndefined();
    expect(free.provenance).toMatchObject({ confidence: "harness", priceStatus: "unknown" });

    const bare = confirmed(models.check("deepseek/pi-bare-1"));
    expect(bare.cost).toBeUndefined();
    expect(bare.provenance).toMatchObject({ priceStatus: "unknown", evidence: "pi.dev" });
  });

  // A harness row found through an effort suffix is the base model's row: the
  // spelling prices like the catalog's synthesized variants (xhigh at twice
  // the base rate). A row listed under the suffixed id is priced as listed.
  describe("a harness-only effort-suffixed spelling", () => {
    const u = uniqueSuffix();
    const viaBase = `new-${u}`;
    const literal = `lit-${u}-xhigh`;
    const rows: Record<string, { id: string; cost: { input: number; output: number } }> = {
      [`deepseek/${viaBase}-xhigh`]: { id: viaBase, cost: { input: 1, output: 4 } },
      [`deepseek/${viaBase}-high`]: { id: viaBase, cost: { input: 1, output: 4 } },
      [`deepseek/${literal}`]: { id: literal, cost: { input: 1, output: 4 } },
    };

    it("doubles the base row's price for -xhigh and keeps a literally listed row's price", async () => {
      const models = await load(
        { hank: hankOf(Object.keys(rows)) },
        {
          harnesses: {
            codon: [
              claude(),
              pi({
                answer: (provider, modelId) => ({
                  ok: true,
                  evidence: "pi catalog",
                  row: rows[`${provider}/${modelId}`],
                }),
              }),
            ],
            sentinel: [aiSdk()],
          },
        },
      );

      const xhigh = confirmed(models.check(`deepseek/${viaBase}-xhigh`));
      expect(xhigh.modelId).toBe(`${viaBase}-xhigh`);
      expect(xhigh.cost).toMatchObject({ input: 2, output: 8 });
      expect(xhigh.provenance).toMatchObject({ confidence: "harness", priceStatus: "known" });
      expect(confirmed(models.check(`deepseek/${viaBase}-high`)).cost).toMatchObject({
        input: 1,
        output: 4,
      });
      expect(confirmed(models.check(`deepseek/${literal}`)).cost).toMatchObject({
        input: 1,
        output: 4,
      });
    });

    it("prices parse mode's offline row the same way", async () => {
      const offlineRow = (provider: string, modelId: string) =>
        provider === "deepseek" ? rows[`${provider}/${modelId}`] : undefined;
      const models = await load(
        { hank: hankOf([`deepseek/${viaBase}-xhigh`]) },
        {
          harnesses: { codon: [claude(), pi({ offlineRow })], sentinel: [aiSdk()] },
          prerequisites: false,
        },
      );

      const xhigh = confirmed(models.check(`deepseek/${viaBase}-xhigh`));
      expect(xhigh.provenance?.evidence).toBe("pi catalog (parse mode)");
      expect(xhigh.cost).toMatchObject({ input: 2, output: 8 });
      // Answered on demand, never collected.
      expect(confirmed(models.check(`deepseek/${literal}`)).cost).toMatchObject({
        input: 1,
        output: 4,
      });
      expect(calls).toEqual([]);
    });
  });
});

describe("Models.load: adoption", () => {
  const withBlock = () =>
    hankOf(["deepseek/deepseek-v9"], {
      models: [
        {
          id: "deepseek/deepseek-v9",
          basedOn: "deepseek/deepseek-v4-pro",
          cost: { input: 1, output: 2 },
        },
      ],
    });
  const unknownUnlessAdopted =
    (adopted: Set<string>): Answer =>
    (provider, modelId) =>
      adopted.has(`${provider}/${modelId}`)
        ? { ok: true, evidence: "pi catalog" }
        : {
            ok: false,
            kind: "unknown-model",
            message: `Pi has no model '${provider}/${modelId}'.`,
            candidates: [],
          };

  it("lets the harness adopt a model the catalog has a record for, then checks again", async () => {
    const adopted = new Set<string>();
    const adopt = mock(
      async (
        provider: string,
        modelId: string,
        _record: ModelInfo,
        siblings: readonly ModelInfo[],
      ) => {
        adopted.add(`${provider}/${modelId}`);
        return { ok: true as const, evidence: `adopted from ${provider}/${siblings[0]?.modelId}` };
      },
    );
    const models = await load(
      { hank: withBlock() },
      {
        harnesses: {
          codon: [claude(), pi({ adopt, answer: unknownUnlessAdopted(adopted) })],
          sentinel: [aiSdk()],
        },
      },
    );

    expect(targets()).toEqual(["deepseek/deepseek-v9", "deepseek/deepseek-v9"]);
    expect(adopt).toHaveBeenCalledTimes(1);
    const [provider, modelId, record, siblings] = adopt.mock.calls[0];
    expect([provider, modelId]).toEqual(["deepseek", "deepseek-v9"]);
    expect(record).toMatchObject({ providerId: "deepseek", modelId: "deepseek-v9" });
    expect(record.provenance?.confidence).toBe("user");
    expect(siblings.length).toBeGreaterThan(0);
    expect(siblings.every((s) => s.providerId === "deepseek" && s.modelId !== "deepseek-v9")).toBe(
      true,
    );
    expect(siblings.map((s) => s.modelId)).toContain("deepseek-v4-pro");
    // Same family first, then the rest of the line, each newest first (siblingsOf).
    const family = record.family?.toLowerCase();
    const sameFamily = siblings.filter(
      (s) => family !== undefined && s.family?.toLowerCase() === family,
    );
    const sameLine = siblings.slice(sameFamily.length);
    expect(siblings.slice(0, sameFamily.length)).toEqual(sameFamily);
    expect([...sameFamily].sort(compareNewest)).toEqual(sameFamily);
    expect([...sameLine].sort(compareNewest)).toEqual(sameLine);

    const model = confirmed(models.check("deepseek/deepseek-v9"));
    expect(model.provenance?.evidence).toBe(`adopted from deepseek/${siblings[0]?.modelId}`);
    expect(model.provenance?.confidence).toBe("user");
    expect(model.cost).toMatchObject({ input: 1, output: 2 });
  });

  describe("a model models.dev listed after the cache was refreshed", () => {
    const body = {
      deepseek: {
        name: "DeepSeek",
        models: {
          "deepseek-v9-fresh": {
            name: "DeepSeek V9 Fresh",
            attachment: false,
            reasoning: true,
            tool_call: true,
            release_date: "2026-10-20",
            last_updated: "2026-10-20",
            cost: { input: 0.5, output: 2 },
            limit: { context: 1000000, output: 64000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    };
    const adopter = (adopted: Set<string>) =>
      mock(async (provider: string, modelId: string) => {
        adopted.add(`${provider}/${modelId}`);
        return { ok: true as const, evidence: "adopted from deepseek/deepseek-v4-pro" };
      });
    const cachePath = () => path.join(tmp, "catalog", "models-dev.json");
    const options = (
      adopt: ReturnType<typeof adopter>,
      adopted: Set<string>,
      fetchSpy: unknown,
    ) => ({
      harnesses: {
        codon: [claude(), pi({ adopt, answer: unknownUnlessAdopted(adopted) })],
        sentinel: [aiSdk()],
      },
      network: true,
      fetch: fetchSpy as typeof fetch,
    });

    it("refreshes a missing models.dev cache before rejecting, then adopts", async () => {
      const adopted = new Set<string>();
      const adopt = adopter(adopted);
      const fetchSpy = mock(async () => Response.json(body));
      const models = await load(
        { hank: hankOf(["deepseek/deepseek-v9-fresh"]) },
        options(adopt, adopted, fetchSpy),
      );

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(adopt).toHaveBeenCalledTimes(1);
      const model = confirmed(models.check("deepseek/deepseek-v9-fresh"));
      expect(model.provenance?.evidence).toBe("adopted from deepseek/deepseek-v4-pro");
      expect(model.provenance?.source).toStartWith("models.dev live ");
      expect(model.cost).toMatchObject({ input: 0.5, output: 2 });
      expect(fs.existsSync(cachePath())).toBe(true);
    });

    it("does not refresh a fresh cache, nor when every model is known", async () => {
      const adopted = new Set<string>();
      const adopt = adopter(adopted);
      const fetchSpy = mock(async () => Response.json(body));
      await load(
        { hank: hankOf(["deepseek/deepseek-v9-fresh"]) },
        options(adopt, adopted, fetchSpy),
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Fresh cache: an unknown model is rejected without another download.
      const again = await load(
        { hank: hankOf(["deepseek/deepseek-imaginary-9"]) },
        options(adopter(new Set()), new Set(), fetchSpy),
      );
      expect(failed(again.check("deepseek/deepseek-imaginary-9")).kind).toBe("unknown-model");
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Stale cache, known model: nothing to retry, so no download.
      fs.rmSync(cachePath());
      await load({ hank: hankOf(["deepseek/deepseek-v4-pro"]) }, options(adopt, adopted, fetchSpy));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("stays offline when online model checks are off", async () => {
      const adopted = new Set<string>();
      const fetchSpy = mock(async () => Response.json(body));
      const models = await load(
        { hank: hankOf(["deepseek/deepseek-v9-fresh"]) },
        { ...options(adopter(adopted), adopted, fetchSpy), network: false },
      );
      expect(failed(models.check("deepseek/deepseek-v9-fresh")).kind).toBe("unknown-model");
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it("says why an adoption failed", async () => {
    const models = await load(
      { hank: withBlock() },
      {
        harnesses: {
          codon: [
            claude(),
            pi({
              adopt: async () => ({ ok: false, reason: "no sibling to copy from" }),
              answer: unknownUnlessAdopted(new Set()),
            }),
          ],
          sentinel: [aiSdk()],
        },
      },
    );

    const result = failed(models.check("deepseek/deepseek-v9"));
    expect(result.kind).toBe("unknown-model");
    expect(result.message).toBe(
      "Pi has no model 'deepseek/deepseek-v9'. Closest: deepseek/deepseek-flash, deepseek/deepseek-v4-pro. hankweave's catalog has a record for it, but it could not be added to Pi's catalog: no sibling to copy from.",
    );
  });

  // "<id>-high" is <id> at a higher effort: Pi adopts <id> and carries the
  // effort, which only a reasoning model has.
  describe("an effort-suffixed spelling", () => {
    /** Pi knows a model once its base id was adopted, effort suffix allowed. */
    const unknownUnlessBaseAdopted =
      (adopted: Set<string>): Answer =>
      (provider, modelId) =>
        adopted.has(`${provider}/${modelId.replace(/-(xhigh|high)$/, "")}`)
          ? { ok: true, evidence: "pi catalog" }
          : {
              ok: false,
              kind: "unknown-model",
              message: `Pi has no model '${provider}/${modelId}'.`,
              candidates: [],
            };
    const adopter = (adopted: Set<string>) =>
      mock(async (provider: string, _modelId: string, record: ModelInfo) => {
        adopted.add(`${provider}/${record.modelId}`);
        return { ok: true as const, evidence: `adopted from ${provider}/deepseek-v4-pro` };
      });
    const flashBlock = (reasoning: boolean) => [{ id: "deepseek/deepseek-v4-flash", reasoning }];

    it("adopts the base record when the base is a reasoning model", async () => {
      const adopted = new Set<string>();
      const adopt = adopter(adopted);
      const models = await load(
        { hank: hankOf(["deepseek/deepseek-v4-flash-high"], { models: flashBlock(true) }) },
        {
          harnesses: {
            codon: [claude(), pi({ adopt, answer: unknownUnlessBaseAdopted(adopted) })],
            sentinel: [aiSdk()],
          },
        },
      );

      expect(adopt).toHaveBeenCalledTimes(1);
      const [provider, modelId, record] = adopt.mock.calls[0];
      expect([provider, modelId]).toEqual(["deepseek", "deepseek-v4-flash-high"]);
      expect(record).toMatchObject({
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        reasoning: true,
      });
      expect(targets()).toEqual([
        "deepseek/deepseek-v4-flash-high",
        "deepseek/deepseek-v4-flash-high",
      ]);
      const model = confirmed(models.check("deepseek/deepseek-v4-flash-high"));
      expect(model.modelId).toBe("deepseek-v4-flash-high");
      expect(model.provenance?.evidence).toBe("adopted from deepseek/deepseek-v4-pro");
    });

    it("does not adopt the base record when the base is not a reasoning model", async () => {
      const adopted = new Set<string>();
      const adopt = adopter(adopted);
      const models = await load(
        { hank: hankOf(["deepseek/deepseek-v4-flash-high"], { models: flashBlock(false) }) },
        {
          harnesses: {
            codon: [claude(), pi({ adopt, answer: unknownUnlessBaseAdopted(adopted) })],
            sentinel: [aiSdk()],
          },
        },
      );

      expect(models.get("deepseek", "deepseek-v4-flash")?.reasoning).toBe(false);
      expect(adopt).not.toHaveBeenCalled();
      const result = failed(models.check("deepseek/deepseek-v4-flash-high"));
      expect(result.kind).toBe("unknown-model");
      expect(result.message).not.toContain("hankweave's catalog has a record for it");
    });

    it("shares one adoption between X and X-high checked concurrently", async () => {
      const adopted = new Set<string>();
      const adopt = adopter(adopted);
      const models = await load(
        {
          hank: hankOf(["deepseek/deepseek-v9", "deepseek/deepseek-v9-high"], {
            models: [
              { id: "deepseek/deepseek-v9", basedOn: "deepseek/deepseek-v4-pro", reasoning: true },
            ],
          }),
        },
        {
          harnesses: {
            codon: [claude(), pi({ adopt, answer: unknownUnlessBaseAdopted(adopted) })],
            sentinel: [aiSdk()],
          },
        },
      );

      expect(adopt).toHaveBeenCalledTimes(1);
      expect(adopt.mock.calls[0]?.[2].modelId).toBe("deepseek-v9");
      for (const spelling of ["deepseek/deepseek-v9", "deepseek/deepseek-v9-high"]) {
        expect(confirmed(models.check(spelling)).provenance?.evidence).toBe(
          "adopted from deepseek/deepseek-v4-pro",
        );
      }
    });

    // OpenAI reasoning models get synthesized "-high"/"-xhigh" catalog
    // variants (xhigh at twice the rate). Those are prices, not records to
    // adopt: Pi gets the base record, once, whichever spelling asks.
    it("adopts an OpenAI base once for X, X-high and X-xhigh, from the base record", async () => {
      const id = `gpt-test-${uniqueSuffix()}`;
      const spellings = [`openai/${id}`, `openai/${id}-high`, `openai/${id}-xhigh`];
      const adopt = mock(
        async (_provider: string, _modelId: string, _record: ModelInfo) =>
          ({ ok: true, evidence: "adopted" }) as const,
      );
      const models = await load(
        {
          hank: hankOf(spellings, {
            models: [
              {
                id: `openai/${id}`,
                reasoning: true,
                cost: { input: 2, output: 10 },
                limit: { context: 200_000, output: 32_000 },
              },
            ],
          }),
        },
        {
          harnesses: {
            // Pi never learns the model: every spelling stays unknown.
            codon: [claude(), pi({ adopt, answer: unknownUnlessBaseAdopted(new Set()) })],
            sentinel: [aiSdk()],
          },
        },
      );

      // Every spelling was rejected (Pi never learned the model), so get()
      // hands out none of them, the synthesized xhigh variant included.
      expect(models.get("openai", `${id}-xhigh`)).toBeUndefined();
      expect(adopt).toHaveBeenCalledTimes(1);
      const [provider, , record] = adopt.mock.calls[0] ?? [];
      expect(provider).toBe("openai");
      expect(record).toMatchObject({
        providerId: "openai",
        modelId: id,
        reasoning: true,
        cost: { input: 2, output: 10 },
      });
      expect(record?.provenance?.confidence).toBe("user");
      for (const spelling of spellings) {
        expect(failed(models.check(spelling)).kind).toBe("unknown-model");
      }
    });
  });
});

describe("Models.load: harness answers", () => {
  it("reports a harness check that throws as harness-unavailable", async () => {
    const models = await load(
      { hank: hankOf(["anthropic/claude-haiku-4-5"]) },
      {
        harnesses: {
          codon: [
            claude({
              answer: () => {
                throw new Error("CLI crashed");
              },
            }),
            pi(),
          ],
          sentinel: [aiSdk()],
        },
      },
    );

    const result = failed(models.check("anthropic/claude-haiku-4-5"));
    expect(result).toMatchObject({ kind: "harness-unavailable", stage: "harness" });
    expect(result.message).toBe(
      "the Claude Agent SDK failed while checking 'anthropic/claude-haiku-4-5': CLI crashed",
    );
  });

  const probe: ProbeRecord = {
    providerId: "anthropic",
    modelId: "claude-probed-1",
    probedAt: new Date().toISOString(),
    source: "anthropic GET /v1/models/claude-probed-1",
    name: "Claude Probed 1",
  };
  const probing = () =>
    claude({
      answer: (provider, modelId, _env, opts) =>
        opts.knownToCatalog(provider, modelId)
          ? { ok: true, evidence: "catalog" }
          : {
              ok: true,
              evidence: "anthropic GET /v1/models",
              probe,
              row: { name: probe.name },
            },
    });

  it("saves a model-list answer to probes.json and takes the record from the rebuilt catalog", async () => {
    const catalogDir = path.join(tmp, "catalog");
    const models = await load(
      { hank: hankOf(["anthropic/claude-probed-1"]) },
      { harnesses: { codon: [probing(), pi()], sentinel: [aiSdk()] } },
    );

    const saved = JSON.parse(fs.readFileSync(path.join(catalogDir, "probes.json"), "utf-8"));
    expect(saved.records).toEqual([probe]);
    const model = confirmed(models.check("anthropic/claude-probed-1"));
    expect(model.provenance?.confidence).toBe("provisional");
    expect(model.provenance?.source).toStartWith("anthropic GET /v1/models/claude-probed-1");
    expect(model.provenance?.evidence).toBe("anthropic GET /v1/models");

    // The next startup finds it in the catalog.
    const again = await load(
      { hank: hankOf(["anthropic/claude-probed-1"]) },
      { harnesses: { codon: [probing(), pi()], sentinel: [aiSdk()] } },
    );
    expect(confirmed(again.check("anthropic/claude-probed-1")).provenance).toMatchObject({
      confidence: "provisional",
      evidence: "catalog",
    });
  });

  it("reports a model-list answer it could not save instead of failing the run", async () => {
    const catalogDir = path.join(tmp, "catalog");
    // A directory where probes.json belongs: no rename lands over it.
    fs.mkdirSync(path.join(catalogDir, "probes.json"), { recursive: true });
    const models = await load(
      { hank: hankOf(["anthropic/claude-probed-1"]) },
      { harnesses: { codon: [probing(), pi()], sentinel: [aiSdk()] } },
    );

    expect(models.problems()).toHaveLength(1);
    expect(models.problems()[0]).toStartWith(
      `Model catalog: anthropic confirmed 'claude-probed-1', but the result could not be saved to ${path.join(catalogDir, "probes.json")}:`,
    );
    expect(confirmed(models.check("anthropic/claude-probed-1")).provenance?.confidence).toBe(
      "harness",
    );
  });
});

describe("Models: reports", () => {
  const steps: HarnessCheckStep[] = [
    { name: "sdk_installed", passed: true, message: "Claude Agent SDK found (version 9.9.9)" },
    { name: "model_catalog", passed: true, message: "The model catalog lists it" },
  ];
  const info = () => ({
    shim: { name: "claude-agent-sdk-manager", version: "9.9.9" },
    agent: { name: "claude-agent-sdk", version: "9.9.9" },
  });

  it("returns per-codon harness reports in the self-test shape", async () => {
    const models = await load(
      {
        hank: {
          hank: [
            codon("c0", "anthropic/claude-haiku-4-5", {
              sentinels: [{ sentinelConfig: sentinel("s", "anthropic/claude-haiku-4-5") }],
            }),
            codon("c1", "sonnet"),
          ],
        },
      },
      {
        harnesses: {
          codon: [claude({ info, answer: () => ({ ok: true, evidence: "catalog", steps }) }), pi()],
          sentinel: [aiSdk({ answer: () => ({ ok: true, evidence: "catalog", steps }) })],
        },
      },
    );

    expect(models.harnessReports()).toEqual([
      {
        modelId: "claude-haiku-4-5",
        modelName: bundled("anthropic", "claude-haiku-4-5").name,
        provider: "anthropic",
        passed: true,
        result: {
          shim: info().shim,
          agent: { ...info().agent, found: true },
          checks: steps,
          overall: { passed: true, message: "All checks passed" },
        },
      },
    ]);
  });

  it("prints each confirmed model with its evidence, and each rejection with its origin", async () => {
    const models = await load({ hank: hankOf(["anthropic/claude-haiku-4-5", "sonnet"]) });

    const report = models.report();
    expect(report[0]).toBe("Models");
    expect(report[1]).toMatch(
      /^ {2}anthropic\/claude-haiku-4-5 → anthropic\/claude-haiku-4-5 {2}claude-agent-sdk {2}registry /,
    );
    expect(report[2]?.trim()).toStartWith("confirmed by catalog");
    expect(report.at(-1)).toBe(`! codon 'c1': ${failed(models.check("sonnet")).message}`);
  });
});

describe("Models.load: the collector covers every path config parsing validates", () => {
  /** Every check config parsing makes, with its result. */
  function recordChecks(models: Models): { spelling: string; use: ModelUse; kind: string }[] {
    const asked: { spelling: string; use: ModelUse; kind: string }[] = [];
    const original = models.check.bind(models);
    models.check = (spelling: string, use: ModelUse = "codon") => {
      const result = original(spelling, use);
      asked.push({ spelling, use, kind: result.ok ? "ok" : result.kind });
      return result;
    };
    return asked;
  }

  function writeConfigs(options: {
    overrides?: string;
    runtimeModel?: string;
    /** Add codon 'm', which writes no model (an override supplies it), with an env block and a sentinel. */
    modelless?: boolean;
  }) {
    fs.mkdirSync(path.join(tmp, "sentinels"));
    fs.writeFileSync(
      path.join(tmp, "sentinels", "judge.json"),
      JSON.stringify(sentinel("judge", "openai/gpt-5.6-sol")),
    );
    const hank = {
      ...(options.overrides ? { overrides: { model: options.overrides } } : {}),
      hank: [
        codon("a", "anthropic/claude-haiku-4-5", {
          sentinels: [
            { sentinelConfig: sentinel("inline", "anthropic/claude-sonnet-4-5") },
            { sentinelConfig: "sentinels/judge.json" },
          ],
        }),
        {
          type: "loop",
          id: "l",
          name: "L",
          terminateOn: { type: "iterationLimit", limit: 2 },
          codons: [codon("b", "deepseek/deepseek-v4-pro")],
        },
        ...(options.modelless
          ? [
              {
                id: "m",
                name: "m",
                continuationMode: "fresh",
                promptText: "x",
                env: { MODELLESS_KEY: "from-codon-m" },
                sentinels: [{ sentinelConfig: sentinel("modelless", "openai/gpt-4o") }],
              },
            ]
          : []),
      ],
    };
    const hankPath = path.join(tmp, "hank.json");
    fs.writeFileSync(hankPath, JSON.stringify(hank));
    const runtimePath = path.join(tmp, "hankweave.json");
    fs.writeFileSync(
      runtimePath,
      JSON.stringify(options.runtimeModel ? { model: options.runtimeModel } : {}),
    );
    const execution = path.join(tmp, "execution");
    fs.mkdirSync(execution);
    return { hank, hankPath, runtimePath, execution };
  }

  async function parse(
    files: ReturnType<typeof writeConfigs>,
    asked: ReturnType<typeof recordChecks>,
    modelOverride?: string,
  ) {
    loadRuntimeConfig(files.runtimePath);
    await validateHank({
      configPath: files.hankPath,
      executionPath: files.execution,
      logger: new Logger("/dev/null"),
      modelOverride,
    });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.filter((a) => a.kind !== "ok")).toEqual([]);
  }

  it("codon models (incl. loop codons) and sentinel models (inline and file-backed)", async () => {
    const files = writeConfigs({});
    const models = await load({ hank: files.hank, hankDir: tmp });
    const asked = recordChecks(models);

    await parse(files, asked);
    expect(targets().sort()).toEqual(
      [
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-sonnet-4-5",
        "deepseek/deepseek-v4-pro",
        "openai/gpt-5.6-sol",
      ].sort(),
    );
    expect(new Set(asked.map((a) => `${a.use} ${a.spelling}`))).toEqual(
      new Set([
        "codon anthropic/claude-haiku-4-5",
        "codon deepseek/deepseek-v4-pro",
        "sentinel anthropic/claude-sonnet-4-5",
        "sentinel openai/gpt-5.6-sol",
      ]),
    );
  });

  // resolveSettings hands the winning override to validation as modelOverride.
  const layers: {
    name: string;
    effective: string;
    cliModel?: string;
    env?: NodeJS.ProcessEnv;
    overrides?: string;
    runtimeModel?: string;
  }[] = [
    { name: "hankweave.json model", effective: "zai/glm-5", runtimeModel: "zai/glm-5" },
    {
      name: "hank overrides.model",
      effective: "anthropic/claude-opus-4-6",
      overrides: "anthropic/claude-opus-4-6",
      runtimeModel: "zai/glm-5",
    },
    {
      name: "HANKWEAVE_RUNTIME_MODEL",
      effective: "openai-codex/gpt-5.6-sol",
      env: { HANKWEAVE_RUNTIME_MODEL: "openai-codex/gpt-5.6-sol" },
      overrides: "anthropic/claude-opus-4-6",
      runtimeModel: "zai/glm-5",
    },
    {
      name: "--model",
      effective: "anthropic/claude-sonnet-4-6",
      cliModel: "anthropic/claude-sonnet-4-6",
      env: { HANKWEAVE_RUNTIME_MODEL: "openai-codex/gpt-5.6-sol" },
      overrides: "anthropic/claude-opus-4-6",
      runtimeModel: "zai/glm-5",
    },
  ];
  for (const layer of layers) {
    it(`${layer.name}, when it is the effective override`, async () => {
      const files = writeConfigs({ ...layer, modelless: true });
      const models = await load(
        { hank: files.hank, runtime: { model: layer.runtimeModel }, hankDir: tmp },
        { cliModel: layer.cliModel, env: layer.env ?? {} },
      );
      const asked = recordChecks(models);

      await parse(files, asked, layer.effective);
      // Once for the codons with no env block, once with codon 'm''s.
      const codonCalls = calls.filter((c) => c.harness !== "ai-sdk");
      expect(codonCalls.map((c) => c.target)).toEqual([layer.effective, layer.effective]);
      expect(codonCalls.map((c) => c.env.MODELLESS_KEY)).toEqual([undefined, "from-codon-m"]);
      expect(asked.some((a) => a.use === "codon" && a.spelling === layer.effective)).toBe(true);
      // Codon 'm''s sentinel was collected, and config parsing found it prepared.
      expect(targets("ai-sdk")).toContain("openai/gpt-4o");
      expect(asked).toContainEqual({ spelling: "openai/gpt-4o", use: "sentinel", kind: "ok" });
      expect(
        models.report().filter((line) => line.startsWith("!") || line.includes("not checked")),
      ).toEqual([]);
    });
  }
});

describe("Models.load with the real harness checks", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = captureEnv();
    // Hermetic: no Pi auth store, no catalog cache, no provider keys.
    process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(tmp, "pi-agent-"));
    process.env.HANKWEAVE_MODEL_CATALOG_DIR = path.join(tmp, "catalog");
    for (const key of Object.keys(process.env)) {
      if (key.endsWith("_API_KEY")) delete process.env[key];
    }
  });

  afterEach(() => {
    restoreEnv(savedEnv);
  });

  /** An environment with nothing a provider could authenticate with. */
  const bareEnv = (): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    HANKWEAVE_MODEL_CATALOG_DIR: process.env.HANKWEAVE_MODEL_CATALOG_DIR,
  });

  it("Pi names the missing key of a provider outside the old credentials table, offline", async () => {
    const fetchSpy = mock(globalThis.fetch);
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const models = await load(
        {
          hank: {
            hank: [
              codon("keyless", "deepseek/deepseek-v4-pro"),
              codon("keyed", "deepseek/deepseek-imaginary-9", {
                env: { DEEPSEEK_API_KEY: "sk-test-never-valid" },
              }),
            ],
          },
        },
        {
          harnesses: { codon: [new ClaudeModelCheck(), new PiModelCheck()], sentinel: [] },
          env: bareEnv(),
          network: false,
        },
      );

      const keyless = failed(models.check("deepseek/deepseek-v4-pro"));
      expect(keyless.kind).toBe("no-credentials");
      expect(keyless.message).toStartWith(
        "No credentials for provider 'deepseek' (checked the environment, this codon's env block and Pi's auth store).",
      );
      expect(keyless.message).toContain("Set DEEPSEEK_API_KEY");

      // A key in the codon's env block is enough; the model is then Pi's to know, without pi.dev.
      const unknown = failed(models.check("deepseek/deepseek-imaginary-9"));
      expect(unknown.kind).toBe("unknown-model");
      expect(unknown.message).toContain("online model checks are off");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("the Claude route confirms a catalog model offline and a keyless sentinel is skipped", async () => {
    const models = await load(
      {
        hank: {
          hank: [
            codon("c0", "anthropic/claude-haiku-4-5", {
              sentinels: [{ sentinelConfig: sentinel("judge", "openai/gpt-5.6-sol") }],
            }),
          ],
        },
      },
      {
        harnesses: {
          codon: [new ClaudeModelCheck(), new PiModelCheck()],
          sentinel: [new AiSdkModelCheck()],
        },
        env: { ...bareEnv(), ANTHROPIC_API_KEY: "sk-ant-test-never-valid" },
        network: false,
      },
    );

    const haiku = confirmed(models.check("anthropic/claude-haiku-4-5"));
    expect(haiku.provenance?.evidence).toBe("catalog");
    expect(models.harnessReports()[0]?.result.checks.map((c) => c.name)).toContain(
      "authentication",
    );
    expect(failed(models.check("openai/gpt-5.6-sol", "sentinel"))).toMatchObject({
      kind: "no-credentials",
      stage: "harness",
    });
    expect(models.report().some((line) => line.endsWith("(the sentinel will be skipped)"))).toBe(
      true,
    );
  });

  it("hands the AI SDK check a catalog lookup that excludes synthesized effort variants", async () => {
    process.env.OPENAI_API_KEY = "sk-test-never-valid";
    const real = new AiSdkModelCheck();
    const lookups: HarnessCheckOptions["knownToCatalog"][] = [];
    const spy: HarnessModelCheck = {
      harness: real.harness,
      label: real.label,
      providers: () => real.providers(),
      runs: (provider) => real.runs(provider),
      check(provider, modelId, env, opts) {
        lookups.push(opts.knownToCatalog);
        return real.check(provider, modelId, env, opts);
      },
    };
    const codonLookups: HarnessCheckOptions["knownToCatalog"][] = [];
    const models = await load(
      {
        hank: {
          hank: [
            codon("c0", "openai/gpt-5.6-sol-xhigh", {
              sentinels: [
                { sentinelConfig: sentinel("variant", "openai/gpt-5.6-sol-xhigh") },
                { sentinelConfig: sentinel("base", "openai/gpt-5.6-sol") },
              ],
            }),
          ],
        },
      },
      {
        harnesses: {
          codon: [
            claude(),
            pi({
              answer: (provider, modelId, env, opts) => {
                codonLookups.push(opts.knownToCatalog);
                return yes("pi")(provider, modelId, env, opts);
              },
            }),
          ],
          sentinel: [spy],
        },
        env: bareEnv(),
        network: false,
      },
    );

    expect(lookups).toHaveLength(2);
    for (const knownToCatalog of lookups) {
      expect(knownToCatalog("openai", "gpt-5.6-sol-xhigh")).toBe(false);
      expect(knownToCatalog("openai", "gpt-5.6-sol-high")).toBe(false);
      expect(knownToCatalog("openai", "gpt-5.6-sol")).toBe(true);
    }
    // A codon's lookup lists the variant: Pi carries the suffix as its effort.
    expect(codonLookups[0]?.("openai", "gpt-5.6-sol-xhigh")).toBe(true);

    expect(failed(models.check("openai/gpt-5.6-sol-xhigh", "sentinel"))).toMatchObject({
      kind: "unknown-model",
      stage: "harness",
      message:
        "The model catalog does not list 'openai/gpt-5.6-sol-xhigh'. Closest: openai/gpt-5.6-sol.",
      suggestions: ["openai/gpt-5.6-sol"],
    });
    expect(confirmed(models.check("openai/gpt-5.6-sol", "sentinel")).provenance?.evidence).toBe(
      "catalog",
    );
    expect(confirmed(models.check("openai/gpt-5.6-sol-xhigh", "codon")).provenance?.evidence).toBe(
      "catalog",
    );
  });
});
