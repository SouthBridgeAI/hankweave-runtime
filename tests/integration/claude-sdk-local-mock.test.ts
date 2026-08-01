#!/usr/bin/env bun
/**
 * A REAL Claude-SDK codon against a LOCAL mock Anthropic endpoint — the second
 * harness's live execution path, offline and keyless. The pi twin is
 * `pi-local-mock.test.ts`; between them, both of hankweave's harnesses now have
 * their full live paths (session setup, streaming, cost accounting, log
 * parsing, state) exercised deterministically with zero provider spend.
 *
 * Mechanism, all pre-existing plumbing:
 * - `--anthropic-base-url` flows config → CodonRunner → ClaudeAgentSDKManager,
 *   which sets `ANTHROPIC_BASE_URL` in the SDK's env. No proxy (off by default),
 *   so the SDK dials the mock directly.
 * - The startup self-test's checks are static (SDK importable, key *present*),
 *   so a fake `ANTHROPIC_API_KEY` passes — the mock never reads it, and if a
 *   bug ever routed a request to the real API, the fake key means a 401, not
 *   spend.
 * - This suite runs keyless under enforcement; the fake key is set explicitly
 *   on the server process, which is the point: no real credential exists here.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type LaunchedServer, launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

const MOCK_REPLY = "MOCK CLAUDE SDK OK";

/**
 * Minimal Anthropic Messages API, streaming one canned end_turn reply.
 * Logs every path it is asked for, so a failing run names what the SDK
 * actually wanted instead of timing out silently.
 */
function startMockAnthropic(): {
  server: ReturnType<typeof Bun.serve>;
  requests: string[];
} {
  const requests: string[] = [];

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
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        );
      }

      const body = (await req.json().catch(() => ({}))) as { stream?: boolean; model?: string };
      const model = body.model ?? "claude-haiku-4-5";
      const usage = { input_tokens: 40, output_tokens: 7 };

      if (!body.stream) {
        return new Response(
          JSON.stringify({
            id: "msg_mock_1",
            type: "message",
            role: "assistant",
            model,
            content: [{ type: "text", text: MOCK_REPLY }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage,
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      const streamBody = [
        sse("message_start", {
          type: "message_start",
          message: {
            id: "msg_mock_1",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: usage.input_tokens, output_tokens: 1 },
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
          delta: { type: "text_delta", text: MOCK_REPLY },
        }),
        sse("content_block_stop", { type: "content_block_stop", index: 0 }),
        sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: usage.output_tokens },
        }),
        sse("message_stop", { type: "message_stop" }),
      ].join("");

      return new Response(streamBody, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    },
  });

  return { server, requests };
}

describe("claude-sdk codon against a local mock provider", () => {
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

  test("runs the real SDK path offline: session, SSE, cost, log parsing", async () => {
    const { server: mock, requests } = startMockAnthropic();
    cleanups.push(() => mock.stop(true));

    const hankDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mock-hank-"));
    cleanups.push(() => fs.rmSync(hankDir, { recursive: true, force: true }));
    const configPath = path.join(hankDir, "hank.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        hank: [
          {
            id: "codon-claude-mock",
            name: "Claude SDK Mock Codon",
            promptText: `Reply with exactly: ${MOCK_REPLY}`,
            model: "haiku",
            continuationMode: "fresh",
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
        logPrefix: "[claude-mock]",
        extraArgs: ["--force"],
        env: {
          // Keyless by enforcement; the SDK only checks presence, the mock never
          // reads it, and the real API would reject it — the safe direction.
          ANTHROPIC_API_KEY: "sk-ant-test-never-valid",
          // Without the proxy (off by default), the `--anthropic-base-url` flag
          // is only the PROXY's upstream and never reaches the SDK. The direct
          // path is the env passthrough: ClaudeAgentSDKManager copies every
          // ANTHROPIC_* var from the server's env into the SDK session env.
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`,
        },
      });
      await server.waitForEvent("server.ready", 30_000);
      await server.waitForRunToComplete(90_000);

      // Wait on state, not the event stream (RunCompleted precedes the final
      // cost transitions being absorbed into state.json).
      await server.waitForState((s) => {
        const c = s.runs[0]?.codons.find((x) => x.codonId === "codon-claude-mock");
        return c?.status === "completed";
      }, 15_000);

      const state = server.getState();
      expect(state.runs[0]?.status).toBe("completed");
      const codon = state.runs[0]?.codons.find((c) => c.codonId === "codon-claude-mock");
      expect(codon?.status).toBe("completed");

      // The mock was genuinely dialed by the SDK — live HTTP path, not replay.
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.some((r) => r.includes("/v1/messages"))).toBe(true);
    } finally {
      await server?.stop(10_000).catch(() => {});
    }
  }, 120_000);
});
