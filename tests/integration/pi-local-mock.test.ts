#!/usr/bin/env bun
/**
 * A REAL pi codon against a LOCAL mock provider — the live execution path,
 * offline, keyless, deterministic.
 *
 * Everything the replay tier bypasses runs for real here: PiSdkManager session
 * setup, pi's ModelRuntime + OpenAI client, HTTP + SSE parsing, usage/cost
 * aggregation, and pi-translation into claude-session-schema JSONL that the
 * runtime's log parser consumes. The only fake is the far end of the wire.
 *
 * Mechanism (no production code involved):
 * - `PI_CODING_AGENT_DIR` points pi's config root at a temp dir whose
 *   `models.json` defines provider `mocklocal` with
 *   `baseUrl: http://127.0.0.1:<port>/v1` and `api: "openai-completions"`.
 *   Custom providers from models.json are first-class in pi's ModelRuntime.
 * - `PI_OFFLINE=1` disables pi's remote catalog refresh — true zero-network.
 * - The codon model `pi/mocklocal/mock-1` passes hankweave validation because
 *   `pi` is a passthrough provider, and skips the credential gate because
 *   `mocklocal` is not credential-enforced.
 *
 * This also isolates the test from the developer's real `~/.pi` credential
 * store, which the default ModelRuntime would otherwise read.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type LaunchedServer, launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort } from "../utils/test-helpers.js";

const MOCK_REPLY = "MOCK PROVIDER OK";

/** Minimal OpenAI chat-completions endpoint, streaming one canned reply. */
function startMockProvider(): { server: ReturnType<typeof Bun.serve>; requests: number[] } {
  const requests: number[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      requests.push(Date.now());

      const chunk = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
      const id = `chatcmpl-mock-${requests.length}`;
      const created = Math.floor(Date.now() / 1000);
      const base = { id, object: "chat.completion.chunk", created, model: "mock-1" };

      const body = [
        chunk({
          ...base,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        }),
        chunk({
          ...base,
          choices: [{ index: 0, delta: { content: MOCK_REPLY }, finish_reason: null }],
        }),
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        // Usage chunk (OpenAI emits it with empty choices when requested; pi's
        // cost accounting reads it). Non-zero numbers make cost assertions real.
        chunk({
          ...base,
          choices: [],
          usage: { prompt_tokens: 40, completion_tokens: 7, total_tokens: 47 },
        }),
        "data: [DONE]\n\n",
      ].join("");

      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
      });
    },
  });
  return { server, requests };
}

describe("pi codon against a local mock provider", () => {
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

  test("runs the real execution path offline: session, SSE, cost, translation", async () => {
    const { server: mock, requests } = startMockProvider();
    cleanups.push(() => mock.stop(true));

    // pi config root: models.json defining the local provider
    const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mock-agent-"));
    cleanups.push(() => fs.rmSync(piDir, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(piDir, "models.json"),
      JSON.stringify(
        {
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
                  // Non-zero pricing so pi's usage→cost math produces a number
                  // the runtime must carry through to state.
                  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
        null,
        2,
      ),
    );

    // Hank config: one codon on the mock model
    const hankDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mock-hank-"));
    cleanups.push(() => fs.rmSync(hankDir, { recursive: true, force: true }));
    const configPath = path.join(hankDir, "hank.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        hank: [
          {
            id: "codon-mock",
            name: "Mock Provider Codon",
            promptText: `Reply with exactly: ${MOCK_REPLY}`,
            model: "pi/mocklocal/mock-1",
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
        logPrefix: "[pi-mock]",
        extraArgs: ["--force"],
        // The mock codon finishes in ~1s, so autostart reliably beats this
        // client's handshake and the assistant.action event below would be
        // broadcast to nobody (measured: 2 of 4 in-suite runs). Backfill is
        // safe here — the execution dir is a fresh mkdtemp, so the journal
        // contains only this run.
        sendPreviousEvents: true,
        env: {
          PI_CODING_AGENT_DIR: piDir,
          PI_OFFLINE: "1",
        },
      });
      await server.waitForEvent("server.ready", 30_000);
      await server.waitForRunToComplete(60_000);

      // RunCompleted arrives on the event stream before state.json necessarily
      // absorbs the final transitions (CodonFinalCostSet lands via the async
      // transition queue and a debounced disk write). Wait for the *state* to
      // show the finished codon with its cost — the disk file is the contract
      // here, not the event ordering.
      await server.waitForState((s) => {
        const c = s.runs[0]?.codons.find((x) => x.codonId === "codon-mock");
        return c?.status === "completed" && c.finalCost > 0;
      }, 15_000);

      const state = server.getState();
      const run = state.runs[0];
      expect(run.status).toBe("completed");
      const codon = run.codons.find((c) => c.codonId === "codon-mock");
      expect(codon?.status).toBe("completed");

      // The mock was genuinely dialed — this is the live HTTP path, not replay.
      expect(requests.length).toBeGreaterThan(0);

      // Cost flowed from the mock's usage chunk through pi's accounting into
      // runtime state: 40 in × $1/M + 7 out × $2/M — tiny but strictly > 0.
      // (`finalCost` lives only on the completed variant of the union, and the
      // status assertion above already proved we are on it.)
      const finalCost = codon?.status === "completed" ? codon.finalCost : 0;
      expect(finalCost).toBeGreaterThan(0);

      // pi-translation produced claude-schema JSONL the log parser accepted,
      // and the assistant text survived the whole pipeline.
      const events = server.getEvents();
      const assistant = events.filter(
        (e) => e.type === "assistant.action" && JSON.stringify(e.data).includes(MOCK_REPLY),
      );
      expect(assistant.length).toBeGreaterThan(0);
    } finally {
      await server?.stop(10_000).catch(() => {});
    }
  }, 120_000);
});
