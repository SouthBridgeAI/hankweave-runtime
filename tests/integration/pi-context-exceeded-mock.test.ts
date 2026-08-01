#!/usr/bin/env bun
/**
 * L1 probe, pi half (intermediates/54-context-exceeded-testing/plan.md): what
 * does the embedded Pi agent surface when the provider rejects a request with
 * OpenAI's input-overflow error — and what does the runtime then do with a
 * `terminateOn: {type: "contextExceeded"}` loop?
 *
 * Mechanism is the pi-local-mock pattern (PI_CODING_AGENT_DIR + models.json
 * with a localhost baseUrl, PI_OFFLINE=1). The mock succeeds the setup codon,
 * then answers every call carrying the loop codon's marker with the REAL error
 * body OpenAI-compatible providers return on context overflow:
 *
 *   {"error":{"message":"This model's maximum context length is 128000
 *    tokens. However, your messages resulted in 131111 tokens...",
 *    "type":"invalid_request_error","code":"context_length_exceeded"}}
 *
 * Together with the Claude-side probe (claude-sdk-context-exceeded-mock), this
 * pins the input-overflow shape each harness delivers to the runtime: pi
 * passes the provider's error body through verbatim (the
 * `context_length_exceeded` code survives into the error result), which
 * `isContextExceeded()` matches — so the loop codon COMPLETES and the loop
 * terminates. If pi's error surfacing ever re-words the body, this fails here
 * first, offline.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "bun";
import { type LaunchedServer, launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

const CONTEXT_LENGTH_ERROR =
  "This model's maximum context length is 128000 tokens. However, your messages resulted in 131111 tokens. Please reduce the length of the messages.";

/** Handle for the scripted mock: the listening server plus its observability. */
interface ScriptedMockProvider {
  server: Server<undefined>;
  /** Total chat-completions calls observed. */
  calls: () => number;
  /** How many calls were answered with the context-overflow 400. */
  failedCalls: () => number;
}

/**
 * OpenAI chat-completions mock: requests whose body carries the marker get the
 * context-overflow 400; everything else gets a canned streamed reply.
 */
function startScriptedMockProvider(failMarker: string): ScriptedMockProvider {
  let calls = 0;
  let failed = 0;

  const server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      calls++;

      const rawBody = await req.text();
      if (rawBody.includes(failMarker)) {
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

      const chunk = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
      const base = {
        id: `chatcmpl-mock-${calls}`,
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
          choices: [{ index: 0, delta: { content: "Setup done." }, finish_reason: null }],
        }),
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        chunk({
          ...base,
          choices: [],
          usage: { prompt_tokens: 40, completion_tokens: 7, total_tokens: 47 },
        }),
        "data: [DONE]\n\n",
      ].join("");

      return new Response(body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });

  return { server, calls: () => calls, failedCalls: () => failed };
}

describe("pi input-overflow against a local mock provider", () => {
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

  test("context_length_exceeded 400 inside a contextExceeded loop terminates the loop cleanly", async () => {
    const FAIL_MARKER = "FILL_THE_WINDOW_MARKER";
    const { server: mock, calls, failedCalls } = startScriptedMockProvider(FAIL_MARKER);
    cleanups.push(() => mock.stop(true));

    const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ctx-mock-agent-"));
    cleanups.push(() => fs.rmSync(piDir, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(piDir, "models.json"),
      JSON.stringify({
        providers: {
          mocklocal: {
            baseUrl: `http://127.0.0.1:${mock.port}/v1`,
            api: "openai-completions",
            apiKey: "test-key-never-checked",
            models: [
              {
                id: "mock-1",
                name: "Local Mock Model",
                contextWindow: 128000,
                maxTokens: 4096,
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );

    const hankDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-ctx-mock-hank-"));
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
                promptText: `${FAIL_MARKER} keep writing until the window is full.`,
                model: "pi/mocklocal/mock-1",
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
        logPrefix: "[pi-ctx-mock]",
        extraArgs: ["--force"],
        env: {
          PI_CODING_AGENT_DIR: piDir,
          PI_OFFLINE: "1",
        },
      });
      await server.waitForEvent("server.ready", 30_000);

      await server.waitForState((s) => {
        const c = s.runs[0]?.codons.find((x) => x.codonId === "setup");
        return c?.status === "completed";
      }, 60_000);

      await server.waitForState((s) => {
        const c = s.runs[0]?.codons.find((x) => x.codonId === "gen#0");
        return c?.status === "completed" || c?.status === "failed";
      }, 90_000);

      const state = server.getState();
      const gen = state.runs[0]?.codons.find((c) => c.codonId === "gen#0");

      // The mock genuinely rejected the loop codon's request(s).
      expect(calls()).toBeGreaterThan(1);
      expect(failedCalls()).toBeGreaterThan(0);

      // pi's pass-through error body carries context_length_exceeded, the
      // detector matches it, the loop's terminateOn accepts it → completed,
      // loop terminated at this iteration.
      expect(gen?.status).toBe("completed");
      expect(state.runs[0]?.codons.some((c) => c.codonId === "gen#1")).toBe(false);

      const infos = server
        .getEvents()
        .filter(
          (e) =>
            e.type === "info" &&
            e.data.message.includes("completed successfully due to context exceeded"),
        );
      expect(infos.length).toBeGreaterThan(0);
    } finally {
      await server?.stop(10_000).catch(() => {});
    }
  }, 120_000);
});
