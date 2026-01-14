#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
};

console.log(`\n${colors.blue}=== Hankweave Test Sanity Check ===${colors.reset}\n`);

// Get current directory info
const cwd = process.cwd();
console.log(`Current directory: ${colors.yellow}${cwd}${colors.reset}`);

// Check if we're in the right directory
let isCorrectDir = false;
if (fs.existsSync("package.json")) {
  try {
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
    isCorrectDir = pkg.name === "hankweave";
    console.log(`Package name: ${colors.yellow}${pkg.name}${colors.reset}`);
  } catch (_e) {
    console.log(`${colors.red}Error reading package.json${colors.reset}`);
  }
}

if (!isCorrectDir) {
  console.log(`\n${colors.red}❌ Not in hankweave root directory!${colors.reset}`);
  console.log(`Expected to find package.json with name: "hankweave"`);
  process.exit(1);
}

console.log(`${colors.green}✓ In correct directory${colors.reset}`);

// Check test configuration
console.log(`\n${colors.blue}Test Configuration:${colors.reset}`);
const testConfigPath = path.join(cwd, "tests/config/test-codons.config.json");
if (fs.existsSync(testConfigPath)) {
  console.log(`${colors.green}✓ Test config exists${colors.reset}: ${testConfigPath}`);

  // Parse and show codons
  try {
    const hankFile = JSON.parse(fs.readFileSync(testConfigPath, "utf-8"));
    const codons = hankFile.hank || [];
    console.log(`\nCodons to run:`);
    codons.forEach(
      (codon: { id?: string; name?: string; model?: string; checkpointedFiles?: string[] }) => {
        console.log(`  - ${colors.yellow}${codon.id}${colors.reset}: ${codon.name}`);
        console.log(`    Model: ${codon.model}`);
        console.log(
          `    Tracked Files: ${codon.checkpointedFiles ? codon.checkpointedFiles.join(", ") : "none"}`,
        );
      },
    );
  } catch (_e) {
    console.log(`${colors.red}Error parsing test config${colors.reset}`);
  }
} else {
  console.log(`${colors.red}✗ Test config missing${colors.reset}`);
}

// Check test area
console.log(`\n${colors.blue}Test Area Status:${colors.reset}`);
const testAreaPath = path.join(cwd, "tests/test-area");
console.log(`Test area path: ${colors.yellow}${testAreaPath}${colors.reset}`);

if (fs.existsSync(testAreaPath)) {
  console.log(`${colors.yellow}⚠ Test area exists${colors.reset}`);

  // List contents
  const contents = fs.readdirSync(testAreaPath);
  if (contents.length > 0) {
    console.log(`\nCurrent contents:`);
    contents.forEach((item) => {
      const itemPath = path.join(testAreaPath, item);
      const stat = fs.statSync(itemPath);
      const icon = stat.isDirectory() ? "📁" : "📄";
      console.log(`  ${icon} ${item}`);
    });

    console.log(`\n${colors.yellow}⚠ Test area is not empty!${colors.reset}`);
    console.log(`Running 'bun run pre-test:cleanup' will DELETE everything in:`);
    console.log(`  ${colors.red}${testAreaPath}${colors.reset}`);
  } else {
    console.log(`${colors.green}✓ Test area is empty${colors.reset}`);
  }
} else {
  console.log(`${colors.gray}Test area doesn't exist yet (will be created)${colors.reset}`);
}

// Check server spawn configuration
console.log(`\n${colors.blue}Server Configuration:${colors.reset}`);
console.log(
  `Server will run with working directory: ${colors.yellow}${testAreaPath}${colors.reset}`,
);
console.log(
  `This means Claude will create files in: ${colors.yellow}${testAreaPath}${colors.reset}`,
);
console.log(
  `Server executable: ${colors.yellow}${path.join(cwd, "server/index.ts")}${colors.reset}`,
);

// Check for existing server
const lockFilePath = path.join(testAreaPath, ".hankweave/runtime.lock");
if (fs.existsSync(lockFilePath)) {
  console.log(`\n${colors.red}⚠ Lock file exists!${colors.reset} Server may be running`);
  console.log(`Lock file: ${lockFilePath}`);
  try {
    const pid = fs.readFileSync(lockFilePath, "utf-8").trim();
    console.log(`PID in lock file: ${pid}`);
  } catch {}
}

// Safety warnings
console.log(`\n${colors.blue}Safety Summary:${colors.reset}`);
console.log(
  `1. Test will run in isolated directory: ${colors.green}${testAreaPath}${colors.reset}`,
);
console.log(
  `2. Pre-test will ${colors.red}DELETE${colors.reset} and recreate: ${colors.yellow}${testAreaPath}${colors.reset}`,
);
console.log(`3. Server working directory will be: ${colors.green}${testAreaPath}${colors.reset}`);
console.log(
  `4. All Claude-created files will be in: ${colors.green}${testAreaPath}${colors.reset}`,
);
console.log(`5. Your project files will ${colors.green}NOT${colors.reset} be affected`);

console.log(`\n${colors.blue}Commands:${colors.reset}`);
console.log(
  `- ${colors.yellow}bun run pre-test:cleanup${colors.reset} - Wipe and recreate test area`,
);
console.log(`- ${colors.yellow}bun run test:check${colors.reset} - Run readiness checks`);
console.log(`- ${colors.yellow}bun run test${colors.reset} - Run full test suite`);

console.log("\n");
