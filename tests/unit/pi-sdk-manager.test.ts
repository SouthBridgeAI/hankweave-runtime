/**
 * PiSdkManager unit tests, merged from the former per-concern files
 * (env overlay, in-band failure handling, resume lookup, runtime key
 * injection, setup-failure routing, adaptive watchdog). One top-level
 * describe per concern keeps failure isolation; the file-scope hooks below
 * hold the setup/teardown that was byte-identical across those files, and
 * hooks that differ per concern (env save/restore) stay scoped inside their
 * describe.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { ClaudeLogParser } from "../../server/claude-log-parser.js";
import { createPiModelRuntime } from "../../server/pi-model-catalog.js";
import {
  applyEnvOverlay,
  buildEnvOverlay,
  checkPiModel,
  configureModelRuntime,
  PiSdkManager,
  resolveProviderApiKey,
} from "../../server/pi-sdk-manager.js";
import type { ResultMessage } from "../../server/types/claude-session-schema.js";
import { Logger } from "../../server/utils.js";
import { createTestCodon } from "../utils/test-codon-factory.js";

// Every describe below except the two env-focused ones runs against a real
// tempDir + Logger and must stop its ClaudeLogParser before the dir is
// removed; that setup/teardown was byte-identical across the merged files, so
// it lives here at file scope. mkdtempSync guarantees per-test uniqueness —
// the old Date.now()-suffixed names under tests/test-area collided when two
// tests started within the same millisecond.
let tempDir: string;
let logger: Logger;
let logParser: ClaudeLogParser | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-manager-test-"));
  logger = new Logger(path.join(tempDir, "test.log"));
});

afterEach(async () => {
  logParser?.stop();
  // Each test owns at most one parser; drop the reference so a later test's
  // teardown can't re-stop a parser left over from a different describe.
  logParser = undefined;
  // maxRetries guards Windows EBUSY/EPERM when a failed test leaves the
  // manager's log WriteStream open on a file inside tempDir.
  await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Test doubles for reaching into PiSdkManager internals, matching the access
// pattern used by codon-runner-transient-crash-retry.test.ts. Declared once:
// ManagerInternals is the union of the private members the describes below
// reach for — the in-band/watchdog prompt plumbing plus the resume lookup's
// makeSessionManager. Each cast uses only the members it needs.
type PiEvent = {
  type: string;
  message?: {
    role: string;
    content: unknown[];
    stopReason?: string;
    errorMessage?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total?: number };
    };
  };
};
type FakeSession = {
  sessionId: string;
  subscribe: (cb: (event: PiEvent) => void) => void;
  prompt: (text: string) => Promise<void>;
  dispose: () => void;
  abort: () => void;
};
type ManagerInternals = {
  session: FakeSession;
  sessionId: string;
  logStream: fs.WriteStream;
  startedAt: number;
  killed: boolean;
  subscribe: (session: FakeSession, model: string) => void;
  runPrompt: (
    session: FakeSession,
    prompt: string,
    model: string,
    idleTimeoutSec?: number,
  ) => Promise<void>;
  makeSessionManager: (
    cwd: string,
    resumeId: string | null,
    sessionDir: string,
  ) => Promise<SessionManager>;
};

/**
 * The removed ShimProcessManager built its child env from the server env:
 * HANKWEAVE_-prefixed vars passed through with the prefix stripped
 * (HANKWEAVE_RUNTIME_* / HANKWEAVE_SENTINEL_* excluded, literal "unset"
 * deletes the target var), then codon.env overlaid on top. The in-process
 * PiSdkManager has no child env, so buildEnvOverlay/applyEnvOverlay reproduce
 * that contract at the points the pi session reads an environment (provider
 * credential resolution, bash spawn env). These tests pin the semantics.
 */

const TEST_KEYS = [
  "HANKWEAVE_PI_TEST_FOO",
  "HANKWEAVE_PI_TEST_GONE",
  "HANKWEAVE_RUNTIME_PI_TEST_INTERNAL",
  "HANKWEAVE_SENTINEL_PI_TEST_SECRET",
];

describe("PiSdkManager env overlay", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of TEST_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of TEST_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("strips the HANKWEAVE_ prefix on pass-through", () => {
    process.env.HANKWEAVE_PI_TEST_FOO = "bar";
    const overlay = buildEnvOverlay();
    expect(overlay.set.PI_TEST_FOO).toBe("bar");
  });

  test("excludes HANKWEAVE_RUNTIME_* and HANKWEAVE_SENTINEL_*", () => {
    process.env.HANKWEAVE_RUNTIME_PI_TEST_INTERNAL = "server-config";
    process.env.HANKWEAVE_SENTINEL_PI_TEST_SECRET = "sentinel-key";
    const overlay = buildEnvOverlay();
    expect(overlay.set.RUNTIME_PI_TEST_INTERNAL).toBeUndefined();
    expect(overlay.set.SENTINEL_PI_TEST_SECRET).toBeUndefined();
    expect(overlay.set.PI_TEST_INTERNAL).toBeUndefined();
    expect(overlay.set.PI_TEST_SECRET).toBeUndefined();
  });

  test("literal 'unset' deletes the target var from the base env", () => {
    process.env.HANKWEAVE_PI_TEST_GONE = "unset";
    const overlay = buildEnvOverlay();
    const env = applyEnvOverlay({ PI_TEST_GONE: "was-here", OTHER: "kept" }, overlay);
    expect(env.PI_TEST_GONE).toBeUndefined();
    expect(env.OTHER).toBe("kept");
  });

  test("codon.env overrides both the base env and the pass-through", () => {
    process.env.HANKWEAVE_PI_TEST_FOO = "from-passthrough";
    const overlay = buildEnvOverlay({ PI_TEST_FOO: "from-codon", CODON_ONLY: "yes" });
    const env = applyEnvOverlay({ PI_TEST_FOO: "from-base" }, overlay);
    expect(env.PI_TEST_FOO).toBe("from-codon");
    expect(env.CODON_ONLY).toBe("yes");
  });

  test("codon.env wins over an 'unset' pass-through (shim applied codon.env last)", () => {
    process.env.HANKWEAVE_PI_TEST_GONE = "unset";
    const overlay = buildEnvOverlay({ PI_TEST_GONE: "codon-resurrects" });
    const env = applyEnvOverlay({ PI_TEST_GONE: "base" }, overlay);
    expect(env.PI_TEST_GONE).toBe("codon-resurrects");
  });

  test("applyEnvOverlay does not mutate the base env", () => {
    process.env.HANKWEAVE_PI_TEST_FOO = "bar";
    const base = { EXISTING: "value" };
    const env = applyEnvOverlay(base, buildEnvOverlay());
    expect(env).not.toBe(base);
    expect(base).toEqual({ EXISTING: "value" });
    expect(env.EXISTING).toBe("value");
    expect(env.PI_TEST_FOO).toBe("bar");
  });
});

/**
 * resolveProviderApiKey is the single source of truth for accepted key
 * spellings — the welcome wizard's detection AND credit validation both use
 * it, so a setup can't be reported ready and then fail validation with a
 * different (missing) key. Google standardized on GEMINI_API_KEY (pi's native
 * variable); the legacy GOOGLE_API_KEY alias was removed.
 */
describe("resolveProviderApiKey", () => {
  test("google resolves pi's native GEMINI_API_KEY", () => {
    const env = { GEMINI_API_KEY: "gemini-key" };
    expect(resolveProviderApiKey("google", env)).toBe("gemini-key");
  });

  test("the removed GOOGLE_API_KEY alias is not accepted", () => {
    const env = { GOOGLE_API_KEY: "google-key" };
    expect(resolveProviderApiKey("google", env)).toBeUndefined();
  });

  test("blank values are ignored", () => {
    const env = { GEMINI_API_KEY: "  " };
    expect(resolveProviderApiKey("google", env)).toBeUndefined();
  });

  test("unknown provider and missing keys resolve to undefined", () => {
    expect(resolveProviderApiKey("not-a-provider", {})).toBeUndefined();
    expect(resolveProviderApiKey("google", {})).toBeUndefined();
  });
});

/**
 * Pi surfaces LLM failures IN-BAND: when its internal retries exhaust (or the
 * session is aborted), session.prompt() RESOLVES normally and the failure only
 * shows up as the final assistant message's stopReason ("error"/"aborted") and
 * errorMessage. PiSdkManager.runPrompt used to treat any resolution as success
 * — emitting a success result and exit 0 — which marked the codon complete and
 * bypassed failure-policy handling (onFailure: retry/abort/ignore never fired).
 *
 * Desired contract (this test):
 *  - final stopReason "error"  -> error result carrying pi's errorMessage
 *    (CodonRunner classifies retriability from that text) and exit 1
 *  - final stopReason "aborted" WITHOUT kill() -> error result and exit 1
 *  - final stopReason "aborted" DURING kill()  -> success result and exit 0
 *    (intentional teardown, matching ClaudeAgentSDKManager's killed path)
 *  - final stopReason "stop"   -> success result and exit 0 (unchanged)
 */
describe("PiSdkManager in-band failure handling", () => {
  /**
   * Wires a PiSdkManager around a fake pi session whose prompt() RESOLVES after
   * emitting a final assistant message with the given stopReason/errorMessage,
   * runs the prompt, and returns the exit code plus the logged result message.
   */
  async function runFakeSession(args: {
    stopReason: string;
    errorMessage?: string;
    killDuringPrompt?: boolean;
    usage?: NonNullable<PiEvent["message"]>["usage"];
  }): Promise<{ exitCode: number; result: ResultMessage }> {
    const logPath = path.join(tempDir, `log-${args.stopReason}.jsonl`);
    logParser = new ClaudeLogParser({
      logPath,
      codonId: "pi-inband-test",
      parsingInterval: 100,
    });
    const manager = new PiSdkManager(tempDir, tempDir, logger, logParser);
    const m = manager as unknown as ManagerInternals;

    let subscriber: ((event: PiEvent) => void) | undefined;
    const fakeSession: FakeSession = {
      sessionId: "fake-session",
      subscribe: (cb) => {
        subscriber = cb;
      },
      prompt: async () => {
        if (args.killDuringPrompt) m.killed = true;
        subscriber?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: args.stopReason,
            ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
            ...(args.usage ? { usage: args.usage } : {}),
          },
        });
      },
      dispose: () => {},
      abort: () => {},
    };

    m.session = fakeSession;
    m.sessionId = fakeSession.sessionId;
    m.startedAt = Date.now();
    m.logStream = fs.createWriteStream(logPath);
    m.subscribe(fakeSession, "anthropic/fake-model");

    const exitCodes: number[] = [];
    manager.on("exit", (code: number) => exitCodes.push(code));

    await m.runPrompt(fakeSession, "do the thing", "anthropic/fake-model");

    // Read the log IMMEDIATELY — no settling delay. runPrompt must flush the
    // result line before emitExit(), because emitExit synchronously re-parses
    // the log (extension decisions and failure classification depend on it).
    // Stream writes are ordered, so the flushed result implies earlier lines
    // (assistant messages) are on disk too.
    const lines = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const result = lines.find((msg) => msg.type === "result") as ResultMessage;

    expect(exitCodes).toHaveLength(1);
    expect(result).toBeDefined();
    return { exitCode: exitCodes[0], result };
  }

  test("stopReason 'error' emits error result with pi's errorMessage and exit 1", async () => {
    const { exitCode, result } = await runFakeSession({
      stopReason: "error",
      errorMessage: "429 rate limit exceeded, retries exhausted",
    });

    expect(exitCode).toBe(1);
    expect(result.subtype).toBe("error");
    expect(result.is_error).toBe(true);
    // The real upstream text must survive — CodonRunner classifies retriability
    // (429 -> retriable, auth/billing -> permanent) from this string.
    expect(result.result).toBe("429 rate limit exceeded, retries exhausted");
  });

  test("stopReason 'error' without errorMessage still emits error result and exit 1", async () => {
    const { exitCode, result } = await runFakeSession({ stopReason: "error" });

    expect(exitCode).toBe(1);
    expect(result.subtype).toBe("error");
    expect(result.is_error).toBe(true);
    expect(result.result).toContain("error");
  });

  test("stopReason 'aborted' without kill() emits error result and exit 1", async () => {
    const { exitCode, result } = await runFakeSession({
      stopReason: "aborted",
      errorMessage: "request aborted",
    });

    expect(exitCode).toBe(1);
    expect(result.subtype).toBe("error");
    expect(result.is_error).toBe(true);
  });

  test("stopReason 'aborted' during kill() stays a success exit (intentional teardown)", async () => {
    const { exitCode, result } = await runFakeSession({
      stopReason: "aborted",
      killDuringPrompt: true,
    });

    expect(exitCode).toBe(0);
    expect(result.subtype).toBe("success");
    expect(result.is_error).toBe(false);
  });

  test("stopReason 'stop' emits success result and exit 0", async () => {
    const { exitCode, result } = await runFakeSession({ stopReason: "stop" });

    expect(exitCode).toBe(0);
    expect(result.subtype).toBe("success");
    expect(result.is_error).toBe(false);
  });

  test("result carries aggregate usage so pi's reported cost is applied", async () => {
    const { result } = await runFakeSession({
      stopReason: "stop",
      usage: { input: 100, output: 42, cacheRead: 7, cacheWrite: 3, cost: { total: 0.0123 } },
    });

    // CostTracker.handleResultUsage() discards the whole result — including
    // total_cost_usd — when usage is absent, so for passthrough models missing
    // from the pricing registry a usage-less result zeroes budgets/telemetry.
    expect(result.total_cost_usd).toBeCloseTo(0.0123);
    expect(result.usage).toBeDefined();
    expect(result.usage?.input_tokens).toBe(100);
    expect(result.usage?.output_tokens).toBe(42);
    expect(result.usage?.cache_read_input_tokens).toBe(7);
    expect(result.usage?.cache_creation_input_tokens).toBe(3);
  });

  test("zero pi cost omits total_cost_usd so the registry fallback prices the run", async () => {
    const { result } = await runFakeSession({
      stopReason: "stop",
      usage: { input: 100, output: 42, cost: { total: 0 } },
    });

    // A zero total means pi's catalog had no pricing, not that the turn was
    // free. CostTracker treats any defined total_cost_usd as authoritative and
    // would overwrite the registry-calculated cost with $0 — so the field must
    // be absent while usage stays present for the registry calculation.
    expect(result.total_cost_usd).toBeUndefined();
    expect(result.usage).toBeDefined();
    expect(result.usage?.input_tokens).toBe(100);
    expect(result.usage?.output_tokens).toBe(42);
  });
});

/**
 * A requested Pi resume session MUST be found. The old makeSessionManager
 * silently fell back to SessionManager.create() when the session was absent or
 * unreadable, so a continuation or exhaustion prompt "succeeded" with a blank
 * conversation — no history. The removed pi shim hard-failed on this
 * (StartupError: "Session not found"). Desired contract (these tests):
 *
 *  - resumeId null        -> fresh session (unchanged)
 *  - resumeId not found   -> throw, failing the codon spawn
 *  - resumeId only in the pre-reorg shim dir (.hankweave/logs/shim-debug/
 *    sessions) -> resumed from there instead of starting fresh
 */
describe("PiSdkManager resume session lookup", () => {
  let sessionDir: string;
  let manager: ManagerInternals;

  beforeEach(async () => {
    sessionDir = path.join(tempDir, ".hankweave/logs/pi-sessions");
    await fs.promises.mkdir(sessionDir, { recursive: true });
    logParser = new ClaudeLogParser({
      logPath: path.join(tempDir, "unused.jsonl"),
      codonId: "pi-resume-test",
      parsingInterval: 100,
    });
    manager = new PiSdkManager(tempDir, tempDir, logger, logParser) as unknown as ManagerInternals;
  });

  /**
   * Create a persisted pi session file in the given dir; returns its id.
   * Pi defers writing the session file until an assistant message exists, so
   * one is required for the file to hit disk.
   */
  function persistSession(dir: string): string {
    const sm = SessionManager.create(tempDir, dir);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "earlier conversation" }],
      // Minimal message accepted by pi's persistence layer.
    } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "earlier reply" }],
      // Minimal message accepted by pi's persistence layer.
    } as unknown as Parameters<SessionManager["appendMessage"]>[0]);
    return sm.getSessionId();
  }

  test("no resumeId creates a fresh session", async () => {
    const sm = await manager.makeSessionManager(tempDir, null, sessionDir);
    expect(sm).toBeInstanceOf(SessionManager);
  });

  test("missing resume session throws instead of starting fresh", async () => {
    await expect(
      manager.makeSessionManager(tempDir, "0198c000-dead-7000-beef-000000000000", sessionDir),
    ).rejects.toThrow(/Pi session not found/);
  });

  test("resume session in the current session dir is opened", async () => {
    const id = persistSession(sessionDir);
    const sm = await manager.makeSessionManager(tempDir, id, sessionDir);
    expect(sm.getSessionId()).toBe(id);
  });

  test("resume session only in the pre-reorg shim dir is found and opened", async () => {
    const legacyDir = path.join(tempDir, ".hankweave/logs/shim-debug/sessions");
    await fs.promises.mkdir(legacyDir, { recursive: true });
    const id = persistSession(legacyDir);
    const sm = await manager.makeSessionManager(tempDir, id, sessionDir);
    expect(sm.getSessionId()).toBe(id);
  });
});

/**
 * configureModelRuntime must inject codon-env-only API keys for BUILT-IN pi
 * providers (deepseek, groq, xai, …), not just extension-registered ones.
 * It originally iterated modelRuntime.getRegisteredProviderIds(), which
 * returns only extension registrations — always empty here (hankweave runs
 * pi with noExtensions) — so a key supplied via codon.env / HANKWEAVE_
 * pass-through was never injected and the session fell back to the server's
 * real process.env, failing auth. These tests pin the catalog-wide iteration
 * against a real (offline) ModelRuntime.
 */
describe("configureModelRuntime runtime key injection", () => {
  const savedGroqKey = process.env.GROQ_API_KEY;

  beforeEach(() => {
    delete process.env.GROQ_API_KEY;
  });

  afterEach(() => {
    if (savedGroqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedGroqKey;
  });

  /** Offline runtime isolated from the user's real ~/.pi credential store. */
  function makeRuntime(): Promise<ModelRuntime> {
    return ModelRuntime.create({
      authPath: path.join(tempDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
  }

  test("injects a built-in provider key present only in the effective env", async () => {
    const runtime = await makeRuntime();
    const effectiveEnv = { ...process.env, GROQ_API_KEY: "codon-only-groq-key" };

    await configureModelRuntime(effectiveEnv, runtime);

    // groq is a built-in provider hankweave does not enforce; before the fix
    // the injection loop never visited it and auth stayed unconfigured.
    expect(runtime.getProviderAuthStatus("groq")).toEqual({
      configured: true,
      source: "runtime",
    });
  });

  test("does not inject when the key matches the real process.env", async () => {
    process.env.GROQ_API_KEY = "server-wide-groq-key";
    const runtime = await makeRuntime();

    await configureModelRuntime({ ...process.env }, runtime);

    // Identical values are left to pi's own env-vs-credential-store
    // precedence — no runtime overlay is installed.
    expect(runtime.getProviderAuthStatus("groq").source).not.toBe("runtime");
  });
});

/**
 * A provider the user's models.json defines names its key "$NAME" or
 * "${NAME}"; pi interpolates that from the real process.env only. A key the
 * codon supplies in its env block reaches the in-process session as a
 * runtime key (configureModelRuntime), so checkPiModel's authentication —
 * the same question spawn asks — passes with it and fails without it.
 */
describe("checkPiModel with a models.json provider keyed from the codon env", () => {
  const KEY_VAR = "GW_TEST_KEY";
  const MANAGED = [
    KEY_VAR,
    "PI_CODING_AGENT_DIR",
    "HANKWEAVE_MODEL_CATALOG_DIR",
    "HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS",
  ];
  const savedEnv: Record<string, string | undefined> = {};
  let originalFetch: typeof fetch;
  let requests: string[];

  beforeEach(() => {
    for (const key of MANAGED) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "pi-agent-dir");
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    process.env.HANKWEAVE_MODEL_CATALOG_DIR = path.join(tempDir, "model-catalog");
    process.env.HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS = "1";
    requests = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      throw new Error(`unexpected network request: ${url}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
  });

  /** Write the user's models.json with one gateway provider; returns its (unique) id. */
  function writeGateway(apiKey: string): string {
    const provider = `gw-${Math.random().toString(36).slice(2, 8)}`;
    fs.writeFileSync(
      path.join(process.env.PI_CODING_AGENT_DIR as string, "models.json"),
      JSON.stringify({
        providers: {
          [provider]: {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey,
            models: [{ id: "gw-model", contextWindow: 32_000, maxTokens: 4_096 }],
          },
        },
      }),
    );
    return provider;
  }

  const authentication = (result: Awaited<ReturnType<typeof checkPiModel>>) =>
    result.steps?.find((step) => step.name === "authentication");

  for (const apiKey of [`$${KEY_VAR}`, `\${${KEY_VAR}}`]) {
    test(`apiKey '${apiKey}': a key only in the codon env authenticates`, async () => {
      const provider = writeGateway(apiKey);

      const withKey = await checkPiModel(
        provider,
        "gw-model",
        { ...process.env, [KEY_VAR]: "codon-only-gateway-key" },
        { network: false },
      );
      expect(authentication(withKey)?.passed).toBe(true);
      expect(withKey.ok).toBe(true);

      const without = await checkPiModel(
        provider,
        "gw-model",
        { ...process.env },
        { network: false },
      );
      expect(without).toMatchObject({ ok: false, kind: "no-credentials" });
      expect(authentication(without)?.passed).toBe(false);
      expect(requests).toEqual([]);
    }, 20000);
  }
});

/**
 * runSelfTest runs the same checks as startup model validation
 * (checkPiModel): pi's own credential resolution (ModelRuntime.checkAuth)
 * for every provider, then pi's catalog. Pi refuses a request when its auth
 * resolution finds no credential, so the self-test must ask that same
 * question instead of deferring the failure to the first invoke.
 * PI_CODING_AGENT_DIR isolates pi's credential store from the developer's
 * real ~/.pi; the AWS markers and provider keys are cleared so only what each
 * test sets is visible, and online model checks are off so a catalog miss
 * never asks pi.dev.
 */
describe("PiSdkManager runSelfTest credential and catalog checks", () => {
  const AWS_MARKERS = [
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
  ];
  const PROVIDER_KEYS = [
    "DEEPSEEK_API_KEY",
    "ZAI_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
  ].flatMap((key) => [key, `HANKWEAVE_${key}`]);
  const MANAGED = [
    ...AWS_MARKERS,
    ...PROVIDER_KEYS,
    "PI_CODING_AGENT_DIR",
    "HANKWEAVE_MODEL_CATALOG_DIR",
    "HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS",
  ];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MANAGED) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "pi-agent-dir");
    process.env.HANKWEAVE_MODEL_CATALOG_DIR = path.join(tempDir, "model-catalog");
    process.env.HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS = "1";
  });

  afterEach(() => {
    for (const key of MANAGED) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
  });

  function makeManager(): PiSdkManager {
    logParser = new ClaudeLogParser({
      logPath: path.join(tempDir, "self-test.jsonl"),
      codonId: "pi-self-test",
      parsingInterval: 100,
    });
    return new PiSdkManager(tempDir, tempDir, logger, logParser);
  }

  const check = (result: { checks: { name: string }[] }, name: string) =>
    result.checks.find((c) => c.name === name) as
      | { name: string; passed: boolean; message: string }
      | undefined;

  test("no AWS credentials → authentication check fails with remediation", async () => {
    const result = await makeManager().runSelfTest("amazon-bedrock/deepseek.v3.2");

    const auth = check(result, "authentication");
    expect(auth).toBeDefined();
    expect(auth?.passed).toBe(false);
    expect(auth?.message).toContain("AWS_BEARER_TOKEN_BEDROCK");
    expect(result.overall.passed).toBe(false);
  }, 20000);

  test("bearer token present → authentication passes and names the source", async () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = "test-bearer-token";

    const result = await makeManager().runSelfTest("amazon-bedrock/deepseek.v3.2");

    const auth = check(result, "authentication");
    expect(auth?.passed).toBe(true);
    expect(auth?.message).toContain("AWS_BEARER_TOKEN_BEDROCK");
  }, 20000);

  test("a provider without a key fails authentication, naming its env var and pi's auth store", async () => {
    const result = await makeManager().runSelfTest("deepseek/deepseek-flash");

    expect(check(result, "authentication")).toEqual({
      name: "authentication",
      passed: false,
      message:
        "No credentials for provider 'deepseek' (checked the environment, this codon's env block and Pi's auth store). Set DEEPSEEK_API_KEY, or add the key in Pi's auth store.",
    });
    // Credentials stop the check: the catalog is never consulted.
    expect(check(result, "model_catalog")).toBeUndefined();
    expect(result.overall.passed).toBe(false);
  }, 20000);

  test("a key reached only through the HANKWEAVE_ pass-through counts", async () => {
    process.env.HANKWEAVE_DEEPSEEK_API_KEY = "test-deepseek-key";

    const result = await makeManager().runSelfTest("deepseek/deepseek-flash");

    expect(check(result, "authentication")?.passed).toBe(true);
    expect(result.overall.passed).toBe(true);
  }, 20000);

  test("a key in pi's own auth store counts", async () => {
    const agentDir = process.env.PI_CODING_AGENT_DIR as string;
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "auth.json"),
      JSON.stringify({ deepseek: { type: "api_key", key: "test-deepseek-key" } }),
    );

    const result = await makeManager().runSelfTest("deepseek/deepseek-flash");

    const auth = check(result, "authentication");
    expect(auth?.passed).toBe(true);
    expect(auth?.message).toContain("Credentials for provider 'deepseek'");
  }, 20000);

  // Pi's catalog is the gate spawn actually applies, so a model pi cannot
  // serve (the zai/glm-5.1 class) fails HERE, at startup, not at codon launch.
  test("model_catalog passes for a catalog model", async () => {
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";

    const result = await makeManager().runSelfTest("deepseek/deepseek-flash");

    const catalog = check(result, "model_catalog");
    expect(catalog?.passed).toBe(true);
    expect(catalog?.message).toContain("deepseek/deepseek-flash");
  }, 20000);

  test("model_catalog fails for a model pi cannot serve", async () => {
    process.env.ZAI_API_KEY = "test-zai-key";

    const result = await makeManager().runSelfTest("zai/glm-5.1");

    const catalog = check(result, "model_catalog");
    expect(catalog?.passed).toBe(false);
    expect(catalog?.message).toContain(
      "Pi has no model 'zai/glm-5.1' (checked its catalog; online model checks are off).",
    );
    // Pi's ids are candidates, ranked into the message by Models, not listed here.
    expect(catalog?.message).not.toContain("Pi's zai models");
    expect(result.overall.passed).toBe(false);
  }, 20000);

  test("model_catalog resolves reasoning-effort suffixes to the base model", async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";

    const result = await makeManager().runSelfTest("openai/gpt-5.6-terra-high");

    expect(check(result, "model_catalog")?.passed).toBe(true);
  }, 20000);

  test("model_catalog enforces pi's static openrouter list", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";

    const known = await makeManager().runSelfTest("openrouter/moonshotai/kimi-k3");
    expect(check(known, "model_catalog")?.passed).toBe(true);

    const unknown = await makeManager().runSelfTest("openrouter/some-org/definitely-not-real");
    const catalog = check(unknown, "model_catalog");
    expect(catalog?.passed).toBe(false);
    expect(catalog?.message).toContain("Pi has no model 'openrouter/some-org/definitely-not-real'");
  }, 40000);

  test("a provider pi does not know is named as such, before credentials or the catalog", async () => {
    // Startup rejects such a spelling at stage 0 (no harness runs the
    // provider); called directly, Pi says it has no such provider.
    const result = await makeManager().runSelfTest("nosuchprovider/some-model");

    const auth = check(result, "authentication");
    expect(auth?.passed).toBe(false);
    expect(auth?.message).toContain("Pi has no provider 'nosuchprovider'. Pi's providers: ");
    expect(check(result, "model_catalog")).toBeUndefined();
  }, 20000);
});

/**
 * Pi setup failures (missing credential, unresolvable model) must NOT escape
 * spawn() as exceptions: CodonRunner.run() would rethrow them as an
 * initialization error, which the runtime records as non-retriable and
 * escalates WITHOUT consulting resolveFailurePolicy — so a configured
 * onFailure: "ignore"/"retry" never applies. Desired contract (these tests):
 * spawn() resolves, and the failure arrives asynchronously through the same
 * error-result + exit(1) path as in-band pi failures, carrying the real error
 * text for classification (missing key -> permanent auth failure).
 *
 * The resume-session lookup is deliberately excluded: a missing continuation
 * session still throws from spawn() (see the resume session lookup describe
 * above).
 */
describe("PiSdkManager setup failure routing", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const CLEARED_VARS = [
    "OPENAI_API_KEY",
    "HANKWEAVE_OPENAI_API_KEY",
    "PI_CODING_AGENT_DIR",
    "HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS",
  ];

  beforeEach(() => {
    for (const key of CLEARED_VARS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // An empty pi credential store, and no pi.dev refresh for the lookup.
    process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "pi-agent-dir");
    process.env.HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS = "1";
  });

  afterEach(() => {
    for (const key of CLEARED_VARS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
  });

  test("missing API key resolves spawn() and fails via error result + exit 1", async () => {
    const logPath = path.join(tempDir, "setup-failure.jsonl");
    logParser = new ClaudeLogParser({
      logPath,
      codonId: "pi-setup-failure-test",
      parsingInterval: 100,
    });
    const manager = new PiSdkManager(tempDir, tempDir, logger, logParser);

    const codon = createTestCodon({
      id: "setup-failure",
      name: "Setup failure",
      model: "pi/openai/gpt-5.2",
      continuationMode: "fresh",
      promptText: "irrelevant",
    });

    const exitPromise = new Promise<number>((resolve) => {
      manager.on("exit", (code: number) => resolve(code));
    });
    const errors: Error[] = [];
    manager.on("error", (error: Error) => errors.push(error));

    // The setup failure must NOT throw out of spawn().
    const actualLogPath = await manager.spawn(codon, null, { logPath });
    expect(actualLogPath).toBe(logPath);

    const exitCode = await exitPromise;
    expect(exitCode).toBe(1);
    // Routed through the exit path — never the fatal "error" event.
    expect(errors).toHaveLength(0);
    expect(manager.isRunning()).toBe(false);
    // No session was created, so establishment must read false (a crash
    // before establishment classifies as a local, non-retriable failure —
    // correct for a missing credential).
    expect(manager.getSessionEstablished()).toBe(false);

    const lines = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const result = lines.find((msg) => msg.type === "result") as ResultMessage;
    expect(result).toBeDefined();
    expect(result.is_error).toBe(true);
    // The real error text must survive, naming what is missing and where pi
    // looked; with no session established CodonRunner classifies it as a
    // permanent local setup failure, honoring onFailure policy semantics.
    expect(String(result.result)).toContain(
      "No credentials for provider 'openai' (checked the environment, this codon's env block and Pi's auth store). Set OPENAI_API_KEY",
    );
  }, 15000);
});

/**
 * A model Models adopted into pi's catalog at startup (provenance evidence
 * "adopted from …") lives only in that process's generated models.json. A
 * resumed plan's codon carries the persisted record, so spawn adopts it
 * again — sibling taken from pi's own models — instead of failing with "Pi
 * model not found". Every network request is refused: the session's first
 * prompt never leaves the process, and the test kills it once spawned.
 */
describe("PiSdkManager spawn-time re-adoption", () => {
  // xai: a provider no other test lists the models of. Injected rows last
  // for the process (every test file shares it), so the ids are unique too.
  const MODEL_ID = "grok-spawn-readopt-1";
  const MANAGED = [
    "XAI_API_KEY",
    "HANKWEAVE_XAI_API_KEY",
    "PI_CODING_AGENT_DIR",
    "HANKWEAVE_MODEL_CATALOG_DIR",
    "HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS",
  ];
  const savedEnv: Record<string, string | undefined> = {};
  let originalFetch: typeof fetch;
  let requests: string[];

  beforeEach(() => {
    for (const key of MANAGED) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "pi-agent-dir");
    process.env.HANKWEAVE_MODEL_CATALOG_DIR = path.join(tempDir, "model-catalog");
    process.env.HANKWEAVE_RUNTIME_NO_ONLINE_MODEL_CHECKS = "1";
    process.env.XAI_API_KEY = "xai-test-never-valid";
    requests = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      throw new Error(`unexpected network request: ${url}`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of MANAGED) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
  });

  /** A codon whose (persisted) model pi's catalog lacks, with the given evidence and confidence. */
  function codonWithEvidence(
    evidence: string,
    modelId = MODEL_ID,
    confidence: "user" | "harness" = "user",
  ) {
    const codon = createTestCodon({
      id: "readopt",
      name: "Re-adopt",
      model: "xai/grok-4.3",
      continuationMode: "fresh",
      promptText: "irrelevant",
    });
    codon.model = {
      ...codon.model,
      providerId: "xai",
      modelId,
      name: "Grok Spawn Re-adopt",
      provenance: {
        confidence,
        source: "hank.json models",
        priceStatus: "known",
        evidence,
      },
    };
    return codon;
  }

  function makeManager(logPath: string): PiSdkManager {
    logParser = new ClaudeLogParser({ logPath, codonId: "readopt", parsingInterval: 100 });
    return new PiSdkManager(tempDir, tempDir, logger, logParser);
  }

  test("an adopted model pi lacks is injected again and the session starts", async () => {
    const logPath = path.join(tempDir, "readopt.jsonl");
    const manager = makeManager(logPath);
    expect((await createPiModelRuntime()).getModel("xai", MODEL_ID)).toBeUndefined();

    await manager.spawn(codonWithEvidence("adopted from xai/grok-4.3"), null, {
      logPath,
    });
    const started = manager.isRunning();
    // kill() waits for the aborted prompt, so nothing of it outlives the test.
    await manager.kill();

    expect(started).toBe(true);
    const injected = (await createPiModelRuntime()).getModel("xai", MODEL_ID);
    expect(injected).toMatchObject({ id: MODEL_ID, name: "Grok Spawn Re-adopt" });
    expect(fs.readFileSync(path.join(tempDir, "test.log"), "utf8")).toContain(
      `Injected xai/${MODEL_ID} into pi's catalog`,
    );
    // Only the session's own (refused) model request was attempted: no pi.dev refresh.
    expect(requests.filter((url) => !url.startsWith("https://api.x.ai/"))).toEqual([]);
  }, 20000);

  test("a model pi lacks whose record nothing vouches for fails setup with 'Pi model not found'", async () => {
    const logPath = path.join(tempDir, "not-adopted.jsonl");
    const manager = makeManager(logPath);
    const exit = new Promise<number>((resolve) => manager.on("exit", resolve));

    // Process-wide injected rows persist: a fresh id, never injected.
    // A harness-only record (Pi's own row, now gone): nothing to adopt from.
    await manager.spawn(codonWithEvidence("pi catalog", "grok-spawn-readopt-2", "harness"), null, {
      logPath,
    });

    expect(await exit).toBe(1);
    const result = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
      .find((msg) => msg.type === "result") as ResultMessage;
    expect(String(result.result)).toContain(
      "Pi model not found: grok-spawn-readopt-2 (provider=xai, model=grok-spawn-readopt-2)",
    );
    expect(requests.filter((url) => url.startsWith("https://pi.dev/"))).toEqual([]);
  }, 20000);
});

/**
 * The Pi watchdog must mirror the removed shim's ADAPTIVE timeout, not a flat
 * idle limit: while pi reports a busy step (turn/tool in flight) the limit is
 * max(idleTimeout, 300s), because a legitimate build or test command can emit
 * no events for well over the 120s idle default. And when the watchdog DOES
 * fire, the IdleTimeoutError text must reach the result message — CodonRunner
 * classifies the failure from that text, and the bare "Pi session ended with
 * error" placeholder classifies as a generic API error instead of a timeout.
 */

// Real wall-clock sleep on purpose: this describe exercises PiSdkManager's
// real-timer adaptive watchdog end to end, so fake timers would never let the
// watchdog (or the deadline race below) fire.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("PiSdkManager adaptive watchdog", () => {
  /**
   * Wires a PiSdkManager around a fake pi session, runs the prompt with the
   * given idle timeout, and returns the exit code plus the logged result.
   * The fake prompt() drives events through the captured subscriber.
   */
  async function runWithWatchdog(args: {
    idleTimeoutSec: number;
    prompt: (emit: (event: PiEvent) => void) => Promise<void>;
  }): Promise<{ exitCode: number; result: ResultMessage }> {
    const logPath = path.join(tempDir, `log-${Date.now()}.jsonl`);
    logParser = new ClaudeLogParser({
      logPath,
      codonId: "pi-watchdog-test",
      parsingInterval: 100,
    });
    const manager = new PiSdkManager(tempDir, tempDir, logger, logParser);
    const m = manager as unknown as ManagerInternals;

    let subscriber: ((event: PiEvent) => void) | undefined;
    const emit = (event: PiEvent) => subscriber?.(event);
    const fakeSession: FakeSession = {
      sessionId: "fake-session",
      subscribe: (cb) => {
        subscriber = cb;
      },
      prompt: () => args.prompt(emit),
      dispose: () => {},
      abort: () => {},
    };

    m.session = fakeSession;
    m.sessionId = fakeSession.sessionId;
    m.startedAt = Date.now();
    m.logStream = fs.createWriteStream(logPath);
    m.subscribe(fakeSession, "pi/fake-model");

    const exitCodes: number[] = [];
    manager.on("exit", (code: number) => exitCodes.push(code));

    // The prompt in two of these tests NEVER resolves — the watchdog firing is
    // the only thing that settles runPrompt. If the watchdog misses (the very
    // bug this suite defends against), the bare await would leave a pending
    // promise plus live watchdog timers that outlast bun's per-test timeout;
    // this file once wedged the whole unit suite into its 600s SIGKILL, twice
    // in one run, yielding zero junit. Race a test-owned deadline instead, and
    // tear the manager down on the way out so no timer survives the test.
    const deadline = 8_000;
    try {
      await Promise.race([
        m.runPrompt(fakeSession, "do the thing", "pi/fake-model", args.idleTimeoutSec),
        sleep(deadline).then(() => {
          throw new Error(
            `watchdog did not settle runPrompt within ${deadline}ms — the adaptive watchdog missed`,
          );
        }),
      ]);
    } finally {
      await manager.forceKill().catch(() => {});
    }

    const lines = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const result = lines.find((msg) => msg.type === "result") as ResultMessage;

    expect(exitCodes).toHaveLength(1);
    expect(result).toBeDefined();
    return { exitCode: exitCodes[0], result };
  }

  test("idle silence beyond the limit times out with the timeout text in the result", async () => {
    const { exitCode, result } = await runWithWatchdog({
      idleTimeoutSec: 1,
      // Never emits an event and never resolves — pure silence while idle.
      prompt: () => new Promise<void>(() => {}),
    });

    expect(exitCode).toBe(1);
    expect(result.is_error).toBe(true);
    // The IdleTimeoutError text must survive into the result — CodonRunner's
    // classifyApiErrorText keys the "timeout" failure type off it.
    expect(String(result.result)).toMatch(/Idle timeout/);
  }, 10000);

  test("a busy step (tool in flight) defers the idle limit", async () => {
    const { exitCode, result } = await runWithWatchdog({
      idleTimeoutSec: 1,
      prompt: async (emit) => {
        // Tool starts, then stays silent well past the 1s idle limit — the
        // busy limit (max(idleTimeout, 300s)) must apply instead.
        emit({ type: "tool_execution_start" });
        await sleep(2500);
        emit({
          type: "message_end",
          message: { role: "assistant", content: [], stopReason: "stop" },
        });
      },
    });

    expect(exitCode).toBe(0);
    expect(result.is_error).toBe(false);
  }, 10000);

  test("turn_end settles back to idle enforcement", async () => {
    const { exitCode, result } = await runWithWatchdog({
      idleTimeoutSec: 1,
      prompt: (emit) => {
        emit({ type: "tool_execution_start" });
        emit({ type: "turn_end" });
        // Silence after the turn settled — the plain idle limit applies again.
        return new Promise<void>(() => {});
      },
    });

    expect(exitCode).toBe(1);
    expect(String(result.result)).toMatch(/Idle timeout/);
  }, 10000);
});
