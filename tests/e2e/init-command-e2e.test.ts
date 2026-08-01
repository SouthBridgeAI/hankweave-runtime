#!/usr/bin/env bun
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerReadyEvent } from "../../server/schemas/event-schemas.js";
import {
  type BinarySetup,
  cleanupBinary,
  getBinaryCommandOverride,
  needsBinary,
  setupBinary,
} from "../utils/binary.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { generateTestTimestamp, getFreePort } from "../utils/test-helpers.js";
import {
  cleanupVerdaccio,
  getCommandOverride,
  needsVerdaccio,
  setupVerdaccio,
  type VerdaccioSetup,
} from "../utils/verdaccio.js";

// Test configuration
const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_TIMESTAMP =
  generateTestTimestamp() +
  (process.env.HANKWEAVE_E2E_TEST_ID ? `-${process.env.HANKWEAVE_E2E_TEST_ID}` : "");

// Platform detection for conditional assertions
const isWindows = process.platform === "win32";
const INIT_RUN_TIMEOUT_MS = isWindows ? 8 * 60_000 : 5 * 60_000;
const GENERATED_HANK_TEST_TIMEOUT_MS = INIT_RUN_TIMEOUT_MS;
// npx/package manager modes need more time: npx must download and install all dependencies
// through the Verdaccio proxy before running the init command
const INIT_CREATE_TIMEOUT_MS = needsVerdaccio() ? 5 * 60_000 : 3 * 60_000;

// Verdaccio setup state (for package manager testing)
let verdaccioSetup: VerdaccioSetup | null = null;

// Binary setup state (for compiled binary testing)
let binarySetup: BinarySetup | null = null;

// Test area and init directory - determined at runtime based on test mode
let TEST_AREA: string;
let INIT_TEST_DIR: string;

/**
 * Spawns the init command using either binary, package manager (npx/bunx/pnpm dlx/deno), or direct bun execution.
 * Automatically configures registry URL if using Verdaccio.
 */
function spawnInitCommand(options: {
  cwd: string;
  stdio?: Parameters<typeof spawn>[2]["stdio"];
}): ReturnType<typeof spawn> {
  let command: string;
  let args: string[];

  // Priority order: binary > package manager > default bun
  if (binarySetup) {
    // Using compiled binary
    const binaryCommandOverride = getBinaryCommandOverride(binarySetup.binaryPath);
    command = binaryCommandOverride.command;
    args = [...binaryCommandOverride.args, "--init"];
  } else if (needsVerdaccio()) {
    // Using package manager (npx/bunx/pnpm dlx/deno)
    const commandOverride = getCommandOverride();
    if (!commandOverride) {
      throw new Error("Verdaccio mode enabled but no command override configured");
    }
    command = commandOverride.command;
    args = [...commandOverride.args, "--init"];
  } else {
    // Default: direct bun execution
    const serverEntry = path.join(TEST_ROOT, "server/index.ts");
    command = "bun";
    args = [serverEntry, "--init"];
  }

  const spawnOptions: Parameters<typeof spawn>[2] = {
    cwd: options.cwd,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  };

  // Add registry URL if using Verdaccio (not needed for binary mode)
  if (verdaccioSetup && !binarySetup && needsVerdaccio()) {
    spawnOptions.env = {
      ...process.env,
      npm_config_registry: verdaccioSetup.registry.registryURL,
      // Explicitly point npm/npx to the .npmrc file (needed on Windows)
      NPM_CONFIG_USERCONFIG: verdaccioSetup.npmrcPath,
    };
  }

  // On Windows, package manager commands (npx, bunx, pnpm) are .cmd files
  // and need to be spawned with shell=true. Binary and Deno are native executables and don't need shell.
  const needsShell =
    !binarySetup &&
    process.platform === "win32" &&
    ["npx", "bunx", "pnpm", "npm"].includes(command);
  spawnOptions.shell = needsShell;

  // Log the command being executed for debugging
  console.log("\n=== Spawning Init Command ===");
  console.log("Mode:", binarySetup ? "Binary" : verdaccioSetup ? "Verdaccio" : "Default");
  console.log("Command:", command);
  console.log("Args:", args);
  console.log("CWD:", options.cwd);
  if (verdaccioSetup && !binarySetup) {
    console.log("Registry:", verdaccioSetup.registry.registryURL);
  }
  console.log("Shell:", spawnOptions.shell);
  console.log("===========================\n");

  return spawn(command, args, spawnOptions);
}

describe("init command e2e", () => {
  beforeAll(async () => {
    const projectRoot = path.resolve(TEST_ROOT);

    // Clean npx cache to prevent ENOTEMPTY errors from previous killed runs.
    // When npx is killed mid-installation (e.g., by test timeout), it leaves
    // ~/.npm/_npx in a dirty state that causes subsequent runs to fail.
    if (process.env.HANKWEAVE_TEST_USE_NPX) {
      const npxCacheDir = path.join(homedir(), ".npm", "_npx");
      if (fs.existsSync(npxCacheDir)) {
        fs.rmSync(npxCacheDir, { recursive: true, force: true });
        console.log("Cleared npx cache directory");
      }
    }

    // Setup binary if testing with compiled binary
    if (needsBinary()) {
      binarySetup = await setupBinary(projectRoot);
    }

    // Use project-local test area for all tests
    TEST_AREA = path.join(TEST_ROOT, "tests/test-area");
    INIT_TEST_DIR = path.join(TEST_AREA, `init-test-${TEST_TIMESTAMP}`);

    // Setup Verdaccio if testing with package managers
    if (needsVerdaccio()) {
      verdaccioSetup = await setupVerdaccio(projectRoot);
    }

    // Create test area directory
    if (!fs.existsSync(TEST_AREA)) {
      fs.mkdirSync(TEST_AREA, { recursive: true });
    }
  }, 120_000); // 2 minutes timeout for setup (Verdaccio publish can take time on Windows)

  afterAll(async () => {
    // Clean up test directory
    // if (fs.existsSync(INIT_TEST_DIR)) {
    //   fs.rmSync(INIT_TEST_DIR, { recursive: true, force: true });
    // }

    // Cleanup binary if it was built
    if (binarySetup) {
      await cleanupBinary(binarySetup);
      binarySetup = null;
    }

    // Cleanup Verdaccio if it was started
    if (verdaccioSetup) {
      await cleanupVerdaccio(verdaccioSetup);
      verdaccioSetup = null;
    }
  }, 60_000); // 60 seconds timeout for cleanup

  test(
    "init command creates all required files",
    async () => {
      // Create empty directory for init
      fs.mkdirSync(INIT_TEST_DIR, { recursive: true });

      // Run init command
      const child = spawnInitCommand({ cwd: INIT_TEST_DIR });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      // Wait for process to complete
      const [exitCode] = await once(child, "exit");

      // Log output for debugging
      console.log("\n=== Init Command Output ===");
      console.log("Exit Code:", exitCode);
      console.log("\n--- STDOUT ---");
      console.log(stdout || "(empty)");
      console.log("\n--- STDERR ---");
      console.log(stderr || "(empty)");
      console.log("=== End Output ===\n");

      // Verify success
      expect(exitCode).toBe(0);
      expect(stdout).toContain("Initialized hank");

      // Verify files were created
      expect(fs.existsSync(path.join(INIT_TEST_DIR, "hank.json"))).toBe(true);
      expect(fs.existsSync(path.join(INIT_TEST_DIR, "prompts/analyze-haiku.md"))).toBe(true);
      expect(fs.existsSync(path.join(INIT_TEST_DIR, "prompts/analyze-gemini.md"))).toBe(true);
      expect(fs.existsSync(path.join(INIT_TEST_DIR, "prompts/analyze-pi.md"))).toBe(true);
      expect(fs.existsSync(path.join(INIT_TEST_DIR, "prompts/analyze-gpt.md"))).toBe(true);
      expect(fs.existsSync(path.join(INIT_TEST_DIR, "README.md"))).toBe(true);
      expect(fs.existsSync(path.join(INIT_TEST_DIR, "data/sample1.txt"))).toBe(true);
      expect(fs.existsSync(path.join(INIT_TEST_DIR, "data/sample2.txt"))).toBe(true);
      expect(fs.existsSync(path.join(INIT_TEST_DIR, "data/notes.txt"))).toBe(true);

      // Verify hank.json is valid JSON and has expected structure
      const hankContent = fs.readFileSync(path.join(INIT_TEST_DIR, "hank.json"), "utf-8");
      const hankConfig = JSON.parse(hankContent);

      expect(hankConfig).toHaveProperty("meta");
      expect(hankConfig).toHaveProperty("hank");
      expect(Array.isArray(hankConfig.hank)).toBe(true);
      expect(hankConfig.hank.length).toBe(4);

      // Verify first codon (haiku via the Claude SDK) has required fields
      const firstCodon = hankConfig.hank[0];
      expect(firstCodon).toHaveProperty("id");
      expect(firstCodon).toHaveProperty("name");
      expect(firstCodon).toHaveProperty("model");
      expect(firstCodon).toHaveProperty("continuationMode");

      // Verify second codon (gemini via the embedded Pi agent) has required fields
      const secondCodon = hankConfig.hank[1];
      expect(secondCodon).toHaveProperty("id");
      expect(secondCodon).toHaveProperty("name");
      expect(secondCodon).toHaveProperty("model");
      expect(secondCodon).toHaveProperty("continuationMode");
      expect(secondCodon.model).toBe("pi/google/gemini-2.5-flash");

      // Verify third codon (explicit pi passthrough) has required fields
      const thirdCodon = hankConfig.hank[2];
      expect(thirdCodon).toHaveProperty("id");
      expect(thirdCodon).toHaveProperty("name");
      expect(thirdCodon).toHaveProperty("model");
      expect(thirdCodon).toHaveProperty("continuationMode");
      expect(thirdCodon.model).toBe("pi/anthropic/claude-haiku-4-5");
    },
    INIT_CREATE_TIMEOUT_MS,
  );

  test("init command fails in non-empty directory", async () => {
    // Create directory with a file
    const nonEmptyDir = path.join(TEST_AREA, `init-nonempty-${TEST_TIMESTAMP}`);
    fs.mkdirSync(nonEmptyDir, { recursive: true });
    fs.writeFileSync(path.join(nonEmptyDir, "existing.txt"), "content");

    // Run init command
    const child = spawnInitCommand({ cwd: nonEmptyDir });

    let stderr = "";
    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    const [exitCode] = await once(child, "exit");

    // Verify failure
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not empty");

    // Clean up
    fs.rmSync(nonEmptyDir, { recursive: true, force: true });
  }, 30_000); // 30 seconds timeout for this test

  test(
    "generated hank can be executed successfully",
    async () => {
      const configPath = path.join(INIT_TEST_DIR, "hank.json");
      const dataDir = path.join(INIT_TEST_DIR, "data");

      // Get a free port for the server
      const port = await getFreePort();

      // Determine command to use - priority: binary > verdaccio > default
      const serverOptions: Parameters<typeof launchHankweave>[0] = {
        configPath,
        dataDir,
        port,
        cwd: INIT_TEST_DIR,
        executionDir: INIT_TEST_DIR,
        reuseTestDirectory: true, // Don't clean the directory - it has our init files
        logPrefix: "[Init E2E]",
      };

      if (binarySetup) {
        // Use binary command override
        serverOptions.commandOverride = getBinaryCommandOverride(binarySetup.binaryPath);
      } else if (needsVerdaccio()) {
        // Use package manager command override
        const commandOverride = getCommandOverride();
        if (commandOverride) {
          serverOptions.commandOverride = commandOverride;
        }
        // Add registry URL to env for verdaccio
        if (verdaccioSetup) {
          serverOptions.env = {
            ...serverOptions.env,
            npm_config_registry: verdaccioSetup.registry.registryURL,
          };
        }
      }

      // Launch server using the data directory created by init
      // Use INIT_TEST_DIR as both cwd (for output files) and execution directory
      const server = await launchHankweave(serverOptions);

      try {
        const readyEvent = (await server.waitForEvent("server.ready")) as ServerReadyEvent;
        const agentRootPath = readyEvent.data.agentRootPath;

        // Wait for the run to complete
        await server.waitForRunToComplete(INIT_RUN_TIMEOUT_MS);

        // Verify that the analysis files were created in the agent workspace
        // With the new default behavior, outputs stay in agentRoot/ instead of being copied to hankweave-results/
        const analysisHaikuFile = path.join(agentRootPath, "analysis-haiku.md");
        expect(fs.existsSync(analysisHaikuFile)).toBe(true);

        const analysisGeminiFile = path.join(agentRootPath, "analysis-gemini.md");
        expect(fs.existsSync(analysisGeminiFile)).toBe(true);

        // Pi analysis file (in-process embedded Pi agent, no binary needed)
        const analysisPiFile = path.join(agentRootPath, "analysis-pi.md");
        expect(fs.existsSync(analysisPiFile)).toBe(true);

        // GPT analysis file (pi/openai-codex — ChatGPT subscription via pi's
        // credential store; CI provisions it from CODEX_AUTH_JSON)
        const analysisGptFile = path.join(agentRootPath, "analysis-gpt.md");
        expect(fs.existsSync(analysisGptFile)).toBe(true);

        // Verify analysis files have content
        const analysisHaikuContent = fs.readFileSync(analysisHaikuFile, "utf-8");
        expect(analysisHaikuContent.length).toBeGreaterThan(0);

        const analysisGeminiContent = fs.readFileSync(analysisGeminiFile, "utf-8");
        expect(analysisGeminiContent.length).toBeGreaterThan(0);

        // Verify pi analysis file has content
        const analysisPiContent = fs.readFileSync(analysisPiFile, "utf-8");
        expect(analysisPiContent.length).toBeGreaterThan(0);

        // Verify gpt analysis file has content
        const analysisGptContent = fs.readFileSync(analysisGptFile, "utf-8");
        expect(analysisGptContent.length).toBeGreaterThan(0);

        // Verify the in-process Pi agent persisted its session transcripts.
        // Only when a codon actually ran on Pi: HANKWEAVE_RUNTIME_MODEL
        // overrides EVERY codon's model (scripts/e2e/test-new-models.ts uses it
        // for new-model smoke runs), and an anthropic/ override routes all
        // codons — including analyze-pi — through the Claude SDK, so no Pi
        // session ever exists.
        const runtimeModelOverride = process.env.HANKWEAVE_RUNTIME_MODEL ?? "";
        const allCodonsOnClaudeSdk = runtimeModelOverride.toLowerCase().startsWith("anthropic/");
        if (!allCodonsOnClaudeSdk) {
          const piSessionsDir = path.join(INIT_TEST_DIR, ".hankweave/logs/pi-sessions");
          expect(fs.existsSync(piSessionsDir)).toBe(true);

          const piSessionFiles = fs
            .readdirSync(piSessionsDir)
            .filter((file) => file.endsWith(".jsonl"));
          expect(piSessionFiles.length).toBeGreaterThan(0);

          // Verify at least one session transcript has content (agent events)
          const sessionPath = path.join(piSessionsDir, piSessionFiles[0]);
          const sessionContent = fs.readFileSync(sessionPath, "utf-8");
          expect(sessionContent.split("\n").filter((line) => line.trim()).length).toBeGreaterThan(
            0,
          );
        }

        // Verify execution metadata contains environment info
        const executionMetaPath = path.join(INIT_TEST_DIR, ".hankweave/execution-meta.json");
        expect(fs.existsSync(executionMetaPath)).toBe(true);

        const executionMeta = JSON.parse(fs.readFileSync(executionMetaPath, "utf-8"));

        // Schema version should be 1.1.0
        expect(executionMeta.version).toBe("1.1.0");

        // Hankweave version should be present
        expect(executionMeta.hankweaveVersion).toBeTruthy();

        // Environment block should be present with all fields
        expect(executionMeta.environment).toBeDefined();
        expect(executionMeta.environment.platform).toBe(process.platform);
        expect(executionMeta.environment.arch).toBe(process.arch);
        expect(executionMeta.environment.osRelease).toBeTruthy();
        expect(executionMeta.environment.runtime).toMatch(/^(bun|node|deno) /);

        // Invocation method should match the test mode
        if (binarySetup) {
          expect(executionMeta.environment.invocationMethod).toBe("binary");
        } else {
          expect(executionMeta.environment.invocationMethod).toBeOneOf(["bun", "node", "deno"]);
        }
      } finally {
        // Clean up server
        await server.stop(10000);
      }
    },
    GENERATED_HANK_TEST_TIMEOUT_MS,
  );
});
