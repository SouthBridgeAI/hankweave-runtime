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
});
