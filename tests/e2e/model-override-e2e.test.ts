#!/usr/bin/env bun
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CodonCompletedEvent, ServerReadyEvent } from "../../server/schemas/event-schemas.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

describe("Model Override E2E Test", () => {
  it("should override all codon models to haiku when --model haiku is passed", async () => {
    const configPath = "tests/config/test-model-override.config.json";
    const port = await getFreePort();

    // Launch server with --model haiku flag to override all codon models
    const hankweave = await launchHankweave({
      configPath,
      port,
      logPrefix: "[model-override-test]",
      commandOverride: {
        command: "bun",
        args: ["server/index.ts", "--model", "haiku"],
      },
    });

    try {
      // Wait for server ready
      const readyEvent = (await hankweave.waitForEvent("server.ready")) as ServerReadyEvent;
      const executionPath = readyEvent.data.executionPath;

      // Expected codons (in order):
      // 1. codon-1 (configured as opus, should run as haiku)
      // 2. codon-a#0 (configured as sonnet, should run as haiku)
      // 3. codon-b#0 (configured as opus, should run as haiku)
      // 4. codon-a#1 (configured as sonnet, should run as haiku)
      // 5. codon-b#1 (configured as opus, should run as haiku)
      // 6. codon-2 (configured as sonnet, should run as haiku)

      const expectedCodons = [
        "codon-1",
        "codon-a#0",
        "codon-b#0",
        "codon-a#1",
        "codon-b#1",
        "codon-2",
      ];

      const expectedLogFiles = [
        "codon-1-claude.log",
        "codon-a-0-claude.log",
        "codon-b-0-claude.log",
        "codon-a-1-claude.log",
        "codon-b-1-claude.log",
        "codon-2-claude.log",
      ];

      let lastTimestamp: string | undefined;

      // Wait for all codons to complete
      for (const expectedCodonId of expectedCodons) {
        await hankweave.waitForCodonStart(
          expectedCodonId,
          lastTimestamp,
          300_000, // 5 minute timeout
        );

        const completedEvent = (await hankweave.waitForCodonCompletion(
          expectedCodonId,
          lastTimestamp,
          300_000, // 5 minute timeout
        )) as CodonCompletedEvent;

        expect(completedEvent.data.success).toBe(true);
        lastTimestamp = completedEvent.timestamp;
      }

      // Wait for the run to complete
      await hankweave.waitForRunToComplete(10_000);

      // Get the run ID to locate log files
      const finalState = hankweave.getState();
      const currentRun = finalState.runs[0];
      expect(currentRun).toBeDefined();
      const runId = currentRun.runId;

      // Verify all codons ran successfully
      expect(currentRun.status).toBe("completed");
      expect(currentRun.codons.length).toBe(6);

      // Check that all output files were created
      const outputDir = path.join(executionPath, "output");
      expect(fs.existsSync(outputDir)).toBe(true);

      const outputFiles = fs.readdirSync(outputDir);
      expect(outputFiles).toContain("step1.txt");
      expect(outputFiles).toContain("final.txt");
      expect(outputFiles.filter((f) => f.startsWith("loop_a_")).length).toBe(2);
      expect(outputFiles.filter((f) => f.startsWith("loop_b_")).length).toBe(2);

      // CRITICAL TEST: Verify all codons used haiku model by checking log files
      const runFolder = path.join(executionPath, ".hankweave", "runs", runId);
      expect(fs.existsSync(runFolder)).toBe(true);

      console.log("\n📋 Verifying model override in log files...");

      for (const logFile of expectedLogFiles) {
        const logPath = path.join(runFolder, logFile);
        expect(fs.existsSync(logPath)).toBe(true);

        // Read the log file (JSONL format)
        const logContent = fs.readFileSync(logPath, "utf-8");
        const lines = logContent.trim().split("\n");

        // Line 2 (index 1) contains the init message with model info
        expect(lines.length).toBeGreaterThanOrEqual(2);

        const initLine = lines[1];
        const initMessage = JSON.parse(initLine);

        // Verify it's the init message
        expect(initMessage.type).toBe("system");
        expect(initMessage.subtype).toBe("init");

        // CRITICAL ASSERTION: Model should be haiku
        expect(initMessage.model).toBeDefined();
        expect(initMessage.model).toContain("haiku");

        console.log(`  ✓ ${logFile}: model = ${initMessage.model}`);
      }

      console.log("\n✅ All codons correctly used haiku model despite different config settings\n");

      // Server will shutdown automatically, wait for connection close
      await hankweave.waitForConnectionClose(5000);
    } finally {
      // Only stop if server is still running
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 600_000); // 10 minute timeout
});
