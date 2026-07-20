import { describe, expect, test } from "bun:test";
import { resolveModel } from "../src/utils.js";

describe("resolveModel", () => {
  test("keeps plain model names and adds openai/ prefix for publicModel", () => {
    const resolved = resolveModel("gpt-5.1-codex-max");
    expect(resolved.publicModel).toBe("openai/gpt-5.1-codex-max");
    expect(resolved.sdkModel).toBe("gpt-5.1-codex-max");
    expect(resolved.reasoningEffort).toBe("high");
  });

  test("extracts reasoning effort suffix, publicModel is provider-prefixed without suffix", () => {
    const resolved = resolveModel("gpt-5.2-xhigh");
    expect(resolved.publicModel).toBe("openai/gpt-5.2");
    expect(resolved.sdkModel).toBe("gpt-5.2");
    expect(resolved.reasoningEffort).toBe("xhigh");
  });

  test("strips openai provider prefix for SDK calls, keeps it in publicModel", () => {
    const resolved = resolveModel("openai/gpt-5.2-high");
    expect(resolved.publicModel).toBe("openai/gpt-5.2");
    expect(resolved.sdkModel).toBe("gpt-5.2");
    expect(resolved.reasoningEffort).toBe("high");
  });

  test("gpt-5.6 sol variant: strips effort suffix but keeps the variant name", () => {
    // "sol" must not be mistaken for an effort suffix; only the trailing
    // effort is stripped. Codex 0.144.x supports high/xhigh for gpt-5.6-sol.
    const resolved = resolveModel("gpt-5.6-sol-xhigh");
    expect(resolved.publicModel).toBe("openai/gpt-5.6-sol");
    expect(resolved.sdkModel).toBe("gpt-5.6-sol");
    expect(resolved.reasoningEffort).toBe("xhigh");
  });

  test("gpt-5.6 variants without effort suffix default to high", () => {
    // Hankweave's default is "high" for all codex models — deliberately
    // higher than codex's own per-model defaults (sol: low, luna/terra:
    // medium), since hanks run unattended and favor depth over latency.
    for (const variant of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]) {
      const resolved = resolveModel(variant);
      expect(resolved.sdkModel).toBe(variant);
      expect(resolved.reasoningEffort).toBe("high");
    }
  });
});
