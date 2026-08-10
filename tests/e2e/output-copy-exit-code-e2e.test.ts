#!/usr/bin/env bun
/**
 * E2E regression for output-stage failures silently exiting 0.
 *
 * Symptom: a codon's model turn succeeds, then an outputFiles.beforeCopy (or
 * copy) step fails. The failure was only routed through handleError at
 * OPERATION severity — logged and emitted, but the run was never marked failed
 * and no shutdown was triggered. The runtime then reached the "all codons
 * completed" shutdown and the headless process exited 0 despite the validator
 * failure, so CI green-lit runs whose outputs never materialized.
 *
 * These tests exercise the whole contract end to end: the REAL CLI runs in
 * --headless mode, a single haiku codon runs against the live API, and the
 * assertion is on the actual process exit code after the process shuts itself
 * down.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { generateTestTimestamp, getFreePort } from "../utils/test-helpers.js";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_AREA = path.join(TEST_ROOT, "tests/test-area");

const RUN_TIMEOUT_MS = 240_000;

interface HeadlessRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  runStatus: string | undefined;
  outputDir: string;
}

describe("E2E: output-stage failures must exit the headless process non-zero", () => {
  const cleanups: Array<() => void> = [];

  afterAll(() => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // best-effort
      }
    }
  });

  /**
   * Run one full headless execution: a single live haiku codon whose
   * outputFiles group runs `beforeCopyCommand` and then copies result.txt.
   * Resolves when the server process exits BY ITSELF — the exit code is the
   * value under test.
   */
  const runHeadlessHank = async (beforeCopyCommand: string): Promise<HeadlessRunResult> => {
    fs.mkdirSync(TEST_AREA, { recursive: true });
    const hankDir = fs.mkdtempSync(
      path.join(TEST_AREA, `output-exit-e2e-${generateTestTimestamp()}-`),
    );
    cleanups.push(() => fs.rmSync(hankDir, { recursive: true, force: true }));

    const outputDir = path.join(hankDir, "output");
    fs.mkdirSync(outputDir, { recursive: true });

    const dataPath = path.join(hankDir, "input.txt");
    fs.writeFileSync(dataPath, "test input\n");

    const configPath = path.join(hankDir, "hank.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        hank: [
          {
            id: "emit-outputs",
            name: "Emit outputs",
            promptText: "Reply with exactly: OK. Do not use any tools.",
            model: "haiku",
            continuationMode: "fresh",
            outputFiles: [
              {
                copy: ["result.txt"],
                beforeCopy: [
                  {
                    type: "command",
                    command: { run: beforeCopyCommand, workingDirectory: "project" },
                  },
                ],
              },
            ],
          },
        ],
      }),
    );

    const port = await getFreePort();
    const server = await launchHankweave({
      port,
      configPath,
      dataDir: dataPath,
      executionDir: path.join(hankDir, "execution"),
      reuseTestDirectory: true,
      logPrefix: "[output-exit-e2e]",
      extraArgs: ["--headless", "--output", outputDir, "--force", "-y"],
    });

    try {
      // The headless process must exit on its own — its exit code is the
      // value under test.
      const { exitCode, signalCode } = await server.waitForExit(RUN_TIMEOUT_MS);

      return {
        exitCode,
        signal: signalCode,
        runStatus: server.getState().runs[0]?.status,
        outputDir,
      };
    } finally {
      // No-op when the process already exited; terminates it if the wait
      // timed out so a hung run doesn't wedge the suite.
      await server.stop(10_000).catch(() => server.kill().catch(() => {}));
    }
  };

  test(
    "failing beforeCopy exits 1 and marks the run failed",
    async () => {
      const result = await runHeadlessHank("exit 1");

      expect(result.signal).toBeNull();
      expect(result.exitCode).toBe(1);
      expect(result.runStatus).toBe("failed");
      // Fail-fast: the copy stage must not have run.
      expect(fs.existsSync(path.join(result.outputDir, "result.txt"))).toBe(false);
    },
    RUN_TIMEOUT_MS + 30_000,
  );

  test(
    "passing beforeCopy exits 0 and copies outputs",
    async () => {
      const result = await runHeadlessHank("echo ok > result.txt");

      expect(result.signal).toBeNull();
      expect(result.exitCode).toBe(0);
      expect(result.runStatus).toBe("completed");
      expect(fs.existsSync(path.join(result.outputDir, "result.txt"))).toBe(true);
    },
    RUN_TIMEOUT_MS + 30_000,
  );
});
