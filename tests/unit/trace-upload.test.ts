import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { RuntimeLock } from "../../server/runtime-lock.js";
import { createTraceSnapshot, registerTraceUpload } from "../../server/trace-watcher.js";
import { escapeShellArg, Logger } from "../../server/utils.js";

let originalCwd: string;
let root: string;
let dir: string;
let layout: ExecutionLayout;
let lock: RuntimeLock;
const envKeys = [
  "HANKWEAVE_TRACE_BINARY",
  "HANKWEAVE_TRACE_BRAINTRUST",
  "HANKWEAVE_TRACE_LANGFUSE",
];
let originalEnv: (string | undefined)[];
const disposers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  originalCwd = process.cwd();
  originalEnv = envKeys.map((key) => process.env[key]);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trace-upload-test-")));
  dir = path.join(root, "execution with ' quotes");
  layout = new ExecutionLayout(dir);
  fs.mkdirSync(path.join(layout.runsDir, "run-1"), { recursive: true });
  fs.mkdirSync(layout.eventsDir);
  fs.writeFileSync(
    layout.statePath,
    JSON.stringify({
      runs: [{ runId: "run-1", runFolder: path.join(layout.runsDir, "run-1"), codons: [] }],
    }),
  );
  fs.writeFileSync(path.join(layout.runsDir, "run-1", "step-claude.log"), "original log\n");
  fs.writeFileSync(path.join(layout.eventsDir, "events.jsonl"), "original event\n");
  const hankPath = path.join(root, "hank.json");
  fs.writeFileSync(hankPath, JSON.stringify({ meta: { name: "Original hank", version: "1" } }));
  fs.writeFileSync(layout.metaPath, JSON.stringify({ hankPath, executionPath: dir }));
  lock = await RuntimeLock.acquire(dir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await lock.release();
  for (const dispose of disposers.splice(0)) await dispose();
  fs.rmSync(root, { recursive: true, force: true });
  envKeys.forEach((key, index) => {
    if (originalEnv[index] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[index];
  });
});

test("snapshot retains all trace inputs independently of mutation and cleanup", async () => {
  fs.mkdirSync(layout.checkpointsPath);
  fs.writeFileSync(path.join(layout.checkpointsPath, "not-a-trace-input"), "checkpoint");
  const snapshot = await createTraceSnapshot(dir);
  disposers.push(snapshot.dispose);
  const copy = new ExecutionLayout(snapshot.executionPath);
  const state = JSON.parse(fs.readFileSync(copy.statePath, "utf8"));
  const meta = JSON.parse(fs.readFileSync(copy.metaPath, "utf8"));
  expect(state.runs[0].runFolder).toBe(path.join(copy.runsDir, "run-1"));
  expect(meta.executionPath).toBe(dir);
  expect(meta.hankPath).toBe(path.join(snapshot.executionPath, "hank.json"));
  expect(fs.existsSync(copy.checkpointsPath)).toBe(false);
  await lock.release();
  fs.writeFileSync(path.join(layout.runsDir, "run-1", "step-claude.log"), "successor log");
  fs.writeFileSync(path.join(root, "hank.json"), "{}");
  fs.rmSync(dir, { recursive: true });
  expect(fs.readFileSync(path.join(copy.eventsDir, "events.jsonl"), "utf8")).toBe(
    "original event\n",
  );
  expect(fs.readFileSync(path.join(state.runs[0].runFolder, "step-claude.log"), "utf8")).toBe(
    "original log\n",
  );
  expect(JSON.parse(fs.readFileSync(meta.hankPath, "utf8")).meta.name).toBe("Original hank");
  await snapshot.dispose();
  expect(fs.existsSync(snapshot.executionPath)).toBe(false);
});

test.each([0, 7])("upload runs once from the snapshot and removes it (exit: %s)", async (code) => {
  const observation = path.join(root, "observed.json");
  const binary = path.join(root, "fake-trace.ts");
  fs.writeFileSync(
    binary,
    `
    import fs from "node:fs";
    import path from "node:path";
    if (process.argv[2] === "config") { console.log("configured"); process.exit(0); }
    const dir = process.argv[3];
    await Bun.sleep(50);
    const state = JSON.parse(fs.readFileSync(path.join(dir, ".hankweave/state.json"), "utf8"));
    const meta = JSON.parse(fs.readFileSync(path.join(dir, ".hankweave/execution-meta.json"), "utf8"));
    fs.appendFileSync(${JSON.stringify(observation)}, JSON.stringify({
      dir: fs.realpathSync(dir), log: fs.readFileSync(path.join(state.runs[0].runFolder, "step-claude.log"), "utf8"),
      name: JSON.parse(fs.readFileSync(meta.hankPath, "utf8")).meta.name,
      flags: process.argv.slice(4),
      config: JSON.parse(fs.readFileSync(".hankweave-trace.json", "utf8")),
      cwd: process.cwd(),
    }) + "\\n");
    console.log("uploader stdout diagnostic");
    console.error("uploader stderr diagnostic");
    process.exit(${code});
  `,
  );
  const quote = (value: string) =>
    process.platform === "win32" ? `"${value}"` : escapeShellArg(value);
  process.env.HANKWEAVE_TRACE_BINARY = `${quote(process.execPath)} ${quote(binary)}`;
  process.env.HANKWEAVE_TRACE_BRAINTRUST = "1";
  process.env.HANKWEAVE_TRACE_LANGFUSE = "";
  fs.writeFileSync(path.join(dir, ".hankweave-trace.json"), JSON.stringify({ test: "frozen" }));
  process.chdir(dir);
  const prepare = await registerTraceUpload(dir);
  const prepared = await prepare();
  disposers.push(prepared.dispose);
  await lock.release();
  process.chdir(originalCwd);
  fs.rmSync(dir, { recursive: true });
  let ticked = false;
  const timer = setTimeout(() => {
    ticked = true;
  }, 10);
  const stdout = spyOn(console, "log").mockImplementation(() => {});
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    await Promise.all([prepared.upload(), prepared.upload()]);
    const output = [...stdout.mock.calls, ...stderr.mock.calls].flat().join("\n");
    expect(output).toContain("uploader stdout diagnostic");
    expect(output).toContain("uploader stderr diagnostic");
    if (code !== 0) expect(output).toContain("Trace upload failed:");
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  clearTimeout(timer);
  expect(ticked).toBe(true);
  const observations = fs.readFileSync(observation, "utf8").trim().split("\n");
  expect(observations).toHaveLength(1);
  const result = JSON.parse(observations[0]);
  expect(result.log).toBe("original log\n");
  expect(result.name).toBe("Original hank");
  expect(result.cwd).toBe(result.dir);
  expect(result.config).toEqual({ test: "frozen" });
  expect(result.flags).toEqual(["--force", "--braintrust"]);
  expect(fs.existsSync(result.dir)).toBe(false);
  expect(fs.existsSync(dir)).toBe(false);
});

test("failed snapshot removes its temporary directory and exit listener", async () => {
  fs.writeFileSync(layout.statePath, "invalid JSON");
  const before = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("hankweave-trace-"));
  const listeners = process.listenerCount("exit");
  await expect(createTraceSnapshot(dir)).rejects.toThrow();
  expect(process.listenerCount("exit")).toBe(listeners);
  expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("hankweave-trace-"))).toEqual(
    before,
  );
  await expect(RuntimeLock.acquire(dir)).rejects.toThrow(/in use/);
});

test("post-release logging cannot recreate a cleaned execution directory", () => {
  const logger = new Logger(path.join(layout.stateDir, "logs/server.log"));
  logger.log("before release");
  logger.disableFileLogging();
  fs.rmSync(dir, { recursive: true });
  logger.log("after release");
  expect(fs.existsSync(dir)).toBe(false);
});
