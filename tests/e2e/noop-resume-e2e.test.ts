#!/usr/bin/env bun
/**
 * E2E for issue #231: rerunning an already-completed execution must SAY so.
 *
 * Without --start-new, `hankweave --execution <dir>` resumes the execution. If
 * every codon already completed, the runtime creates an empty continuation run,
 * finds nothing to start, and exits 0 after a 2s timer — historically with no
 * console output in headless mode, indistinguishable from a successful fresh
 * run. The fix prints, once, on stdout:
 *
 *   Resumed completed execution <id> — nothing to do. All codons already
 *   completed. Use --start-new to run fresh.
 *
 * Contract exercised here through the REAL CLI, not runtime internals:
 *
 * 1. Run 1 completes a full two-codon execution as a plain `--headless`
 *    subprocess — offline and keyless via the local mock provider seam from
 *    tests/integration/pi-local-mock.test.ts (`PI_CODING_AGENT_DIR` models.json
 *    defines provider `mocklocal` against an in-test HTTP server; `PI_OFFLINE=1`
 *    keeps pi off the network; `pi/mocklocal/mock-1` passes hankweave's model
 *    validation and self-test with zero API keys).
 * 2. Run 2 reruns the SAME execution directory the same way: it must exit 0 and
 *    print the notice exactly once, naming the execution and the --start-new
 *    escape hatch.
 * 3. The completing run itself (run 1) must NOT print the notice — it only
 *    fires on the no-op rerun.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { generateTestTimestamp, getFreePort } from "../utils/test-helpers.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_AREA = path.join(PROJECT_ROOT, "tests", "test-area");

const NOOP_MARKER = "nothing to do";
const OLD_MESSAGE = "All codons completed successfully";
const MOCK_REPLY = "MOCK PROVIDER OK";

// Each spawn is one CLI boot ending in the runtime's 2s shutdown timer; the
// mock codons themselves finish in ~1s. Generous headroom for CI.
const SPAWN_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 240_000;

/** Minimal OpenAI chat-completions endpoint, streaming one canned reply. */
function startMockProvider(): ReturnType<typeof Bun.serve> {
  let requestCount = 0;
  return Bun.serve({
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      requestCount += 1;

      const chunk = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
      const base = {
        id: `chatcmpl-mock-${requestCount}`,
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
          choices: [{ index: 0, delta: { content: MOCK_REPLY }, finish_reason: null }],
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
}

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

describe("E2E: no-op rerun of a completed execution announces itself", () => {
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

  /**
   * Run 1, shared by both tests (memoized — bun runs this file's tests
   * sequentially): boot the real CLI headless against the mock provider, let
   * it run both codons to completion and exit on its own, keep the execution
   * directory. Returns the captured stdout and the paths run 2 needs.
   */
  let completingRun: Promise<{
    run1: CliResult;
    execDir: string;
    configPath: string;
    dataPath: string;
    spawnCli: (args: string[]) => Promise<CliResult>;
  }> | null = null;

  const completeExecutionOnce = () => {
    completingRun ??= (async () => {
      const mock = startMockProvider();
      cleanups.push(() => mock.stop(true));

      // pi config root: models.json defining the keyless local provider.
      const piDir = fs.mkdtempSync(path.join(os.tmpdir(), "noop-resume-pi-"));
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

      // Hank + data + execution dir, all under tests/test-area.
      fs.mkdirSync(TEST_AREA, { recursive: true });
      const hankDir = fs.mkdtempSync(
        path.join(TEST_AREA, `noop-resume-e2e-${generateTestTimestamp()}-`),
      );
      cleanups.push(() => fs.rmSync(hankDir, { recursive: true, force: true }));

      const configPath = path.join(hankDir, "hank.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          hank: ["codon-one", "codon-two"].map((id) => ({
            id,
            name: id,
            promptText: `Reply with exactly: ${MOCK_REPLY}`,
            model: "pi/mocklocal/mock-1",
            continuationMode: "fresh",
          })),
        }),
      );
      const dataPath = path.join(hankDir, "input.txt");
      fs.writeFileSync(dataPath, "noop resume e2e input\n");
      const execDir = path.join(hankDir, "execution");

      /** Spawn the real CLI headless, capture stdout/stderr, wait for exit. */
      const spawnCli = async (args: string[]): Promise<CliResult> => {
        const proc = Bun.spawn(["bun", path.join(PROJECT_ROOT, "server/index.ts"), ...args], {
          cwd: PROJECT_ROOT,
          env: {
            ...process.env,
            HANKWEAVE_TELEMETRY: "0",
            PI_CODING_AGENT_DIR: piDir,
            PI_OFFLINE: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        });

        // Watchdog: a wedged boot must fail THIS test, not hang the file.
        const watchdog = setTimeout(() => proc.kill(), SPAWN_TIMEOUT_MS);
        const exitCode = await proc.exited;
        clearTimeout(watchdog);

        const stdout = proc.stdout ? await new Response(proc.stdout as ReadableStream).text() : "";
        const stderr = proc.stderr ? await new Response(proc.stderr as ReadableStream).text() : "";
        return { exitCode, stdout, stderr };
      };

      const run1 = await spawnCli([
        "--execution",
        execDir,
        "--config",
        configPath,
        "--data",
        dataPath,
        "--port",
        String(await getFreePort()),
        "--headless",
        "-y",
      ]);

      if (run1.exitCode !== 0) {
        throw new Error(
          `completing run failed (exit ${run1.exitCode})\nstdout:\n${run1.stdout}\nstderr:\n${run1.stderr}`,
        );
      }

      return { run1, execDir, configPath, dataPath, spawnCli };
    })();
    return completingRun;
  };

  test(
    "no-op rerun exits 0 and prints the notice exactly once",
    async () => {
      const { execDir, configPath, dataPath, spawnCli } = await completeExecutionOnce();

      const rerun = await spawnCli([
        "--execution",
        execDir,
        "--config",
        configPath,
        "--data",
        dataPath,
        "--port",
        String(await getFreePort()),
        "--headless",
        "-y",
      ]);

      expect(rerun.exitCode).toBe(0);

      // Exactly ONE console line announces the no-op...
      const noopLines = rerun.stdout.split(/\r?\n/).filter((l) => l.includes(NOOP_MARKER));
      expect(noopLines.length).toBe(1);

      // ...naming the escape hatch and the execution it resumed.
      expect(noopLines[0]).toContain("--start-new");
      expect(noopLines[0]).toContain(path.basename(execDir));

      // The old completion message must not masquerade as console output on a
      // run that completed nothing. (Logs on disk are not under test — only
      // what the console shows.)
      expect(rerun.stdout).not.toContain(OLD_MESSAGE);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the completing run itself never prints the notice",
    async () => {
      const { run1 } = await completeExecutionOnce();

      // A fresh run that actually completes codons must look like one: exit 0
      // (asserted at spawn) with no "nothing to do" line anywhere on stdout.
      expect(run1.exitCode).toBe(0);
      expect(run1.stdout).not.toContain(NOOP_MARKER);
    },
    TEST_TIMEOUT_MS,
  );
});
