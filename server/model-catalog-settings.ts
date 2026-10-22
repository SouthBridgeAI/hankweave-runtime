import fs from "node:fs";
import path from "node:path";
import { getExtractionBaseDir } from "./runtime-extractor-base.js";
import { renameWithRetrySync } from "./utils.js";

/**
 * Where model data lives on disk and whether hankweave may go online for it.
 * Shared by the model catalog (server/llm) and Pi's catalog
 * (pi-model-catalog.ts), which keeps its models store in the same directory.
 */

/** The catalog directory: $HANKWEAVE_MODEL_CATALOG_DIR, else <cache dir>/model-catalog. */
export function getModelCatalogDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HANKWEAVE_MODEL_CATALOG_DIR || path.join(getExtractionBaseDir(), "model-catalog");
}

/**
 * hankweave.json's `noOnlineModelChecks`, recorded at startup: the model
 * pre-pass reads the file before settings resolution and before the working
 * directory changes, and later readers (Pi's refreshes at codon start) run
 * long after.
 */
let configuredNoOnlineModelChecks = false;

export function recordConfiguredNoOnlineModelChecks(value: boolean): void {
  configuredNoOnlineModelChecks = value;
}

/**
 * Whether model checks stay off the network: the environment variable
 * HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS when set ("1"/"true" turn checks
 * off, anything else leaves them on), else hankweave.json's
 * `noOnlineModelChecks` — the precedence of every other runtime setting.
 */
export function isModelCatalogOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS?.trim().toLowerCase();
  if (value) return value === "1" || value === "true";
  return configuredNoOnlineModelChecks;
}

/**
 * Write a file atomically: a same-directory temp file renamed over the target.
 * The rename retries through a transient lock (another process reading the
 * target on Windows); any other failure propagates, for the caller to treat
 * as it sees fit — every catalog write is a cache, so callers log and go on.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    fs.writeFileSync(temp, content);
    renameWithRetrySync(temp, filePath);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
