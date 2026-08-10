#!/usr/bin/env bun
/**
 * AWS Bedrock auth-scheme acceptance matrix (internal e2e — see
 * intermediates/57-bedrock-support/research.md, "Acceptance criteria").
 *
 * One hank (tests/config/test-bedrock-auth.config.json) exercises both
 * runtimes and both model families per run:
 *   haiku-agent-sdk  — Anthropic-on-Bedrock, unprefixed → Claude Agent SDK
 *   haiku-pi         — same model, explicit pi/ override → pi
 *   deepseek-pi      — non-Anthropic Bedrock model → pi
 *
 * The run is repeated once per credential scheme, with EVERY other credential
 * source stripped so a green cell can only come from the scheme under test:
 *   A. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (SigV4 key pair)
 *   B. AWS_PROFILE — a credentials file derived from the key pair at runtime
 *   C. AWS_BEARER_TOKEN_BEDROCK (long-term Bedrock API key; the suite maps
 *      BEDROCK_API_KEY to it — product code does no such aliasing)
 * plus a negative control (no credentials → the first codon must FAIL, with
 * the mapped Bedrock remediation in its failure; this cell is what proves the
 * isolation of the other three).
 *
 * Cells self-skip when their source credential is absent from the runner env
 * ("when enabled" semantics — the suite runs whatever the environment can
 * support). Isolation per cell: strip all AWS vars, point the AWS config/
 * credentials files at nonexistent paths (else a dev machine's ~/.aws default
 * profile masks a broken scheme — HOME is inherited), and disable IMDS so
 * instance roles can't leak in on EC2-hosted CI.
 */

import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CodonCompletedEvent, ServerReadyEvent } from "../../server/schemas/event-schemas.js";
import { launchHankweave, ServerLaunchError } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

const CONFIG_PATH = "tests/config/test-bedrock-auth.config.json";
const REGION = process.env.AWS_REGION ?? "us-east-1";

/**
 * Binary mode: point HANKWEAVE_BEDROCK_TEST_BINARY at a compiled hankweave
 * executable to run the matrix against it instead of `bun server/index.ts` —
 * the compiled shape is what catches lazy-import registration bugs (pi loads
 * its bedrock provider through a bundler-opaque specifier; see
 * setBedrockProviderModule in server/pi-sdk-manager.ts).
 */
const BINARY_PATH = process.env.HANKWEAVE_BEDROCK_TEST_BINARY;
const commandOverride = BINARY_PATH ? { command: path.resolve(BINARY_PATH), args: [] } : undefined;

/** codon id → substring the codon log's system-init `model` field must carry.
 * The Agent SDK reports the bare Bedrock id; pi reports the "amazon-bedrock/…"
 * pi model string — which is exactly the routing assertion. */
const EXPECTED_CODONS: Array<{ id: string; logFile: string; initModel: string }> = [
  {
    id: "haiku-agent-sdk",
    logFile: "haiku-agent-sdk-claude.log",
    initModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  },
  {
    id: "haiku-pi",
    logFile: "haiku-pi-claude.log",
    initModel: "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
  },
  {
    id: "deepseek-pi",
    logFile: "deepseek-pi-claude.log",
    // deepseek.v3.2, not R1: R1 on Bedrock rejects toolConfig ("This model
    // doesn't support tool use") so it can never serve a coding-agent codon.
    initModel: "amazon-bedrock/deepseek.v3.2",
  },
];

/** Every env var that could smuggle AWS credentials into a cell — including
 * the Agent-managed gateway pair: a host-configured
 * CLAUDE_CODE_SKIP_BEDROCK_AUTH would pass preflight (and route the child to
 * a credential-holding gateway) with no scheme credentials at all. */
const AWS_CREDENTIAL_VARS = [
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "BEDROCK_API_KEY",
];

// Source credentials from the runner env (before any stripping).
const KEY_PAIR =
  process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY }
    : undefined;
const BEARER_TOKEN = process.env.AWS_BEARER_TOKEN_BEDROCK ?? process.env.BEDROCK_API_KEY;

const schemeTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bedrock-auth-e2e-"));

// Empty Claude config dir per suite: the real user settings.json may define
// awsAuthRefresh/awsCredentialExport helpers, which preflight (and the Agent
// SDK child) would accept as a credential source outside the scheme under
// test.
const claudeConfigDir = path.join(schemeTmpDir, "claude-config");
fs.mkdirSync(claudeConfigDir);

// The profile scheme writes the real long-lived key pair into
// derived-credentials under this dir — never leave that on disk, pass or fail.
afterAll(() => {
  fs.rmSync(schemeTmpDir, { recursive: true, force: true });
});

/**
 * Compose a cell's environment: shared isolation + the scheme's injected
 * credentials. launchHankweave applies `env` on top of process.env and then
 * deletes `unsetEnv` keys, so anything injected must not appear in unsetEnv.
 */
function schemeEnv(inject: Record<string, string>): {
  env: Record<string, string>;
  unsetEnv: string[];
} {
  const env: Record<string, string> = {
    AWS_REGION: REGION,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_SHARED_CREDENTIALS_FILE: path.join(schemeTmpDir, "no-such-credentials"),
    AWS_CONFIG_FILE: path.join(schemeTmpDir, "no-such-config"),
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    ...inject,
  };
  return { env, unsetEnv: AWS_CREDENTIAL_VARS.filter((key) => !(key in env)) };
}

/** Scheme B derives a real profile file from the key pair. */
function profileScheme(): { env: Record<string, string>; unsetEnv: string[] } {
  if (!KEY_PAIR) throw new Error("profileScheme requires the key pair");
  const credentialsFile = path.join(schemeTmpDir, "derived-credentials");
  fs.writeFileSync(
    credentialsFile,
    `[hankweave-e2e]\naws_access_key_id = ${KEY_PAIR.id}\naws_secret_access_key = ${KEY_PAIR.secret}\n`,
    { mode: 0o600 },
  );
  return schemeEnv({
    AWS_PROFILE: "hankweave-e2e",
    AWS_SHARED_CREDENTIALS_FILE: credentialsFile,
  });
}

/**
 * Launch the bedrock hank under a scheme env and assert the full happy path.
 *
 * sentinelFires: sentinels accept only explicit env credentials (bearer /
 * key pair — @aws-sdk/credential-providers is deliberately not bundled), so
 * the AWS_PROFILE scheme expects the bedrock-probe sentinel to be SKIPPED
 * while every codon still completes — the documented codon/sentinel
 * asymmetry, asserted rather than tolerated.
 */
async function runSchemeToCompletion(
  schemeName: string,
  cellEnv: { env: Record<string, string>; unsetEnv: string[] },
  sentinelFires = true,
): Promise<void> {
  const port = await getFreePort();
  const hankweave = await launchHankweave({
    configPath: CONFIG_PATH,
    port,
    logPrefix: `[bedrock-${schemeName}]`,
    env: cellEnv.env,
    unsetEnv: cellEnv.unsetEnv,
    commandOverride,
  });

  try {
    const readyEvent = (await hankweave.waitForEvent("server.ready")) as ServerReadyEvent;
    const executionPath = readyEvent.data.executionPath;
    const agentRootPath = readyEvent.data.agentRootPath;

    let lastTimestamp: string | undefined;
    for (const { id } of EXPECTED_CODONS) {
      await hankweave.waitForCodonStart(id, lastTimestamp, 300_000);
      const completed = (await hankweave.waitForCodonCompletion(
        id,
        lastTimestamp,
        300_000,
      )) as CodonCompletedEvent;
      expect(completed.data.success).toBe(true);
      lastTimestamp = completed.timestamp;
    }

    await hankweave.waitForRunToComplete(60_000);

    const finalState = hankweave.getState();
    const currentRun = finalState.runs[0];
    expect(currentRun).toBeDefined();
    expect(currentRun.status).toBe("completed");

    // Every codon wrote its file.
    for (const { id } of EXPECTED_CODONS) {
      const outputFile = path.join(agentRootPath, `${id}.txt`);
      expect(fs.existsSync(outputFile)).toBe(true);
    }

    // Sentinel assertion: the bedrock-probe sentinel (attached to the
    // haiku-agent-sdk codon) runs its LLM calls through the AI SDK
    // amazon-bedrock provider — a third code path independent of both codon
    // runtimes. Its continuous log existing and holding at least one entry
    // proves a Bedrock-hosted sentinel model actually fired under this
    // credential scheme; for codon-only schemes the log's ABSENCE proves the
    // sentinel was skipped without harming the run.
    const sentinelLog = path.join(
      executionPath,
      ".hankweave",
      "sentinels",
      "outputs",
      "bedrock-probe",
      "bedrock-probe.log",
    );
    if (sentinelFires) {
      expect(fs.existsSync(sentinelLog)).toBe(true);
      const sentinelEntries = fs.readFileSync(sentinelLog, "utf-8").trim().split("\n");
      expect(sentinelEntries.length).toBeGreaterThan(0);
      expect(sentinelEntries[0].length).toBeGreaterThan(0);
      console.log(
        `  ✓ [${schemeName}] sentinel bedrock-probe fired (${sentinelEntries.length} entries)`,
      );
    } else {
      expect(fs.existsSync(sentinelLog)).toBe(false);
      console.log(`  ✓ [${schemeName}] sentinel bedrock-probe skipped (codon-only credentials)`);
    }

    // Routing assertion: the system-init `model` in each codon log proves
    // which runtime ran it (bare Bedrock id = Agent SDK; amazon-bedrock/… =
    // pi model string).
    const runFolder = path.join(executionPath, ".hankweave", "runs", currentRun.runId);
    for (const { logFile, initModel } of EXPECTED_CODONS) {
      const logPath = path.join(runFolder, logFile);
      expect(fs.existsSync(logPath)).toBe(true);
      const entries = fs
        .readFileSync(logPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((e) => !(e.type === "system" && e.subtype === "hook_response"));
      const initMessage = entries[0];
      expect(initMessage.type).toBe("system");
      expect(initMessage.subtype).toBe("init");
      expect(initMessage.model).toBe(initModel);
      console.log(`  ✓ [${schemeName}] ${logFile}: model = ${initMessage.model}`);
    }
  } finally {
    if (hankweave.process.exitCode === null && hankweave.process.signalCode === null) {
      await hankweave.stop();
    }
  }
}

describe("Bedrock auth-scheme acceptance matrix", () => {
  it.skipIf(!KEY_PAIR)(
    "scheme A: key pair (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY)",
    async () => {
      if (!KEY_PAIR) throw new Error("unreachable");
      await runSchemeToCompletion(
        "keypair",
        schemeEnv({ AWS_ACCESS_KEY_ID: KEY_PAIR.id, AWS_SECRET_ACCESS_KEY: KEY_PAIR.secret }),
      );
    },
    900_000,
  );

  it.skipIf(!KEY_PAIR)(
    "scheme B: AWS_PROFILE (credentials file derived from the key pair; sentinel skips — codon-only source)",
    async () => {
      await runSchemeToCompletion("profile", profileScheme(), false);
    },
    900_000,
  );

  it.skipIf(!BEARER_TOKEN)(
    "scheme C: bearer token (AWS_BEARER_TOKEN_BEDROCK)",
    async () => {
      if (!BEARER_TOKEN) throw new Error("unreachable");
      await runSchemeToCompletion("bearer", schemeEnv({ AWS_BEARER_TOKEN_BEDROCK: BEARER_TOKEN }));
    },
    900_000,
  );

  it("negative control: no credentials → startup self-test fails with mapped Bedrock guidance", async () => {
    // With zero AWS credential sources, the startup self-test must refuse
    // to start the server AND say how to fix it — the spec's fail-early
    // requirement. A successful launch here means credentials leaked in
    // from somewhere and every green cell above is meaningless.
    const cellEnv = schemeEnv({});
    const port = await getFreePort();
    let startupError: unknown;
    try {
      const hankweave = await launchHankweave({
        configPath: CONFIG_PATH,
        port,
        logPrefix: "[bedrock-negative]",
        env: cellEnv.env,
        unsetEnv: cellEnv.unsetEnv,
        commandOverride,
      });
      await hankweave.stop();
    } catch (error) {
      startupError = error;
    }

    expect(startupError).toBeDefined();
    // The launch helper throws ServerLaunchError with the server's stderr —
    // the mapped guidance lives there ("Self-test failed for 1 model(s): …").
    expect(startupError).toBeInstanceOf(ServerLaunchError);
    const stderr = (startupError as ServerLaunchError).stderr;
    expect(stderr).toContain("Self-test failed");
    expect(stderr).toContain("No AWS credentials found for Bedrock");
    expect(stderr).toContain("AWS_BEARER_TOKEN_BEDROCK");
  }, 600_000);
});
