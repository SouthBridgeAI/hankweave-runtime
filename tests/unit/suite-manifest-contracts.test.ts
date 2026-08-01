/**
 * Pins the two structural contracts the suite runner leans on:
 *
 * 1. Key enforcement — `buildSuiteEnv` grants a suite exactly the provider
 *    keys it declared (`needsEnv` gates+grants, `optionalEnv` grants) and
 *    strips every other `PROVIDER_KEY_ENV_VARS` entry, so an undeclared
 *    provider dependency fails where it lies instead of silently spending.
 *
 * 2. Manifest invariants — the free tiers are enforced-$0 structurally:
 *    no `needsEnv`, `estCostUsd === 0`, every declared key is a real
 *    provider key, and every listed file exists.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSuiteEnv, costFromStateFile } from "../../scripts/test-suite.js";
import { DEFAULT_TIERS, PROVIDER_KEY_ENV_VARS, resolveSuites, SUITES } from "../suite-manifest.js";

const ROOT = path.resolve(import.meta.dir, "../..");

describe("key enforcement (buildSuiteEnv)", () => {
  // A base env carrying every provider key plus an unrelated variable.
  const baseEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", UNRELATED: "kept" };
    for (const key of PROVIDER_KEY_ENV_VARS) env[key] = `secret-${key}`;
    return env;
  };

  test("declared needsEnv keys survive; undeclared provider keys are deleted", () => {
    const env = buildSuiteEnv({ needsEnv: ["ANTHROPIC_API_KEY"] }, baseEnv());
    expect(env.ANTHROPIC_API_KEY).toBe("secret-ANTHROPIC_API_KEY");
    for (const key of PROVIDER_KEY_ENV_VARS) {
      if (key === "ANTHROPIC_API_KEY") continue;
      expect(env).not.toHaveProperty(key);
    }
  });

  test("a suite declaring nothing gets no provider keys at all", () => {
    const env = buildSuiteEnv({}, baseEnv());
    for (const key of PROVIDER_KEY_ENV_VARS) {
      expect(env).not.toHaveProperty(key);
    }
    // Non-provider vars pass through untouched.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.UNRELATED).toBe("kept");
  });

  test("optionalEnv grants pass-through without gating", () => {
    const env = buildSuiteEnv({ optionalEnv: ["GEMINI_API_KEY"] }, baseEnv());
    expect(env.GEMINI_API_KEY).toBe("secret-GEMINI_API_KEY");
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");

    // Optional means optional: a missing key is not conjured up.
    const sparse = buildSuiteEnv({ optionalEnv: ["GEMINI_API_KEY"] }, { PATH: "/usr/bin" });
    expect(sparse).not.toHaveProperty("GEMINI_API_KEY");
  });

  test("HANKWEAVE_SENTINEL_ aliases are stripped with their bare key", () => {
    // The provider registry PREFERS the sentinel alias over the bare key, and
    // CI exports both from the same secret — stripping only the bare form
    // leaves a free suite able to make billable calls through the alias.
    const withAliases = (): NodeJS.ProcessEnv => {
      const env = baseEnv();
      for (const key of PROVIDER_KEY_ENV_VARS) {
        env[`HANKWEAVE_SENTINEL_${key}`] = `sentinel-${key}`;
      }
      return env;
    };

    const keyless = buildSuiteEnv({}, withAliases());
    for (const key of PROVIDER_KEY_ENV_VARS) {
      expect(keyless).not.toHaveProperty(key);
      expect(keyless).not.toHaveProperty(`HANKWEAVE_SENTINEL_${key}`);
    }

    // Declaring the bare key grants both forms — they name the same provider.
    const granted = buildSuiteEnv({ needsEnv: ["ANTHROPIC_API_KEY"] }, withAliases());
    expect(granted.ANTHROPIC_API_KEY).toBe("secret-ANTHROPIC_API_KEY");
    expect(granted.HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY).toBe("sentinel-ANTHROPIC_API_KEY");
    expect(granted).not.toHaveProperty("HANKWEAVE_SENTINEL_GEMINI_API_KEY");

    // optionalEnv grants the pair the same way.
    const optional = buildSuiteEnv({ optionalEnv: ["GEMINI_API_KEY"] }, withAliases());
    expect(optional.HANKWEAVE_SENTINEL_GEMINI_API_KEY).toBe("sentinel-GEMINI_API_KEY");
    expect(optional).not.toHaveProperty("HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY");
  });

  test("suite.env overrides win over the base environment", () => {
    const env = buildSuiteEnv({ env: { UNRELATED: "overridden", EXTRA: "added" } }, baseEnv());
    expect(env.UNRELATED).toBe("overridden");
    expect(env.EXTRA).toBe("added");
  });

  test("HANKWEAVE_RUNTIME_LOG_PARSING_INTERVAL defaults to 100 but suite.env can override", () => {
    const defaulted = buildSuiteEnv({}, baseEnv());
    expect(defaulted.HANKWEAVE_RUNTIME_LOG_PARSING_INTERVAL).toBe("100");

    // Even an ambient value in the parent shell is overridden by the default.
    const ambient = buildSuiteEnv(
      {},
      {
        ...baseEnv(),
        HANKWEAVE_RUNTIME_LOG_PARSING_INTERVAL: "1000",
      },
    );
    expect(ambient.HANKWEAVE_RUNTIME_LOG_PARSING_INTERVAL).toBe("100");

    const overridden = buildSuiteEnv(
      { env: { HANKWEAVE_RUNTIME_LOG_PARSING_INTERVAL: "250" } },
      baseEnv(),
    );
    expect(overridden.HANKWEAVE_RUNTIME_LOG_PARSING_INTERVAL).toBe("250");
  });
});

describe("spend metering (costFromStateFile)", () => {
  const writeState = (state: unknown): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-spend-"));
    const statePath = path.join(dir, "state.json");
    fs.writeFileSync(statePath, JSON.stringify(state));
    return statePath;
  };

  test("sentinel spend counts alongside the codon's own cost", () => {
    // state-manager persists sentinel charges as codon.sentinels.totalCost,
    // NOT inside finalCost/partialCost — the meter must sum both or every
    // report and --max-cost check underreports real dollars.
    const now = new Date().toISOString();
    const statePath = writeState({
      runs: [
        {
          codons: [
            { startTime: now, finalCost: 0.5, sentinels: { executed: 2, totalCost: 0.25 } },
            { startTime: now, partialCost: 0.1 },
          ],
        },
      ],
    });
    expect(costFromStateFile(statePath, Date.now() - 60_000)).toBeCloseTo(0.85, 10);
  });

  test("codons started before the window are excluded, sentinels included", () => {
    const statePath = writeState({
      runs: [
        {
          codons: [
            {
              startTime: new Date(Date.now() - 3_600_000).toISOString(),
              finalCost: 5,
              sentinels: { executed: 1, totalCost: 5 },
            },
            { startTime: new Date().toISOString(), finalCost: 0.2 },
          ],
        },
      ],
    });
    expect(costFromStateFile(statePath, Date.now() - 60_000)).toBeCloseTo(0.2, 10);
  });
});

describe("manifest invariants", () => {
  test("suite ids are unique", () => {
    const seen = new Set<string>();
    for (const suite of SUITES) {
      expect(seen.has(suite.id)).toBe(false);
      seen.add(suite.id);
    }
  });

  test("every files entry exists on disk", () => {
    for (const suite of SUITES) {
      for (const entry of suite.files) {
        expect(fs.existsSync(path.join(ROOT, entry))).toBe(true);
      }
    }
  });

  test("free tiers are free structurally: $0 and no needsEnv", () => {
    const free = new Set<string>(DEFAULT_TIERS);
    for (const suite of SUITES) {
      if (!free.has(suite.tier)) continue;
      expect(suite.estCostUsd).toBe(0);
      expect(suite.needsEnv ?? []).toEqual([]);
    }
  });

  test("every needsEnv/optionalEnv entry is a known provider key", () => {
    const known = new Set<string>(PROVIDER_KEY_ENV_VARS);
    for (const suite of SUITES) {
      for (const key of [...(suite.needsEnv ?? []), ...(suite.optionalEnv ?? [])]) {
        expect(known.has(key)).toBe(true);
      }
    }
  });

  test("estSeconds > 0 and suiteTimeoutSeconds > estSeconds", () => {
    for (const suite of SUITES) {
      expect(suite.estSeconds).toBeGreaterThan(0);
      expect(suite.suiteTimeoutSeconds).toBeGreaterThan(suite.estSeconds);
    }
  });

  test("every suite carries substantive triage metadata (failureMeans)", () => {
    // failureMeans feeds results.jsonl and triage.md when a suite fails — a
    // missing or one-word entry turns the triage report back into "go read
    // the log". Substantive = at least a sentence.
    for (const suite of SUITES) {
      expect(suite.failureMeans.trim().length).toBeGreaterThan(60);
    }
  });

  test("every suspects path exists on disk", () => {
    // Suspects are triage starting points; a renamed server module must not
    // leave triage pointing at a ghost.
    for (const suite of SUITES) {
      for (const suspect of suite.suspects ?? []) {
        expect(fs.existsSync(path.join(ROOT, suspect))).toBe(true);
      }
    }
  });

  test("resolveSuites over the default tiers returns only $0 suites", () => {
    const suites = resolveSuites({ tiers: DEFAULT_TIERS });
    expect(suites.length).toBeGreaterThan(0);
    for (const suite of suites) {
      expect(suite.estCostUsd).toBe(0);
    }
  });

  test("filter treats commas as OR — CI's smoke job selects its exact suite pair", () => {
    const suites = resolveSuites({
      tiers: ["e2e-live", "e2e-heavy"],
      filter: "e2e-happy-path,e2e-llm-provider-health",
    });
    expect(suites.map((s) => s.id).sort()).toEqual(["e2e-happy-path", "e2e-llm-provider-health"]);
  });
});
