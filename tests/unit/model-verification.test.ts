import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LanguageModel } from "ai";
import {
  limitCorrection,
  type ModelReport,
  mergeProposals,
  newModelKeys,
  parseVerifyArgs,
  runBattery,
  runVerifyModels,
  VerifyCatalog,
  type VerifyDeps,
} from "../../scripts/model-verification.js";
import type { ModelInfo } from "../../server/llm/index.js";
import { ModelCatalogStore } from "../../server/llm/internal/catalog-store.js";
import { BUNDLED_OVERLAY, type ModelOverlay } from "../../server/llm/internal/overlay.js";

const usage = { inputTokens: 12, outputTokens: 3, totalTokens: 15 };

/**
 * A model that answers like a capable one: "ready" to the reply prompt,
 * "red" to the image, and a tool call whenever tools are offered — except
 * that forced tool choice fails when `rejectForcedTools` is set.
 */
/** The provider-level model interface generateText calls (without a new dependency). */
type ProviderModel = Exclude<LanguageModel, string>;

function mockModel(options: { rejectForcedTools?: boolean } = {}): ProviderModel {
  return {
    specificationVersion: "v2",
    provider: "mock",
    modelId: "mock-model",
    supportedUrls: {},
    doStream: async () => {
      throw new Error("the battery never streams");
    },
    doGenerate: async (call) => {
      if (call.tools?.length) {
        if (options.rejectForcedTools && call.toolChoice?.type === "tool") {
          throw new Error("Thinking mode does not support this tool_choice");
        }
        return {
          content: [
            { type: "tool-call", toolCallId: "call-1", toolName: "add", input: '{"a":2,"b":3}' },
          ],
          finishReason: "tool-calls",
          usage,
          warnings: [],
        };
      }
      const hasImage = JSON.stringify(call.prompt).includes('"type":"file"');
      return {
        content: [{ type: "text", text: hasImage ? "Red" : "ready" }],
        finishReason: "stop",
        usage,
        warnings: [],
      };
    },
  };
}

const record = (extra: Partial<ModelInfo> = {}): ModelInfo => ({
  providerId: "anthropic",
  modelId: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  attachment: true,
  reasoning: true,
  tool_call: true,
  cost: { input: 1, output: 5 },
  limit: { context: 200000, output: 64000 },
  modalities: { input: ["text", "image"], output: ["text"] },
  release_date: "2025-10-15",
  last_updated: "2025-10-15",
  provenance: { confidence: "registry", source: "models.dev snapshot", priceStatus: "known" },
  ...extra,
});

describe("runBattery", () => {
  it("passes every check for a capable model", async () => {
    const checks = await runBattery(record(), mockModel());
    expect(checks.map((c) => [c.name, c.passed])).toEqual([
      ["reply", true],
      ["priced", true],
      ["tool-call", true],
      ["forced-tool-choice", true],
      ["image-input", true],
    ]);
  });

  it("records a capability the model lacks, with the provider's error", async () => {
    const checks = await runBattery(record(), mockModel({ rejectForcedTools: true }));
    const forced = checks.find((c) => c.name === "forced-tool-choice");
    expect(forced?.passed).toBe(false);
    expect(forced?.detail).toContain("does not support this tool_choice");
  });

  it("skips checks the catalog says do not apply, and fails pricing for an unknown price", async () => {
    const textOnly = record({
      tool_call: false,
      modalities: { input: ["text"], output: ["text"] },
      cost: undefined,
      provenance: { confidence: "provisional", source: "probe", priceStatus: "unknown" },
    });
    const checks = await runBattery(textOnly, mockModel());
    expect(checks.map((c) => [c.name, c.passed])).toEqual([
      ["reply", true],
      ["priced", false],
    ]);
  });
});

describe("limitCorrection", () => {
  const found = (limit: { context?: number; output?: number }) =>
    ({
      status: "found",
      record: {
        providerId: "anthropic",
        modelId: "claude-haiku-4-5",
        probedAt: "",
        source: "s",
        limit,
      },
    }) as const;

  it("proposes the limits the provider reports when they differ", () => {
    const [correction] = limitCorrection(record(), found({ context: 400000, output: 64000 }));
    expect(correction?.model).toBe("anthropic/claude-haiku-4-5");
    expect(correction?.limit).toEqual({ context: 400000 });
    expect(correction?.source).toBe("https://docs.anthropic.com/en/api/models");
  });

  it("proposes nothing when the limits agree or the provider was not asked", () => {
    expect(limitCorrection(record(), found({ context: 200000, output: 64000 }))).toEqual([]);
    expect(limitCorrection(record(), { status: "skipped", reason: "no key" })).toEqual([]);
  });
});

describe("mergeProposals", () => {
  const overlay: ModelOverlay = {
    ...BUNDLED_OVERLAY,
    corrections: [
      {
        model: "anthropic/claude-haiku-4-5",
        cost: { input: 1, output: 5 },
        reason: "r",
        source: "https://example.com/pricing",
      },
    ],
  };
  const report = (proposed: ModelReport["proposed"]): ModelReport => ({
    model: "anthropic/claude-haiku-4-5",
    harness: "claude-agent-sdk",
    confidence: "registry",
    priceStatus: "known",
    checks: [],
    proposed,
  });

  it("merges a proposed correction into the model's existing one", () => {
    const merged = mergeProposals(
      overlay,
      [
        report({
          corrections: [
            {
              model: "anthropic/claude-haiku-4-5",
              limit: { context: 400000 },
              reason: "r2",
              source: "https://example.com/models",
            },
          ],
        }),
      ],
      "2026-09-29",
    );
    expect(merged.updated).toBe("2026-09-29");
    expect(merged.corrections).toEqual([
      {
        model: "anthropic/claude-haiku-4-5",
        cost: { input: 1, output: 5 },
        limit: { context: 400000 },
        reason: "r2",
        source: "https://example.com/models",
      },
    ]);
  });
});

describe("newModelKeys", () => {
  it("selects first-party models the snapshot lacks, for providers with credentials", () => {
    const rows = [
      record({ modelId: "claude-new-1" }),
      record({ modelId: "claude-haiku-4-5" }),
      record({ providerId: "openai", modelId: "gpt-new-1" }),
      record({ providerId: "nano-gpt", modelId: "reseller-new-1" }),
    ];
    const keys = newModelKeys(
      rows,
      new Set(["anthropic/claude-haiku-4-5"]),
      new Set(["anthropic"]),
    );
    expect(keys).toEqual(["anthropic/claude-new-1"]);
  });
});

describe("runVerifyModels", () => {
  let tmp: string;
  let lines: string[];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hw-verify-models-"));
    lines = [];
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function deps(overrides: Partial<VerifyDeps> = {}): VerifyDeps {
    const overlayPath = path.join(tmp, "model-overlay.json");
    fs.writeFileSync(overlayPath, JSON.stringify(BUNDLED_OVERLAY));
    return {
      store: new ModelCatalogStore({ dir: path.join(tmp, "catalog"), offline: true }),
      catalog: new VerifyCatalog(),
      languageModelFor: async () => mockModel(),
      probe: async () => ({
        status: "found",
        record: {
          providerId: "anthropic",
          modelId: "claude-haiku-4-5",
          probedAt: "",
          source: "s",
          limit: { context: 400000 },
        },
      }),
      codon: async () => ({ passed: true, log: "codon.log" }),
      availableProviders: async () => new Set(["anthropic"]),
      log: (line) => lines.push(line),
      overlayPath,
      today: () => "2026-09-29",
      ...overrides,
    };
  }

  it("checks a model end to end and writes the proposed correction into the overlay", async () => {
    const d = deps();
    const jsonPath = path.join(tmp, "report.json");
    const code = await runVerifyModels(
      parseVerifyArgs([
        "anthropic/claude-haiku-4-5",
        "--codon",
        "--json",
        jsonPath,
        "--write-overlay",
      ]),
      d,
    );
    expect(code).toBe(0);
    const report = JSON.parse(fs.readFileSync(jsonPath, "utf-8")).reports[0];
    expect(report.codon.passed).toBe(true);
    const overlay = JSON.parse(fs.readFileSync(d.overlayPath, "utf-8"));
    expect(overlay.corrections).toContainEqual(
      expect.objectContaining({ limit: { context: 400000 } }),
    );
  });

  it("reports a failed codon run and exits non-zero", async () => {
    const d = deps({ codon: async () => ({ passed: false, log: "codon.log", detail: "boom" }) });
    const code = await runVerifyModels(
      parseVerifyArgs(["anthropic/claude-haiku-4-5", "--codon"]),
      d,
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("✗ codon (claude-agent-sdk): boom");
  });

  it("reports a model the catalog does not have and exits non-zero", async () => {
    const code = await runVerifyModels(parseVerifyArgs(["anthropic/claude-imaginary"]), deps());
    expect(code).toBe(1);
    expect(lines).toContain("! anthropic/claude-imaginary: not in the model catalog");
  });

  it("checks an overlay file without verifying anything", async () => {
    const d = deps();
    expect(await runVerifyModels(parseVerifyArgs(["--check-overlay", d.overlayPath]), d)).toBe(0);
    fs.writeFileSync(
      d.overlayPath,
      JSON.stringify({ ...BUNDLED_OVERLAY, aliases: [{ from: "x" }] }),
    );
    expect(await runVerifyModels(parseVerifyArgs(["--check-overlay", d.overlayPath]), d)).toBe(1);
  });
});
