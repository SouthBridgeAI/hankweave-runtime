import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HankDir } from "../../server/hank-dir.js";

describe("HankRef context", () => {
  let tempDir: string;
  let hank: HankDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hank-ref-context-"));
    hank = new HankDir(path.join(tempDir, "hank"));
  });

  afterEach(() => {
    hank.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("binds context without requiring the hank or source to exist", () => {
    const ref = hank.ref("prompts/./main.md");
    expect(ref.root).toBe(hank.root);
    expect(ref.baseDir).toBe(hank.root);
    expect(ref.path as string).toBe(path.join(hank.root, "prompts/main.md"));
    expect(ref.raw).toBe("prompts/./main.md");
    expect(fs.existsSync(hank.root)).toBe(false);
    expect(hank.rootRuleSource()).toBeUndefined();
  });

  test("reads from the captured base while enforcing the separate hank boundary", () => {
    const baseDir = path.join(hank.root, "sentinels/nested");
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(path.join(hank.root, "sentinels/prompt.md"), "nested prompt");
    fs.writeFileSync(path.join(hank.root, "prompt.md"), "wrong base");
    const options = { baseDir };
    const ref = hank.ref("../prompt.md", options);
    options.baseDir = hank.root;

    expect(ref.validate()).toBeNull();
    expect(ref.readText({ what: "Prompt" }).text).toBe("nested prompt");
    expect(hank.ref("../../../outside.md", { baseDir }).validate()?.kind).toBe("escapes");
  });

  test("distinguishes authored absolute references from resolved loader paths", async () => {
    fs.mkdirSync(hank.root);
    const absolutePath = path.join(hank.root, "prompt.md");
    fs.writeFileSync(absolutePath, "prompt");
    const authored = hank.ref(absolutePath);
    expect(authored.path as string).toBe(absolutePath);
    expect(authored.validate()?.kind).toBe("absolute");
    expect(() => authored.readText({ what: "Prompt" })).toThrow(/absolute/);
    await expect(authored.inspect()).rejects.toThrow(/absolute/);

    const resolved = hank.refFromPath(absolutePath);
    expect(resolved.raw).toBe("prompt.md");
    expect(resolved.readText({ what: "Prompt" }).text).toBe("prompt");
    expect(await resolved.inspect()).toEqual({ text: "prompt", bytes: 6 });
    expect(hank.refFromPath(hank.root).isRoot()).toBe(true);
    expect(() => hank.refFromPath("prompt.md")).toThrow(/absolute source path/);
  });

  test("resolved paths still undergo containment checks", () => {
    fs.mkdirSync(hank.root);
    const absolutePath = path.join(tempDir, "outside.md");
    fs.writeFileSync(absolutePath, "outside");
    const ref = hank.refFromPath(absolutePath);
    expect(ref.validate()?.kind).toBe("escapes");
    expect(() => ref.readText({ what: "Prompt" })).toThrow(/outside the hank/);
  });

  test("copy-tree validation uses the reference's base directory", () => {
    const baseDir = path.join(hank.root, "sentinels");
    fs.mkdirSync(path.join(baseDir, "templates"), { recursive: true });
    fs.writeFileSync(path.join(baseDir, "templates/.gitignore"), "*.log\n");
    const ref = hank.ref("templates", { baseDir });
    expect(hank.validateCopyTree(ref)?.kind).toBe("tree-nested-gitignore");
  });

  test("copy-tree validation checks the reference before consulting tree rules", () => {
    fs.mkdirSync(path.join(hank.root, ".gitignore"), { recursive: true });
    expect(hank.validateCopyTree(hank.ref("../outside"))?.kind).toBe("escapes");
    expect(hank.rootRuleSource()).toBeUndefined();
    const other = new HankDir(path.join(tempDir, "other"));
    expect(() => hank.validateCopyTree(other.ref("templates"))).toThrow(/different hank/);
  });
});
