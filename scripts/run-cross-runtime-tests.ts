#!/usr/bin/env node
/**
 * Runs all cross-runtime tests (tests/cross-runtime/*.test.ts)
 * using the specified runtime: bun, node, or deno.
 *
 * Usage: bun scripts/run-cross-runtime-tests.ts <bun|node|deno>
 */

import { execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const runtime = process.argv[2];
if (!runtime || !["bun", "node", "deno"].includes(runtime)) {
  console.error("Usage: bun scripts/run-cross-runtime-tests.ts <bun|node|deno>");
  process.exit(1);
}

const testsDir = resolve(import.meta.dirname ?? ".", "../tests/cross-runtime");
const testFiles = readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

if (testFiles.length === 0) {
  console.error("No test files found in tests/cross-runtime/");
  process.exit(1);
}

console.log(`Running ${testFiles.length} cross-runtime test(s) with ${runtime}...\n`);

for (const file of testFiles) {
  const filePath = join("tests/cross-runtime", file);
  let cmd: string;
  switch (runtime) {
    case "bun":
      cmd = `bun ${filePath}`;
      break;
    case "node":
      cmd = `npx tsx ${filePath}`;
      break;
    case "deno":
      // --node-modules-dir=manual: use the node_modules bun installed from
      // bun.lock. The default (auto) re-resolves package.json ranges, ignoring
      // bun.lock, and rewrites node_modules in place; release.yml's publish
      // build then bundled those newer deps (0.13.0 shipped bedrock 3.0.141,
      // which imports an @ai-sdk/anthropic export our ^2.0.94 range lacks).
      cmd = `deno run -A --node-modules-dir=manual --sloppy-imports ${filePath}`;
      break;
    default:
      throw new Error(`Unknown runtime: ${runtime}`);
  }

  console.log(`▶ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

console.log(`\n✅ All ${testFiles.length} cross-runtime tests passed with ${runtime}`);
