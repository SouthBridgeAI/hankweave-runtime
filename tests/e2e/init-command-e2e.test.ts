#!/usr/bin/env bun
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateTestTimestamp } from "../utils/test-helpers.js";

// Test configuration
const TEST_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const TEST_AREA = path.join(TEST_ROOT, "tests/test-area");
const TEST_TIMESTAMP = generateTestTimestamp();
const INIT_TEST_DIR = path.join(TEST_AREA, `init-test-${TEST_TIMESTAMP}`);

describe("init command e2e", () => {
  beforeAll(() => {
    // Create test area directory
    if (!fs.existsSync(TEST_AREA)) {
      fs.mkdirSync(TEST_AREA, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test directory
    if (fs.existsSync(INIT_TEST_DIR)) {
      fs.rmSync(INIT_TEST_DIR, { recursive: true, force: true });
    }
  });

  test("init command creates all required files", async () => {
    // Create empty directory for init
    fs.mkdirSync(INIT_TEST_DIR, { recursive: true });

    // Run init command
    const serverEntry = path.join(TEST_ROOT, "server/index.ts");
    const child = spawn("bun", [serverEntry, "--init"], {
      cwd: INIT_TEST_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });

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

    // Verify success
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Initialized Strandweave project");

    // Verify files were created
    expect(fs.existsSync(path.join(INIT_TEST_DIR, "strand.json"))).toBe(true);
    expect(fs.existsSync(path.join(INIT_TEST_DIR, "prompts/analyze.md"))).toBe(true);
    expect(fs.existsSync(path.join(INIT_TEST_DIR, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(INIT_TEST_DIR, "README.md"))).toBe(true);

    // Verify strand.json is valid JSON and has expected structure
    const strandContent = fs.readFileSync(path.join(INIT_TEST_DIR, "strand.json"), "utf-8");
    const strandConfig = JSON.parse(strandContent);

    expect(strandConfig).toHaveProperty("meta");
    expect(strandConfig).toHaveProperty("recommendations");
    expect(strandConfig).toHaveProperty("strand");
    expect(Array.isArray(strandConfig.strand)).toBe(true);
    expect(strandConfig.strand.length).toBeGreaterThan(0);

    // Verify first codon has required fields
    const firstCodon = strandConfig.strand[0];
    expect(firstCodon).toHaveProperty("id");
    expect(firstCodon).toHaveProperty("name");
    expect(firstCodon).toHaveProperty("model");
    expect(firstCodon).toHaveProperty("continuationMode");
  });

  test("init command fails in non-empty directory", async () => {
    // Create directory with a file
    const nonEmptyDir = path.join(TEST_AREA, `init-nonempty-${TEST_TIMESTAMP}`);
    fs.mkdirSync(nonEmptyDir, { recursive: true });
    fs.writeFileSync(path.join(nonEmptyDir, "existing.txt"), "content");

    // Run init command
    const serverEntry = path.join(TEST_ROOT, "server/index.ts");
    const child = spawn("bun", [serverEntry, "--init"], {
      cwd: nonEmptyDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
  });

  test("generated strand can be executed successfully", async () => {
    // Create a simple data file for the workflow to analyze
    const dataFile = path.join(INIT_TEST_DIR, "sample-data.txt");
    fs.writeFileSync(
      dataFile,
      "This is a sample data file for testing the init workflow.\nIt contains some text to analyze.",
    );

    const configPath = path.join(INIT_TEST_DIR, "strand.json");
    const serverEntry = path.join(TEST_ROOT, "server/index.ts");

    // Spawn server directly with correct data path
    // Don't specify --execution, let the server create its own execution directory
    const child = spawn(
      "bun",
      [serverEntry, "--basic", `--config=${configPath}`, `--data=${dataFile}`, "--port=7888"],
      {
        cwd: INIT_TEST_DIR,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let completed = false;

    child.stdout?.on("data", (data) => {
      const text = data.toString();
      console.log(`[Init E2E] ${text.trim()}`);

      // Check if codon completed
      if (text.includes("Codon completed") || text.includes('"type":"codon.completed"')) {
        completed = true;
      }
    });

    child.stderr?.on("data", (data) => {
      const text = data.toString();
      console.error(`[Init E2E ERROR] ${text.trim()}`);
    });

    // Wait for completion or timeout
    const timeout = 120000; // 2 minutes
    const startTime = Date.now();

    while (!completed && Date.now() - startTime < timeout) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check if process exited
      if (child.exitCode !== null) {
        break;
      }
    }

    // Wait a bit more for file operations to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Kill process if still running
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }

    // Verify that the analysis file was created in strandweave-results
    const resultsDir = path.join(INIT_TEST_DIR, "strandweave-results");
    expect(fs.existsSync(resultsDir)).toBe(true);

    const analysisFile = path.join(resultsDir, "analysis.md");
    expect(fs.existsSync(analysisFile)).toBe(true);

    // Verify analysis file has content
    const analysisContent = fs.readFileSync(analysisFile, "utf-8");
    expect(analysisContent.length).toBeGreaterThan(0);
  }, 150000); // 2.5 minute timeout for this test
});
