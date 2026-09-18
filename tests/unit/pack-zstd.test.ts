import { describe, expect, it } from "bun:test";
import {
  detectZstdBackend,
  ZSTD_UNAVAILABLE_MESSAGE,
  ZstdUnavailableError,
  zstdCompress,
  zstdDecompress,
} from "../../server/pack/zstd.js";

/** Both dev runtimes (Bun, Node ≥22.15) must have a working backend; the
 * capability-probe and Deno-stub behavior is pinned by the adapter design
 * (probe compresses real bytes, so a present-but-throwing symbol can
 * never be selected). */
describe("zstd backend (phase-2 issue 06)", () => {
  it("selects a working backend on this runtime", () => {
    const backend = detectZstdBackend();
    expect(backend).not.toBeNull();
    expect(backend?.kind === "node" || backend?.kind === "bun").toBe(true);
  });

  it("round-trips the exact input bytes", () => {
    const input = Buffer.from("canonical tar bytes ".repeat(500), "utf8");
    const compressed = zstdCompress(input);
    expect(compressed.length).toBeGreaterThan(0);
    expect(compressed.length).toBeLessThan(input.length);
    expect(zstdDecompress(compressed, input.length).equals(input)).toBe(true);
    expect(() => zstdDecompress(compressed, input.length - 1)).toThrow();
  });

  it("is repeatable for one backend/build", () => {
    const input = Buffer.from("determinism ".repeat(1000), "utf8");
    expect(zstdCompress(input).equals(zstdCompress(input))).toBe(true);
  });

  it("names the documented message when no backend exists", () => {
    const error = new ZstdUnavailableError();
    expect(error.message).toBe(ZSTD_UNAVAILABLE_MESSAGE);
    expect(ZSTD_UNAVAILABLE_MESSAGE).toBe("pack requires Node >=22.15 or Bun (zstd)");
  });
});
