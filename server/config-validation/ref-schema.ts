import { z } from "zod";
import {
  forbiddenRefSpelling,
  lexicallyEscapesBase,
  refViolationMessage,
  type SentinelRefFields,
  sentinelOwnRefs,
} from "../hank-refs.js";

/**
 * Zod schema for one authored hank ref whose base directory is the hank dir.
 *
 * Enforces the textual half of the strict-ref rules (spec:
 * intermediates/63-strict-hank-paths/strict-paths-spec.md): R1 (portable
 * POSIX-style spelling) and R2 (never climbs above the hank root). R3
 * (symlinks) needs the filesystem and is enforced by the runtime loaders.
 *
 * Lives in this dependency-leaf module because both config.ts and
 * sentinel.schema.ts need it, and config.ts already imports
 * sentinel.schema.ts — defining it in config.ts would create a cycle.
 *
 * `what` names the field in the empty-string message. Note that .min(1)
 * deliberately makes an empty authored scalar a schema error rather than
 * "field absent" (normalizeRefField's runtime contract is unchanged).
 */
export const hankRefStringSchema = (what: string) =>
  z
    .string()
    .min(1, `${what} cannot be an empty string; omit the field instead`)
    .superRefine((raw, ctx) => {
      const kind = forbiddenRefSpelling(raw);
      if (kind !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: refViolationMessage({ kind, raw }),
        });
        return;
      }
      if (lexicallyEscapesBase(raw)) {
        // Same first clause as refViolationMessage's "escapes"; the resolved
        // path is omitted because the schema layer never resolves.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${raw}" resolves outside the hank directory; move the file into the hank directory`,
        });
      }
    });

/**
 * A ref field that may be a single ref or a list of refs, preserving the
 * authored shape. Element-level violations surface with their index via the
 * union's array branch.
 */
export const hankRefFieldSchema = (what: string) =>
  z.union([hankRefStringSchema(what), z.array(hankRefStringSchema(what))]);

/**
 * R1-only variant for a sentinel config's own refs (systemPromptFile,
 * userPromptFile, structuredOutput.schemaFile) in the standalone
 * sentinelConfigSchema. A file-based config's base is its own directory,
 * whose position inside the hank the schema cannot know — a leading "../"
 * may legally climb back toward the hank root — so R2/R3 for those are
 * runtime checks. The INLINE branch of codonSentinelEntrySchema layers R2
 * on top via inlineSentinelRefsEscapeIssues, because an inline config's
 * base is knowably the hank dir.
 */
export const portableRefStringSchema = (what: string) =>
  z
    .string()
    .min(1, `${what} cannot be an empty string; omit the field instead`)
    .superRefine((raw, ctx) => {
      const kind = forbiddenRefSpelling(raw);
      if (kind !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: refViolationMessage({ kind, raw }),
        });
      }
    });

export const portableRefFieldSchema = (what: string) =>
  z.union([portableRefStringSchema(what), z.array(portableRefStringSchema(what))]);

/**
 * R2 for an INLINE sentinel config's own refs, applied at the wrapper schema
 * (the only place that knows the config is inline and therefore hank-dir
 * anchored). Returns one message per escaping ref; the caller turns them
 * into issues on its own ctx.
 */
export function inlineSentinelRefsEscapeIssues(config: SentinelRefFields): string[] {
  const issues: string[] = [];
  for (const { field, raw } of sentinelOwnRefs(config)) {
    if (forbiddenRefSpelling(raw) === null && lexicallyEscapesBase(raw)) {
      issues.push(
        `${field}: "${raw}" resolves outside the hank directory; move the file into the hank directory`,
      );
    }
  }
  return issues;
}
