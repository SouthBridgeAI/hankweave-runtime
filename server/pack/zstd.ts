/**
 * zstd backend selection for `hankweave pack` (phase-2 issue 06).
 *
 * Two adapters with EXPLICIT per-backend option shapes — the two APIs do
 * not accept the same options object, and the wrong shape is silently
 * ignored (a shim passing `{level: 19}` to node:zlib "works" at the
 * default level while claiming 19):
 *
 * - node:zlib  → `zstdCompressSync(data, {params: {[ZSTD_c_compressionLevel]: 19}})`
 * - Bun native → `Bun.zstdCompressSync(data, {level: 19})`
 *
 * Detection is CAPABILITY, not symbol presence: Deno exposes a function
 * named `zstdCompressSync` that throws on call, so each candidate must
 * survive a compress/decompress round-trip before it is selected. node:zlib is
 * preferred (on Bun too, when its node:zlib zstd works); Bun-native is the
 * fallback; neither → ZstdUnavailableError with the one documented
 * message. The module is imported via the namespace, never by named
 * import, so a runtime lacking the export fails the probe instead of
 * failing module instantiation (which would make the Bun fallback
 * unreachable).
 *
 * Callers (pack-command) must not touch this module until lint has passed
 * and an archive is actually being emitted — `--check` never probes zstd.
 */

import zlib from "node:zlib";

export const ZSTD_UNAVAILABLE_MESSAGE = "pack requires Node >=22.15 or Bun (zstd)";

export class ZstdUnavailableError extends Error {
  constructor() {
    super(ZSTD_UNAVAILABLE_MESSAGE);
    this.name = "ZstdUnavailableError";
  }
}

export interface ZstdBackend {
  kind: "node" | "bun";
  /** Single-shot compress at level 19, no dictionary, default window. */
  compress(data: Buffer): Buffer;
  decompress(data: Buffer, maxOutputLength: number): Buffer;
}

const ZSTD_LEVEL = 19;

type NodeZstd = (data: Buffer, options: { params: Record<number, number> }) => Buffer;
type BunZstd = (data: Buffer | Uint8Array, options: { level: number }) => Uint8Array;

function nodeBackend(): ZstdBackend | null {
  const compressSync = (zlib as { zstdCompressSync?: NodeZstd }).zstdCompressSync;
  const level = (zlib.constants as { ZSTD_c_compressionLevel?: number }).ZSTD_c_compressionLevel;
  if (typeof compressSync !== "function" || typeof level !== "number") return null;
  const compress = (data: Buffer): Buffer =>
    compressSync(data, { params: { [level]: ZSTD_LEVEL } });
  const nativeDecompress = (
    zlib as { zstdDecompressSync?: (data: Buffer, options: { maxOutputLength: number }) => Buffer }
  ).zstdDecompressSync;
  if (typeof nativeDecompress !== "function") return null;
  const decompress = (data: Buffer, maxOutputLength: number): Buffer =>
    checkOutputLength(nativeDecompress(data, { maxOutputLength }), maxOutputLength);
  const backend: ZstdBackend = { kind: "node", compress, decompress };
  return probe(backend) ? backend : null;
}

function bunBackend(): ZstdBackend | null {
  const bun = (
    globalThis as {
      Bun?: { zstdCompressSync?: BunZstd; zstdDecompressSync?: (data: Buffer) => Uint8Array };
    }
  ).Bun;
  if (typeof bun?.zstdCompressSync !== "function") return null;
  const native = bun.zstdCompressSync.bind(bun);
  const compress = (data: Buffer): Buffer => Buffer.from(native(data, { level: ZSTD_LEVEL }));
  if (typeof bun.zstdDecompressSync !== "function") return null;
  const nativeDecompress = bun.zstdDecompressSync.bind(bun);
  // Bun has no output cap: it allocates before this check.
  const decompress = (data: Buffer, maxOutputLength: number): Buffer =>
    checkOutputLength(Buffer.from(nativeDecompress(data)), maxOutputLength);
  const backend: ZstdBackend = { kind: "bun", compress, decompress };
  return probe(backend) ? backend : null;
}

/** A backend is usable iff it can round-trip bytes — presence-only
 * checks select Deno's throwing stub. */
function probe(backend: ZstdBackend): boolean {
  try {
    const input = Buffer.from("hankweave-zstd-probe");
    return backend.decompress(backend.compress(input), input.length).equals(input);
  } catch {
    return false;
  }
}

/** Select a working backend, or null when this runtime has none. */
export function detectZstdBackend(): ZstdBackend | null {
  return nodeBackend() ?? bunBackend();
}

/** Compress the canonical tar, or throw the documented unavailable error.
 * Input/allocation failures from a WORKING backend propagate with their
 * own diagnostics — only missing capability maps to the named message. */
export function zstdCompress(data: Buffer): Buffer {
  const backend = detectZstdBackend();
  if (!backend) throw new ZstdUnavailableError();
  return backend.compress(data);
}

function checkOutputLength(output: Buffer, maxOutputLength: number): Buffer {
  if (output.length > maxOutputLength)
    throw new Error(`zstd output exceeds maxOutputLength (${maxOutputLength})`);
  return output;
}

export function zstdDecompress(data: Buffer, maxOutputLength: number): Buffer {
  const backend = detectZstdBackend();
  if (!backend) throw new ZstdUnavailableError();
  return backend.decompress(data, maxOutputLength);
}
