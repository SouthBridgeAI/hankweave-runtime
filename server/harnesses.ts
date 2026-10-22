import fs from "node:fs";
import path from "node:path";
import { readRawHankJson } from "./config.js";
import { ClaudeModelCheck } from "./harness/claude/model-check.js";
import { PiModelCheck } from "./harness/pi/model-check.js";
import type { HarnessModelCheck, RawModelConfigs } from "./llm/index.js";
import { AiSdkModelCheck } from "./sentinels/model-check.js";

/**
 * The harnesses model validation asks, in routing order (spec 72): codon
 * models are offered to the Claude Agent SDK, then Pi — the first whose
 * `runs` is true wins, "pi/…" forcing Pi — and sentinel models to the AI SDK
 * alone. Every entry point (run, --validate, replay, cleanup, pack, bundle
 * verification) builds its lists here.
 */
export function codonHarnesses(): HarnessModelCheck[] {
  return [new ClaudeModelCheck(), new PiModelCheck()];
}

export function sentinelHarnesses(): HarnessModelCheck[] {
  return [new AiSdkModelCheck()];
}

export function modelHarnesses(): {
  codon: HarnessModelCheck[];
  sentinel: HarnessModelCheck[];
} {
  return { codon: codonHarnesses(), sentinel: sentinelHarnesses() };
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined; // missing or invalid: loadRuntimeConfig owns reporting
  }
}

/**
 * The raw configs model validation reads: the hank (missing or unparseable
 * is validateHank's to report) and hankweave.json (default: the working
 * directory's, like loadRuntimeConfig).
 */
export function readModelConfigs(hankPath: string, runtimeConfigPath?: string): RawModelConfigs {
  let hank: unknown;
  try {
    hank = readRawHankJson(hankPath);
  } catch {
    hank = undefined;
  }
  return {
    hank,
    runtime: readJson(runtimeConfigPath ?? path.join(process.cwd(), "hankweave.json")),
    hankDir: path.dirname(path.resolve(hankPath)),
  };
}
