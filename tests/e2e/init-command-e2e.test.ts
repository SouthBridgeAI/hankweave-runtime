#!/usr/bin/env bun
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { launchStrandweave } from "../utils/strandweave-server-test-helpers.js";
import { generateTestTimestamp, getFreePort } from "../utils/test-helpers.js";

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
    // if (fs.existsSync(INIT_TEST_DIR)) {
    //   fs.rmSync(INIT_TEST_DIR, { recursive: true, force: true });
    // }
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
    expect(stdout).toContain("Initialized strand");

    // Verify files were created
    expect(fs.existsSync(path.join(INIT_TEST_DIR, "strand.json"))).toBe(true);
    expect(fs.existsSync(path.join(INIT_TEST_DIR, "prompts/analyze.md"))).toBe(true);
    expect(fs.existsSync(path.join(INIT_TEST_DIR, ".gitignore"))).toBe(true);
    expect(fs.existsSync(path.join(INIT_TEST_DIR, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(INIT_TEST_DIR, "data/sample1.txt"))).toBe(true);
    expect(fs.existsSync(path.join(INIT_TEST_DIR, "data/sample2.txt"))).toBe(true);
    expect(fs.existsSync(path.join(INIT_TEST_DIR, "data/notes.txt"))).toBe(true);

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
    const configPath = path.join(INIT_TEST_DIR, "strand.json");
    const dataDir = path.join(INIT_TEST_DIR, "data");

    // Get a free port for the server
    const port = await getFreePort();

    // Launch server using the data directory created by init
    // Use INIT_TEST_DIR as both cwd (for output files) and execution directory
    const server = await launchStrandweave({
      configPath,
      dataDir,
      port,
      cwd: INIT_TEST_DIR,
      executionDir: INIT_TEST_DIR,
      reuseTestDirectory: true, // Don't clean the directory - it has our init files
      logPrefix: "[Init E2E]",
    });

    try {
      // Wait for the run to complete
      await server.waitForRunToComplete(120000);

      // Verify that the analysis file was created in strandweave-results
      const resultsDir = path.join(INIT_TEST_DIR, "strandweave-results");
      expect(fs.existsSync(resultsDir)).toBe(true);

      const analysisFile = path.join(resultsDir, "analysis.md");
      expect(fs.existsSync(analysisFile)).toBe(true);

      // Verify analysis file has content
      const analysisContent = fs.readFileSync(analysisFile, "utf-8");
      expect(analysisContent.length).toBeGreaterThan(0);
    } finally {
      // Clean up server
      await server.stop(10000);
    }
  }, 150000); // 2.5 minute timeout for this test
});
