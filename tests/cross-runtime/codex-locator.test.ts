/**
 * Cross-runtime test for codex binary location.
 *
 * Validates that locateCodexViaImportResolve() and ensureCodexAvailable()
 * correctly find the codex binary under each runtime (Bun, Node.js, Deno).
 *
 * Usage:
 *   bun tests/cross-runtime/codex-locator.test.ts
 *   npx tsx tests/cross-runtime/codex-locator.test.ts
 *   deno run -A --node-modules-dir --sloppy-imports tests/cross-runtime/codex-locator.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import {
  ensureCodexAvailable,
  locateCodexInNodeModules,
  locateCodexViaImportResolve,
} from "../../server/codex-runtime-extractor.js";

// ─── Helpers ───────────────────────────────────────────────────────────

function currentRuntime(): string {
  // @ts-ignore -- Bun global not in all type definitions
  if (typeof Bun !== "undefined") return "bun";
  // @ts-ignore -- Deno global not in all type definitions
  if (typeof Deno !== "undefined") return "deno";
  return "node";
}

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`        ${error instanceof Error ? error.message : error}`);
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────

async function testImportMetaResolveReturnsFileUrl() {
  // At least one of the codex packages should be resolvable to a file:// URL
  let resolved: string | null = null;
  for (const pkg of ["@openai/codex-sdk"]) {
    try {
      const url = import.meta.resolve(pkg);
      if (url.startsWith("file://")) {
        resolved = url;
        break;
      }
    } catch {
      // Package not available under this name
    }
  }
  assert.ok(resolved, "import.meta.resolve should return a file:// URL for @openai/codex-sdk");
}

async function testLocateCodexViaImportResolveFinds() {
  const result = locateCodexViaImportResolve();
  assert.ok(result, "locateCodexViaImportResolve() should return a non-null path");
  assert.ok(fs.existsSync(result), `Returned path should exist on disk: ${result}`);
}

async function testLocateCodexViaImportResolveIsExecutable() {
  if (os.platform() === "win32") return; // Skip on Windows

  const result = locateCodexViaImportResolve();
  assert.ok(result, "locateCodexViaImportResolve() should return a path");

  const stat = fs.statSync(result);
  assert.ok(
    (stat.mode & 0o100) !== 0,
    `Binary should have execute permission (mode: ${stat.mode.toString(8)})`,
  );
}

async function testEnsureCodexAvailableSucceeds() {
  const result = await ensureCodexAvailable();
  assert.ok(result.path, "ensureCodexAvailable() should return a path");
  assert.ok(fs.existsSync(result.path), `Returned path should exist: ${result.path}`);
  assert.ok(result.version, "Should include a version string");
  assert.equal(typeof result.cached, "boolean", "Should include a cached flag");
}

async function testResolvedMatchesNodeModules() {
  const runtime = currentRuntime();
  // Under Bun and Node, both locators should find the same binary
  // Under Deno with --node-modules-dir, node_modules may also exist
  const nodeModulesResult = locateCodexInNodeModules();
  const resolveResult = locateCodexViaImportResolve();

  if (nodeModulesResult && resolveResult) {
    // Both found something — verify they resolve to the same file
    const nmReal = fs.realpathSync(nodeModulesResult);
    const resolveReal = fs.realpathSync(resolveResult);
    assert.equal(
      nmReal,
      resolveReal,
      `Both locators should find the same binary (node_modules: ${nmReal}, resolve: ${resolveReal})`,
    );
  } else if (runtime === "bun" || runtime === "node") {
    // Under Bun/Node, both should succeed
    assert.ok(nodeModulesResult, "locateCodexInNodeModules() should succeed under " + runtime);
    assert.ok(resolveResult, "locateCodexViaImportResolve() should succeed under " + runtime);
  }
  // Under Deno, locateCodexInNodeModules() might fail (that's the whole point),
  // but locateCodexViaImportResolve() must succeed
  assert.ok(resolveResult, "locateCodexViaImportResolve() must always succeed");
}

// ─── Runner ────────────────────────────────────────────────────────────

async function main() {
  const runtime = currentRuntime();
  console.log(`\nCodex Locator Tests (runtime: ${runtime})\n`);

  await runTest("import.meta.resolve returns file:// URL for codex package", testImportMetaResolveReturnsFileUrl);
  await runTest("locateCodexViaImportResolve() finds the binary", testLocateCodexViaImportResolveFinds);
  await runTest("locateCodexViaImportResolve() returns an executable file", testLocateCodexViaImportResolveIsExecutable);
  await runTest("ensureCodexAvailable() succeeds", testEnsureCodexAvailableSucceeds);
  await runTest("resolved binary matches node_modules binary", testResolvedMatchesNodeModules);

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main();
