/**
 * The authoritative `hank.lock` shape (phase-2 issue 13).
 *
 * ONE definition: the builder (`lock.ts`), the schema generator
 * (`scripts/generate-schemas.ts` → `schemas/hank.lock.schema.json`), and the
 * phase-3 bundle reader all import THIS schema; `HankLock` is inferred from
 * it, never hand-written. The generated JSON schema describes the on-disk
 * artifact exactly — pack writes locks without a `$schema` property, so the
 * generator must not inject one (see the `injectSchemaProp` flag there).
 *
 * `.strict()` everywhere: a lock is a machine artifact with no
 * forward-compatibility contract inside `v: 1` — an unknown field means a
 * corrupted or newer lock, and the phase-3 reader must refuse rather than
 * guess.
 */

import { z } from "zod";
import { SEMVER_RE } from "./semver.js";

const sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters (sha256)");

/**
 * A string-keyed record whose parse PRESERVES an own `__proto__` key.
 *
 * Bundle paths and codon ids are authored data, and `__proto__` is legal
 * for both — but z.record assigns parsed entries onto a plain object, so
 * an own `__proto__` property is validated and then silently dropped from
 * the parse output (the assignment hits the prototype accessor). A
 * consumer parsing such a lock would lose that file or codon entry and
 * could not verify the emitted bundle. Fix at the parse layer: escape the
 * key with a NUL prefix before the record parse (NUL can never appear in
 * a genuine key that arrived via JSON from a filesystem path, but escape
 * defensively anyway: any key starting with NUL gains one more), then
 * restore it into a null-prototype record, where plain assignment of
 * `__proto__` creates an ordinary own property.
 *
 * zod-to-json-schema resolves both effects wrappers to the inner
 * z.record, so the GENERATED schema is identical to a bare record's.
 */
function protoSafeRecord<V extends z.ZodTypeAny>(valueSchema: V) {
  const ESC = "\u0000";
  return z.preprocess(
    (val) => {
      if (typeof val !== "object" || val === null || Array.isArray(val)) return val;
      const escaped: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(val)) {
        escaped[key === "__proto__" || key.startsWith(ESC) ? ESC + key : key] = value;
      }
      return escaped;
    },
    z.record(z.string().min(1), valueSchema).transform((rec) => {
      const out: Record<string, z.output<V>> = Object.create(null);
      for (const [key, value] of Object.entries(rec)) {
        out[key.startsWith(ESC) ? key.slice(1) : key] = value as z.output<V>;
      }
      return out;
    }),
  );
}

const lockFileEntrySchema = z
  .object({
    mode: z.enum(["644", "755"]),
    sha256: sha256HexSchema,
  })
  .strict();

export const hankLockSchema = z
  .object({
    v: z.literal(1),
    name: z.string().min(1),
    version: z.string().min(1),
    bundleHash: sha256HexSchema,
    files: protoSafeRecord(lockFileEntrySchema),
    codonInputs: protoSafeRecord(sha256HexSchema),
    runtime: z
      .object({
        // .regex, not .refine(isStrictSemVer): both enforce the same
        // grammar at runtime, but only a regex survives into the generated
        // JSON schema as a `pattern` (a refine predicate is dropped, which
        // would let Ajv accept "banana" as runtime.min).
        min: z.string().regex(SEMVER_RE, "must be a canonical SemVer 2.0.0 version (e.g. 1.2.3)"),
      })
      .strict(),
    /** ADVISORY (outside the identity payload): fingerprint of the
     * built-in default ignore patterns the closure was judged under
     * (hank-dir.ts DEFAULT_IGNORE_FINGERPRINT). */
    ignoreDefaults: sha256HexSchema,
  })
  .strict();

export type HankLock = z.infer<typeof hankLockSchema>;
export type LockFileEntry = z.infer<typeof lockFileEntrySchema>;
