#!/usr/bin/env bun
import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchHankweave, ServerLaunchError } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/** Minimal codon pair for all test hanks. */
const BASE_CODONS = [
  {
    id: "a",
    name: "Codon A",
    promptText: "Say hello",
    model: "haiku",
    continuationMode: "fresh",
  },
  {
    id: "b",
    name: "Codon B",
    promptText: "Say goodbye",
    model: "haiku",
    continuationMode: "fresh",
  },
];

/**
 * Write a hank.json + data.txt to a temp dir, launch via launchHankweave,
 * and expect a ServerLaunchError (validation failure before WebSocket).
 * Returns the error for assertions.
 */
async function expectValidationError(
  hankConfig: Record<string, unknown>,
): Promise<ServerLaunchError> {
  const tmp = path.join(
    os.tmpdir(),
    `hw-budget-val-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  fs.mkdirSync(tmp, { recursive: true });
  tempDirs.push(tmp);

  const hankPath = path.join(tmp, "hank.json");
  const dataPath = path.join(tmp, "data.txt");
  fs.writeFileSync(hankPath, JSON.stringify(hankConfig, null, 2));
  fs.writeFileSync(dataPath, "test data");

  const port = await getFreePort();
  try {
    await launchHankweave({
      configPath: hankPath,
      dataDir: dataPath,
      port,
      logPrefix: "[budget-validation]",
      extraArgs: ["--force"],
    });
    throw new Error("Expected launchHankweave to throw ServerLaunchError, but it succeeded");
  } catch (err) {
    if (err instanceof ServerLaunchError) {
      return err;
    }
    throw err;
  }
}

describe("budget preflight validation errors", () => {
  it("rejects shares summing to more than 1.0", async () => {
    const err = await expectValidationError({
      overrides: {
        budget: {
          maxDollars: 10,
          allocation: "proportional",
          shares: { a: 0.6, b: 0.6 },
        },
      },
      hank: BASE_CODONS,
    });

    expect(err.exitCode).toBe(1);
    expect(err.stderr).toContain("must sum to at most 1.0");
  }, 60_000);

  it("rejects shares referencing unknown child IDs", async () => {
    const err = await expectValidationError({
      overrides: {
        budget: {
          maxDollars: 10,
          allocation: "proportional",
          shares: { nonexistent: 0.5 },
        },
      },
      hank: BASE_CODONS,
    });

    expect(err.exitCode).toBe(1);
    expect(err.stderr).toContain("unknown child IDs");
  }, 60_000);

  it("rejects shares without proportional allocation", async () => {
    const err = await expectValidationError({
      overrides: {
        budget: {
          maxDollars: 10,
          shares: { a: 0.5 },
        },
      },
      hank: BASE_CODONS,
    });

    expect(err.exitCode).toBe(1);
    expect(err.stderr).toContain("requires allocation mode");
  }, 60_000);

  it("rejects proportional allocation without maxDollars", async () => {
    const err = await expectValidationError({
      overrides: {
        budget: {
          allocation: "proportional",
        },
      },
      hank: BASE_CODONS,
    });

    expect(err.exitCode).toBe(1);
    expect(err.stderr).toContain("requires budget.maxDollars");
  }, 60_000);

  // TODO: No validation exists yet for codons with budget.maxDollars whose model
  // can't be priced. The check needs to be implemented in config.ts first.
  // Using an unknown model here would fail on the existing "Invalid model" check,
  // not a budget-specific pricing check — so we can't write a meaningful test yet.
  it.todo("rejects dollar budget on codon with unpriced model", () => {});
});
