import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { RuntimeLock, RuntimeLockHeldError } from "../../server/runtime-lock.js";
import { type LaunchedServer, launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { getFreePort, waitForCondition } from "../utils/test-helpers.js";

// Boot the real CLI/runtime and SDKs. Claude's fixture executable spawns a
// child writer; Pi's local provider requests a real Bash tool call. Both
// writers ignore SIGTERM, and killing only the Claude CLI leaves its writer alive.
test.each(["claude", "pi"])(
  "%s lease loss kills its writer without releasing the successor's lock",
  async (engine) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lease-agents-e2e-")));
    const executionDir = path.join(root, "execution");
    const layout = new ExecutionLayout(executionDir);
    const writer = path.join(layout.agentRootPath, "sdk-writes");
    const script = path.join(root, "writer.mjs");
    const claudeScript = path.join(root, "claude.mjs");
    const configPath = path.join(root, "hank.json");
    fs.writeFileSync(
      script,
      `
      import fs from "node:fs";
      process.on("SIGTERM", () => {});
      process.stdin.resume();
      fs.writeFileSync("sdk-writes.pid", String(process.pid));
      setInterval(() => fs.appendFileSync("sdk-writes", "writing\\n"), 10);
    `,
    );
    fs.writeFileSync(
      claudeScript,
      `
      import fs from "node:fs";
      import { spawn } from "node:child_process";
      process.on("SIGTERM", () => {});
      process.stdin.resume();
      fs.writeFileSync("claude.pid", String(process.pid));
      spawn(process.execPath, [${JSON.stringify(script)}], { stdio: "ignore" });
    `,
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        hank: [
          {
            id: "sdk-writer",
            name: "Lease-loss writer",
            model: engine === "claude" ? "anthropic/claude-haiku-4-5" : "pi/mocklocal/mock-1",
            continuationMode: "fresh",
            promptText: "Keep writing until stopped.",
          },
        ],
      }),
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const command = `exec ${quote(process.execPath)} ${quote(script)}`;
    // Keep health probes and Pi's model requests local, isolated from credentials.
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (engine === "pi" && new URL(request.url).pathname.endsWith("/chat/completions")) {
          const chunk = (delta: object, finish_reason: string | null) =>
            `data: ${JSON.stringify({
              id: "chatcmpl-writer",
              object: "chat.completion.chunk",
              created: 0,
              model: "mock-1",
              choices: [{ index: 0, delta, finish_reason }],
            })}\n\n`;
          return new Response(
            [
              chunk(
                {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_writer",
                      type: "function",
                      function: { name: "bash", arguments: JSON.stringify({ command }) },
                    },
                  ],
                },
                null,
              ),
              chunk({}, "tool_calls"),
              "data: [DONE]\n\n",
            ].join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return Response.json(
          { type: "error", error: { type: "not_found_error", message: "fixture" } },
          { status: 404 },
        );
      },
    });
    const piDir = path.join(root, "pi");
    fs.mkdirSync(piDir);
    fs.writeFileSync(
      path.join(piDir, "models.json"),
      JSON.stringify({
        providers: {
          mocklocal: {
            baseUrl: `http://127.0.0.1:${provider.port}/v1`,
            api: "openai-completions",
            apiKey: "test-key-never-checked",
            models: [{ id: "mock-1", name: "Local Mock", contextWindow: 128000, maxTokens: 4096 }],
          },
        },
      }),
    );
    let server: LaunchedServer | undefined;
    let successor: RuntimeLock | undefined;
    try {
      const port = await getFreePort();
      server = await launchHankweave({
        port,
        configPath,
        executionDir,
        logPrefix: `[lease-loss-${engine}]`,
        extraArgs: ["--headless", "--force"],
        env: {
          ANTHROPIC_API_KEY: "sk-ant-test-never-valid",
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.port}`,
          CLAUDE_PATH_TO_CLAUDE_EXECUTABLE: claudeScript,
          PI_CODING_AGENT_DIR: piDir,
          PI_OFFLINE: "1",
        },
      });
      let stderr = "";
      server.process.stderr?.on("data", (data) => {
        stderr += data.toString();
      });
      await server.waitForEvent("server.ready", 30_000);
      expect(await waitForCondition(() => fs.existsSync(writer), 30_000)).toBe(true);
      if (engine === "claude") {
        expect(fs.readFileSync(`${writer}.pid`, "utf8")).not.toBe(
          fs.readFileSync(path.join(layout.agentRootPath, "claude.pid"), "utf8"),
        );
      }
      // The actual runtime holds the lease while its agent writes in agentRoot.
      await expect(RuntimeLock.acquire(executionDir)).rejects.toBeInstanceOf(RuntimeLockHeldError);

      // Give proper-lockfile's potentially rounded mtimes a distinct takeover value.
      await Bun.sleep(1_100);
      fs.rmdirSync(new ExecutionLayout(executionDir).runtimeLockPath);
      successor = await RuntimeLock.acquire(executionDir);
      expect(await server.waitForExit(30_000)).toEqual({ exitCode: 1, signalCode: null });
      expect(stderr).toContain("Fatal: execution lease lost");

      const size = fs.statSync(writer).size;
      // Negative assertion: an orphan would keep appending every 10ms.
      await Bun.sleep(200);
      expect(fs.statSync(writer).size).toBe(size);
      await expect(RuntimeLock.acquire(executionDir)).rejects.toBeInstanceOf(RuntimeLockHeldError);
    } finally {
      try {
        await server?.kill(10_000, "SIGKILL");
      } finally {
        // Reap both fixtures even when running against the unfixed runtime.
        for (const pidFile of [`${writer}.pid`, path.join(layout.agentRootPath, "claude.pid")]) {
          try {
            process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");
          } catch {
            // Already exited or never spawned.
          }
        }
        provider.stop(true);
        await successor?.release();
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  },
  90_000,
);
