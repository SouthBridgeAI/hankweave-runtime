import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HankDir } from "../../server/hank-dir.js";

/**
 * HankDir.validateCopyTree — the loader's copy-tree scan, run through THE
 * hank walk with git's own ignore verdicts: junk trees (and anything hiding
 * inside them) are invisible, while violations in the KEPT part of a tree
 * still reject the hank.
 */

const isWindows = process.platform === "win32";

const tempDirs: string[] = [];
const hanks: HankDir[] = [];
afterEach(() => {
  for (const hank of hanks.splice(0)) hank.dispose();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempHank(): { dir: string; hank: HankDir } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "copy-tree-ignore-"));
  tempDirs.push(dir);
  const hank = new HankDir(dir);
  hanks.push(hank);
  return { dir, hank };
}

describe("validateCopyTree with the ignore rules", () => {
  it.skipIf(isWindows)("does not see a symlink inside an ignored directory", () => {
    const { dir, hank } = tempHank();
    fs.mkdirSync(path.join(dir, "tpl/node_modules/.bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tpl/keep.md"), "kept\n");
    fs.symlinkSync("../pkg/cli.js", path.join(dir, "tpl/node_modules/.bin/cli"));

    expect(hank.validateCopyTree(hank.ref("./tpl"))).toBeNull();
  });

  it.skipIf(isWindows)("still rejects a symlink outside ignored directories", () => {
    const { dir, hank } = tempHank();
    fs.mkdirSync(path.join(dir, "tpl/sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tpl/keep.md"), "kept\n");
    fs.symlinkSync("keep.md", path.join(dir, "tpl/sub/link.md"));

    expect(hank.validateCopyTree(hank.ref("./tpl"))).toEqual({
      kind: "tree-symlink",
      raw: "./tpl",
      entry: path.join(hank.root, "tpl/sub/link.md"),
    });
  });

  it.skipIf(isWindows)(
    "an authored .gitignore that leaves node_modules included exposes its symlinks",
    () => {
      const { dir, hank } = tempHank();
      fs.mkdirSync(path.join(dir, "tpl/node_modules"), { recursive: true });
      fs.writeFileSync(path.join(dir, "tpl/keep.md"), "kept\n");
      fs.symlinkSync("../keep.md", path.join(dir, "tpl/node_modules/link.md"));
      fs.writeFileSync(path.join(dir, ".gitignore"), "custom/\n");

      expect(hank.validateCopyTree(hank.ref("./tpl"))?.kind).toBe("tree-symlink");
    },
  );

  it("authored rules replace defaults: validation enters node_modules when not excluded", () => {
    const { dir, hank } = tempHank();
    fs.mkdirSync(path.join(dir, "tpl/node_modules/deep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tpl/keep.md"), "kept\n");
    fs.writeFileSync(path.join(dir, "tpl/node_modules/deep/.gitignore"), "junk/\n");
    fs.writeFileSync(path.join(dir, ".gitignore"), "custom/\n");

    expect(hank.validateCopyTree(hank.ref("./tpl"))).toEqual({
      kind: "tree-nested-gitignore",
      raw: "./tpl",
      entry: path.join(dir, "tpl/node_modules/deep/.gitignore"),
    });
  });

  it("a NESTED .gitignore inside the copy tree is REJECTED (root-only rules)", () => {
    const { dir, hank } = tempHank();
    fs.mkdirSync(path.join(dir, "tpl/sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tpl/keep.md"), "kept\n");
    fs.writeFileSync(path.join(dir, "tpl/sub/.gitignore"), "generated/\n");

    expect(hank.validateCopyTree(hank.ref("./tpl"))).toEqual({
      kind: "tree-nested-gitignore",
      raw: "./tpl",
      entry: path.join(hank.root, "tpl/sub/.gitignore"),
    });
  });

  it("a nested .gitignore inside an IGNORED directory is invisible (pruned first)", () => {
    const { dir, hank } = tempHank();
    fs.mkdirSync(path.join(dir, "tpl/node_modules/pkg"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tpl/keep.md"), "kept\n");
    fs.writeFileSync(path.join(dir, "tpl/node_modules/pkg/.gitignore"), "dist\n");

    expect(hank.validateCopyTree(hank.ref("./tpl"))).toBeNull();
  });

  it("rejects a directory root that is itself ignored (parent-exclusion would empty it)", () => {
    const { dir, hank } = tempHank();
    fs.mkdirSync(path.join(dir, "dist"));
    fs.writeFileSync(path.join(dir, "dist/out.js"), "built\n");

    expect(hank.validateCopyTree(hank.ref("./dist"))).toEqual({
      kind: "tree-ignored-root",
      raw: "./dist",
    });
  });

  it("never consults the ignore rules for a FILE copy source", () => {
    const { dir, hank } = tempHank();
    fs.writeFileSync(path.join(dir, "single.md"), "one file\n");

    expect(hank.validateCopyTree(hank.ref("./single.md"))).toBeNull();
    // Never judged → the rules were never read and git never spawned.
    expect(hank.rootRuleSource()).toBeUndefined();
  });

  it("scale pin: a ~50-directory tree validates in one spawn per directory, not per file", () => {
    const { dir, hank } = tempHank();
    for (let d = 0; d < 50; d++) {
      for (let f = 0; f < 4; f++) {
        const abs = path.join(dir, "tpl", `dir-${d}`, `file-${f}.txt`);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, "x");
      }
    }
    const start = Date.now();
    expect(hank.validateCopyTree(hank.ref("./tpl"))).toBeNull();
    // ~51 spawnSync batches at a few ms each; per-FILE spawning (200+)
    // would blow well past this.
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
