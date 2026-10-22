import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLegacyProviderModelInfo } from "../../server/config-validation/model-validator.js";
import { modelHarnesses } from "../../server/harnesses.js";
import {
  effortBase,
  type HarnessModelCheck,
  type ModelCheck,
  type ModelInfo,
  Models,
} from "../../server/llm/index.js";
import { effortVariant } from "../../server/llm/internal/catalog-index.js";
import { collectModelSources } from "../../server/llm/internal/sources.js";
import { ProviderHealth } from "../../server/sentinels/provider-health.js";
import { Logger } from "../../server/utils.js";

/**
 * Effort variants ("<id>-high", "<id>-xhigh") and the round-4 review fixes:
 * the derived variant keeps its base's catalog price on every provider, it
 * remembers its base (provenance.effortOf) so a resumed run re-adopts the
 * base unscaled, and a sentinel never gets a synthesized variant.
 */

const parsing = () => Models.loadForParsing({}, { harnesses: modelHarnesses(), bundledOnly: true });

afterEach(() => {
  parsing();
});

function confirmed(result: ModelCheck): ModelInfo {
  if (!result.ok) throw new Error(`expected ok, got ${result.kind}: ${result.message}`);
  return result.model;
}

function provenanceOf(model: ModelInfo): NonNullable<ModelInfo["provenance"]> {
  if (!model.provenance) throw new Error(`${model.modelId} has no provenance`);
  return model.provenance;
}

function inputRate(model: ModelInfo): number {
  const input = model.cost?.input;
  if (input === undefined) throw new Error(`${model.modelId} is unpriced`);
  return input;
}

describe("effort variants", () => {
  it("derives a non-OpenAI variant from its base catalog record, scaling xhigh once", () => {
    const models = parsing();
    const base = confirmed(models.check("deepseek/deepseek-v4-pro"));
    const high = confirmed(models.check("deepseek/deepseek-v4-pro-high"));
    const xhigh = confirmed(models.check("deepseek/deepseek-v4-pro-xhigh"));

    // The overlay's correction (a declared source) carries over.
    const { confidence, priceSource } = provenanceOf(base);
    expect(provenanceOf(high)).toMatchObject({ confidence, priceSource });
    expect(inputRate(high)).toBe(inputRate(base));
    expect(inputRate(xhigh)).toBe(inputRate(base) * 2);
    expect(provenanceOf(xhigh).effortOf).toBe("deepseek-v4-pro");
  });

  it("effortBase restores the base id and unscaled rates of a variant", () => {
    const base = confirmed(parsing().check("openai/gpt-5.6-sol"));
    const variant = effortVariant(base, "xhigh");
    expect(variant.modelId).toBe("gpt-5.6-sol-xhigh");
    const restored = effortBase(variant);
    expect(restored.modelId).toBe("gpt-5.6-sol");
    expect(restored.name).toBe(base.name);
    expect(restored.cost).toEqual(base.cost);
    expect(restored.provenance?.effortOf).toBeUndefined();
    // A record that is not a variant is returned as it is.
    expect(effortBase(base)).toBe(base);
  });

  it("never hands a sentinel a synthesized variant, through get or ProviderHealth", () => {
    const models = parsing();
    expect(models.check("openai/gpt-5.6-sol-xhigh", "sentinel").ok).toBe(false);
    expect(models.get("openai", "gpt-5.6-sol-xhigh", "sentinel")).toBeUndefined();
    expect(models.get("openai", "gpt-5.6-sol-xhigh", "codon")?.modelId).toBe("gpt-5.6-sol-xhigh");
    expect(models.get("openai", "gpt-5.6-sol", "sentinel")?.modelId).toBe("gpt-5.6-sol");
    const health = new ProviderHealth({ logger: new Logger("/dev/null") });
    expect(health.getModelInfo("openai/gpt-5.6-sol-xhigh").success).toBe(false);
  });
});

describe("collector tolerance", () => {
  it("a mistyped override or codon id hides no other model", () => {
    const sources = collectModelSources(
      {
        hank: {
          overrides: { model: 5 },
          hank: [
            { id: 7, model: "anthropic/claude-haiku-4-5" },
            { id: "b", model: "deepseek/deepseek-v4-pro" },
          ],
        },
        runtime: { model: false },
      },
      { env: {} },
    );
    expect(sources.occurrences.map((o) => o.spelling)).toEqual([
      "anthropic/claude-haiku-4-5",
      "deepseek/deepseek-v4-pro",
    ]);
    expect(sources.occurrences[0]?.origin).toBe("codon '?'");
  });
});

describe("round-5 review fixes", () => {
  it("parse mode accepts an effort spelling of a declared reasoning base Pi lacks", () => {
    const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-effort-parse-"));
    const models = Models.loadForParsing(
      {
        hank: {
          models: [
            {
              id: "deepseek/deepseek-review5",
              reasoning: true,
              cost: { input: 1, output: 2 },
              limit: { context: 100_000, output: 8_000 },
            },
          ],
        },
      },
      { harnesses: modelHarnesses(), catalogDir },
    );
    const xhigh = confirmed(models.check("deepseek/deepseek-review5-xhigh"));
    expect(xhigh.cost).toMatchObject({ input: 2, output: 4 });
    expect(xhigh.provenance?.effortOf).toBe("deepseek-review5");
    // Never through the pricing mapping: openai-codex has no such base.
    expect(models.check("openai-codex/gpt-4o-xhigh").ok).toBe(false);
  });

  it("a row the harness lists under the suffixed id beats the synthesized variant", () => {
    const harnesses = modelHarnesses();
    const pi = harnesses.codon.find((h) => h.harness === "pi") as HarnessModelCheck;
    const literal: HarnessModelCheck = {
      ...pi,
      providers: () => pi.providers(),
      runs: (p, m) => pi.runs(p, m),
      check: (...args) => pi.check(...args),
      offlineRow: (provider, modelId) =>
        `${provider}/${modelId}` === "openai/gpt-5.6-sol-xhigh"
          ? {
              id: modelId,
              cost: { input: 99, output: 199 },
              limit: { context: 50_000, output: 5_000 },
            }
          : pi.offlineRow?.(provider, modelId),
    };
    const models = Models.loadForParsing(
      {},
      {
        harnesses: {
          codon: [harnesses.codon[0] as HarnessModelCheck, literal],
          sentinel: harnesses.sentinel,
        },
        bundledOnly: true,
      },
    );
    const record = confirmed(models.check("openai/gpt-5.6-sol-xhigh"));
    expect(record.cost).toMatchObject({ input: 99, output: 199 });
    expect(record.provenance?.effortOf).toBeUndefined();
  });

  it("the legacy migration leaves a current opencode record alone", () => {
    const base = confirmed(parsing().check("anthropic/claude-haiku-4-5"));
    const current: ModelInfo = {
      ...base,
      providerId: "opencode",
      modelId: "acme/reasoner",
      provenance: base.provenance && { ...base.provenance, evidence: "pi catalog" },
    };
    expect(normalizeLegacyProviderModelInfo(current)).toBe(current);
    const legacy = { ...current, provenance: undefined };
    expect(normalizeLegacyProviderModelInfo(legacy)).toMatchObject({
      providerId: "acme",
      modelId: "reasoner",
    });
  });

  it.skipIf(process.platform === "win32")(
    "never reads a sentinel config that is not a regular file in the hank",
    () => {
      const hankDir = fs.mkdtempSync(path.join(os.tmpdir(), "hw-sentinel-fifo-"));
      execFileSync("mkfifo", [path.join(hankDir, "fifo.json")]);
      const outside = path.join(os.tmpdir(), `hw-outside-${process.pid}.json`);
      fs.writeFileSync(outside, JSON.stringify({ id: "o", model: "anthropic/claude-haiku-4-5" }));
      const sources = collectModelSources(
        {
          hank: {
            hank: [
              {
                id: "a",
                model: "anthropic/claude-haiku-4-5",
                sentinels: [
                  { sentinelConfig: "fifo.json" },
                  { sentinelConfig: outside },
                  { sentinelConfig: "../x.json" },
                ],
              },
            ],
          },
          hankDir,
        },
        { env: {} },
      );
      // Returned at all (a FIFO read would block) and no sentinel collected.
      expect(sources.occurrences.filter((o) => o.use === "sentinel")).toEqual([]);
      fs.rmSync(outside, { force: true });
    },
  );
});
