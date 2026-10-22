import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { buildCli } from "../../scripts/build-cli.js";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { RuntimeLock } from "../../server/runtime-lock.js";
import { buildReplayFixture, successResultLine } from "../utils/replay-fixture-builder.js";

test("the bundled Node CLI accepts its own lease and completes a replay", async () => {
  // Keep the bundle under the repository so Node can resolve external packages.
  // Use a private output directory instead of racing other tests over dist/.
  const testArea = path.resolve("tests/test-area");
  fs.mkdirSync(testArea, { recursive: true });
  const bundleDir = fs.mkdtempSync(path.join(testArea, "cli-bundle-lease-"));
  const fixture = buildReplayFixture({
    codons: [{ id: "done", logLines: [successResultLine()] }],
  });
  // Copied lease contents would merge into the destination's live lock and
  // make release fail with ENOTEMPTY. The source must remain untouched.
  const sourceLease = new ExecutionLayout(fixture.execDir).runtimeLockPath;
  fs.mkdirSync(sourceLease);
  fs.writeFileSync(path.join(sourceLease, "source-only"), "do not copy");
  try {
    const build = await buildCli(bundleDir);
    expect(build.success, build.logs.map(String).join("\n")).toBe(true);
    const child = Bun.spawn(
      [
        "node",
        path.join(bundleDir, "index.js"),
        "--replay",
        fixture.execDir,
        "--headless",
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
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stdout + stderr).toBe(0);
      expect(stdout).toContain("Running in headless mode");
      const replayPath = stdout.match(/\[REPLAY\] Copied execution dir to (.+)/)?.[1].trim();
      expect(replayPath).toBeDefined();
      expect(fs.existsSync(replayPath as string)).toBe(false);
      expect(fs.existsSync(new ExecutionLayout(replayPath as string).runtimeLockPath)).toBe(false);
      expect(fs.readFileSync(path.join(sourceLease, "source-only"), "utf8")).toBe("do not copy");
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    fixture.cleanup();
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}, 45_000);

test("the bundled Node CLI retries a held lease and resumes setup after release", async () => {
  const testArea = path.resolve("tests/test-area");
  fs.mkdirSync(testArea, { recursive: true });
  const bundleDir = fs.mkdtempSync(path.join(testArea, "cli-bundle-contention-"));
  const executionPath = path.join(bundleDir, "execution");
  const configPath = path.join(bundleDir, "hank.json");
  const dataPath = path.join(bundleDir, "data.txt");
  // Stop at configuration validation after setup, without any provider self-tests.
  fs.writeFileSync(configPath, JSON.stringify({ hank: [] }));
  fs.writeFileSync(dataPath, "lease contention fixture");
  const layout = new ExecutionLayout(executionPath);
  const lock = await RuntimeLock.acquire(executionPath);
  try {
    const build = await buildCli(bundleDir);
    expect(build.success, build.logs.map(String).join("\n")).toBe(true);
    const child = Bun.spawn(
      [
        "node",
        path.join(bundleDir, "index.js"),
        configPath,
        dataPath,
        "--execution",
        executionPath,
        "--headless",
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
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    let released = false;
    const stderr = (async () => {
      let output = "";
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr) {
        output += decoder.decode(chunk, { stream: true });
        if (!released && output.includes("Ctrl+C to cancel.")) {
          expect(fs.existsSync(layout.metaPath)).toBe(false);
          released = true;
          await lock.release();
        }
      }
      return output + decoder.decode();
    })();
    try {
      const [code, stdout, errorOutput] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        stderr,
      ]);
      expect(released, stdout + errorOutput).toBe(true);
      expect(code, stdout + errorOutput).toBe(1);
      expect(errorOutput).toContain("At least one codon required");
      // Setup only writes metadata after the retry successfully acquires ownership.
      expect(fs.existsSync(layout.metaPath)).toBe(true);
      expect(fs.existsSync(layout.runtimeLockPath)).toBe(false);
    } finally {
      clearTimeout(timeout);
      child.kill("SIGKILL");
      await child.exited;
    }
  } finally {
    await lock.release();
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}, 45_000);
