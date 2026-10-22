import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CATALOG_SOURCE_URLS } from "../server/llm/internal/catalog-store";
import {
  parseModelsDataRows,
  toModelsData,
  transformModelsDevApi,
} from "../server/llm/internal/models-dev-transform";
import { writeFileAtomic } from "../server/model-catalog-settings";

/**
 * Refresh the bundled models.dev snapshot (server/llm/internal/models-dev-data.json):
 * the model catalog's offline floor, compiled into every build.
 *
 * Running installs no longer depend on this file for new models — the model
 * catalog refreshes models.dev at runtime (spec 70). Refresh the snapshot at
 * release time (`bun scripts/release.ts … --refresh-models`) so offline
 * machines start from recent data.
 *
 * Rows are validated one at a time by the same transform the runtime catalog
 * uses, so a malformed upstream row is skipped and reported instead of
 * failing the refresh. The write is atomic; git is the backup.
 */

const OUTPUT_PATH = path.join(process.cwd(), "server/llm/internal/models-dev-data.json");
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

async function fetchWithRetry(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(`Attempt ${attempt}/${MAX_RETRIES}: fetching ${url}`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
      return response;
    } catch (error) {
      if (attempt >= MAX_RETRIES) throw error;
      const delay = RETRY_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`Attempt ${attempt} failed (${error}); retrying in ${delay} ms`);
      await sleep(delay);
    }
  }
}

function modelKeys(raw: unknown): Set<string> {
  return new Set(parseModelsDataRows(raw).rows.map((r) => `${r.providerId}/${r.modelId}`));
}

export async function fetchModelsData(): Promise<void> {
  const previous = fs.existsSync(OUTPUT_PATH)
    ? modelKeys(JSON.parse(fs.readFileSync(OUTPUT_PATH, "utf-8")))
    : new Set<string>();

  const response = await fetchWithRetry(CATALOG_SOURCE_URLS["models.dev"]);
  const parsed = transformModelsDevApi(await response.json());
  if (parsed.rows.length === 0) {
    throw new Error("models.dev returned no usable rows; the snapshot was left unchanged");
  }
  const data = toModelsData(parsed, new Date().toISOString());
  writeFileAtomic(OUTPUT_PATH, JSON.stringify(data, null, 2));

  const current = new Set(parsed.rows.map((r) => `${r.providerId}/${r.modelId}`));
  const added = [...current].filter((key) => !previous.has(key));
  const removed = [...previous].filter((key) => !current.has(key));
  console.log(
    `\nWrote ${OUTPUT_PATH}: ${data.providers.length} providers, ${parsed.rows.length} models ` +
      `(+${added.length} / -${removed.length} vs. the previous snapshot)`,
  );
  if (parsed.skipped.length > 0) {
    console.log(`Skipped ${parsed.skipped.length} malformed upstream row(s):`);
    for (const { key, reason } of parsed.skipped.slice(0, 20)) console.log(`  ${key}: ${reason}`);
    if (parsed.skipped.length > 20) console.log(`  … and ${parsed.skipped.length - 20} more`);
  }
  const firstParty = /^(anthropic|openai|google|deepseek|xai|mistral|groq)\//;
  const notable = added.filter((key) => firstParty.test(key));
  if (notable.length > 0) console.log(`New first-party models: ${notable.join(", ")}`);
}

if (import.meta.main) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      "Usage: bun scripts/fetch-models-dev.ts\n\n" +
        `Refreshes ${OUTPUT_PATH} from ${CATALOG_SOURCE_URLS["models.dev"]}.\n` +
        "Commit the result on its own so the data diff is reviewable.",
    );
    process.exit(0);
  }
  fetchModelsData().catch((error) => {
    console.error(`\nFailed to refresh the models.dev snapshot: ${error}`);
    process.exit(1);
  });
}
