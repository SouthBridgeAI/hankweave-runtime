#!/usr/bin/env node
/**
 * Discovers and runs tests for all shim packages under shims/.
 * A directory is treated as a testable shim if its package.json has a "test" script.
 *
 * Usage: bun scripts/test-shims.ts
 */

import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const shimsDir = resolve(import.meta.dirname ?? ".", "../shims");

const shims = readdirSync(shimsDir)
	.filter((name) => {
		const dir = join(shimsDir, name);
		if (!statSync(dir).isDirectory()) return false;
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			return Boolean(pkg.scripts?.test);
		} catch {
			return false;
		}
	})
	.sort();

if (shims.length === 0) {
	console.error("No testable shim packages found in shims/");
	process.exit(1);
}

console.log(`Found ${shims.length} shim package(s): ${shims.join(", ")}\n`);

let failed = 0;

for (const shim of shims) {
	const dir = join(shimsDir, shim);
	console.log(`▶ Testing ${shim}`);
	try {
		execSync("bun install", { cwd: dir, stdio: "inherit" });
		execSync("bun test", { cwd: dir, stdio: "inherit" });
	} catch {
		failed++;
		console.error(`✗ ${shim} tests failed\n`);
	}
}

if (failed > 0) {
	console.error(`\n✗ ${failed} of ${shims.length} shim package(s) failed`);
	process.exit(1);
}

console.log(`\n✅ All ${shims.length} shim package(s) passed`);
