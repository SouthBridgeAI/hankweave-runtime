import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { HankDir } from "../../server/hank-dir.js";
import type { FileNode } from "../../server/schemas/event-schemas.js";
import { CommandError } from "../../server/types/error-types.js";
import { Logger } from "../../server/utils.js";
import { CheckpointId, CheckpointNotFoundError } from "../../server/workspace/checkpoints.js";
import { Workspace } from "../../server/workspace/index.js";
import { createWorkspaceMatcher } from "../../server/workspace/patterns.js";
import { normalizeRigOperationFailure } from "../../server/workspace/rigs.js";
import { buildFileTree } from "../../server/workspace/tree.js";
import { requireHistoryTip } from "../utils/checkpoint-history.js";

/**
 * Workspace — the agent-workspace entity: git's file classes over the shadow
 * checkpoint repo, the mandatory exclusions, the visible surface, the
 * pattern dialect, what a checkpoint stages, the tool-use visibility
 * verdict, the file tree, and the copies in (rig) and out (outputs).
 */

const isWindows = process.platform === "win32";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

class MockLogger extends Logger {
  logs: Array<{ message: string; level: string }> = [];

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    this.logs.push({ message, level });
  }

  logSocketTraffic(_socketLogFile: string, _direction: "in" | "out", _data: unknown): void {
    // Mock implementation
  }
}

describe("createWorkspaceMatcher (fast-glob dialect)", () => {
  test("no positive patterns matches nothing", () => {
    expect(createWorkspaceMatcher([]).hasPositive).toBe(false);
    expect(createWorkspaceMatcher(["!skip.md"]).matches("a.md")).toBe(false);
  });

  test("negatives subtract globally regardless of order", () => {
    const m = createWorkspaceMatcher(["!notes/secret.md", "**/*.md"]);
    expect(m.matches("notes/plan.md")).toBe(true);
    expect(m.matches("notes/secret.md")).toBe(false);
  });

  test("dotfiles match; ./ prefix and duplicate slashes are normalized", () => {
    const m = createWorkspaceMatcher(["./src//**/*.ts"]);
    expect(m.matches("src/a/.hidden.ts")).toBe(true);
  });

  test("a bare directory name matches the directory's contents", () => {
    const m = createWorkspaceMatcher(["shim"]);
    expect(m.matches("shim/index.ts")).toBe(true);
    expect(m.matches("shim/deep/nested.ts")).toBe(true);
    expect(m.matches("shims/other.ts")).toBe(false);
  });

  test("negated directory names exclude the directory's contents", () => {
    const m = createWorkspaceMatcher(["**/*", "!shim"]);
    expect(m.matches("shim/index.ts")).toBe(false);
    expect(m.matches("other.ts")).toBe(true);
  });

  test("posix mode: negated character classes behave like fast-glob", () => {
    const m = createWorkspaceMatcher(["[!a]*.txt"]);
    expect(m.matches("b1.txt")).toBe(true);
    expect(m.matches("a1.txt")).toBe(false);
  });

  test("extglobs and braces preserve global exclusions across repeated matches", () => {
    const m = createWorkspaceMatcher(["!private", "*.{ts,js}", "!(private)/*.ts", "!**/*.test.ts"]);
    for (let pass = 0; pass < 2; pass++) {
      expect(m.matches("app.ts")).toBe(true);
      expect(m.matches("app.js")).toBe(true);
      expect(m.matches("src/app.ts")).toBe(true);
      expect(m.matches("private/app.ts")).toBe(false);
      expect(m.matches("src/app.test.ts")).toBe(false);
      expect(m.matches("app.test.ts")).toBe(false);
      expect(m.matches("app.md")).toBe(false);
    }
  });

  test("degenerate patterns that normalize to nothing do not throw", () => {
    const m = createWorkspaceMatcher(["**/*.md", "!./"]);
    expect(m.matches("notes/a.md")).toBe(true);
    expect(createWorkspaceMatcher(["./"]).hasPositive).toBe(false);
  });

  test("polarity is decided AFTER ./ is stripped — ./!foo is a negation, not a match-all", () => {
    // Regression: "./!foo" was classified positive, then fed to micromatch
    // where the leading "!" re-read as a negation and matched everything.
    const m = createWorkspaceMatcher(["./!foo"]);
    expect(m.hasPositive).toBe(false); // pure negation → matches nothing
    expect(m.matches("report.txt")).toBe(false);
    // And it still subtracts when paired with a real positive.
    const m2 = createWorkspaceMatcher(["**/*", "./!foo"]);
    expect(m2.matches("foo")).toBe(false);
    expect(m2.matches("bar")).toBe(true);
  });
});

describe("Workspace — paths and lifecycle", () => {
  test("opening prepares every capability over the supplied layout", async () => {
    const layout = new ExecutionLayout(tempDir);
    fs.mkdirSync(layout.agentRootPath);
    const ws = await Workspace.open(layout);
    expect(ws.rigs.workingDirFor("agentRoot")).toBe(layout.agentRootPath);
    const everything = ws.files.select(["**"]);
    expect(await everything.files()).toEqual([]);
    expect(everything.admit("x.md")).toBe("x.md");
    expect(everything.read("x.md")).toBeNull();
    fs.writeFileSync(path.join(layout.agentRootPath, "x.md"), "ready");
    expect(everything.read("x.md")?.content).toBe("ready");
    expect(await everything.tree()).toHaveLength(1);
    const id = await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "immediately usable",
      patterns: ["*.md"],
    });
    expect(await ws.archives.archive(everything, { kind: "codon", codonId: "step" }, id)).toEqual([
      { path: "x.md", status: "archived" },
    ]);
  });
});

describe("Workspace — git-backed listing over the shadow repo", () => {
  let workTree: string;
  let gitDir: string;
  let homeDir: string;

  function shadowGit(args: string[]): string {
    return execFileSync("git", args, {
      cwd: workTree,
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: workTree,
        HOME: homeDir,
        XDG_CONFIG_HOME: homeDir,
        GIT_CONFIG_NOSYSTEM: "1",
      } as NodeJS.ProcessEnv,
      encoding: "utf8",
    });
  }

  let workspace: Workspace;

  beforeEach(async () => {
    workTree = path.join(tempDir, "agentRoot");
    homeDir = path.join(tempDir, ".hankweave", "checkpoints");
    gitDir = path.join(homeDir, ".hankweavecheckpoints");
    fs.mkdirSync(workTree, { recursive: true });
    workspace = await Workspace.open(new ExecutionLayout(tempDir, { agentRootPath: workTree }));
  });

  function ws(): Workspace {
    return workspace;
  }
  // The whole visible surface is the all-matching selection.
  const present = () => ws().files.select(["**"]).files();
  const resolve = (patterns: string[]) => ws().files.select(patterns).files();
  const admit = (candidate: string) => ws().files.select(["**"]).admit(candidate);

  /** Take a checkpoint of `patterns` and return the paths its tree holds. */
  async function committed(patterns: string[]): Promise<string[]> {
    const w = ws();
    const sha = await w.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(w.checkpoints.history("main")),
      message: "test checkpoint",
      patterns,
    });
    return shadowGit(["ls-tree", "-r", "--name-only", "-z", sha]).split("\0").filter(Boolean);
  }

  function put(rel: string, content = "x"): void {
    const abs = path.join(workTree, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  test("admit normalizes absolute, ./-prefixed, and platform-separated paths", () => {
    expect(admit(path.join(workTree, "deep", "dir", "notes.md"))).toBe("deep/dir/notes.md");
    expect(admit("./root.md")).toBe("root.md");
    expect(admit("a//b.md")).toBe("a/b.md");
  });

  test("admit rejects escapes, the root itself, and the empty path", () => {
    expect(admit("../outside.md")).toBeNull();
    expect(admit(path.join(workTree, "..", "outside.md"))).toBeNull();
    expect(admit(path.join(workTree, ".."))).toBeNull();
    expect(admit("..")).toBeNull();
    expect(admit(path.resolve("/somewhere/else/notes.md"))).toBeNull();
    expect(admit("")).toBeNull();
    expect(admit(".")).toBeNull();
  });

  test("admit: a leading-dot-dot FILENAME is not an escape", () => {
    expect(admit("..notes.md")).toBe("..notes.md");
    expect(admit(path.join(workTree, "..notes.md"))).toBe("..notes.md");
    expect(admit("../notes.md")).toBeNull();
  });

  test("lists untracked non-ignored files, POSIX-relative", async () => {
    put("src/app.ts");
    put("notes.md");
    const files = await present();
    expect(files).toEqual(["notes.md", "src/app.ts"]);
    expect(files.some((f) => f.includes("\\"))).toBe(false);
  });

  test("workspace .gitignore rules apply, nested included", async () => {
    put(".gitignore", "*.log\n");
    put("sub/.gitignore", "!keep.log\n");
    put("sub/keep.log");
    put("sub/drop.log");
    put("app.log");
    const files = await present();
    expect(files).toContain("sub/keep.log");
    expect(files).not.toContain("sub/drop.log");
    expect(files).not.toContain("app.log");
  });

  test("a mid-run .gitignore edit takes effect on the NEXT resolve (no frozen cache)", async () => {
    put("volatile.md");
    expect(await resolve(["**/*.md"])).toEqual(["volatile.md"]);
    put(".gitignore", "volatile.md\n");
    expect(await resolve(["**/*.md"])).toEqual([]);
  });

  test("ignored directories are never entered (node_modules trap)", async () => {
    put(".gitignore", "node_modules/\n");
    put("node_modules/pkg/index.js");
    put("index.ts");
    const files = await present();
    expect(files).toEqual([".gitignore", "index.ts"]);
  });

  test("mandatory exclusions hold even against a negating workspace .gitignore", async () => {
    put(".gitignore", "!read_only_data_source/\n!read_only_data_source/**\n");
    put("read_only_data_source/data.csv");
    put("kept.txt");
    const files = await present();
    expect(files).toEqual([".gitignore", "kept.txt"]);
  });

  test.skipIf(isWindows)("symlinks are excluded from listings", async () => {
    put("real.txt");
    fs.symlinkSync(path.join(workTree, "real.txt"), path.join(workTree, "link.txt"));
    const files = await present();
    expect(files).toEqual(["real.txt"]);
  });

  test("an embedded git repository's contents vanish from listings", async () => {
    put("nested/inner.txt");
    execFileSync("git", ["init", "--quiet", path.join(workTree, "nested")], {
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        HOME: homeDir,
        GIT_CONFIG_NOSYSTEM: "1",
      } as NodeJS.ProcessEnv,
    });
    put("outer.txt");
    const files = await present();
    expect(files).toEqual(["outer.txt"]);
  });

  test("empty pattern list resolves to []", async () => {
    put("a.md");
    expect(await resolve([])).toEqual([]);
  });

  test("directory pattern resolves the directory's contents", async () => {
    put("shim/index.ts");
    put("shim/deep/util.ts");
    put("other.ts");
    expect(await resolve(["shim"])).toEqual(["shim/deep/util.ts", "shim/index.ts"]);
  });

  test("fileTree shapes the resolved set, one listing pass for every pattern", async () => {
    put("src/index.ts");
    put("src/utils/helper.ts");
    put("README.md");
    put("ignored.log");
    put(".gitignore", "*.log\n");
    const tree = await ws().files.select(["**/*.ts", "*.md"]).tree();
    expect(tree.map((n) => n.name).sort()).toEqual(["README.md", "src"]);
    const src = tree.find((n) => n.name === "src");
    expect(src?.isDirectory).toBe(true);
    expect(src?.children.map((c) => c.name).sort()).toEqual(["index.ts", "utils"]);
    const readme = tree.find((n) => n.name === "README.md");
    expect(readme?.isDirectory).toBe(false);
    expect(readme?.lastModified).toBeDefined();
  });

  test("tracked-then-ignored: still checkpoints, leaves the visible surface", async () => {
    put("state.json");
    shadowGit(["add", "--", "state.json"]);
    shadowGit(["commit", "-q", "-m", "initial"]);
    shadowGit(["update-ref", "refs/heads/main", shadowGit(["rev-parse", "HEAD"]).trim()]);
    put(".gitignore", "state.json\n");
    expect(await present()).not.toContain("state.json");
    expect(await committed(["**/*"])).toContain("state.json");
  });

  test("a checkpoint honors a workspace .gitignore live, nested subfolder included", async () => {
    // The precise behavior the checkpoint system must keep: an UNtracked
    // file ignored by a workspace .gitignore (root or nested) is never
    // staged, and the rules are read at checkpoint time (no frozen snapshot).
    put(".gitignore", "*.log\n");
    put("src/.gitignore", "generated/\n");
    put("src/app.ts");
    put("src/app.log"); // ignored by root rule
    put("src/generated/out.js"); // ignored by nested rule
    put("keep.txt");
    const tree = await committed(["**/*"]);
    expect(tree).toContain("src/app.ts");
    expect(tree).toContain("keep.txt");
    expect(tree).not.toContain("src/app.log");
    expect(tree).not.toContain("src/generated/out.js");
  });

  test.skipIf(isWindows)(
    "a tracked path reached through a symlinked ANCESTOR is excluded (protected-tree escape)",
    async () => {
      put("safe/data.csv", "innocent");
      shadowGit(["add", "--", "safe/data.csv"]);
      shadowGit(["commit", "-q", "-m", "initial"]);
      shadowGit(["update-ref", "refs/heads/main", shadowGit(["rev-parse", "HEAD"]).trim()]);
      // The agent swaps the directory for a symlink into the protected tree.
      put("read_only_data_source/data.csv", "PROTECTED");
      fs.rmSync(path.join(workTree, "safe"), { recursive: true });
      fs.symlinkSync(path.join(workTree, "read_only_data_source"), path.join(workTree, "safe"));
      // safe/data.csv now resolves inside read_only_data_source — it must
      // not be listable (and thus not archivable/movable), and a checkpoint
      // must never stage the protected content behind the old name.
      expect(await present()).not.toContain("safe/data.csv");
      await committed(["**/*"]);
      expect(shadowGit(["show", "refs/heads/main:safe/data.csv"])).toBe("innocent");
    },
  );

  test.skipIf(isWindows)(
    "a tracked regular file replaced by a symlink is checkpointed as a REMOVAL",
    async () => {
      put("report.txt", "original");
      shadowGit(["add", "--", "report.txt"]);
      shadowGit(["commit", "-q", "-m", "initial"]);
      shadowGit(["update-ref", "refs/heads/main", shadowGit(["rev-parse", "HEAD"]).trim()]);
      put("target.txt", "elsewhere");
      fs.rmSync(path.join(workTree, "report.txt"));
      fs.symlinkSync(path.join(workTree, "target.txt"), path.join(workTree, "report.txt"));
      // Neither silently kept (stale blob in every later checkpoint) nor
      // added — recorded as gone.
      const tree = await committed(["**/*"]);
      expect(tree).not.toContain("report.txt");
      expect(tree).toContain("target.txt");
    },
  );

  test("a checkpoint records tracked deletions", async () => {
    put("doomed.txt");
    shadowGit(["add", "--", "doomed.txt"]);
    shadowGit(["commit", "-q", "-m", "initial"]);
    shadowGit(["update-ref", "refs/heads/main", shadowGit(["rev-parse", "HEAD"]).trim()]);
    fs.rmSync(path.join(workTree, "doomed.txt"));
    expect(await committed(["**/*"])).not.toContain("doomed.txt");
  });

  test("a checkpoint purges historical index entries under mandatory exclusions", async () => {
    put("read_only_data_source/data.csv");
    shadowGit(["add", "-f", "--", "read_only_data_source/data.csv"]);
    shadowGit(["commit", "-q", "-m", "oops"]);
    shadowGit(["update-ref", "refs/heads/main", shadowGit(["rev-parse", "HEAD"]).trim()]);
    expect(await committed(["**/*"])).not.toContain("read_only_data_source/data.csv");
  });

  test("admit judges a tracked path by rules alone", async () => {
    put(".gitignore", "*.log\n");
    put("app.log");
    shadowGit(["add", "-f", "--", "app.log"]);
    expect(admit("app.log")).toBeNull();
    expect(admit("app.ts")).toBe("app.ts");
  });

  test("admit applies the SAME policy as the listing (event path can't diverge)", async () => {
    put("app.ts");
    put("app.log");
    put(".gitignore", "*.log\nbuild/\n");
    put(".git/config", "[core]"); // the hard .git rule
    put("read_only_data_source/secret", "PROTECTED");
    // Existing: the same verdicts as the listing.
    expect(admit("app.ts")).toBe("app.ts");
    expect(admit("app.log")).toBeNull();
    expect(admit("read_only_data_source/secret")).toBeNull();
    expect(admit(".git/config")).toBeNull();
    expect(admit("")).toBeNull();
    const files = await present();
    for (const hidden of ["app.log", "read_only_data_source/secret", ".git/config"]) {
      expect(files).not.toContain(hidden);
    }
    expect(files).toContain("app.ts");
    // Prospective (nothing there yet): admitted unless a rule or mandatory
    // exclusion says otherwise — including through directories that do not
    // exist yet.
    expect(admit("brand-new.ts")).toBe("brand-new.ts");
    expect(admit("new/deep/dir/file.ts")).toBe("new/deep/dir/file.ts");
    expect(admit("brand-new.log")).toBeNull();
    expect(admit("build/out.ts")).toBeNull();
    expect(admit("read_only_data_source/new.csv")).toBeNull();
    expect(admit("rigArchive/new.csv")).toBeNull();
    expect(admit(".git/new")).toBeNull();
    // An existing ancestor that is a FILE (not a directory) rejects the path.
    expect(admit("app.ts/child")).toBeNull();
  });

  test("admit re-reads rules live (a mid-run .gitignore edit applies to the next check)", async () => {
    expect(admit("output/tmp/x.md")).toBe("output/tmp/x.md");
    put(".gitignore", "output/tmp/\n");
    expect(admit("output/tmp/x.md")).toBeNull();
  });

  test.skipIf(isWindows)(
    "admit rejects symlinks and paths through a symlinked ancestor, existing or not",
    async () => {
      put("read_only_data_source/secret", "PROTECTED");
      put("real.txt");
      fs.symlinkSync(path.join(workTree, "read_only_data_source"), path.join(workTree, "link"));
      fs.symlinkSync(path.join(workTree, "real.txt"), path.join(workTree, "alias.txt"));
      // link/secret resolves inside the protected tree — the file tree omits
      // it, so an event for it must be suppressed too.
      expect(admit("link/secret")).toBeNull();
      expect(admit("link/not-yet-there")).toBeNull();
      // A plain non-regular target (the symlink itself) is rejected as well.
      expect(admit("alias.txt")).toBeNull();
      expect(admit("real.txt")).toBe("real.txt");
      expect(await present()).toEqual(["real.txt"]);
    },
  );

  test("select: a pattern-scoped view that lists, admits, and reads", async () => {
    put("src/app.ts", "export {}");
    put("src/app.log");
    put("README.md", "# hi");
    put(".gitignore", "*.log\n");
    const sel = ws().files.select(["src/**"]);
    expect(await sel.files()).toEqual(["src/app.ts"]);
    expect((await sel.tree()).map((n) => n.name)).toEqual(["src"]);
    // admit: normalizes any spelling, then patterns, then policy.
    expect(sel.admit(path.join(workTree, "src", "app.ts"))).toBe("src/app.ts");
    expect(sel.admit("./src//app.ts")).toBe("src/app.ts");
    expect(sel.admit("src/new.ts")).toBe("src/new.ts"); // prospective
    expect(sel.admit("src/app.log")).toBeNull(); // ignored
    expect(sel.admit("README.md")).toBeNull(); // outside the patterns
    expect(sel.admit("../outside.ts")).toBeNull(); // escapes the workspace
    expect(sel.admit("")).toBeNull();
    // read: body and mtime, null for missing or excluded files.
    const file = sel.read("src/app.ts");
    expect(file?.content).toBe("export {}");
    expect(file?.lastModified).toBeInstanceOf(Date);
    expect(sel.read("src/missing.ts")).toBeNull();
    expect(sel.read("src")).toBeNull();
  });

  test("select reads normalize candidates and enforce patterns and workspace containment", () => {
    put("src/app.ts", "export {}");
    put("src/private.ts", "excluded by a negative pattern");
    put("README.md", "outside the selection");
    fs.writeFileSync(path.join(tempDir, "outside.ts"), "outside the workspace");
    const sel = ws().files.select(["**/*.ts", "!src/private.ts"]);

    for (const candidate of ["src/app.ts", "./src//app.ts", path.join(workTree, "src", "app.ts")]) {
      expect(sel.read(candidate)?.content).toBe("export {}");
    }
    for (const candidate of [
      "src/private.ts",
      "README.md",
      "../outside.ts",
      path.join(tempDir, "outside.ts"),
      "",
      ".",
      "src/missing.ts",
    ]) {
      expect(sel.read(candidate)).toBeNull();
    }
  });

  test("read never spawns git: a listed file reads without a per-file ignore verdict", async () => {
    // Codon start lists once (git, rules applied) and then reads every
    // listed file. The read must not re-run `git check-ignore` per file:
    // that was one blocking subprocess per watched file at every start.
    for (let i = 0; i < 25; i++) put(`src/f${i}.ts`, `export const f${i} = ${i};`);
    put("src/skip.log", "ignored");
    put(".gitignore", "*.log\n");
    const sel = ws().files.select(["src/**"]);
    const listed = await sel.files();
    expect(listed).toHaveLength(25);

    const spawnSyncSpy = spyOn(childProcess, "spawnSync");
    try {
      for (const rel of listed) {
        const i = path.basename(rel, ".ts").slice(1);
        expect(sel.read(rel)?.content).toBe(`export const f${i} = ${i};`);
      }
      expect(spawnSyncSpy).toHaveBeenCalledTimes(0);
      // admit is the door that asks git — once per candidate, by design.
      expect(sel.admit("src/f0.ts")).toBe("src/f0.ts");
      expect(spawnSyncSpy).toHaveBeenCalledTimes(1);
    } finally {
      spawnSyncSpy.mockRestore();
    }

    // The in-process guards survive: a listed path that is no longer a
    // regular file, escapes the workspace, or falls outside the patterns
    // still reads as null.
    fs.rmSync(path.join(workTree, "src", "f1.ts"));
    fs.mkdirSync(path.join(workTree, "src", "f1.ts"));
    expect(sel.read("src/f1.ts")).toBeNull();
    if (process.platform !== "win32") {
      fs.rmSync(path.join(workTree, "src", "f2.ts"));
      fs.symlinkSync(path.join(workTree, "src", "f3.ts"), path.join(workTree, "src", "f2.ts"));
      expect(sel.read("src/f2.ts")).toBeNull();
    }
    expect(sel.read("src/gone.ts")).toBeNull();
    expect(sel.read("../outside.ts")).toBeNull();
    expect(sel.read("README.md")).toBeNull();
  });

  test("reused selections keep their patterns while reading live files and ignore rules", async () => {
    put("src/app.ts", "export {}");
    await committed(["src/**"]);
    const patterns = ["**/*.ts", "!src/private.ts"];
    const sel = ws().files.select(patterns);
    patterns.splice(0, patterns.length, "**/*.md");
    const [listed] = await sel.files();
    expect(listed).toBe("src/app.ts");
    expect(sel.read(listed)?.content).toBe("export {}");

    const treeFiles = async () => {
      const paths: string[] = [];
      const visit = (nodes: FileNode[]) => {
        for (const node of nodes) {
          if (node.isDirectory) visit(node.children ?? []);
          else paths.push(node.path.split(path.sep).join("/"));
        }
      };
      visit(await sel.tree());
      return paths.sort();
    };
    expect(await treeFiles()).toEqual(["src/app.ts"]);

    put("src/.gitignore", "app.ts\n");
    put("src/new.ts", "new");
    put("src/private.ts", "private");
    put("README.md", "outside original patterns");
    expect(await sel.files()).toEqual(["src/new.ts"]);
    expect(await treeFiles()).toEqual(["src/new.ts"]);
    expect(sel.admit(listed)).toBeNull();
    // read trusts the verdict the caller holds and does not re-ask git:
    // the now-ignored file still reads until a fresh files()/admit() drops it.
    expect(sel.read(listed)?.content).toBe("export {}");
    expect(sel.read("src/new.ts")?.content).toBe("new");
    expect(sel.read("src/private.ts")).toBeNull();
    expect(sel.read("README.md")).toBeNull();

    put("src/.gitignore", "");
    fs.unlinkSync(path.join(workTree, "src/new.ts"));
    expect(await sel.files()).toEqual(["src/app.ts"]);
    expect(await treeFiles()).toEqual(["src/app.ts"]);
    expect(sel.admit(listed)).toBe(listed);
    expect(sel.read(listed)?.content).toBe("export {}");
  });

  test("select reads propagate unexpected file read failures", () => {
    put("app.ts", "export {}");
    const sel = ws().files.select(["**/*.ts"]);
    const failure = Object.assign(new Error("read failed"), { code: "EIO" });
    const read = spyOn(fs, "readFileSync").mockImplementation(() => {
      throw failure;
    });
    try {
      expect(() => sel.read("app.ts")).toThrow(failure);
    } finally {
      read.mockRestore();
    }
  });

  test("select reads reject mandatory exclusions and git metadata", () => {
    put("read_only_data_source/secret.txt", "protected");
    put("rigArchive/secret.txt", "archived");
    put(".git/config", "metadata");
    put(".gitignore", "!read_only_data_source/\n!rigArchive/\n!.git/\n");
    const sel = ws().files.select(["**"]);

    expect(sel.read("read_only_data_source/secret.txt")).toBeNull();
    expect(sel.read("rigArchive/secret.txt")).toBeNull();
    expect(sel.read(".git/config")).toBeNull();
  });

  test.skipIf(isWindows)("select reads reject symlinks introduced after listing", async () => {
    put("safe/data.txt", "visible");
    put("read_only_data_source/data.txt", "protected");
    const sel = ws().files.select(["**/*.txt"]);
    expect(await sel.files()).toEqual(["safe/data.txt"]);

    fs.rmSync(path.join(workTree, "safe"), { recursive: true });
    fs.symlinkSync(path.join(workTree, "read_only_data_source"), path.join(workTree, "safe"));
    fs.symlinkSync(
      path.join(workTree, "read_only_data_source/data.txt"),
      path.join(workTree, "alias.txt"),
    );

    expect(sel.read("safe/data.txt")).toBeNull();
    expect(sel.read("alias.txt")).toBeNull();
  });

  test("select with no positive pattern matches nothing", async () => {
    put("a.md");
    const sel = ws().files.select(["!skip.md"]);
    expect(await sel.files()).toEqual([]);
    expect(sel.admit("a.md")).toBeNull();
    expect(sel.read("a.md")).toBeNull();
    expect(ws().files.select([]).read("a.md")).toBeNull();
  });

  test("adversarial filenames survive the round trip", async () => {
    put("--all");
    put("with space.txt");
    // ":" and tab are ILLEGAL filename characters on NTFS — these two
    // adversaries only exist on POSIX filesystems.
    if (!isWindows) {
      put(":(glob)tricky.txt");
      put("with\ttab.txt");
    }
    const files = await present();
    expect(files).toContain("--all");
    expect(files).toContain("with space.txt");
    if (!isWindows) {
      expect(files).toContain(":(glob)tricky.txt");
      expect(files).toContain("with\ttab.txt");
    }
  });

  test("mandatory exclusions answer by path alone, case/Unicode-folded, at any depth", () => {
    expect(ExecutionLayout.isMandatoryExcluded("read_only_data_source/data.csv")).toBe(true);
    expect(ExecutionLayout.isMandatoryExcluded("READ_ONLY_DATA_SOURCE/data.csv")).toBe(true);
    expect(ExecutionLayout.isMandatoryExcluded("RigArchive/x")).toBe(true);
    expect(ExecutionLayout.isMandatoryExcluded("project/.hankweave/runs/state.json")).toBe(true);
    expect(ExecutionLayout.isMandatoryExcluded("a/.HankweaveCheckpoints/objects/ab")).toBe(true);
    expect(ExecutionLayout.isMandatoryExcluded("a/.hankweavecheckpoints-quarantine-x/y")).toBe(
      true,
    );
    expect(ExecutionLayout.isMandatoryExcluded("src/read_only_data_source/x.txt")).toBe(false);
    expect(ExecutionLayout.isMandatoryExcluded("src/app.ts")).toBe(false);
    expect(ExecutionLayout.CHECKPOINT_INFO_EXCLUDE).toContain("/read_only_data_source/");
    expect(ExecutionLayout.CHECKPOINT_INFO_EXCLUDE).toContain("/rigArchive/");
  });

  test("scale: a 1000-rule .gitignore resolves without the glob-everything walk", async () => {
    const rules = Array.from({ length: 1000 }, (_, i) => `junk-${i}/`).join("\n");
    put(".gitignore", rules);
    for (let i = 0; i < 100; i++) put(`keep/file-${i}.txt`);
    put("junk-5/never.txt");
    const start = Date.now();
    const files = await resolve(["keep/**/*"]);
    expect(files.length).toBe(100);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("buildFileTree (the filetree.updated shape)", () => {
  const at = "2025-01-01T00:00:00.000Z";
  const build = (paths: string[]) =>
    buildFileTree(paths.map((p) => ({ path: p, lastModified: at })));

  test("builds tree from flat file list", () => {
    const tree = build(["file1.txt", "file2.txt"]);
    expect(tree).toHaveLength(2);
    expect(tree.map((node) => node.name).sort()).toEqual(["file1.txt", "file2.txt"]);
    for (const node of tree) {
      expect(node.isDirectory).toBe(false);
      expect((node as FileNode & { isDirectory: false }).lastModified).toBe(at);
    }
  });

  test("handles nested directories correctly", () => {
    const tree = build(["src/index.ts", "src/utils/helper.ts"]);
    const srcNode = tree.find((node) => node.name === "src");
    expect(srcNode?.isDirectory).toBe(true);
    const indexFile = srcNode?.children?.find((child) => child.name === "index.ts");
    expect(indexFile?.isDirectory).toBe(false);
    const utilsDir = srcNode?.children?.find((child) => child.name === "utils");
    expect(utilsDir?.isDirectory).toBe(true);
    const helperFile = utilsDir?.children?.find((child) => child.name === "helper.ts");
    expect(helperFile?.isDirectory).toBe(false);
  });

  test("sorts files within directories", () => {
    const tree = build(["b.txt", "a.txt", "c.txt"]);
    expect(tree.map((node) => node.name)).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  test("marks directories with isDirectory flag and strips a leading ./", () => {
    const tree = build(["./dir/file.txt"]);
    const dirNode = tree.find((node) => node.name === "dir");
    expect(dirNode?.isDirectory).toBe(true);
    expect(dirNode?.path).toBe("dir");
    const fileInDir = dirNode?.children?.find((child) => child.name === "file.txt");
    expect(fileInDir?.isDirectory).toBe(false);
  });

  test("handles an empty list", () => {
    expect(build([])).toEqual([]);
  });

  test("handles files at root level beside directories", () => {
    const tree = build(["root.txt", "dir/nested.txt"]);
    const rootFile = tree.find((node) => node.name === "root.txt");
    expect(rootFile?.path).toBe("root.txt");
    expect(rootFile?.isDirectory).toBe(false);
    const dirNode = tree.find((node) => node.name === "dir");
    expect(dirNode?.isDirectory).toBe(true);
    const nestedFile = dirNode?.children?.find((child) => child.name === "nested.txt");
    expect(nestedFile?.isDirectory).toBe(false);
  });
});

describe("rig operation failures", () => {
  test("preserves the command error and exit code", () => {
    const error = new CommandError("Command failed", 7, "output", "diagnostic");
    const failure = normalizeRigOperationFailure(error, "command");
    expect(failure.error).toBe(error);
    expect(failure.exitCode).toBe(7);
    expect(failure.failureType).toBe("command_failed");
  });

  test.each(["TIMED OUT", "Timeout", "ETIMEDOUT"])(
    "%s in the message or stderr takes precedence over command failure",
    (message) => {
      expect(normalizeRigOperationFailure(new Error(message), "copy").failureType).toBe("timeout");
      const failure = normalizeRigOperationFailure(
        new CommandError("Command failed", 1, "", message),
        "command",
      );
      expect(failure.failureType).toBe("timeout");
      expect(failure.exitCode).toBe(1);
    },
  );

  test("generic failures have no exit code and are classified by operation", () => {
    const error = new Error("Source path does not exist");
    expect(normalizeRigOperationFailure(error, "copy")).toEqual({
      error,
      exitCode: undefined,
      failureType: "other",
    });
    const failure = normalizeRigOperationFailure("spawn failed", "command");
    expect(failure.error.message).toBe("spawn failed");
    expect(failure.exitCode).toBeUndefined();
    expect(failure.failureType).toBe("command_failed");
  });
});

describe("Workspace.plantRigCopy (rig copies in)", () => {
  test("source-side checks: missing source, missing target parent", async () => {
    const agentRoot = path.join(tempDir, "agentRoot");
    fs.mkdirSync(agentRoot);
    const ws = await Workspace.open(new ExecutionLayout(tempDir, { agentRootPath: agentRoot }));
    const hankDir = path.join(tempDir, "hank");
    fs.mkdirSync(path.join(hankDir, "tpl"), { recursive: true });
    fs.writeFileSync(path.join(hankDir, "tpl", "a.txt"), "a");
    await expect(ws.rigs.plantCopy(null, path.join(hankDir, "missing"), "x")).rejects.toThrow(
      /Source path does not exist/,
    );
    await expect(
      ws.rigs.plantCopy(null, path.join(hankDir, "tpl"), path.join("no", "parent")),
    ).rejects.toThrow(/Target parent directory does not exist/);
  });

  test("without a hank the copy is plain; with one it honors the hank's rules", async () => {
    const agentRoot = path.join(tempDir, "agentRoot");
    fs.mkdirSync(agentRoot);
    const ws = await Workspace.open(new ExecutionLayout(tempDir, { agentRootPath: agentRoot }));
    const hankDir = path.join(tempDir, "hank");
    fs.mkdirSync(path.join(hankDir, "tpl", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(hankDir, "tpl", "keep.txt"), "kept");
    fs.writeFileSync(path.join(hankDir, "tpl", "node_modules", "junk.js"), "junk");
    fs.writeFileSync(path.join(hankDir, ".gitignore"), "*.secret\n");
    fs.writeFileSync(path.join(hankDir, "tpl", "key.secret"), "shh");

    await ws.rigs.plantCopy(null, path.join(hankDir, "tpl"), "plain");
    expect(fs.existsSync(path.join(agentRoot, "plain", "node_modules", "junk.js"))).toBe(true);
    expect(fs.existsSync(path.join(agentRoot, "plain", "key.secret"))).toBe(true);

    const hank = new HankDir(hankDir);
    try {
      await ws.rigs.plantCopy(hank, path.join(hankDir, "tpl"), "filtered");
      expect(fs.readFileSync(path.join(agentRoot, "filtered", "keep.txt"), "utf8")).toBe("kept");
      // The authored .gitignore replaces defaults and excludes only *.secret.
      expect(fs.existsSync(path.join(agentRoot, "filtered", "node_modules", "junk.js"))).toBe(true);
      expect(fs.existsSync(path.join(agentRoot, "filtered", "key.secret"))).toBe(false);
    } finally {
      hank.dispose();
    }
  });
});

describe("Workspace.copyOut (output files)", () => {
  let agentRoot: string;
  let destDir: string;
  let mockLogger: MockLogger;
  let ws: Workspace;

  beforeEach(async () => {
    agentRoot = path.join(tempDir, "agentRoot");
    destDir = path.join(tempDir, "out");
    await fs.promises.mkdir(agentRoot, { recursive: true });
    mockLogger = new MockLogger("");
    ws = await Workspace.open(new ExecutionLayout(tempDir, { agentRootPath: agentRoot }), {
      logger: mockLogger,
    });
  });

  test("copies single file to destination", async () => {
    await fs.promises.writeFile(path.join(agentRoot, "test.txt"), "test content");
    await ws.outputs.copyOut(["test.txt"], destDir);
    expect(await fs.promises.readFile(path.join(destDir, "test.txt"), "utf-8")).toBe(
      "test content",
    );
  });

  test("copies multiple files", async () => {
    await fs.promises.writeFile(path.join(agentRoot, "file1.txt"), "content1");
    await fs.promises.writeFile(path.join(agentRoot, "file2.txt"), "content2");
    await ws.outputs.copyOut(["*.txt"], destDir);
    expect(await fs.promises.readFile(path.join(destDir, "file1.txt"), "utf-8")).toBe("content1");
    expect(await fs.promises.readFile(path.join(destDir, "file2.txt"), "utf-8")).toBe("content2");
  });

  test("preserves directory structure", async () => {
    await fs.promises.mkdir(path.join(agentRoot, "nested", "deep"), { recursive: true });
    await fs.promises.writeFile(path.join(agentRoot, "nested", "file.txt"), "nested content");
    await fs.promises.writeFile(
      path.join(agentRoot, "nested", "deep", "deep-file.txt"),
      "deep content",
    );
    await ws.outputs.copyOut(["**/*.txt"], destDir);
    expect(await fs.promises.readFile(path.join(destDir, "nested", "file.txt"), "utf-8")).toBe(
      "nested content",
    );
    expect(
      await fs.promises.readFile(path.join(destDir, "nested", "deep", "deep-file.txt"), "utf-8"),
    ).toBe("deep content");
  });

  test("creates destination directory if it doesn't exist", async () => {
    await fs.promises.writeFile(path.join(agentRoot, "test.txt"), "content");
    expect(fs.existsSync(destDir)).toBe(false);
    await ws.outputs.copyOut(["test.txt"], destDir);
    expect(fs.existsSync(path.join(destDir, "test.txt"))).toBe(true);
  });

  test("handles multiple patterns", async () => {
    await fs.promises.writeFile(path.join(agentRoot, "a.js"), "js");
    await fs.promises.writeFile(path.join(agentRoot, "b.ts"), "ts");
    await fs.promises.writeFile(path.join(agentRoot, "c.md"), "md");
    await ws.outputs.copyOut(["*.js", "*.ts"], destDir);
    expect(fs.existsSync(path.join(destDir, "a.js"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "b.ts"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "c.md"))).toBe(false);
  });

  test("handles no matching files gracefully", async () => {
    await ws.outputs.copyOut(["*.nonexistent"], destDir);
    expect(mockLogger.logs.some((l) => l.message.includes("No files matched"))).toBe(true);
  });

  test("copies directories recursively", async () => {
    await fs.promises.mkdir(path.join(agentRoot, "source-dir", "subdir"), { recursive: true });
    await fs.promises.writeFile(path.join(agentRoot, "source-dir", "file.txt"), "dir content");
    await fs.promises.writeFile(
      path.join(agentRoot, "source-dir", "subdir", "nested.txt"),
      "nested dir content",
    );
    await ws.outputs.copyOut(["source-dir/**"], destDir);
    expect(await fs.promises.readFile(path.join(destDir, "source-dir", "file.txt"), "utf-8")).toBe(
      "dir content",
    );
    expect(
      await fs.promises.readFile(path.join(destDir, "source-dir", "subdir", "nested.txt"), "utf-8"),
    ).toBe("nested dir content");
  });

  test("ignores .gitignore rules and copies all matching files", async () => {
    await fs.promises.writeFile(path.join(agentRoot, "include.txt"), "included");
    await fs.promises.writeFile(path.join(agentRoot, "ignore.txt"), "ignored");
    await fs.promises.writeFile(path.join(agentRoot, ".gitignore"), "ignore.txt\n");
    await ws.outputs.copyOut(["*.txt"], destDir);
    expect(await fs.promises.readFile(path.join(destDir, "include.txt"), "utf-8")).toBe("included");
    expect(await fs.promises.readFile(path.join(destDir, "ignore.txt"), "utf-8")).toBe("ignored");
  });

  test.skipIf(isWindows)("preserves symlinks when copying (verbatimSymlinks)", async () => {
    const realFile = path.join(agentRoot, "real.txt");
    await fs.promises.writeFile(realFile, "real content");
    await fs.promises.symlink(realFile, path.join(agentRoot, "link.txt"));
    await fs.promises.symlink("./real.txt", path.join(agentRoot, "relative-link.txt"));
    await ws.outputs.copyOut(["**/*"], destDir);
    expect((await fs.promises.lstat(path.join(destDir, "link.txt"))).isSymbolicLink()).toBe(true);
    const rel = path.join(destDir, "relative-link.txt");
    expect((await fs.promises.lstat(rel)).isSymbolicLink()).toBe(true);
    expect(await fs.promises.readlink(rel)).toBe("./real.txt");
    expect(await fs.promises.readFile(path.join(destDir, "real.txt"), "utf-8")).toBe(
      "real content",
    );
  });

  test("default behavior renames on conflict", async () => {
    await fs.promises.mkdir(destDir, { recursive: true });
    await fs.promises.writeFile(path.join(agentRoot, "report.txt"), "new content");
    await fs.promises.writeFile(path.join(destDir, "report.txt"), "old content");
    const { conflicts } = await ws.outputs.copyOut(["report.txt"], destDir);
    expect(conflicts.length).toBe(1);
    expect(await fs.promises.readFile(path.join(destDir, "report.txt"), "utf-8")).toBe(
      "old content",
    );
    expect(await fs.promises.readFile(conflicts[0].resolved, "utf-8")).toBe("new content");
  });

  test("overwrite: true replaces existing files; overwrite: false renames", async () => {
    await fs.promises.mkdir(destDir, { recursive: true });
    await fs.promises.writeFile(path.join(agentRoot, "a.txt"), "new-a");
    await fs.promises.writeFile(path.join(agentRoot, "b.txt"), "new-b");
    await fs.promises.writeFile(path.join(destDir, "a.txt"), "old-a");
    await fs.promises.writeFile(path.join(destDir, "b.txt"), "old-b");
    const { conflicts } = await ws.outputs.copyOut(["*.txt"], destDir, { overwrite: true });
    expect(conflicts.length).toBe(0);
    expect(await fs.promises.readFile(path.join(destDir, "a.txt"), "utf-8")).toBe("new-a");
    expect(await fs.promises.readFile(path.join(destDir, "b.txt"), "utf-8")).toBe("new-b");
    const again = await ws.outputs.copyOut(["a.txt"], destDir, { overwrite: false });
    expect(again.conflicts.length).toBe(1);
    // And a fresh destination works with overwrite on.
    await fs.promises.writeFile(path.join(agentRoot, "new-file.txt"), "fresh content");
    const fresh = await ws.outputs.copyOut(["new-file.txt"], destDir, { overwrite: true });
    expect(fresh.conflicts.length).toBe(0);
    expect(await fs.promises.readFile(path.join(destDir, "new-file.txt"), "utf-8")).toBe(
      "fresh content",
    );
  });
});

describe("Workspace — checkpoints in workspace terms", () => {
  test("opening builds the store; checkpoint, list, restore, and snapshots round-trip", async () => {
    const agentRoot = path.join(tempDir, "agentRoot");
    fs.mkdirSync(agentRoot);
    const ws = await Workspace.open(new ExecutionLayout(tempDir, { agentRootPath: agentRoot }));

    const main = await requireHistoryTip(ws.checkpoints.history("main"));
    const history = ws.checkpoints.history("run-1");
    expect(await history.tip()).toBeNull();

    fs.writeFileSync(path.join(agentRoot, "report.txt"), "v1");
    const first = await history.checkpoint({ parent: main, message: "first", patterns: ["*.txt"] });
    fs.writeFileSync(path.join(agentRoot, "report.txt"), "v2");
    const second = await history.checkpoint({
      parent: first,
      message: "second",
      patterns: ["*.txt"],
    });
    expect(first).toMatch(/^[0-9a-f]{40,64}$/);
    expect(second).toMatch(/^[0-9a-f]{40,64}$/);
    expect(await history.tip()).toBe(second);
    expect(await ws.checkpoints.history("main").tip()).toBe(main);

    const listed = await history.list();
    expect(listed.map((c) => c.id)).toEqual([second, first, main]);
    expect(listed.find((c) => c.id === second)?.parents).toEqual([first]);
    expect(Object.keys(listed[0]).sort()).toEqual(["id", "message", "parents", "timestamp"]);
    expect(await ws.checkpoints.reachableDifference(second, first)).toEqual(new Set([second]));
    expect((await ws.checkpoints.allReachableIds()).has(first)).toBe(true);

    const recovery = await ws.recovery.prepare({
      target: first.substring(0, 12),
      baseline: second,
      reason: "test",
      patterns: [],
    });
    expect(recovery.target).toBe(first);
    expect(recovery.snapshot.branch).toMatch(/^recovery\//);
    await recovery.restore();
    expect(fs.readFileSync(path.join(agentRoot, "report.txt"), "utf8")).toBe("v1");
    // Restoring files does not move a named history's tip.
    expect(await history.tip()).toBe(second);

    const snapshot = await ws.recovery.preserve({
      baseline: first,
      reason: "unit test",
      patterns: [],
    });
    expect(snapshot.branch).toMatch(/^recovery\//);
    expect(Object.keys(snapshot).sort()).toEqual(["branch", "checkpointPaths", "snapshotId"]);
    expect((await ws.checkpoints.allReachableIds()).has(snapshot.snapshotId)).toBe(true);
    const beforeMissing = await ws.checkpoints.allReachableIds();
    const missing = "missing-checkpoint";
    const failure = await ws.recovery
      .prepare({ target: missing, baseline: first, reason: "invalid target", patterns: [] })
      .catch((error) => error);
    expect(failure).toBeInstanceOf(CheckpointNotFoundError);
    expect(failure.reference).toBe(missing);
    expect(await ws.checkpoints.allReachableIds()).toEqual(beforeMissing);
    expect(await history.tip()).toBe(second);
    expect(fs.readFileSync(path.join(agentRoot, "report.txt"), "utf8")).toBe("v1");
    // The visible surface works through the same store.
    expect(await ws.files.select(["**"]).files()).toEqual(["report.txt"]);
  });
});

describe("Workspace — rig copies, removal, and the archive", () => {
  let agentRoot: string;
  let hankDir: string;
  let ws: Workspace;

  beforeEach(async () => {
    agentRoot = path.join(tempDir, "agentRoot");
    hankDir = path.join(tempDir, "hank");
    fs.mkdirSync(path.join(hankDir, "tpl"), { recursive: true });
    fs.mkdirSync(agentRoot);
    fs.writeFileSync(path.join(hankDir, "tpl", "a.txt"), "from hank");
    ws = await Workspace.open(new ExecutionLayout(tempDir, { agentRootPath: agentRoot }));
  });

  test("plantRigCopy replaces an existing target and returns the absolute target", async () => {
    fs.mkdirSync(path.join(agentRoot, "site"));
    fs.writeFileSync(path.join(agentRoot, "site", "stale.txt"), "old");
    const planted = await ws.rigs.plantCopy(null, path.join(hankDir, "tpl"), "site");
    expect(planted).toEqual({ target: path.join(agentRoot, "site"), aborted: false, ignored: [] });
    expect(fs.existsSync(path.join(agentRoot, "site", "stale.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(agentRoot, "site", "a.txt"), "utf8")).toBe("from hank");
  });

  test("plantRigCopy honors shouldAbort between removal and copy", async () => {
    fs.mkdirSync(path.join(agentRoot, "site"));
    const planted = await ws.rigs.plantCopy(null, path.join(hankDir, "tpl"), "site", {
      shouldAbort: () => true,
    });
    expect(planted.aborted).toBe(true);
    expect(fs.existsSync(path.join(agentRoot, "site"))).toBe(false);
  });

  test("removePath reports whether anything was there", async () => {
    fs.mkdirSync(path.join(agentRoot, "gone"));
    expect(await ws.rigs.removePath("gone")).toBe(true);
    expect(fs.existsSync(path.join(agentRoot, "gone"))).toBe(false);
    expect(await ws.rigs.removePath("gone")).toBe(false);
  });

  test("workingDirFor prefers the last copied target only when asked", () => {
    const copied = path.join(agentRoot, "site");
    expect(ws.rigs.workingDirFor("lastCopied", copied)).toBe(copied);
    expect(ws.rigs.workingDirFor("lastCopied", undefined)).toBe(agentRoot);
    expect(ws.rigs.workingDirFor("agentRoot", copied)).toBe(agentRoot);
    expect(ws.rigs.workingDirFor(undefined, copied)).toBe(agentRoot);
  });

  test("archive round trip owns manifest updates and pruning", async () => {
    fs.mkdirSync(path.join(agentRoot, "out"));
    fs.writeFileSync(path.join(agentRoot, "out", "a.txt"), "result");
    expect(
      await ws.archives.archive(
        ws.files.select(["out"]),
        { kind: "codon", codonId: "codon-1" },
        CheckpointId("checkpoint"),
      ),
    ).toEqual([{ path: "out/a.txt", status: "archived" }]);
    expect(fs.existsSync(path.join(agentRoot, "out", "a.txt"))).toBe(false);
    const plan = await ws.archives.planRestore({
      abandoned: new Set([CheckpointId("checkpoint")]),
      known: new Set([CheckpointId("checkpoint")]),
    });
    expect(plan.count).toBe(1);
    expect(await ws.archives.restore(plan)).toEqual([{ path: "out/a.txt", status: "restored" }]);
    expect(fs.readFileSync(path.join(agentRoot, "out", "a.txt"), "utf8")).toBe("result");
    expect(fs.existsSync(path.join(tempDir, "rigArchive", "codon-1"))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "rigArchive"))).toBe(true);
    expect(
      (
        await ws.archives.planRestore({
          abandoned: new Set([CheckpointId("checkpoint")]),
          known: new Set([CheckpointId("checkpoint")]),
        })
      ).count,
    ).toBe(0);
  });
});
