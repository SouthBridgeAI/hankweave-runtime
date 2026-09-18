/**
 * Canonical JSON for `hankweave pack` (U2 spec §4.2).
 *
 * Used for `hank.lock` serialization and every pack hash preimage
 * (`bundleHash`, `codonInputs`). Rules: UTF-8, object keys sorted bytewise
 * (by UTF-8 byte order — NOT UTF-16 code-unit order, which diverges for
 * keys above the BMP), no insignificant whitespace. The single trailing
 * newline the spec allows at hank.lock EOF is the serializer caller's job.
 */

import { compareUtf8 } from "../utils.js";

/** A high surrogate not followed by a low one, or a low surrogate not
 * preceded by a high one (String.isWellFormed needs lib es2024). */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Serialize a JSON-representable value canonically.
 *
 * `undefined` object properties are omitted (matching JSON.stringify);
 * `undefined` array elements and non-finite numbers are rejected rather
 * than silently coerced — a hash preimage must never guess.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`Cannot canonicalize non-finite number: ${value}`);
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new Error(`Cannot canonicalize value of type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    // Index loop, not .map(): map SKIPS holes in sparse arrays, which
    // would serialize new Array(1) as [] — colliding with the preimage of
    // a truly empty array. A visited hole reads as undefined and fails.
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const element = value[i];
      if (element === undefined) {
        throw new Error("Cannot canonicalize undefined array element");
      }
      parts.push(canonicalJsonStringify(element));
    }
    return `[${parts.join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareUtf8);
  for (const key of keys) {
    // TextEncoder maps every lone surrogate to U+FFFD, so distinct
    // malformed keys would compare equal and their order would depend on
    // insertion order — no total order, no deterministic hash. Refuse.
    if (LONE_SURROGATE_RE.test(key)) {
      throw new Error(`Cannot canonicalize object key with lone surrogate: ${JSON.stringify(key)}`);
    }
  }
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`);
  return `{${parts.join(",")}}`;
}
