#!/usr/bin/env bun
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { generateTestTimestamp, getFreePort } from "../utils/test-helpers.js";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_AREA = path.join(TEST_ROOT, "tests/test-area");
const TEST_TIMESTAMP = generateTestTimestamp();

function writeDataFile(dir: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "data.txt");
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("--ignore-data-mismatch relink behavior", () => {
  test("resuming with new data should relink read_only_data_source", async () => {
    // This test covers a subtle resume bug:
    // - An execution directory stores metadata including a data hash.
    // - On resume, if the current data hash differs, `--ignore-data-mismatch`
    //   lets the run continue and updates metadata to the *new* data path/hash.
    // - However, the execution directory still contains `read_only_data_source`
    //   (a symlink or copy created on the first run). When resuming, the
    //   relink step is skipped unless the execution is treated as "new".
    // Result: the run keeps using the *old* data even though metadata now
    // claims the new data, which is misleading and can produce incorrect
    // results. This test asserts that resuming with --ignore-data-mismatch
    // recreates `read_only_data_source` so it points at the new data path.
    fs.mkdirSync(TEST_AREA, { recursive: true });

    const executionDir = path.join(TEST_AREA, `data-mismatch-exec-${TEST_TIMESTAMP}`);
    const dataDirA = path.join(TEST_AREA, `data-mismatch-a-${TEST_TIMESTAMP}`);
    const dataDirB = path.join(TEST_AREA, `data-mismatch-b-${TEST_TIMESTAMP}`);

    const dataPathA = writeDataFile(dataDirA, "alpha");
    const dataPathB = writeDataFile(dataDirB, "bravo");
    const port = await getFreePort();

    const firstServer = await launchHankweave({
      port,
      executionDir,
      dataDir: dataPathA,
    });

    try {
      await firstServer.waitForEvent("server.ready", 30_000);
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await firstServer.stop();
    }

    const secondServer = await launchHankweave({
      port,
      executionDir,
      dataDir: dataPathB,
      reuseTestDirectory: true,
      extraArgs: ["--ignore-data-mismatch"],
    });

    try {
      await secondServer.waitForEvent("server.ready", 30_000);

      const linkedDataPath = path.join(
        executionDir,
        "read_only_data_source",
        path.basename(dataPathB),
      );
      const linkedContents = fs.readFileSync(linkedDataPath, "utf-8").trim();

      expect(linkedContents).toBe("bravo");
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      await secondServer.stop();
    }
  }, 120_000);
});
