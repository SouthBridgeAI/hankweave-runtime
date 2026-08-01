#!/usr/bin/env bun
/**
 * Compaction on/off discriminator for the embedded pi harness
 * (intermediates/55-compaction-default-off/spec.md).
 *
 * Pi's compaction is PROACTIVE: after each turn it compares the reported
 * usage against `contextWindow - reserveTokens` and, when a cut point exists
 * (history estimate above `keepRecentTokens`), summarizes via a real LLM
 * call. PiSdkManager now pins compaction with an in-memory settings manager
 * gated on the codon's `autoCompact` field — nothing is read from the
 * developer's ~/.pi/agent/settings.json.
 *
 * Both tests drive the same topology: a contextExceeded loop whose codon
 * resumes one growing session (continue-previous), with the mock reporting
 * over-threshold usage (8000 > 24000 - 16384) and ~30KB replies so the
 * history crosses pi's keepRecentTokens cut-point requirement (20000 tokens
 * estimated at ~4 chars/token) after three iterations.
 *
 *   autoCompact: true  -> pi compacts (the summarization call is observable
 *                         at the mock), pi-translation emits compact_boundary,
 *                         and the loop terminates on it — gracefully, with
 *                         every iteration's work completed.
 *   default (off)      -> no compaction traffic EVER despite the same
 *                         steering; the mock then serves the provider's
 *                         context_length_exceeded 400, which terminates the
 *                         loop through isContextExceeded Pattern 2.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "bun";
import { type LaunchedServer, launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

const FAIL_MARKER = "FILL_THE_WINDOW_MARKER";
const CONTEXT_LENGTH_ERROR =
  "This model's maximum context length is 24000 tokens. However, your messages resulted in 25111 tokens. Please reduce the length of the messages.";
/** First line of pi's SUMMARIZATION_PROMPT — identifies compaction traffic. */
const PI_SUMMARY_MARKER = "context checkpoint summary";
/** ~30KB of reply text per turn: 3 turns cross keepRecentTokens (20000). */
const BIG_REPLY = `chunk of generated context payload. ${"lorem hankweave filler ".repeat(1300)}`;
/** Reported usage: over compaction threshold (24000 - 16384 = 7616). */
const STEERED_PROMPT_TOKENS = 8000;

interface CompactionScriptedMock {
  server: Server<undefined>;
  port: number;
  /** Normal (non-compaction) calls carrying the loop marker. */
  genCalls: () => number;
  /** Compaction/summarization calls observed. */
  compactionCalls: () => number;
  /** Overflow 400s served. */
  failedCalls: () => number;
}

/**
 * OpenAI chat-completions mock.
 * - Compaction traffic (pi's summarization prompt) -> canned summary.
 * - Marker-bearing gen traffic -> BIG steered replies; when `overflowAtCall`
 *   is set, that gen call gets the REAL context_length_exceeded 400 instead.
 * - Everything else (setup codon) -> small canned reply.
 */
function startCompactionScriptedMock(opts: { overflowAtCall?: number }): CompactionScriptedMock {
  let gen = 0;
  let compaction = 0;
  let failed = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      const rawBody = await req.text();

      const chunk = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
      const respond = (text: string, promptTokens: number): Response => {
        const base = {
          id: `chatcmpl-mock-${gen}-${compaction}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "mock-1",
        };
        const body = [
          chunk({
            ...base,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          }),
          chunk({
            ...base,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          }),
          chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
          chunk({
            ...base,
            choices: [],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: 20,
              total_tokens: promptTokens + 20,
            },
          }),
          "data: [DONE]\n\n",
        ].join("");
        return new Response(body, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      };

      // Compaction first: the serialized conversation inside a summarization
      // request also contains the gen marker, so this check must win.
      if (rawBody.includes(PI_SUMMARY_MARKER)) {
        compaction++;
        return respond("## Goal\nSummarized session: generated filler context.", 100);
      }

      if (rawBody.includes(FAIL_MARKER)) {
        gen++;
        if (opts.overflowAtCall !== undefined && gen >= opts.overflowAtCall) {
          failed++;
          return new Response(
            JSON.stringify({
              error: {
                message: CONTEXT_LENGTH_ERROR,
                type: "invalid_request_error",
                param: "messages",
                code: "context_length_exceeded",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return respond(BIG_REPLY, STEERED_PROMPT_TOKENS);
      }

      // Setup codon traffic: small, under every threshold.
      return respond("Setup done.", 40);
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("mock bound without a TCP port");
  return {
    server,
    port,
    genCalls: () => gen,
    compactionCalls: () => compaction,
    failedCalls: () => failed,
  };
}

/** models.json with a small window so steered usage crosses the threshold. */
function writePiDir(mockPort: number): string {
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compaction-agent-"));
  fs.writeFileSync(
    path.join(piDir, "models.json"),
    JSON.stringify({
      providers: {
        mocklocal: {
          baseUrl: `http://127.0.0.1:${mockPort}/v1`,
          api: "openai-completions",
          apiKey: "test-key-never-checked",
          models: [
            {
              id: "mock-1",
              name: "Local Mock Model",
              contextWindow: 24000,
              maxTokens: 4096,
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  return piDir;
}

function writeHank(hankDir: string, opts: { autoCompact?: boolean }): string {
  const configPath = path.join(hankDir, "hank.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      hank: [
        {
          id: "setup",
          name: "Setup",
          promptText: "Reply with exactly: Setup done.",
          model: "pi/mocklocal/mock-1",
          continuationMode: "fresh",
        },
        {
          type: "loop",
          id: "exhaust-loop",
          name: "Exhaust Loop",
          terminateOn: { type: "contextExceeded" },
          codons: [
            {
              id: "gen",
              name: "Generate",
              promptText: `${FAIL_MARKER} keep generating context payload.`,
              model: "pi/mocklocal/mock-1",
              continuationMode: "continue-previous",
              ...(opts.autoCompact !== undefined ? { autoCompact: opts.autoCompact } : {}),
            },
          ],
        },
      ],
    }),
  );
  return configPath;
}

/** Collect gen iteration logs (gen-N-claude.log) under the execution dir. */
function readGenLogs(hankDir: string): Map<number, string> {
  const logs = new Map<number, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        const m = /^gen-(\d+)-claude\.log$/.exec(entry.name);
        if (m) logs.set(Number(m[1]), fs.readFileSync(p, "utf-8"));
      }
    }
  };
  walk(hankDir);
  return logs;
}

async function runScenario(opts: {
  autoCompact?: boolean;
  overflowAtCall?: number;
  logPrefix: string;
}): Promise<{
  mock: CompactionScriptedMock;
  state: ReturnType<LaunchedServer["getState"]>;
  events: ReturnType<LaunchedServer["getEvents"]>;
  genLogs: Map<number, string>;
}> {
  const mock = startCompactionScriptedMock({ overflowAtCall: opts.overflowAtCall });
  const piDir = writePiDir(mock.port);
  const hankDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-compaction-hank-"));
  const configPath = writeHank(hankDir, { autoCompact: opts.autoCompact });

  const port = await getFreePort();
  let server: LaunchedServer | undefined;
  try {
    server = await launchHankweave({
      port,
      configPath,
      executionDir: hankDir,
      reuseTestDirectory: true,
      logPrefix: opts.logPrefix,
      extraArgs: ["--force"],
      env: {
        PI_CODING_AGENT_DIR: piDir,
        PI_OFFLINE: "1",
      },
    });
    await server.waitForEvent("server.ready", 30_000);
    // The loop terminates by contextExceeded (boundary or overflow); wait for
    // the run itself so the final iteration's transitions have landed.
    await server.waitForState((s) => {
      const run = s.runs[0];
      return run !== undefined && run.status !== "running";
    }, 150_000);

    const state = server.getState();
    const events = server.getEvents();
    const genLogs = readGenLogs(hankDir);
    return { mock, state, events, genLogs };
  } finally {
    await server?.stop(10_000).catch(() => {});
    mock.server.stop(true);
    fs.rmSync(hankDir, { recursive: true, force: true });
    fs.rmSync(piDir, { recursive: true, force: true });
  }
}

describe("pi compaction on/off against a local mock provider", () => {
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

  test("autoCompact: true — pi compacts once history crosses the cut point, boundary terminates the loop", async () => {
    const { mock, state, genLogs } = await runScenario({
      autoCompact: true,
      logPrefix: "[pi-compact-on]",
    });

    // The summarization call is the direct proof compaction ran.
    expect(mock.compactionCalls()).toBeGreaterThan(0);
    // And no overflow was ever needed (the mock had none scripted).
    expect(mock.failedCalls()).toBe(0);

    // Every planned iteration completed — compaction is graceful: no work
    // was lost to an error, the boundary simply stopped the loop.
    const run = state.runs[0];
    expect(run?.status).toBe("completed");
    const genCodons = run?.codons.filter((c) => c.codonId.startsWith("gen#")) ?? [];
    expect(genCodons.length).toBeGreaterThan(0);
    for (const codon of genCodons) {
      expect(codon.status).toBe("completed");
    }

    // The LAST iteration's log carries the translated compact_boundary
    // (isContextExceeded Pattern 3) — and it stopped the loop: history
    // estimation is deterministic, so this lands within four iterations.
    expect(genCodons.length).toBeLessThanOrEqual(4);
    const lastIndex = genCodons.length - 1;
    const lastLog = genLogs.get(lastIndex) ?? "";
    expect(lastLog).toContain('"compact_boundary"');
    expect(lastLog).toContain('"trigger":"auto"');
  }, 120_000);

  test("default (compaction off) — identical steering produces zero compaction traffic; the overflow 400 terminates the loop", async () => {
    // Overflow on the 4th gen call: one past where the enabled variant
    // compacts, so "no compaction by then" is a meaningful absence.
    const { mock, state, events, genLogs } = await runScenario({
      overflowAtCall: 4,
      logPrefix: "[pi-compact-off]",
    });

    // The discriminator: same usage steering, same history mass, and pi
    // never attempted a summarization call — compaction was really off.
    expect(mock.compactionCalls()).toBe(0);
    expect(mock.failedCalls()).toBe(1);

    // No boundary anywhere in any iteration's log.
    for (const log of genLogs.values()) {
      expect(log).not.toContain('"compact_boundary"');
    }

    // The overflow iteration completed via Pattern 2 and terminated the loop.
    const run = state.runs[0];
    expect(run?.status).toBe("completed");
    const genCodons = run?.codons.filter((c) => c.codonId.startsWith("gen#")) ?? [];
    expect(genCodons.length).toBe(4);
    for (const codon of genCodons) {
      expect(codon.status).toBe("completed");
    }
    const infos = events.filter(
      (e) =>
        e.type === "info" &&
        e.data.message.includes("completed successfully due to context exceeded"),
    );
    expect(infos.length).toBeGreaterThan(0);
  }, 120_000);
});
