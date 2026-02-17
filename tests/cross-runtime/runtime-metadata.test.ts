/**
 * Cross-runtime test for environment metadata detection.
 *
 * Validates that detectRuntime(), getRuntimeVersion(), and isCompiledExecutable()
 * return correct values under each runtime.
 *
 * Usage:
 *   bun tests/cross-runtime/runtime-metadata.test.ts
 *   npx tsx tests/cross-runtime/runtime-metadata.test.ts
 *   deno run -A --node-modules-dir --sloppy-imports tests/cross-runtime/runtime-metadata.test.ts
 */

import assert from "node:assert/strict";
import { detectRuntime, getRuntimeVersion, isCompiledExecutable } from "../../server/utils.js";

// ─── Helpers ───────────────────────────────────────────────────────────

function expectedRuntime(): string {
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

async function testDetectRuntime() {
  const runtime = detectRuntime();
  const expected = expectedRuntime();
  assert.equal(runtime, expected, `Expected "${expected}", got "${runtime}"`);
}

async function testGetRuntimeVersion() {
  const version = getRuntimeVersion();
  const expected = expectedRuntime();
  assert.ok(
    version.startsWith(`${expected} `),
    `Expected version to start with "${expected} ", got "${version}"`,
  );

  // The version part after the runtime name should be non-empty
  const versionPart = version.slice(expected.length + 1);
  assert.ok(versionPart.length > 0, `Version part should be non-empty, got "${versionPart}"`);

  // Should look like a version string (starts with a digit or "v")
  assert.ok(/^v?\d/.test(versionPart), `Version should start with a digit or "v", got "${versionPart}"`);
}

async function testIsCompiledExecutable() {
  // When running from source via any of these commands, we should NOT be compiled
  const isCompiled = isCompiledExecutable();
  assert.equal(isCompiled, false, `Expected isCompiledExecutable() to be false when running from source`);
}

async function testRuntimeVersionMatchesProcess() {
  const runtime = expectedRuntime();
  const version = getRuntimeVersion();

  if (runtime === "bun") {
    // @ts-ignore
    assert.equal(version, `bun ${process.versions.bun}`);
  } else if (runtime === "node") {
    assert.equal(version, `node ${process.version}`);
  } else if (runtime === "deno") {
    assert.ok(version.startsWith("deno "), `Deno version should start with "deno ", got "${version}"`);
  }
}

// ─── Runner ────────────────────────────────────────────────────────────

async function main() {
  const runtime = expectedRuntime();
  console.log(`\nRuntime Metadata Tests (runtime: ${runtime})\n`);

  await runTest("detectRuntime() returns correct runtime", testDetectRuntime);
  await runTest("getRuntimeVersion() returns runtime + version", testGetRuntimeVersion);
  await runTest("isCompiledExecutable() returns false from source", testIsCompiledExecutable);
  await runTest("getRuntimeVersion() matches process version info", testRuntimeVersionMatchesProcess);

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main();
