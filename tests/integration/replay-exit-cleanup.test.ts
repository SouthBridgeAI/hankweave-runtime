import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { buildReplayFixture, successResultLine } from "../utils/replay-fixture-builder.js";

const entry = path.resolve("server/index.ts");
const runtime = path.resolve("server/hankweave-runtime.ts");
const watchdog = path.resolve("server/shutdown-watchdog.ts");

for (const mode of [
  "force shutdown",
  "compromised lease",
  "startup cleanup failure",
  "watchdog",
  "partial copy exit",
  "async removal failure",
]) {
  test(`replay cleans up only while owning its directory on ${mode}`, async () => {
    const fixture = buildReplayFixture({
      codons: [{ id: "done", logLines: [successResultLine()] }],
    });
    const marker = path.join(fixture.execDir, "replay-path");
    const preload = path.join(fixture.execDir, "exit-preload.ts");
    // Inject failures only in the child. Run the real CLI, process.exit, and
    // exit listeners: mocking exit in the test process would miss this leak.
    fs.writeFileSync(
      preload,
      `
      import fs from "node:fs";
      import path from "node:path";
      import { HankweaveRuntime } from ${JSON.stringify(runtime)};
      import { ShutdownWatchdog } from ${JSON.stringify(watchdog)};
      const mode = ${JSON.stringify(mode)};
      let replayPath;
      const copy = fs.promises.cp;
      fs.promises.cp = async (source, destination, options) => {
        if (!String(destination).includes("hankweave-replay-")) {
          return copy(source, destination, options);
        }
        replayPath = String(destination);
        fs.writeFileSync(${JSON.stringify(marker)}, replayPath);
        if (mode === "partial copy exit") {
          fs.mkdirSync(replayPath, { recursive: true });
          fs.writeFileSync(replayPath + "/partial", "copied bytes");
          process.chdir(replayPath);
          console.error("injected partial copy exit");
          process.exit(1);
        }
        return copy(source, destination, options);
      };
      const remove = fs.promises.rm;
      fs.promises.rm = async (target, options) => {
        // path.join yields backslashes on Windows; compare parents, not prefixes.
        if (mode === "async removal failure" && path.dirname(String(target)) === replayPath) {
          throw new Error("injected async removal failure");
        }
        return remove(target, options);
      };
      const start = HankweaveRuntime.prototype.start;
      HankweaveRuntime.prototype.start = async function () {
        if (mode === "async removal failure") throw new Error("injected startup failure");
        if (mode === "startup cleanup failure") {
          this.initialize = async () => { throw new Error("injected startup failure"); };
          this.sentinelManager.shutdown = async () => { throw new Error("injected cleanup failure"); };
        }
        const port = await start.call(this);
        if (mode === "force shutdown") {
          await this.forceShutdown("replay cleanup regression");
        } else if (mode === "compromised lease") {
          const lease = replayPath + "/${ExecutionLayout.RUNTIME_LOCK}";
          fs.rmdirSync(lease);
          fs.mkdirSync(lease);
          const successorTime = new Date(Date.now() + 10_000);
          fs.utimesSync(lease, successorTime, successorTime);
          fs.writeFileSync(replayPath + "/successor", "successor's work");
        } else if (mode === "watchdog") {
          this.watchdog = new ShutdownWatchdog({ timeoutMs: 25, log: console.error });
          this.currentCodon = { codonId: "wedged" };
          this.codonRunners.set("wedged", { forceKill: () => new Promise(() => {}) });
          await this.forceShutdown("replay cleanup regression");
        }
        return port;
      };
    `,
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        entry,
        "--replay",
        fixture.execDir,
        "--headless",
        "--no-autostart",
        "--force",
        "--port",
        "0",
      ],
      {
        env: {
          ...process.env,
          HANKWEAVE_TELEMETRY: "0",
          HANKWEAVE_TRACE_BRAINTRUST: "",
          HANKWEAVE_TRACE_LANGFUSE: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stdout + stderr).toBe(1);
      const evidence: Record<string, string> = {
        "force shutdown": "Running in headless mode",
        "compromised lease": "Fatal: execution lease lost",
        "startup cleanup failure": "Fatal: startup cleanup failed",
        watchdog: "Shutdown watchdog:",
        "partial copy exit": "injected partial copy exit",
        "async removal failure": "injected async removal failure",
      };
      expect(stdout + stderr).toContain(evidence[mode]);
      const replayPath = fs.readFileSync(marker, "utf8");
      const lostOwnership = mode === "compromised lease";
      expect(fs.existsSync(replayPath)).toBe(lostOwnership);
      expect(fs.existsSync(new ExecutionLayout(replayPath).runtimeLockPath)).toBe(lostOwnership);
      if (lostOwnership) {
        expect(fs.readFileSync(path.join(replayPath, "successor"), "utf8")).toBe(
          "successor's work",
        );
      }
      expect(fs.existsSync(fixture.configPath)).toBe(true);
      expect(fs.existsSync(fixture.dataPath)).toBe(true);
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      await child.exited;
      if (fs.existsSync(marker)) {
        const replayPath = fs.readFileSync(marker, "utf8");
        fs.rmSync(replayPath, { recursive: true, force: true });
      }
      fixture.cleanup();
    }
  }, 25_000);
}
