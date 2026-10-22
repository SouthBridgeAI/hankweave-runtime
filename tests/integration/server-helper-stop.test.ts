import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeLock } from "../../server/runtime-lock.js";
import { escapeShellArg } from "../../server/utils.js";
import { type LaunchedServer, launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { buildReplayFixture, successResultLine } from "../utils/replay-fixture-builder.js";
import { getFreePort, waitForCondition } from "../utils/test-helpers.js";

for (const disconnectFirst of [false, true]) {
  // The connected case also starts a competing runtime, which retries an
  // occupied lease for 70 seconds. Allow that window plus startup/shutdown time.
  test(`stop releases execution ownership with a ${disconnectFirst ? "disconnected" : "connected"} client`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hw-helper-stop-"));
    const executionDir = path.join(root, "execution");
    const configPath = path.join(root, "hank.json");
    const piDir = path.join(root, "pi");
    fs.mkdirSync(piDir);
    // Register a keyless local model for startup validation. No codon runs,
    // so the endpoint is never contacted.
    fs.writeFileSync(
      path.join(piDir, "models.json"),
      JSON.stringify({
        providers: {
          mocklocal: {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            apiKey: "unused-test-key",
            models: [
              { id: "mock-1", name: "Idle Test Model", contextWindow: 128000, maxTokens: 4096 },
            ],
          },
        },
      }),
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        hank: [
          {
            id: "idle",
            name: "Idle",
            model: "pi/mocklocal/mock-1",
            continuationMode: "fresh",
            promptText: "Never executed: autostart is disabled.",
          },
        ],
      }),
    );

    const started = path.join(root, "upload-started");
    const proceed = path.join(root, "upload-proceed");
    const observed = path.join(root, "uploaded-state.json");
    const fakeTrace = path.join(root, "trace.ts");
    fs.writeFileSync(
      fakeTrace,
      `
      import fs from "node:fs";
      import path from "node:path";
      if (process.argv[2] === "config") { console.log("configured"); process.exit(0); }
      const snapshot = process.argv[3];
      fs.writeFileSync(${JSON.stringify(started)}, snapshot);
      while (!fs.existsSync(${JSON.stringify(proceed)})) await Bun.sleep(20);
      fs.copyFileSync(path.join(snapshot, ".hankweave/state.json"), ${JSON.stringify(observed)});
    `,
    );
    const quote = (value: string) =>
      process.platform === "win32" ? `"${value}"` : escapeShellArg(value);
    let server: LaunchedServer | undefined;
    try {
      server = await launchHankweave({
        port: await getFreePort(),
        configPath,
        executionDir,
        reuseTestDirectory: true,
        extraArgs: ["--no-autostart"],
        env: {
          PI_OFFLINE: "1",
          PI_CODING_AGENT_DIR: piDir,
          HANKWEAVE_TRACE_BRAINTRUST: disconnectFirst ? "1" : "",
          HANKWEAVE_TRACE_LANGFUSE: "",
          HANKWEAVE_TRACE_BINARY: `${quote(process.execPath)} ${quote(fakeTrace)}`,
        },
      });
      expect(server.hasLockFile()).toBe(true);
      if (!disconnectFirst) {
        const metaPath = path.join(executionDir, ".hankweave/execution-meta.json");
        const before = fs.readFileSync(metaPath, "utf8");
        // All mutating entry points must reject before setup/reset/journal writes.
        for (const args of [
          [configPath, "--execution", executionDir, "--headless", "--start-new", "--force"],
          [configPath, "--execution", executionDir, "--cleanup", "--yes"],
          ["--diet-journal", executionDir],
        ]) {
          const competitor = Bun.spawn(
            [process.execPath, path.resolve("server/index.ts"), ...args],
            {
              env: {
                ...process.env,
                PI_OFFLINE: "1",
                PI_CODING_AGENT_DIR: piDir,
                HANKWEAVE_TRACE_BRAINTRUST: "",
                HANKWEAVE_TRACE_LANGFUSE: "",
              },
              stdout: "pipe",
              stderr: "pipe",
            },
          );
          const [stdout, stderr, code] = await Promise.all([
            new Response(competitor.stdout).text(),
            new Response(competitor.stderr).text(),
            competitor.exited,
          ]);
          expect(code).toBe(1);
          if (args.includes("--start-new")) {
            expect(stderr).toContain("waiting up to ~70 seconds for release or recovery");
            expect(stderr).toContain("is still locked after waiting ~70 seconds");
          } else {
            expect(stdout + stderr).toContain("is in use by another command");
            expect(stderr).not.toContain("waiting up to");
          }
          expect(stderr).not.toMatch(/Stack(?: trace)?:/);
          expect(fs.readFileSync(metaPath, "utf8")).toBe(before);
          expect(
            fs.readdirSync(executionDir).some((name) => name.startsWith(".hankweave.backup-")),
          ).toBe(false);
        }
      }
      if (disconnectFirst) {
        await server.disconnect();
        await server.waitForConnectionClose();
      }

      const stopping = server.stop(15_000);
      if (disconnectFirst) {
        try {
          expect(await waitForCondition(() => fs.existsSync(started), 10_000)).toBe(true);
          expect(server.hasLockFile()).toBe(false);
          const successor = await RuntimeLock.acquire(executionDir);
          try {
            fs.rmSync(executionDir, { recursive: true });
          } finally {
            await successor.release();
          }
        } finally {
          fs.writeFileSync(proceed, "continue");
          await stopping;
        }
        expect(JSON.parse(fs.readFileSync(observed, "utf8")).runs.length).toBeGreaterThan(0);
        expect(fs.existsSync(fs.readFileSync(started, "utf8"))).toBe(false);
        expect(fs.existsSync(executionDir)).toBe(false);
      } else {
        await stopping;
      }
      expect(server.hasLockFile()).toBe(false);
      // Prove a subsequent owner can acquire the released lease.
      const lock = await RuntimeLock.acquire(executionDir);
      await lock.release();
      await server.stop(); // Already-exited shutdown is idempotent.
      if (!disconnectFirst) {
        server = await launchHankweave({
          port: await getFreePort(),
          configPath,
          executionDir,
          reuseTestDirectory: true,
          sendPreviousEvents: true,
          extraArgs: ["--no-autostart"],
          env: {
            PI_OFFLINE: "1",
            PI_CODING_AGENT_DIR: piDir,
            HANKWEAVE_TRACE_BRAINTRUST: "",
            HANKWEAVE_TRACE_LANGFUSE: "",
          },
        });
        expect(
          server
            .getEvents()
            .some(
              (event) => event.type === "info" && event.data.message.startsWith("Shutting down:"),
            ),
        ).toBe(true);
        // Historical shutdown events must not make stop() wait on an idle runtime.
        await server.stop();
        expect(server.hasLockFile()).toBe(false);
      }
    } finally {
      await server?.stop(15_000).catch(() => server?.kill());
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
}

test("replay cleans its private execution before uploading the independent snapshot", async () => {
  const fixture = buildReplayFixture({ codons: [{ id: "done", logLines: [successResultLine()] }] });
  const observed = path.join(fixture.execDir, "upload-observed.json");
  const proceed = path.join(fixture.execDir, "upload-proceed");
  const fakeTrace = path.join(fixture.execDir, "trace.ts");
  fs.writeFileSync(
    fakeTrace,
    `
    import fs from "node:fs";
    import path from "node:path";
    if (process.argv[2] === "config") process.exit(0);
    const dir = process.argv[3];
    const meta = JSON.parse(fs.readFileSync(path.join(dir, ".hankweave/execution-meta.json"), "utf8"));
    fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
      originalExists: fs.existsSync(meta.executionPath),
      lockExists: fs.existsSync(meta.executionPath + ".lock"),
      stateExists: fs.existsSync(path.join(dir, ".hankweave/state.json")),
      cwd: process.cwd(), dir: fs.realpathSync(dir),
    }));
    while (!fs.existsSync(${JSON.stringify(proceed)})) await Bun.sleep(20);
  `,
  );
  const quote = (value: string) =>
    process.platform === "win32" ? `"${value}"` : escapeShellArg(value);
  let server: LaunchedServer | undefined;
  try {
    server = await launchHankweave({
      port: await getFreePort(),
      configPath: fixture.configPath,
      dataDir: fixture.dataPath,
      replayDir: fixture.execDir,
      extraArgs: ["--force"],
      env: {
        HANKWEAVE_TRACE_BRAINTRUST: "1",
        HANKWEAVE_TRACE_LANGFUSE: "",
        HANKWEAVE_TRACE_BINARY: `${quote(process.execPath)} ${quote(fakeTrace)}`,
      },
    });
    await server.waitForRunToComplete(30_000);
    const replayPath = server.executionDir;
    expect(replayPath).not.toBe(fixture.execDir);
    // Hold the upload after the listener closes but before process exit. stop()
    // must await the automatic shutdown without attempting to reconnect.
    await server.waitForConnectionClose();
    expect(await waitForCondition(() => fs.existsSync(observed), 10_000)).toBe(true);
    expect(server.process.exitCode).toBeNull();
    const stopping = server.stop(15_000);
    fs.writeFileSync(proceed, "continue");
    await stopping;
    expect((await server.waitForExit(15_000)).exitCode).toBe(0);
    expect(fs.existsSync(replayPath)).toBe(false);
    expect(server.hasLockFile()).toBe(false);
    expect(fs.existsSync(fixture.execDir)).toBe(true);
    const result = JSON.parse(fs.readFileSync(observed, "utf8"));
    expect(result.originalExists).toBe(false);
    expect(result.lockExists).toBe(false);
    expect(result.stateExists).toBe(true);
    expect(result.cwd).toBe(result.dir);
    expect(fs.existsSync(result.dir)).toBe(false);
  } finally {
    fs.writeFileSync(proceed, "continue");
    await server?.stop(15_000).catch(() => server?.kill());
    fixture.cleanup();
  }
}, 60_000);
