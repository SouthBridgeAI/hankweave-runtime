import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ModelUse } from "../types.js";
import { modelsBlockSchema, type UserModelLayer, type UserModelOrigin } from "./user-models.js";

/**
 * Every model spelling the configs contain, read from the raw JSON (no Zod,
 * before config parsing), with what it is for and the environment it would
 * run with (spec 72, "Effective spellings").
 */

export interface RawModelConfigs {
  /** hank.json, parsed. */
  hank?: unknown;
  /** hankweave.json, parsed. */
  runtime?: unknown;
  /** Directory file-backed sentinel configs resolve against (the hank's). */
  hankDir?: string;
}

export interface ModelOccurrence {
  spelling: string;
  use: ModelUse;
  /** Where it was written: "codon 'plan'", "--model", "sentinel 'x' of codon 'y'", … */
  origin: string;
  /**
   * Whether this spelling is what will run. A global override shadowed by a
   * higher-precedence one is not: it is checked as a name only.
   */
  effective: boolean;
  /** The codon's own `env` block, which overlays the process env at spawn. */
  codonEnv?: Readonly<Record<string, string>>;
}

export interface ModelSources {
  occurrences: ModelOccurrence[];
  user: UserModelLayer[];
  problems: string[];
  /** hankweave.json's `noOnlineModelChecks`. */
  noOnlineModelChecks: boolean;
}

// Every field unknown and narrowed where read: one mistyped field (an id
// that is a number, a non-string override) must not hide the rest of the
// config's models from the pre-pass; the config schemas report it.
const rawCodonSchema = z.object({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  // unknown, like env and sentinels: a codon may omit its model when a
  // global override supplies it (loadHankFile writes the override in before
  // parsing), and its env block and sentinels still count. A malformed field
  // is the codon schema's to report.
  model: z.unknown().optional(),
  env: z.unknown().optional(),
  sentinels: z.unknown().optional(),
});
const rawLoopSchema = z.object({ type: z.literal("loop"), codons: z.array(z.unknown()) });
const rawHankSchema = z.object({
  overrides: z.object({ model: z.unknown().optional() }).passthrough().optional(),
  hank: z.array(z.unknown()).optional(),
  models: z.unknown().optional(),
});
const rawRuntimeSchema = z.object({
  model: z.unknown().optional(),
  models: z.unknown().optional(),
  // unknown, not boolean: a mistyped value must not drop `model` and `models`
  // with it; loadRuntimeConfig reports the type error.
  noOnlineModelChecks: z.unknown().optional(),
});
const rawSentinelEntrySchema = z.object({ sentinelConfig: z.unknown() });
const rawSentinelSchema = z.object({ id: z.unknown().optional(), model: z.string() });

type RawHank = z.infer<typeof rawHankSchema>;
type RawRuntime = z.infer<typeof rawRuntimeSchema>;
interface RawCodon {
  label: string;
  /** Undefined when the codon does not write one (an override supplies it). */
  model?: string;
  env?: Record<string, string>;
  sentinels: unknown[];
}

/** The string entries of a codon's env block. */
function stringEntries(env: unknown): Record<string, string> | undefined {
  if (!env || typeof env !== "object") return undefined;
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const str = (value: unknown) => (typeof value === "string" ? value : undefined);

/** A `models` block as a catalog layer, or the problem that stopped it. */
function userModelLayer(
  origin: UserModelOrigin,
  raw: unknown,
): { layer?: UserModelLayer; problem?: string } {
  if (raw === undefined) return {};
  const parsed = modelsBlockSchema.safeParse(raw);
  if (parsed.success) return { layer: { origin, models: parsed.data } };
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `[${issue.path.join(".")}]` : "";
  return { problem: `${origin} models${where}: ${issue?.message ?? "invalid"}` };
}

/** The hank's `models` block, for parse mode (a hank packs with the models it runs with). */
export function hankModelsLayer(rawHank: unknown): { layer?: UserModelLayer; problem?: string } {
  return userModelLayer("hank.json", rawHankSchema.safeParse(rawHank).data?.models);
}

/** Every codon, loops flattened. */
function codonsOf(items: readonly unknown[]): RawCodon[] {
  return items.flatMap((item): RawCodon[] => {
    const loop = rawLoopSchema.safeParse(item);
    if (loop.success) return codonsOf(loop.data.codons);
    const codon = rawCodonSchema.safeParse(item);
    if (!codon.success) return [];
    const { model, env, sentinels } = codon.data;
    const id = typeof codon.data.id === "string" ? codon.data.id : undefined;
    const name = typeof codon.data.name === "string" ? codon.data.name : undefined;
    return [
      {
        label: id ?? name ?? "?",
        model: typeof model === "string" ? model : undefined,
        env: stringEntries(env),
        sentinels: Array.isArray(sentinels) ? sentinels : [],
      },
    ];
  });
}

/** A sentinel's config: inline, or a JSON file relative to the hank directory. */
function sentinelConfigOf(entry: unknown, hankDir: string | undefined): unknown {
  const parsed = rawSentinelEntrySchema.safeParse(entry);
  if (!parsed.success) return undefined;
  const config = parsed.data.sentinelConfig;
  if (typeof config !== "string") return config;
  if (!hankDir || config === "") return undefined;
  // Only a regular file inside the hank directory; anything else (an
  // escaping or absolute reference, a FIFO, a symlink out) is validateHank's
  // to reject, and must not be read — or block — here.
  const inside = (base: string, file: string) => {
    const relative = path.relative(base, file);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  try {
    const file = path.resolve(hankDir, config);
    const real = fs.realpathSync(file);
    if (!inside(hankDir, file) || !inside(fs.realpathSync(hankDir), real)) return undefined;
    if (!fs.statSync(real).isFile()) return undefined;
    return JSON.parse(fs.readFileSync(real, "utf-8"));
  } catch {
    return undefined; // missing or invalid: validateHank reports it
  }
}

/** Every sentinel model, inline or file-backed, of every codon. Overrides never touch them. */
function sentinelOccurrences(codons: readonly RawCodon[], hankDir?: string): ModelOccurrence[] {
  return codons.flatMap((codon) =>
    codon.sentinels.flatMap((entry): ModelOccurrence[] => {
      const sentinel = rawSentinelSchema.safeParse(sentinelConfigOf(entry, hankDir));
      if (!sentinel.success) return [];
      return [
        {
          spelling: sentinel.data.model,
          use: "sentinel",
          origin: `sentinel '${str(sentinel.data.id) ?? "?"}' of codon '${codon.label}'`,
          effective: true,
        },
      ];
    }),
  );
}

/**
 * Global model overrides in resolveSettings' precedence (CLI >
 * HANKWEAVE_RUNTIME_MODEL > hank overrides > hankweave.json). The first that
 * is set replaces every codon model; the rest are shadowed.
 */
function overrideLayers(
  cliModel: string | undefined,
  env: NodeJS.ProcessEnv,
  hank: RawHank | undefined,
  runtime: RawRuntime | undefined,
): { spelling: string; origin: string }[] {
  const layers: [string | undefined, string][] = [
    [cliModel, "--model"],
    [env.HANKWEAVE_RUNTIME_MODEL, "HANKWEAVE_RUNTIME_MODEL"],
    [str(hank?.overrides?.model), "hank.json overrides.model"],
    [str(runtime?.model), "hankweave.json model"],
  ];
  return layers.flatMap(([spelling, origin]) => (spelling ? [{ spelling, origin }] : []));
}

/** Codon spellings: the effective override for every codon (with its env), else each codon's own. */
function codonOccurrences(
  codons: readonly RawCodon[],
  overrides: readonly { spelling: string; origin: string }[],
): ModelOccurrence[] {
  const [effective, ...shadowed] = overrides;
  const shadowedOccurrences = shadowed.map(
    ({ spelling, origin }): ModelOccurrence => ({
      spelling,
      use: "codon",
      origin: `${origin} (shadowed by ${effective?.origin})`,
      effective: false,
    }),
  );
  if (!effective) {
    return codons.flatMap((codon): ModelOccurrence[] =>
      codon.model === undefined
        ? []
        : [
            {
              spelling: codon.model,
              use: "codon",
              origin: `codon '${codon.label}'`,
              effective: true,
              codonEnv: codon.env,
            },
          ],
    );
  }
  const forCodons: ModelOccurrence[] =
    codons.length > 0
      ? codons.map((codon) => ({
          spelling: effective.spelling,
          use: "codon",
          origin: `${effective.origin} (codon '${codon.label}')`,
          effective: true,
          codonEnv: codon.env,
        }))
      : [{ spelling: effective.spelling, use: "codon", origin: effective.origin, effective: true }];
  return [...forCodons, ...shadowedOccurrences];
}

/** Model spellings and `models` blocks from the raw configs. */
export function collectModelSources(
  raw: RawModelConfigs,
  options: { cliModel?: string; env: NodeJS.ProcessEnv },
): ModelSources {
  const hank = rawHankSchema.safeParse(raw.hank).data;
  const runtime = rawRuntimeSchema.safeParse(raw.runtime).data;
  const blocks = [
    userModelLayer("hank.json", hank?.models),
    userModelLayer("hankweave.json", runtime?.models),
  ];
  const codons = codonsOf(hank?.hank ?? []);
  const overrides = overrideLayers(options.cliModel, options.env, hank, runtime);
  return {
    occurrences: [
      ...codonOccurrences(codons, overrides),
      ...sentinelOccurrences(codons, raw.hankDir),
    ],
    user: blocks.flatMap((block) => (block.layer ? [block.layer] : [])),
    problems: blocks.flatMap((block) => (block.problem ? [block.problem] : [])),
    noOnlineModelChecks: runtime?.noOnlineModelChecks === true,
  };
}
