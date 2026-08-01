#!/usr/bin/env bun

/**
 * E2E test runner for --init command
 *
 * This script runs the comprehensive init command test suite which verifies:
 * - --init creates all required files
 * - Generated config is valid
 * - Works in different modes (normal/binary/package manager)
 *
 * Usage:
 *   bun scripts/e2e/test-init-normal.ts [mode]
 *
 * Modes:
 *   normal  - Direct source execution (default)
 *   npx     - Via npx with Verdaccio registry
 *   bunx    - Via bunx with Verdaccio registry
 *   binary  - Compiled standalone binary
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "../..");
const TEST_FILE = resolve(ROOT, "tests/e2e/init-command-e2e.test.ts");

// Parse command line arguments
type TestMode = "normal" | "npx" | "bunx" | "binary";
const mode = (process.argv[2] || "normal") as TestMode;

const validModes: TestMode[] = ["normal", "npx", "bunx", "binary"];
if (!validModes.includes(mode)) {
  console.error(`Error: Invalid mode '${mode}'`);
  console.error(`Valid modes: ${validModes.join(", ")}`);
  process.exit(1);
}

// Display header
const modeDisplay: Record<TestMode, string> = {
  normal: "Normal Mode (Source)",
  npx: "NPX Mode (Verdaccio)",
  bunx: "Bunx Mode (Verdaccio)",
  binary: "Binary Mode (Compiled)",
};

console.log("╔════════════════════════════════════════════════════════════╗");
console.log(`║  E2E Test: Init Command - ${modeDisplay[mode].padEnd(26)} ║`);
console.log("╚════════════════════════════════════════════════════════════╝\n");

// Set up environment variables based on mode
const testEnv = { ...process.env };

switch (mode) {
  case "npx":
    testEnv.HANKWEAVE_TEST_USE_NPX = "1";
    break;
  case "bunx":
    testEnv.HANKWEAVE_TEST_USE_BUNX = "1";
    break;
  case "binary":
    testEnv.HANKWEAVE_TEST_USE_BINARY = "1";
    break;
  default:
    // No special env vars needed for normal mode
    break;
}

// Run the test using bun test
const proc = spawn("bun", ["test", TEST_FILE], {
  stdio: "inherit",
  env: testEnv,
});

proc.on("close", (code) => {
  process.exit(code || 0);
});
