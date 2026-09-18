import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBundleHank } from "../../server/bundle-resolver.js";
import { sha256Hex } from "../../server/pack/closure.js";
import { runPackCommand } from "../../server/pack/pack-command.js";
import { readCanonicalTar, writeCanonicalTar } from "../../server/pack/tar.js";
import { zstdCompress, zstdDecompress } from "../../server/pack/zstd.js";
import type { ServerIdleEvent, ServerReadyEvent } from "../../server/schemas/event-schemas.js";
import { launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import { buildReplayFixture, successResultLine } from "../utils/replay-fixture-builder.js";
import { getFreePort, waitForCondition } from "../utils/test-helpers.js";

const entry = path.resolve("server/index.ts");
const EXTRACTION_LINE = /(?:Extracted to|Reusing verified extraction|Re-extracted \(.*\)): (.+)/g;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-cli-test-"));
  dirs.push(dir);
  return dir;
}
function pack(source: string, out = path.join(temp(), "input.hank")): string {
  const errors: string[] = [];
  expect(
    runPackCommand([source, "-o", out], { out: () => {}, err: (line) => errors.push(line) }),
  ).toBe(0);
  expect(fs.statSync(out).size).toBeGreaterThan(0);
  return out;
}
async function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    cwd,
    env: { ...process.env, ...env, HANKWEAVE_TELEMETRY: "false" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 30_000);
  try {
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = out + err;
    for (const match of output.matchAll(EXTRACTION_LINE)) dirs.push(match[1].trim());
    return { code, output };
  } finally {
    clearTimeout(timer);
  }
}
function validationFixture() {
  const source = temp();
  fs.writeFileSync(
    path.join(source, "hank.json"),
    JSON.stringify({
      hank: [
        {
          id: "one",
          name: "One",
          model: "pi/mocklocal/mock-1",
          promptFile: "prompt.md",
          continuationMode: "fresh",
        },
      ],
    }),
  );
  fs.writeFileSync(path.join(source, "prompt.md"), "Hello");
  const piDir = temp();
  fs.writeFileSync(
    path.join(piDir, "models.json"),
    JSON.stringify({
      providers: {
        mocklocal: {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "unused",
          models: [{ id: "mock-1", name: "Mock", contextWindow: 128000, maxTokens: 4096 }],
        },
      },
    }),
  );
  return { source, env: { PI_CODING_AGENT_DIR: piDir, PI_OFFLINE: "1" } };
}

describe("bundle CLI gate (no provider calls)", () => {
  it("validates from an empty receiver and reuses the content-addressed extraction on repeated invocations", async () => {
    const { source, env } = validationFixture();
    const receiver = temp();
    const bundle = pack(source, path.join(receiver, "input.hank"));
    fs.rmSync(source, { recursive: true, force: true });
    const first = await cli(["input.hank", "--validate"], receiver, env);
    expect(first.output).toContain("Configuration is valid");
    expect(first.code).toBe(0);
    expect(first.output).toContain("hankweave input.hank");
    const second = await cli([bundle, "--validate"], receiver, env);
    expect(second.code).toBe(0);
    const dir = (result: typeof first) =>
      [...result.output.matchAll(EXTRACTION_LINE)][0]?.[1].trim() as string;
    expect(first.output).toContain("Extracted to:");
    expect(second.output).toContain("Reusing verified extraction:");
    expect(dir(second)).toBe(dir(first));
    const lock = JSON.parse(fs.readFileSync(path.join(dir(first), "hank.lock"), "utf8"));
    expect(sha256Hex(fs.readFileSync(path.join(dir(first), "hank.json")))).toBe(
      lock.files["hank.json"].sha256,
    );
    // Temp cleanup between invocations: the tree comes back at the same path.
    fs.rmSync(dir(first), { recursive: true, force: true });
    const third = await cli([bundle, "--validate"], receiver, env);
    expect(third.code).toBe(0);
    expect(third.output).toContain("Extracted to:");
    expect(dir(third)).toBe(dir(first));
  }, 100_000);

  it("names a tampered prompt before validation or extraction, as a user error", async () => {
    const { source, env } = validationFixture();
    const bundle = pack(source);
    const members = readCanonicalTar(zstdDecompress(fs.readFileSync(bundle), 1024 * 1024));
    const prompt = members.find((member) => member.path === "prompt.md");
    expect(prompt).toBeDefined();
    if (!prompt) throw new Error("missing fixture prompt");
    prompt.bytes = Buffer.from("changed");
    fs.writeFileSync(bundle, zstdCompress(writeCanonicalTar(members)));
    const result = await cli([bundle, "--validate"], temp(), env);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`Error: ${bundle}: prompt.md: does not match hank.lock`);
    // A refused bundle is the user's problem to fix, not a crash: no stack trace.
    expect(result.output).not.toContain("Stack:");
    expect(result.output).not.toContain("    at ");
    expect([...result.output.matchAll(EXTRACTION_LINE)]).toEqual([]);
  }, 40_000);

  it("keeps a directory named *.hank on the directory path and retains ordinary schema rewriting", async () => {
    const { source, env } = validationFixture();
    const named = path.join(temp(), "folder.hank");
    fs.cpSync(source, named, { recursive: true });
    const result = await cli([named, temp(), "--validate"], temp(), env);
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("Loading bundle");
    expect(JSON.parse(fs.readFileSync(path.join(named, "hank.json"), "utf8")).$schema).toBeTruthy();
  }, 40_000);

  it.each([
    { kind: "env", name: "BUNDLE_TEST_REQUIRED_MISSING", error: "Missing required environment" },
    {
      kind: "tools",
      name: "bundle-test-required-missing-tool",
      error: "Missing required tools on PATH",
    },
  ])(
    "enforces verified config requirements.$kind",
    async ({ kind, name, error }) => {
      const { source, env } = validationFixture();
      const file = path.join(source, "hank.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.requirements = { [kind]: [name] };
      fs.writeFileSync(file, JSON.stringify(config));
      const bundle = pack(source);
      const members = readCanonicalTar(zstdDecompress(fs.readFileSync(bundle), 1024 * 1024));
      const lock = JSON.parse(members[0].bytes.toString("utf8"));
      expect(lock).not.toHaveProperty("requirements");
      const result = await cli([bundle, "--validate"], temp(), {
        ...env,
        BUNDLE_TEST_REQUIRED_MISSING: "",
      });
      expect(result.code).toBe(1);
      expect(result.output).toContain(error);
      expect(result.output).toContain(name);
    },
    40_000,
  );

  it("records bundle context and replays from metadata after the original bundle is removed", async () => {
    const fixture = buildReplayFixture({
      codons: [{ id: "one", logLines: [successResultLine()] }],
    });
    dirs.push(fixture.execDir);
    const bundle = pack(fixture.execDir);
    const resolved = await resolveBundleHank(bundle);
    dirs.push(resolved.hankDir);
    const server = await launchHankweave({
      configPath: bundle,
      positionalInputs: true,
      dataDir: fixture.dataPath,
      replayDir: fixture.execDir,
      port: await getFreePort(),
      // --no-autostart: the recording is copied below from a server that is
      // idle after its last codon. With autostart the runtime shuts itself
      // down two seconds after completion and its exit handler removes the
      // replay working directory while the copy is still walking it — the
      // RunCompleted transition waitForRunToComplete watches is emitted from
      // inside that shutdown, so the copy always started too late (ENOENT on
      // Windows CI, where the copy is slower than the teardown).
      extraArgs: ["--force", "--no-autostart"],
      logPrefix: "[Bundle Replay]",
    });
    let meta: Record<string, string>;
    let executionDir: string;
    try {
      const ready = (await server.waitForEvent("server.ready")) as ServerReadyEvent;
      executionDir = ready.data.executionPath;
      server.sendCommand({ id: "start", type: "codon.next" } as never);
      await server.waitForCodonCompletion("one", undefined, 30_000);
      // Not the handshake-time idle (reason "startup"): the one after codon one.
      await server.waitForEvent(
        "server.idle",
        10_000,
        (event) => (event as ServerIdleEvent).data.reason === "codon-completed",
      );
      meta = JSON.parse(
        fs.readFileSync(path.join(executionDir, ".hankweave/execution-meta.json"), "utf8"),
      );
      dirs.push(path.dirname(meta.hankPath));
      expect(meta.version).toBe("1.2.0");
      expect(meta.bundleHash).toBe(resolved.bundleHash);
      expect(meta.bundlePath).toBe(bundle);
      expect(sha256Hex(fs.readFileSync(meta.hankPath))).toBe(
        resolved.lock.files["hank.json"].sha256,
      );
      // The working directory is deleted when the server process exits, so
      // the recording is copied now, while the server idles and nothing
      // touches the tree.
      const recording = temp();
      fs.cpSync(executionDir, recording, { recursive: true });
      executionDir = recording;
    } finally {
      await server.stop();
    }
    fs.unlinkSync(bundle);
    await replayFromMetadata(executionDir, meta, temp());
  }, 90_000);
});

async function replayFromMetadata(
  recording: string,
  expected: Record<string, string>,
  cwd: string,
) {
  const child = spawn(
    process.execPath,
    [entry, "--replay", recording, "--headless", "--force", "--port", String(await getFreePort())],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (data) => {
    output += data.toString();
  });
  child.stderr.on("data", (data) => {
    output += data.toString();
  });
  const closed = once(child, "close");
  try {
    let metaPath = "";
    const ready = await waitForCondition(() => {
      const dir = output.match(/\[REPLAY\] Copied execution dir to (.+)/)?.[1].trim();
      if (!dir) return false;
      metaPath = path.join(dir, ".hankweave/execution-meta.json");
      return output.includes("Running in headless mode") && fs.existsSync(metaPath);
    }, 30_000);
    expect(ready).toBe(true);
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    expect(meta.bundleHash).toBe(expected.bundleHash);
    expect(meta.bundlePath).toBe(expected.bundlePath);
    expect(meta.hankPath).toBe(expected.hankPath);
    expect(output).not.toContain("Loading bundle");
    expect(sha256Hex(fs.readFileSync(meta.hankPath))).toBe(
      sha256Hex(fs.readFileSync(expected.hankPath)),
    );
    expect(JSON.parse(fs.readFileSync(meta.hankPath, "utf8")).$schema).toBeUndefined();
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await closed;
    clearTimeout(timer);
  }
}
