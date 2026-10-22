import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { modelHarnesses } from "../../server/harnesses.js";
import { Models } from "../../server/llm/index.js";

/**
 * Model checks read the installed Models instance (spec 72). A run installs
 * it at startup (Models.load); tests that parse hanks without a run get a
 * parse-mode instance over the bundled catalog: names and catalog
 * membership, no credentials, no network, no cache directory. Tests of
 * run-mode checks install their own.
 */
// Keep the developer's own Pi config (custom providers in models.json, a
// cached pi.dev store) and model catalog cache out of unit tests' answers.
// Tests that need either point these at their own directories. Not when the
// codex credential is in play: suites that declare CODEX_AUTH_JSON read Pi's
// real auth store, and servers they spawn inherit this environment.
if (!process.env.CODEX_AUTH_JSON) {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "hw-models-preload-"));
  process.env.PI_CODING_AGENT_DIR ??= path.join(isolated, "pi-agent");
  process.env.HANKWEAVE_MODEL_CATALOG_DIR ??= path.join(isolated, "model-catalog");
}

Models.loadForParsing({}, { harnesses: modelHarnesses(), bundledOnly: true });
