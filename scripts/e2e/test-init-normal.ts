#!/usr/bin/env bun

/**
 * E2E test runner for --init command in normal mode (direct source execution)
 *
 * This script runs the comprehensive init command test suite which verifies:
 * - --init creates all required files
 * - Generated config is valid
 * - Works in different modes (normal/binary/package manager)
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "../..");
const TEST_FILE = resolve(ROOT, "tests/e2e/init-command-e2e.test.ts");

console.log("╔════════════════════════════════════════════════════════════╗");
console.log("║  E2E Test: Init Command (Normal Mode)                     ║");
console.log("╚════════════════════════════════════════════════════════════╝\n");

// Run the test using bun test
const proc = spawn("bun", ["test", TEST_FILE], {
	stdio: "inherit",
	env: process.env,
});

proc.on("close", (code) => {
	process.exit(code || 0);
});
