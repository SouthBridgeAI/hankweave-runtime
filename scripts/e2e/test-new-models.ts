#!/usr/bin/env bun

/**
 * Runs e2e init tests in parallel for a list of newly added models.
 * Saves stdout/stderr to new-models-dev/<providerId>/<modelId>/ in project root.
 *
 * All non-Anthropic models run via the embedded Pi agent (model validation
 * rewrites bare google/openai spellings to pi/...).
 *
 * Usage:
 *   bun scripts/e2e/test-new-models.ts openai/gpt-5.4-nano google/gemma-3-27b-it ...
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "../..");
const OUTPUT_BASE = resolve(ROOT, "new-models-dev");
const TEST_FILE = resolve(ROOT, "tests/e2e/init-command-e2e.test.ts");

const models = process.argv.slice(2);
if (models.length === 0) {
  console.error("Usage: bun scripts/e2e/test-new-models.ts <providerId/modelId> ...");
  console.error(
    "Example: bun scripts/e2e/test-new-models.ts openai/gpt-5.4-nano google/gemma-3-27b-it",
  );
  process.exit(1);
}

/** Returns the runtime model strings to test for a given providerId/modelId.
 * Everything runs on the embedded Pi agent, so one runtime spelling suffices. */
function getRuntimeModels(providerModelId: string): string[] {
  return [providerModelId];
}

interface TestResult {
  providerModelId: string;
  runtimeModel: string;
  passed: boolean;
  outputDir: string;
  briefError?: string;
}

async function runTest(providerModelId: string, runtimeModel: string): Promise<TestResult> {
  const outputDir = resolve(OUTPUT_BASE, providerModelId);
  mkdirSync(outputDir, { recursive: true });

  let stdout = "";
  let stderr = "";

  return new Promise((res) => {
    // Use a sanitized model ID + harness as the test run ID so parallel runs don't share directories.
    const testId = runtimeModel.replace(/[^a-zA-Z0-9]/g, "-");
    const proc = spawn("bun", ["test", TEST_FILE], {
      env: { ...process.env, HANKWEAVE_RUNTIME_MODEL: runtimeModel, HANKWEAVE_E2E_TEST_ID: testId },
      cwd: ROOT,
    });

    proc.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    proc.on("close", (code) => {
      writeFileSync(resolve(outputDir, "stdout.log"), stdout);
      writeFileSync(resolve(outputDir, "stderr.log"), stderr);

      const passed = code === 0;
      let briefError: string | undefined;
      if (!passed) {
        const combined = `${stdout}\n${stderr}`;
        const failLine = combined
          .split("\n")
          .find((l) => l.includes("(fail)") || l.match(/error:/i));
        briefError = failLine?.trim() ?? `exit code ${code}`;
      }

      res({ providerModelId, runtimeModel, passed, outputDir, briefError });
    });
  });
}

const testCases = models.flatMap((m) =>
  getRuntimeModels(m).map((rm) => ({ providerModelId: m, runtimeModel: rm })),
);

console.log(`\nRunning e2e init tests for ${testCases.length} test case(s) in parallel...`);
console.log(`Output: ${OUTPUT_BASE}\n`);

const results = await Promise.all(
  testCases.map(({ providerModelId, runtimeModel }) => runTest(providerModelId, runtimeModel)),
);

console.log("## E2E test results\n");
for (const r of results) {
  if (r.passed) {
    console.log(`✓ ${r.runtimeModel} — passed`);
  } else {
    console.log(`✗ ${r.runtimeModel} — failed: ${r.briefError}`);
    console.log(`  Logs: ${r.outputDir}`);
  }
}

const passedCount = results.filter((r) => r.passed).length;
console.log(`\nPassed: ${passedCount}/${results.length}`);

process.exit(passedCount === results.length ? 0 : 1);
