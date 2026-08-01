#!/usr/bin/env bun
/**
 * L1 probe (intermediates/54-context-exceeded-testing/plan.md): what does the
 * REAL Claude SDK surface when the provider rejects a request with Anthropic's
 * input-overflow error — and what does the runtime then do with a
 * `terminateOn: {type: "contextExceeded"}` loop?
 *
 * Mechanism is the claude-sdk-local-mock pattern: a real SDK codon dials a
 * local mock Anthropic endpoint (ANTHROPIC_BASE_URL passthrough + fake key).
 * The mock succeeds the setup codon's calls, then answers every call for the
 * loop codon with the REAL error body the Anthropic API returns when a prompt
 * exceeds the model's context window:
 *
 *   {"type":"error","error":{"type":"invalid_request_error",
 *    "message":"prompt is too long: 214315 tokens > 200000 maximum"}}
 *
 * What this pins (observed against @anthropic-ai/claude-agent-sdk 0.3.215):
 * the SDK does NOT auto-compact past a genuine provider rejection — it
 * normalizes the 400 into an error result reading "Prompt is too long" and
 * then fails the query. `isContextExceeded()` (server/types/types.ts) matches
 * that observed shape, so the loop codon COMPLETES and the loop terminates —
 * input overflow now drives `terminateOn: contextExceeded` exactly like the
 * legacy output-token shapes. If the SDK's wording ever changes, this fails
 * here first, offline, instead of in an 18-hour production hank.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "bun";
import { type LaunchedServer, launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

const PROMPT_TOO_LONG = "prompt is too long: 214315 tokens > 200000 maximum";

/** Handle for the scripted mock: the listening server plus its observability. */
interface ScriptedMockAnthropic {
  server: Server<undefined>;
  /** Every request line the mock saw ("POST /v1/messages"). */
  requests: string[];
  /** How many calls were answered with the input-overflow 400. */
  failedCalls: () => number;
}

/**
 * Mock Anthropic Messages API with per-session scripting: calls whose request
 * body mentions the loop codon's marker get the input-overflow 400; everything
 * else gets a canned end_turn success (so the setup codon completes normally).
 */
function startScriptedMockAnthropic(failMarker: string): ScriptedMockAnthropic {
  const requests: string[] = [];
  let failed = 0;

  const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  const server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      requests.push(`${req.method} ${url.pathname}`);

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
      let model = "claude-haiku-4-5";
      try {
        const parsed: unknown = JSON.parse(rawBody);
        if (parsed && typeof parsed === "object" && "model" in parsed) {
          if (typeof parsed.model === "string") model = parsed.model;
        }
      } catch {
        // keep default model
      }

      // The loop codon's prompt carries the marker; the setup codon's doesn't.
      if (rawBody.includes(failMarker)) {
        failed++;
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: PROMPT_TOO_LONG },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      const streamBody = [
        sse("message_start", {
          type: "message_start",
          message: {
            id: "msg_mock_ok",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 40, output_tokens: 1 },
          },
        }),
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Setup done." },
        }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 7 },
        }),
        sse("message_stop", { type: "message_stop" }),
      ].join("");

      return new Response(streamBody, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });

  return { server, requests, failedCalls: () => failed };
}

describe("claude-sdk input-overflow against a local mock provider", () => {
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

  test("prompt-too-long 400 inside a contextExceeded loop terminates the loop cleanly", async () => {
    const FAIL_MARKER = "FILL_THE_WINDOW_MARKER";
    const { server: mock, requests, failedCalls } = startScriptedMockAnthropic(FAIL_MARKER);
    cleanups.push(() => mock.stop(true));

    const hankDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-ctx-mock-hank-"));
    cleanups.push(() => fs.rmSync(hankDir, { recursive: true, force: true }));
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
                promptText: `${FAIL_MARKER} keep writing until the window is full.`,
                model: "haiku",
                continuationMode: "continue-previous",
              },
            ],
          },
        ],
      }),
    );

    const port = await getFreePort();
    let server: LaunchedServer | undefined;
    try {
      server = await launchHankweave({
        port,
        configPath,
        executionDir: hankDir,
        reuseTestDirectory: true,
        logPrefix: "[claude-ctx-mock]",
        extraArgs: ["--force"],
        env: {
          ANTHROPIC_API_KEY: "sk-ant-test-never-valid",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`,
        },
      });
      await server.waitForEvent("server.ready", 30_000);

      await server.waitForState((s) => {
        const c = s.runs[0]?.codons.find((x) => x.codonId === "setup");
        return c?.status === "completed";
      }, 60_000);

      // The loop codon dials the mock and gets the input-overflow 400 back.
      // Wait for it to reach a terminal state, whichever one that is.
      await server.waitForState((s) => {
        const c = s.runs[0]?.codons.find((x) => x.codonId === "gen#0");
        return c?.status === "completed" || c?.status === "failed";
      }, 90_000);

      const state = server.getState();
      const gen = state.runs[0]?.codons.find((c) => c.codonId === "gen#0");

      // The mock genuinely rejected the loop codon's request(s).
      expect(failedCalls()).toBeGreaterThan(0);
      expect(requests.some((r) => r.includes("/v1/messages"))).toBe(true);

      // The observed input-overflow result ("Prompt is too long") matches
      // isContextExceeded, the loop's terminateOn accepts it, and the codon
      // COMPLETES — the loop terminates at this iteration instead of failing.
      expect(gen?.status).toBe("completed");

      // The runtime narrates the termination.
      const infos = server
        .getEvents()
        .filter(
          (e) =>
            e.type === "info" &&
            e.data.message.includes("completed successfully due to context exceeded"),
        );
      expect(infos.length).toBeGreaterThan(0);

      // Loop terminated at iteration 0: no second iteration was ever planned.
      expect(state.runs[0]?.codons.some((c) => c.codonId === "gen#1")).toBe(false);
    } finally {
      await server?.stop(10_000).catch(() => {});
    }
  }, 120_000);
});
