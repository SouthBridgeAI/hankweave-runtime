import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HankConfigFile } from "../../server/hank-dir.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hank-config-file-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function write(rel: string, content = "x"): void {
  const abs = path.join(tempDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("HankConfigFile", () => {
  test.skipIf(process.platform === "win32")(
    "reads and updates through the selected symlink",
    () => {
      write("configs/actual.json", "original");
      const alias = path.join(tempDir, "alias.json");
      fs.symlinkSync("configs/actual.json", alias);
      const config = HankConfigFile.fromInput(alias);
      expect(config.path).toBe(alias);
      expect(config.updateText((text) => `${text} updated`)).toBe(true);
      expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(tempDir, "configs/actual.json"), "utf8")).toBe(
        "original updated",
      );
      const snapshot = config.readSnapshot();
      expect(snapshot.kind).toBe("file");
      if (snapshot.kind !== "file") throw new Error("expected config bytes");
      expect(snapshot.bytes.toString("utf8")).toBe("original updated");
    },
  );

  test("config entry points use disk type before the missing-path spelling heuristic", () => {
    write("custom.config");
    fs.mkdirSync(path.join(tempDir, "directory.json"));
    for (const [input, expected] of [
      ["custom.config", "custom.config"],
      ["directory.json", "directory.json/hank.json"],
      ["missing.json", "missing.json"],
      ["missing", "missing/hank.json"],
    ]) {
      const relativeInput = path.relative(process.cwd(), path.join(tempDir, input));
      expect(HankConfigFile.fromInput(relativeInput).path).toBe(path.join(tempDir, expected));
    }
  });

  test("config snapshots refuse oversized and irregular inputs before reading", () => {
    write("custom.json", "é\n");
    const configPath = path.join(tempDir, "custom.json");
    const config = new HankConfigFile(configPath);
    const readSpy = spyOn(fs, "readFileSync");
    try {
      expect(config.readSnapshot({ maxBytes: 2 })).toEqual({
        kind: "too-large",
        size: 3,
      });
      expect(new HankConfigFile(tempDir).readSnapshot({ maxBytes: 100 })).toEqual({
        kind: "irregular",
      });
      expect(() =>
        new HankConfigFile(path.join(tempDir, "missing.json")).readSnapshot({ maxBytes: 100 }),
      ).toThrow(/ENOENT/);
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
    const snapshot = config.readSnapshot({ maxBytes: 3 });
    expect(snapshot.kind).toBe("file");
    if (snapshot.kind !== "file") throw new Error("expected config bytes");
    expect(snapshot.bytes).toEqual(Buffer.from("é\n"));
    expect(snapshot.stats.size).toBe(3);
  });

  test("reads a config snapshot without a size limit or copy-tree rules", () => {
    write("custom.json", '{"hank":[]}\n');
    // A malformed rules file must not interfere with reading a config entry point.
    fs.mkdirSync(path.join(tempDir, ".gitignore"));
    const absolute = path.join(tempDir, "custom.json");
    for (const configPath of [absolute, path.relative(process.cwd(), absolute)]) {
      const source = new HankConfigFile(configPath).readSnapshot();
      expect(source.kind).toBe("file");
      if (source.kind !== "file") throw new Error("expected config bytes");
      expect(source.bytes.toString("utf-8")).toBe('{"hank":[]}\n');
    }
  });

  test("reports missing/non-regular configs and never creates them on update", () => {
    const missing = path.join(tempDir, "missing.json");
    expect(() => new HankConfigFile(missing).readSnapshot()).toThrow(/ENOENT/);
    expect(new HankConfigFile(tempDir).readSnapshot()).toEqual({ kind: "irregular" });
    expect(new HankConfigFile(missing).updateText(() => "new")).toBe(false);
    expect(new HankConfigFile(tempDir).updateText(() => "new")).toBe(false);
    expect(fs.existsSync(missing)).toBe(false);
  });

  test("updates a config only when the caller changes its text", () => {
    write("custom.json", "original\n");
    const configPath = path.join(tempDir, "custom.json");
    fs.utimesSync(configPath, new Date(0), new Date(0));
    expect(new HankConfigFile(configPath).updateText((text) => text)).toBe(false);
    expect(fs.statSync(configPath).mtimeMs).toBe(0);
    expect(new HankConfigFile(configPath).updateText((text) => `${text}updated\n`)).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toBe("original\nupdated\n");
  });
});
