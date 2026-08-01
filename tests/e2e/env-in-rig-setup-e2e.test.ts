#!/usr/bin/env bun
/**
 * E2E test demonstrating that codon `env` variables are NOT available
 * to `rigSetup` commands on the same codon.
 *
 * Bug: When a codon defines an `env` block, those variables are only
 * injected into the Claude/shim process environment (via buildEnvironment
 * in shim-process-manager.ts). The `runCommand()` method in
 * hankweave-runtime.ts spawns rigSetup commands without passing the
 * codon's env, so shell expansions like ${MY_VAR} resolve to empty strings.
 *
 * This test SHOULD PASS once the bug is fixed. Currently it FAILS.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CodonCompletedEvent, ServerReadyEvent } from "../../server/schemas/event-schemas.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

describe("Env variables in rigSetup commands", () => {
  it("should make codon env variables available to rigSetup commands", async () => {
    const configPath = "tests/config/test-env-in-rig-setup.config.json";
    const port = await getFreePort();

    const hankweave = await launchHankweave({
      configPath,
      port,
      logPrefix: "[env-in-rig-setup]",
    });

    try {
      // Wait for server ready
      const readyEvent = (await hankweave.waitForEvent("server.ready")) as ServerReadyEvent;
      const agentRootPath = readyEvent.data.agentRootPath;

      // Wait for codon to complete
      await hankweave.waitForCodonStart("env-rig-test");
      const completedEvent = (await hankweave.waitForCodonCompletion(
        "env-rig-test",
        undefined,
        120_000,
      )) as CodonCompletedEvent;

      expect(completedEvent.data.success).toBe(true);

      // Wait for run to complete
      await hankweave.waitForRunToComplete(60_000);

      // Check the file written by the rigSetup command
      const resultPath = path.join(agentRootPath, "env_test", "result.txt");
      expect(fs.existsSync(resultPath)).toBe(true);

      const content = fs.readFileSync(resultPath, "utf-8").trim();
      console.log(`[env-in-rig-setup] result.txt content: "${content}"`);

      // This is the key assertion: env vars from the codon's `env` block
      // should be available to rigSetup commands on the same codon.
      // Currently fails because runCommand() doesn't pass codon env to spawn().
      expect(content).toBe("MY_VAR=hello-world");

      await hankweave.waitForConnectionClose(15_000);
    } finally {
      if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
        await hankweave.stop();
      }
    }
  }, 180_000); // 3 minute timeout
});
