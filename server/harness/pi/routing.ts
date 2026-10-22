import fs from "node:fs";
import path from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

/**
 * Which providers Pi can run (spec 72, "Runnable providers only"): its
 * built-in providers plus any the user's models.json defines (a local vLLM,
 * a corporate gateway). Computed, never curated; the same answer a Pi
 * ModelRuntime's getProviders() gives, without constructing one, so routing
 * stays synchronous.
 */

/** The user's own pi models.json ($PI_CODING_AGENT_DIR/models.json, default ~/.pi/agent). */
export function userModelsJsonPath(): string {
  return path.join(getAgentDir(), "models.json");
}

/** A JSON string literal, matched first so comment and comma rules never apply inside one. */
const JSON_STRING = String.raw`"(?:\\.|[^"\\])*"`;
const COMMENTS = new RegExp(`(${JSON_STRING})|//[^\\n]*|/\\*[\\s\\S]*?\\*/`, "g");
const TRAILING_COMMAS = new RegExp(`(${JSON_STRING})|,(\\s*[}\\]])`, "g");

/** Parse JSONC — comments and trailing commas allowed, as pi reads its models.json. */
function parseJsonc(text: string): unknown {
  const withoutComments = text.replace(COMMENTS, (_match, string?: string) => string ?? "");
  const json = withoutComments.replace(
    TRAILING_COMMAS,
    (_match, string?: string, closer?: string) => string ?? closer ?? "",
  );
  return JSON.parse(json.replace(/^﻿/, ""));
}

const userModelsFileSchema = z
  .object({
    providers: z
      .record(z.string(), z.object({ models: z.array(z.unknown()).optional() }).passthrough())
      .optional(),
  })
  .passthrough();

export type UserModelsFile = z.infer<typeof userModelsFileSchema>;

/**
 * The user's models.json: undefined when absent, "invalid" when it does not
 * parse. Cached by path and modification time.
 */
let userFileCache: { key: string; value: UserModelsFile | "invalid" | undefined } | undefined;
export function readUserModelsJson(): UserModelsFile | "invalid" | undefined {
  const filePath = userModelsJsonPath();
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return undefined;
  }
  const key = `${filePath}:${stat.mtimeMs}:${stat.size}`;
  if (userFileCache?.key === key) return userFileCache.value;
  let value: UserModelsFile | "invalid";
  try {
    const parsed = userModelsFileSchema.safeParse(parseJsonc(fs.readFileSync(filePath, "utf-8")));
    value = parsed.success ? parsed.data : "invalid";
  } catch {
    value = "invalid";
  }
  userFileCache = { key, value };
  return value;
}

interface BuiltinCatalog {
  ids: string[];
  /** Vendored (static) model rows per provider. */
  models: Map<string, readonly unknown[]>;
}
let builtin: BuiltinCatalog | undefined;

/** Pi's built-in providers and their vendored (static) model ids. Computed once. */
function builtinCatalog(): BuiltinCatalog {
  if (!builtin) {
    const providers = builtinProviders();
    builtin = {
      ids: providers.map((p) => p.id),
      models: new Map(providers.map((p) => [p.id, p.getModels()])),
    };
  }
  return builtin;
}

function userProviders(): Record<string, { models?: unknown[]; modelOverrides?: unknown }> {
  const user = readUserModelsJson();
  return user && user !== "invalid" ? (user.providers ?? {}) : {};
}

/** Every provider Pi can run: built-ins, then models.json's own. */
export function piProviders(): string[] {
  return [...new Set([...builtinCatalog().ids, ...Object.keys(userProviders())])];
}

/** Pi's routing predicate: Pi runs any model of a provider it has. */
export function runsOnPi(provider: string): boolean {
  return builtinCatalog().ids.includes(provider) || provider in userProviders();
}

/** "<id>-high"/"-xhigh" are hankweave effort variants of <id>, carried as Pi's thinking level. */
export const baseModelId = (modelId: string) => /^(.*)-(xhigh|high)$/.exec(modelId)?.[1] ?? modelId;

/** Pi's vendored (static) rows for a provider. */
export function piVendoredModels(provider: string): readonly unknown[] {
  return builtinCatalog().models.get(provider) ?? [];
}

/** The user's models.json rows and per-id overrides for a provider, raw. */
export function piUserModels(provider: string): {
  models: readonly unknown[];
  overrides: Record<string, unknown>;
} {
  const config = userProviders()[provider];
  const overrides = config?.modelOverrides;
  return {
    models: config?.models ?? [],
    overrides:
      overrides && typeof overrides === "object" ? (overrides as Record<string, unknown>) : {},
  };
}
