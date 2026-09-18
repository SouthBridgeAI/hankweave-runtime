import { afterEach, describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { hankLockSchema } from "../../server/pack/lock-schema.js";
import { runPackCommand } from "../../server/pack/pack-command.js";
import { readCanonicalTar } from "../../server/pack/tar.js";
import { zstdDecompress } from "../../server/pack/zstd.js";
import * as remoteHank from "../../server/remote-hank.js";
import { resolveStartupSource, StartupSourceError } from "../../server/startup-source.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startup-source-test-"));
  dirs.push(dir);
  return dir;
}

function localHank(dir = temp()): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "hank.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      hank: [
        { id: "one", name: "One", model: "sonnet", promptText: "Hello", continuationMode: "fresh" },
      ],
    }),
  );
  return file;
}

function recording(cwd: string, metadata: Record<string, unknown>): string {
  const dir = path.join(cwd, "recording");
  const file = new ExecutionLayout(dir).metaPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(metadata));
  return dir;
}

function bundle(cwd: string) {
  const file = path.join(cwd, "input.hank");
  const silent = { out: () => {}, err: () => {} };
  const source = path.resolve("tests/fixtures/pack-fixture");
  expect(runPackCommand([source, "-o", file, "--no-lock"], silent)).toBe(0);
  const members = readCanonicalTar(zstdDecompress(fs.readFileSync(file), 1024 * 1024));
  const lock = hankLockSchema.parse(JSON.parse(members[0].bytes.toString("utf8")));
  return { file, hash: lock.bundleHash };
}

describe("startup source policy", () => {
  it("resolves relative data and config paths against the invocation directory", async () => {
    const cwd = temp();
    const data = path.join(cwd, "data");
    localHank(data);
    const selected = localHank(path.join(cwd, "selected"));
    const source = await resolveStartupSource({ configPath: "selected", dataFlag: "data" }, cwd);
    expect(source).toEqual({
      dataPath: data,
      inputSourceType: "path",
      hank: {
        configPath: selected,
        displayPath: undefined,
        skipSchemaRewrite: false,
        executionMetadata: {},
      },
    });
  });

  it("treats a directory named *.hank as an ordinary local hank", async () => {
    const cwd = temp();
    const file = localHank(path.join(cwd, "folder.hank"));
    const source = await resolveStartupSource({ hankPath: "folder.hank" }, cwd);
    expect(source.hank.configPath).toBe(file);
    expect(source.hank.skipSchemaRewrite).toBe(false);
    expect(source.hank.executionMetadata).toEqual({});
  });

  it("discovers the hank in the input directory before using replay metadata", async () => {
    const cwd = temp();
    const discovered = localHank(path.join(cwd, "data"));
    recording(cwd, {
      hankPath: localHank(),
      readOnlySourceDataPath: temp(),
      bundleHash: "old-bundle",
      bundlePath: "/removed.hank",
    });
    const source = await resolveStartupSource({ dataPath: "data", replayDir: "recording" }, cwd);
    expect(source.dataPath).toBe(path.join(cwd, "data"));
    expect(source.hank.configPath).toBe(discovered);
    expect(source.hank.skipSchemaRewrite).toBe(false);
    expect(source.hank.executionMetadata).toEqual({});
  });

  it("defaults to cwd/hank.json when no source is found", async () => {
    const cwd = temp();
    const source = await resolveStartupSource({}, cwd);
    expect(source.dataPath).toBe(cwd);
    expect(source.hank.configPath).toBe(path.join(cwd, "hank.json"));
    expect(source.hank.skipSchemaRewrite).toBe(false);
  });

  it("recovers resume input before discovering its hank, unless input was explicit", async () => {
    const cwd = temp();
    const resumed = localHank();
    recording(cwd, { readOnlySourceDataPath: path.dirname(resumed) });
    const source = await resolveStartupSource({ executionPath: "recording" }, cwd);
    expect(source.dataPath).toBe(path.dirname(resumed));
    expect(source.hank.configPath).toBe(resumed);
    const explicit = await resolveStartupSource({ executionPath: "recording", dataPath: "." }, cwd);
    expect(explicit.dataPath).toBe(cwd);
    expect(explicit.hank.configPath).toBe(path.join(cwd, "hank.json"));
  });

  it("preserves verified bytes and provenance when replaying after archive removal", async () => {
    const cwd = temp();
    const packed = bundle(cwd);
    const source = await resolveStartupSource({ hankPath: "input.hank" }, cwd);
    dirs.push(path.dirname(source.hank.configPath));
    const bytes = fs.readFileSync(source.hank.configPath);
    expect(source.hank.displayPath).toBe("input.hank");
    expect(source.hank.skipSchemaRewrite).toBe(true);
    expect(source.hank.executionMetadata).toEqual({
      bundleHash: packed.hash,
      bundlePath: packed.file,
    });

    recording(cwd, {
      hankPath: source.hank.configPath,
      readOnlySourceDataPath: cwd,
      ...source.hank.executionMetadata,
    });
    fs.unlinkSync(packed.file);
    const replay = await resolveStartupSource({ replayDir: "recording" }, cwd);
    expect(replay.hank.configPath).toBe(source.hank.configPath);
    expect(replay.hank.displayPath).toBe(packed.file);
    expect(replay.hank.skipSchemaRewrite).toBe(true);
    expect(replay.hank.executionMetadata).toEqual(source.hank.executionMetadata);
    expect(fs.readFileSync(replay.hank.configPath)).toEqual(bytes);
  });

  it("does not attach recorded bundle identity to an explicitly selected local hank", async () => {
    const cwd = temp();
    const replacement = localHank(path.join(cwd, "replacement"));
    const data = temp();
    recording(cwd, {
      hankPath: localHank(),
      readOnlySourceDataPath: data,
      bundleHash: "old-bundle",
      bundlePath: "/removed.hank",
    });
    const source = await resolveStartupSource(
      { configPath: "replacement", replayDir: "recording" },
      cwd,
    );
    expect(source.dataPath).toBe(data);
    expect(source.hank.configPath).toBe(replacement);
    expect(source.hank.skipSchemaRewrite).toBe(false);
    expect(source.hank.displayPath).toBeUndefined();
    expect(source.hank.executionMetadata).toEqual({});
  });

  it("uses the selected bundle's identity when replacing a recorded bundle", async () => {
    const cwd = temp();
    const packed = bundle(cwd);
    recording(cwd, { hankPath: localHank(), bundleHash: "old-bundle", bundlePath: "/old.hank" });
    const source = await resolveStartupSource(
      { hankPath: "input.hank", replayDir: "recording" },
      cwd,
    );
    dirs.push(path.dirname(source.hank.configPath));
    expect(source.hank.executionMetadata).toEqual({
      bundleHash: packed.hash,
      bundlePath: packed.file,
    });
    expect(source.hank.skipSchemaRewrite).toBe(true);
  });

  it("supports legacy replay metadata and ignores broken metadata", async () => {
    const cwd = temp();
    const hankPath = localHank();
    const dir = recording(cwd, { hankPath, readOnlySourceDataPath: temp() });
    const source = await resolveStartupSource({ replayDir: "recording" }, cwd);
    expect(source.hank.configPath).toBe(hankPath);
    expect(source.hank.skipSchemaRewrite).toBe(false);
    expect(source.hank.executionMetadata).toEqual({});
    fs.writeFileSync(new ExecutionLayout(dir).metaPath, "broken json");
    const fallback = await resolveStartupSource({ replayDir: "recording" }, cwd);
    expect(fallback.hank.configPath).toBe(path.join(cwd, "hank.json"));
    expect(fallback.dataPath).toBe(cwd);
  });

  it("keeps inline input stable and does not substitute replay data", async () => {
    const cwd = temp();
    const home = spyOn(os, "homedir").mockReturnValue(temp());
    try {
      const hankPath = localHank(cwd);
      recording(cwd, { hankPath: localHank(), readOnlySourceDataPath: temp() });
      const args = { inputText: "startup source test input", replayDir: "recording" };
      const first = await resolveStartupSource(args, cwd);
      const modifiedAt = fs.statSync(first.dataPath).mtimeMs;
      const second = await resolveStartupSource(args, cwd);
      expect(first.inputSourceType).toBe("inline-text");
      expect(second.dataPath).toBe(first.dataPath);
      expect(fs.statSync(second.dataPath).mtimeMs).toBe(modifiedAt);
      expect(fs.readFileSync(first.dataPath, "utf8")).toBe(args.inputText);
      // Inline input does not discover cwd/hank.json ahead of the recorded hank.
      expect(first.hank.configPath).not.toBe(hankPath);
    } finally {
      home.mockRestore();
    }
  });

  it("resolves remote sources to a local config while retaining their URL for display", async () => {
    const cwd = temp();
    const hankPath = localHank();
    const url = "https://github.com/example/hank";
    const fetch = spyOn(remoteHank, "resolveRemoteHank").mockResolvedValue({
      repoPath: path.dirname(hankPath),
      hankPath,
      wasFresh: true,
      cachedAt: new Date(),
      resolvedRef: "feature/branch",
    });
    try {
      const source = await resolveStartupSource({ hankPath: url }, cwd);
      expect(fetch).toHaveBeenCalledWith(url);
      expect(source.hank.configPath).toBe(hankPath);
      expect(source.hank.displayPath).toBe(url);
      expect(source.hank.skipSchemaRewrite).toBe(false);
      expect(source.hank.executionMetadata).toEqual({});
    } finally {
      fetch.mockRestore();
    }
  });

  it("reports unloadable bundle and remote sources as StartupSourceError", async () => {
    const missing = resolveStartupSource({ hankPath: "missing.hank" }, temp());
    await expect(missing).rejects.toThrow(StartupSourceError);
    await expect(missing).rejects.toThrow("does not exist");
    const fetch = spyOn(remoteHank, "resolveRemoteHank").mockRejectedValue(new Error("no route"));
    try {
      const remote = resolveStartupSource({ hankPath: "https://github.com/example/hank" }, temp());
      await expect(remote).rejects.toThrow(StartupSourceError);
      await expect(remote).rejects.toThrow("Failed to fetch remote hank: no route");
    } finally {
      fetch.mockRestore();
    }
  });
});
