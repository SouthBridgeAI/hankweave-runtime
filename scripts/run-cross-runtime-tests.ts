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
      // --minimum-dependency-age=0: Deno 2.9+ refuses npm packages published
      // within the last 24h by default; our deps are pinned by the lockfile,
      // so freshly released versions must still install.
      cmd = `deno run -A --minimum-dependency-age=0 --node-modules-dir --sloppy-imports ${filePath}`;
      break;
    default:
      throw new Error(`Unknown runtime: ${runtime}`);
  }

  console.log(`▶ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

console.log(`\n✅ All ${testFiles.length} cross-runtime tests passed with ${runtime}`);
