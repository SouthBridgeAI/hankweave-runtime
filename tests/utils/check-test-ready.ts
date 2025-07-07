#!/usr/bin/env bun
import fs from "node:fs";

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
};

console.log(`\n${colors.blue}Checking test readiness...${colors.reset}\n`);

let ready = true;
const checks: { name: string; pass: boolean; message?: string }[] = [];

// Check 1: In correct directory - check for specific package.json content
let inCorrectDir = false;
try {
  if (fs.existsSync("package.json")) {
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf-8"));
    inCorrectDir = packageJson.name === "langton-runner" && fs.existsSync("server/index.ts");
  }
} catch {
  inCorrectDir = false;
}
checks.push({
  name: "Working directory",
  pass: inCorrectDir,
  message: inCorrectDir ? "In langton-runner root" : "Must run from langton-runner root directory",
});

// Check 2: Test config exists
const testConfigExists = fs.existsSync("tests/config/test-phases.config.json");
checks.push({
  name: "Test configuration",
  pass: testConfigExists,
  message: testConfigExists ? "test-phases.config.json found" : "Missing test configuration",
});

// Check 3: Test directory exists
const testDirExists = fs.existsSync("tests/test-area");
checks.push({
  name: "Test directory",
  pass: testDirExists,
  message: testDirExists ? "test-area exists" : "Test directory missing",
});

// Check 4: Server file exists
const serverExists = fs.existsSync("server/index.ts");
checks.push({
  name: "Server executable",
  pass: serverExists,
  message: serverExists ? "Server found" : "Server file missing",
});

// Check 5: No lock file (no server running)
const lockFile = "tests/test-area/.langton/server.lock";
const noLockFile = !fs.existsSync(lockFile);
checks.push({
  name: "Server lock file",
  pass: noLockFile,
  message: noLockFile ? "No server running" : "Server may already be running (lock file exists)",
});

// Check 6: Claude CLI available
const claudeAvailable = Bun.which("claude") !== null;
checks.push({
  name: "Claude CLI",
  pass: claudeAvailable,
  message: claudeAvailable ? "Claude CLI found" : "Claude CLI not found in PATH",
});

// Note: We don't check for ANTHROPIC_API_KEY since it can be:
// - Set in environment
// - Passed via CLI args
// - Configured in Claude global settings

// Print results
checks.forEach((check) => {
  const icon = check.pass ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
  const color = check.pass ? colors.green : colors.red;
  console.log(`${icon} ${check.name}: ${color}${check.message}${colors.reset}`);
});

ready = checks.every((c) => c.pass);

console.log(`\n${"=".repeat(50)}`);
if (ready) {
  console.log(`${colors.green}✅ All checks passed! Ready to run tests.${colors.reset}`);
  console.log(`\nRun: ${colors.blue}bun run test${colors.reset}`);
} else {
  console.log(
    `${colors.red}❌ Some checks failed. Please fix issues before running tests.${colors.reset}`,
  );

  // Provide helpful fixes
  if (!inCorrectDir) {
    console.log(`\n${colors.yellow}Fix: cd to the project root directory${colors.reset}`);
  }
  if (!claudeAvailable) {
    console.log(
      `\n${colors.yellow}Fix: Install Claude CLI - https://docs.anthropic.com/en/docs/claude-code${colors.reset}`,
    );
  }
  if (!noLockFile) {
    console.log(`\n${colors.yellow}Fix: rm ${lockFile}${colors.reset}`);
  }
}
console.log("");

process.exit(ready ? 0 : 1);
