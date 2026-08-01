#!/usr/bin/env bun
/**
 * Compaction on/off discriminator for the Claude Agent SDK harness
 * (intermediates/55-compaction-default-off/spec.md).
 *
 * Measured mechanism (CLI 2.1.215): auto-compaction is REACTIVE — the CLI
 * compacts only when the provider rejects a request with the input-overflow
 * 400, then retries on the compacted history. With compaction disabled the
 * same 400 becomes a terminal "Prompt is too long" error result.
 *
 * Both tests drive the SAME mock script through the real manager stack:
 * a setup codon, then a contextExceeded-loop codon that does three bash
 * warmup rounds (builds enough history for the CLI's compactor to have
 * something to trim) and then receives exactly one overflow 400.
 *
 *   autoCompact: true  -> CLI compacts, RETRIES (observable at the mock),
 *                         finishes with a success result; compact_boundary
 *                         lands in the codon log and terminates the loop.
 *   default (off)      -> NO retry ever reaches the mock; the codon ends on
 *                         the error result; the loop terminates through
 *                         isContextExceeded Pattern 2.
 *
 * If the CLI's compaction trigger, retry behavior, or error wording drifts
 * in a future SDK pin, this fails here first — offline — instead of in a
 * production hank.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "bun";
import { type LaunchedServer, launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

const PROMPT_TOO_LONG = "prompt is too long: 214315 tokens > 200000 maximum";
/** Warmup tool rounds before the overflow — enough history to compact. */
const WARMUP_ROUNDS = 3;

interface CompactionScriptedMock {
  server: Server<undefined>;
  port: number;
  /** Mainline (tool-bearing) calls observed, in order. */
  mainlineCalls: () => number;
  /** How many overflow 400s were served (script serves at most one). */
  overflowsServed: () => number;
  /** Mainline calls that arrived AFTER the overflow 400 (the compact-retry). */
  postOverflowCalls: () => number;
}

/**
 * Order-scripted Anthropic Messages mock. Mainline calls are the ones
 * carrying a `tools` array (the CLI's title/summary aux calls don't).
 *
 * Mainline script: 1 setup end_turn, then WARMUP_ROUNDS tool_use rounds,
 * then ONE overflow 400, then end_turn successes forever (the post-compact
 * continuation when compaction is on; unreachable when it is off).
 */
function startCompactionScriptedMock(): CompactionScriptedMock {
  let mainline = 0;
  let overflows = 0;
  let postOverflow = 0;

  const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  const respond = (opts: { toolUse?: string; text?: string }): Response => {
    const usage = { input_tokens: 50 + mainline * 10, output_tokens: 10 };
    const content = opts.toolUse
      ? [
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: `toolu_warm_${mainline}`,
              name: "Bash",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify({ command: opts.toolUse }),
            },
          },
          { type: "content_block_stop", index: 0 },
        ]
      : [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: opts.text ?? "Done." },
          },
          { type: "content_block_stop", index: 0 },
        ];
    const streamBody = [
      sse("message_start", {
        type: "message_start",
        message: {
          id: `msg_mock_${mainline}`,
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      }),
      ...content.map((c) => sse(c.type, c)),
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: opts.toolUse ? "tool_use" : "end_turn", stop_sequence: null },
        usage,
      }),
      sse("message_stop", { type: "message_stop" }),
    ].join("");
    return new Response(streamBody, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  };

  const server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method !== "POST" || !url.pathname.includes("/v1/messages")) {
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "not_found_error", message: "mock: unhandled path" },
          }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      const rawBody = await req.text();
      let hasTools = false;
      try {
        const parsed: unknown = JSON.parse(rawBody);
        hasTools =
          typeof parsed === "object" &&
          parsed !== null &&
          "tools" in parsed &&
          Array.isArray((parsed as { tools: unknown }).tools) &&
          (parsed as { tools: unknown[] }).tools.length > 0;
      } catch {
        // treat as aux
      }
      if (!hasTools) {
        // Title-generation / aux traffic: harmless canned success.
        return respond({ text: "aux" });
      }

      mainline++;
      if (overflows > 0) postOverflow++;

      // Mainline 1: the setup codon's single turn.
      if (mainline === 1) return respond({ text: "Setup done." });
      // Mainlines 2..1+WARMUP_ROUNDS: warmup tool rounds for the loop codon.
      if (mainline <= 1 + WARMUP_ROUNDS) {
        return respond({ toolUse: `echo warm-${mainline}` });
      }
      // Exactly one overflow 400 at the boundary.
      if (overflows === 0) {
        overflows++;
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: PROMPT_TOO_LONG },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      // Post-compaction retry path (reached only when compaction is on).
      return respond({ text: "Loop work finished after compaction." });
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("mock bound without a TCP port");
  return {
    server,
    port,
    mainlineCalls: () => mainline,
    overflowsServed: () => overflows,
    postOverflowCalls: () => postOverflow,
  };
}

/** Write the two-codon hank (setup + contextExceeded loop) to a temp dir. */
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
          model: "haiku",
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
              promptText: "Run bash echo commands until told the work is finished.",
              model: "haiku",
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

/** Find the loop codon's JSONL log under the execution dir. */
function readGenCodonLog(hankDir: string): string {
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === "gen-0-claude.log") hits.push(p);
    }
  };
  walk(hankDir);
  expect(hits.length).toBe(1);
  return fs.readFileSync(hits[0], "utf-8");
}

async function runScenario(opts: { autoCompact?: boolean; logPrefix: string }): Promise<{
  mock: CompactionScriptedMock;
  state: ReturnType<LaunchedServer["getState"]>;
  events: ReturnType<LaunchedServer["getEvents"]>;
  genLog: string;
}> {
  const mock = startCompactionScriptedMock();
  const hankDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-compaction-hank-"));
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
        ANTHROPIC_API_KEY: "sk-ant-test-never-valid",
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`,
      },
    });
    await server.waitForEvent("server.ready", 30_000);
    await server.waitForState((s) => {
      const c = s.runs[0]?.codons.find((x) => x.codonId === "gen#0");
      return c?.status === "completed" || c?.status === "failed";
    }, 120_000);
    // Loop termination decisions land via the async transition queue; wait for
    // the run itself to reach a terminal state before reading the plan.
    await server.waitForState((s) => s.runs[0]?.status !== "running", 30_000);

    const state = server.getState();
    const events = server.getEvents();
    const genLog = readGenCodonLog(hankDir);
    return { mock, state, events, genLog };
  } finally {
    await server?.stop(10_000).catch(() => {});
    mock.server.stop(true);
    fs.rmSync(hankDir, { recursive: true, force: true });
  }
}

describe("claude-sdk compaction on/off against a local mock provider", () => {
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

  test("autoCompact: true — CLI compacts on the overflow 400, retries, and the boundary terminates the loop", async () => {
    const { mock, state, genLog } = await runScenario({
      autoCompact: true,
      logPrefix: "[claude-compact-on]",
    });

    // The overflow was genuinely served, and the CLI came BACK after it —
    // the compact-and-retry that only happens with compaction enabled.
    expect(mock.overflowsServed()).toBe(1);
    expect(mock.postOverflowCalls()).toBeGreaterThan(0);

    // The codon finished its work on the compacted session (success path,
    // not the error path): the post-overflow reply is in the log.
    expect(genLog).toContain("Loop work finished after compaction.");

    // The compact_boundary is in the codon log with the auto trigger —
    // this is isContextExceeded Pattern 3, the loop-termination signal.
    const boundaryLines = genLog
      .split("\n")
      .filter((l) => l.includes('"compact_boundary"') && l.includes('"trigger":"auto"'));
    expect(boundaryLines.length).toBeGreaterThan(0);

    // Codon completed; the loop terminated at this iteration.
    const gen = state.runs[0]?.codons.find((c) => c.codonId === "gen#0");
    expect(gen?.status).toBe("completed");
    expect(state.runs[0]?.codons.some((c) => c.codonId === "gen#1")).toBe(false);
  }, 120_000);

  test("default (compaction off) — the same 400 is terminal: no retry, error result terminates the loop", async () => {
    const { mock, state, events, genLog } = await runScenario({
      logPrefix: "[claude-compact-off]",
    });

    // The overflow was served and NOTHING came after it: no compact-retry.
    // This is the assertion that compaction is actually disabled through the
    // real manager stack, not just unobserved.
    expect(mock.overflowsServed()).toBe(1);
    expect(mock.postOverflowCalls()).toBe(0);

    // No boundary was emitted anywhere.
    expect(genLog).not.toContain('"compact_boundary"');

    // The codon ended on the SDK's error result ("Prompt is too long"),
    // isContextExceeded Pattern 2 matched, and the loop accepted it.
    const gen = state.runs[0]?.codons.find((c) => c.codonId === "gen#0");
    expect(gen?.status).toBe("completed");
    expect(state.runs[0]?.codons.some((c) => c.codonId === "gen#1")).toBe(false);
    const infos = events.filter(
      (e) =>
        e.type === "info" &&
        e.data.message.includes("completed successfully due to context exceeded"),
    );
    expect(infos.length).toBeGreaterThan(0);
  }, 120_000);
});
