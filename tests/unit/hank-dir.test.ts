import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertGitAvailable,
  containsGitComponent,
  GitMissingError,
  resetGitProbeForTests,
} from "../../server/git-support.js";
import {
  type CopyTreeEntry,
  DEFAULT_IGNORE_FINGERPRINT,
  DEFAULT_IGNORE_PATTERNS,
  HankDir,
} from "../../server/hank-dir.js";

/**
 * HankDir — the hank directory entity: ref policy on disk, the copy-tree
 * ignore rules (git verdicts over a rules-only mirror), THE copy-tree walk,
 * and the rig copy. Every consumer (loader, pack, runtime) runs through this
 * one class; these tests pin its contract.
 */

const isWindows = process.platform === "win32";

let tempDir: string;
let hanks: HankDir[];

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hank-dir-test-"));
  hanks = [];
});

afterEach(() => {
  for (const hank of hanks) hank.dispose();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function makeHank(hankDir: string): HankDir {
  const hank = new HankDir(hankDir);
  hanks.push(hank);
  return hank;
}

function write(rel: string, content = "x"): void {
  const abs = path.join(tempDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("assertGitAvailable", () => {
  test("passes on this machine (git is a hard requirement of the suite)", () => {
    expect(() => assertGitAvailable("test")).not.toThrow();
  });

  test("fails fast with install guidance when git is not on PATH", () => {
    const savedPath = process.env.PATH;
    resetGitProbeForTests();
    try {
      // An EMPTY PATH falls back to the libc default search path on some
      // platforms; a nonexistent directory reliably finds nothing.
      process.env.PATH = path.join(os.tmpdir(), "hankweave-no-binaries-here");
      expect(() => assertGitAvailable("test")).toThrow(GitMissingError);
      expect(() => assertGitAvailable("test")).toThrow(/git-scm\.com/);
    } finally {
      process.env.PATH = savedPath;
      resetGitProbeForTests();
    }
  });
});

describe("defaults", () => {
  test("fingerprint is the sha256 of the joined pattern list", () => {
    expect(DEFAULT_IGNORE_FINGERPRINT).toMatch(/^[0-9a-f]{64}$/);
    expect(DEFAULT_IGNORE_PATTERNS).toContain("node_modules/");
  });
});

describe("HankDir — construction and paths", () => {
  test("forConfig anchors at the config file's directory", () => {
    const hank = makeHank(tempDir);
    expect(HankDir.forConfig(path.join(tempDir, "sub", "hank.json")).root).toBe(
      path.join(hank.root, "sub"),
    );
    expect(hank.relative(path.join(hank.root, "a", "b.md"))).toBe("a/b.md");
    expect(hank.absolute("a/b.md")).toBe(path.join(hank.root, "a", "b.md"));
    expect(hank.absolute("")).toBe(hank.root);
  });

  test("refs: validate, resolve, read, and the hank-root check", () => {
    write("prompts/main.md", "hello");
    const hank = makeHank(tempDir);
    expect(hank.ref("prompts/main.md").validate()).toBeNull();
    expect(String(hank.ref("prompts/main.md").path)).toBe(
      path.join(hank.root, "prompts", "main.md"),
    );
    expect(hank.ref("prompts/main.md").readText({ what: "Prompt" }).text).toBe("hello");
    expect(() => hank.ref("missing.md").readText({ what: "Prompt" })).toThrow(/Prompt not found/);
    const violation = hank.ref("../escape.md").validate();
    expect(violation).not.toBeNull();
    expect(hank.ref(".").isRoot()).toBe(true);
    expect(hank.ref("sub/..").isRoot()).toBe(true);
    expect(hank.ref("prompts").isRoot()).toBe(false);
  });

  test.skipIf(isWindows)(
    "isRoot with physical resolution follows a symlink back to the root",
    () => {
      write("keep.md");
      fs.symlinkSync(tempDir, path.join(tempDir, "self-link"));
      const hank = makeHank(tempDir);
      expect(hank.ref("self-link").isRoot()).toBe(false);
      expect(hank.ref("self-link").isRoot({ physical: true })).toBe(true);
      expect(hank.ref("does-not-exist").isRoot({ physical: true })).toBe(false);
    },
  );
});

describe("HankDir — config entry points and source inspection", () => {
  test("snapshots read the selected config within a shared directory", () => {
    const defaultHank = makeHank(tempDir);
    const customPath = path.join(tempDir, "experiment.json");
    const customHank = HankDir.forConfig(path.relative(process.cwd(), customPath));
    expect(defaultHank.config.path).toBe(path.join(tempDir, "hank.json"));
    expect(customHank.config.path).toBe(customPath);
    expect(customHank.root).toBe(defaultHank.root);

    // Construction does not require either config to exist. Snapshot reads
    // use the selected file without initializing unrelated copy-tree rules.
    write("hank.json", "default");
    write("experiment.json", "custom");
    fs.mkdirSync(path.join(tempDir, ".gitignore"));
    for (const [hank, text] of [
      [defaultHank, "default"],
      [customHank, "custom"],
    ] as const) {
      const snapshot = hank.config.readSnapshot({ maxBytes: 100 });
      expect(snapshot.kind).toBe("file");
      if (snapshot.kind !== "file") throw new Error("expected config bytes");
      expect(snapshot.bytes.toString()).toBe(text);
      expect(hank.rootRuleSource()).toBeUndefined();
    }
  });

  test.skipIf(isWindows)("config snapshots follow symlinks", () => {
    write("config/actual.json", "{}\n");
    fs.symlinkSync("config/actual.json", path.join(tempDir, "alias.json"));
    const hank = HankDir.forConfig(path.join(tempDir, "alias.json"));
    expect(hank.config.path).toBe(path.join(tempDir, "alias.json"));
    expect(hank.root).toBe(tempDir);
    const snapshot = hank.config.readSnapshot({ maxBytes: 3 });
    expect(snapshot.kind).toBe("file");
    if (snapshot.kind !== "file") throw new Error("expected config bytes");
    expect(snapshot.bytes.toString()).toBe("{}\n");
  });

  test("inspects selected source text and byte size regardless of ignore rules", async () => {
    write("prompt.md", "é\n");
    write(".gitignore", "*.md\n");
    const hank = makeHank(tempDir);
    expect(await hank.ref("prompt.md").inspect()).toEqual({ text: "é\n", bytes: 3 });
    expect(await hank.refFromPath(path.join(tempDir, "prompt.md")).inspect()).toEqual({
      text: "é\n",
      bytes: 3,
    });
    expect(hank.rootRuleSource()).toBeUndefined();
  });

  test("inspection refuses escapes, metadata, directories, and missing files", async () => {
    const hank = makeHank(tempDir);
    await expect(hank.ref("../outside.md").inspect()).rejects.toThrow(/outside the hank/);
    await expect(hank.ref(".git/config").inspect()).rejects.toThrow(/git metadata/);
    await expect(hank.ref(".").inspect()).rejects.toThrow(/not a regular file/);
    await expect(hank.ref("missing.md").inspect()).rejects.toThrow(/ENOENT/);
  });

  test.skipIf(isWindows)("inspection rechecks a source swapped for a symlink", async () => {
    write("prompt.md", "original");
    write("replacement.md", "replacement");
    const hank = makeHank(tempDir);
    const resolved = hank.ref("prompt.md").path;
    expect(hank.ref("prompt.md").validate()).toBeNull();
    fs.unlinkSync(resolved);
    fs.symlinkSync(path.join(tempDir, "replacement.md"), resolved);
    await expect(hank.refFromPath(resolved).inspect()).rejects.toThrow(/symlink/);
  });
});

describe("HankDir — source snapshots", () => {
  test("captures binary bytes and metadata independently of copy-tree rules", () => {
    const bytes = Buffer.from([0, 255, 128, 10]);
    write("source.bin");
    fs.writeFileSync(path.join(tempDir, "source.bin"), bytes);
    write(".gitignore", "*\n");
    const hank = makeHank(tempDir);
    const resolved = hank.ref("source.bin").path;
    const snapshot = hank.refFromPath(resolved).readSnapshot();
    expect(snapshot.bytes).toEqual(bytes);
    expect(snapshot.stats.size).toBe(bytes.length);
    expect(snapshot.stats.isFile()).toBe(true);
    fs.writeFileSync(resolved, "new");
    expect(hank.ref("source.bin").readSnapshot().bytes.toString()).toBe("new");
    expect(snapshot.bytes).toEqual(bytes);
    expect(hank.rootRuleSource()).toBeUndefined();
  });

  test.skipIf(isWindows)("refuses a vetted file replaced by a symlink or FIFO", () => {
    write("source.bin");
    write("target.bin", "must not be read");
    const hank = makeHank(tempDir);
    const resolved = hank.ref("source.bin").path;
    expect(fs.lstatSync(resolved).isFile()).toBe(true);
    fs.unlinkSync(resolved);
    fs.symlinkSync(path.join(tempDir, "target.bin"), resolved);
    expect(fs.lstatSync(resolved).isSymbolicLink()).toBe(true);
    expect(() => hank.refFromPath(resolved).readSnapshot()).toThrow();
    fs.unlinkSync(resolved);
    execFileSync("mkfifo", [resolved]);
    expect(() => hank.refFromPath(resolved).readSnapshot()).toThrow(/not a regular file/);
  });

  test.skipIf(isWindows)(
    "keeps metadata and bytes from the opened file when its path changes",
    () => {
      write("source.bin", "original bytes");
      const hank = makeHank(tempDir);
      const resolved = hank.ref("source.bin").path;
      fs.chmodSync(resolved, 0o755);
      const realOpen = fs.openSync;
      const openSpy = spyOn(fs, "openSync").mockImplementation(((
        ...args: Parameters<typeof fs.openSync>
      ) => {
        const fd = realOpen.apply(fs, args);
        if (args[0] === resolved) {
          fs.renameSync(resolved, `${resolved}.old`);
          fs.writeFileSync(resolved, "replacement", { mode: 0o644 });
        }
        return fd;
      }) as typeof fs.openSync);
      try {
        const snapshot = hank.refFromPath(resolved).readSnapshot();
        expect(snapshot.bytes.toString()).toBe("original bytes");
        expect(snapshot.stats.size).toBe(Buffer.byteLength("original bytes"));
        expect(snapshot.stats.mode & 0o777).toBe(0o755);
      } finally {
        openSpy.mockRestore();
      }
      expect(fs.readFileSync(resolved, "utf8")).toBe("replacement");
    },
  );

  test("closes the descriptor when reading fails", () => {
    write("source.bin");
    const hank = makeHank(tempDir);
    let capturedFd: number | undefined;
    const realRead = fs.readFileSync;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((
      ...args: Parameters<typeof fs.readFileSync>
    ) => {
      if (typeof args[0] === "number") {
        capturedFd = args[0];
        throw new Error("simulated read failure");
      }
      return realRead.apply(fs, args);
    }) as typeof fs.readFileSync);
    try {
      expect(() => hank.ref("source.bin").readSnapshot()).toThrow("simulated read failure");
    } finally {
      readSpy.mockRestore();
    }
    expect(capturedFd).toBeDefined();
    expect(() => fs.fstatSync(capturedFd as number)).toThrow(/EBADF/);
  });
});

describe("HankDir — default rules (no .gitignore)", () => {
  test("default patterns ignore junk; ordinary files pass", () => {
    write("src/app.ts");
    write("node_modules/pkg/index.js");
    write("debug.log");
    const hank = makeHank(tempDir);
    expect(hank.isIgnored("node_modules", true)).toBe(true);
    expect(hank.isIgnored("debug.log", false)).toBe(true);
    expect(hank.isIgnored("src", true)).toBe(false);
    expect(hank.isIgnored("src/app.ts", false)).toBe(false);
    expect(hank.rootRuleSource()).toBeNull();
  });

  test("dir-only default patterns do not ignore a plain FILE of the same name", () => {
    write("node_modules", "a file, not a dir");
    const hank = makeHank(tempDir);
    expect(hank.isIgnored("node_modules", false)).toBe(false);
  });

  test("listDir entries carry the matching rule", () => {
    write("node_modules/x.js");
    const hank = makeHank(tempDir);
    const entry = hank.listDir("").find((e) => e.name === "node_modules");
    expect(entry?.ignored).toBe(true);
    expect(entry?.ignoredBy).toContain("node_modules/");
    expect(entry?.ignoredBy).toContain("info/exclude");
  });
});

describe("HankDir — authored rules replace the defaults", () => {
  test("root .gitignore replaces the defaults", () => {
    write(".gitignore", "custom/\n");
    write("custom/a.txt");
    write("node_modules/pkg/index.js");
    const hank = makeHank(tempDir);
    expect(hank.isIgnored("custom", true)).toBe(true);
    expect(hank.isIgnored("node_modules", true)).toBe(false);
    expect(hank.isIgnored("dist", true)).toBe(false);
    expect(hank.isIgnored("debug.log", false)).toBe(false);
    expect(hank.rootRuleSource()?.bytes.toString()).toBe("custom/\n");
  });

  test("an empty root .gitignore disables every optional default", () => {
    write(".gitignore", "");
    write("dist/out.js");
    const hank = makeHank(tempDir);
    expect(hank.isIgnored("dist", true)).toBe(false);
    expect(hank.isIgnored("dist/out.js", false)).toBe(false);
    for (const pattern of DEFAULT_IGNORE_PATTERNS) {
      const isDir = pattern.endsWith("/");
      const candidate = isDir ? pattern.slice(0, -1) : pattern.replace("*", "debug");
      expect(hank.isIgnored(candidate, isDir)).toBe(false);
    }
    expect(hank.isIgnored(".git", true)).toBe(true);
    expect(hank.rootRuleSource()?.bytes.length).toBe(0);
  });

  test("root rules scope into subfolders with path prefixes", () => {
    write(".gitignore", "sub/*.tmp\n!sub/keep.tmp\nsub/local-only/\n");
    write("sub/keep.tmp");
    write("sub/drop.tmp");
    write("sub/local-only/x.txt");
    const hank = makeHank(tempDir);
    expect(hank.isIgnored("sub/keep.tmp", false)).toBe(false);
    expect(hank.isIgnored("sub/drop.tmp", false)).toBe(true);
    expect(hank.isIgnored("sub/local-only", true)).toBe(true);
  });

  test("a nested .gitignore is NOT a rules layer (root-only policy)", () => {
    // The walk REJECTS nested rules files inside copy trees; the rules
    // themselves simply never read them — only the root file or defaults apply.
    write("a/.gitignore", "secret.txt\n");
    write("a/b/secret.txt");
    const hank = makeHank(tempDir);
    expect(hank.isIgnored("a/b/secret.txt", false)).toBe(false);
  });

  // ":" is not a legal NTFS filename character, so the fixture cannot be
  // created on Windows; the "./" guard under test is platform-independent.
  test.skipIf(isWindows)("a pathspec-magic filename gets a real verdict, not a fatal error", () => {
    // ":(glob)x" is a legal filename; check-ignore --stdin would parse the
    // leading ":" as (unsupported) pathspec magic and abort the batch
    // without the "./" guard.
    write(".gitignore", "*.tmp\n");
    write(":(glob)tricky.tmp");
    write(":(glob)keep.txt");
    const hank = makeHank(tempDir);
    expect(hank.isIgnored(":(glob)tricky.tmp", false)).toBe(true);
    expect(hank.isIgnored(":(glob)keep.txt", false)).toBe(false);
    // And a whole-directory batch survives it.
    const entries = hank.listDir("");
    expect(entries.find((e) => e.name === ":(glob)tricky.tmp")?.ignored).toBe(true);
    expect(entries.find((e) => e.name === ":(glob)keep.txt")?.ignored).toBe(false);
  });
});

describe("HankDir — the hard .git rule", () => {
  test(".git is ignored in directory form, file form, and nested", () => {
    const hank = makeHank(tempDir);
    expect(hank.isIgnored(".git", true)).toBe(true);
    expect(hank.isIgnored(".git", false)).toBe(true); // worktree/submodule marker file
    expect(hank.isIgnored("vendor/repo/.git", true)).toBe(true);
    expect(hank.isIgnored(".git/config", false)).toBe(true);
    write(".git/config", "[core]");
    const entry = hank.listDir("").find((e) => e.name === ".git");
    expect(entry?.ignored).toBe(true);
    expect(entry?.ignoredBy).toContain("built-in");
  });

  test("an authored !.git cannot re-admit git metadata", () => {
    write(".gitignore", "!.git\n");
    const hank = makeHank(tempDir);
    expect(hank.isIgnored(".git", true)).toBe(true);
  });

  test("containsGitComponent matches components only, not substrings — case-folded", () => {
    expect(containsGitComponent(".git")).toBe(true);
    expect(containsGitComponent("a/.git/b")).toBe(true);
    // On a case-insensitive filesystem .GIT is the same entry (and would
    // alias the mirror repo's own admin dir) — every spelling is metadata.
    expect(containsGitComponent(".GIT")).toBe(true);
    expect(containsGitComponent("a/.Git/b")).toBe(true);
    expect(containsGitComponent(".github")).toBe(false);
    expect(containsGitComponent("a/.gitignore")).toBe(false);
  });

  test("a ref naming .git is rejected at the spelling layer (hard prohibition)", () => {
    const hank = makeHank(tempDir);
    const vetted = hank.ref(".git").validate();
    expect(vetted).not.toBeNull();
    if (vetted) expect(vetted.kind).toBe("git-metadata");
    const nested = hank.ref("sub/.git/config").validate();
    if (nested) expect(nested.kind).toBe("git-metadata");
    // .gitignore and .github are ordinary names.
    expect(hank.ref(".gitignore").validate()).toBeNull();
    expect(hank.ref(".github/workflows/x.yml").validate()).toBeNull();
    // The check runs on the NORMALIZED spelling: a ref that only lexically
    // passes .git and collapses away never touches git metadata (internal
    // ".." hops are permitted policy).
    write("sub/safe.md");
    expect(hank.ref("sub/.git/../safe.md").validate()).toBeNull();
  });
});

describe("HankDir — isolation", () => {
  test("a parent repo's .gitignore above the hank root never leaks in", () => {
    // tempDir is a git repo with rules; the hank lives in a subdirectory.
    execFileSync("git", ["init", "--quiet", tempDir]);
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "*.txt\n");
    const hankDir = path.join(tempDir, "hank");
    fs.mkdirSync(hankDir);
    fs.writeFileSync(path.join(hankDir, "notes.txt"), "x");
    const hank = makeHank(hankDir);
    expect(hank.isIgnored("notes.txt", false)).toBe(false);
  });

  test("a hank that IS a git repo: its own .git is skipped, its index untouched", () => {
    execFileSync("git", ["init", "--quiet", tempDir]);
    write(".gitignore", "out/\n");
    write("out/x.txt");
    write("kept.txt");
    const indexPath = path.join(tempDir, ".git", "index");
    const before = fs.existsSync(indexPath) ? fs.statSync(indexPath).mtimeMs : null;
    const hank = makeHank(tempDir);
    expect(hank.isIgnored(".git", true)).toBe(true);
    expect(hank.isIgnored("out", true)).toBe(true);
    expect(hank.isIgnored("kept.txt", false)).toBe(false);
    const after = fs.existsSync(indexPath) ? fs.statSync(indexPath).mtimeMs : null;
    expect(after).toBe(before);
  });

  test("verdicts are case-sensitive even on case-insensitive filesystems", () => {
    write(".gitignore", "Build/\n");
    write("Build/x.txt");
    const hank = makeHank(tempDir);
    expect(hank.isIgnored("Build", true)).toBe(true);
    // Same-cased query only: "bUILD" is a different path and matches no rule
    // (the built-in defaults list "build/", lowercase — also not "bUILD").
    expect(hank.isIgnored("bUILD", true)).toBe(false);
  });

  test(".GITIGNORE (wrong case) is not the rules file on any platform", () => {
    // On a case-insensitive filesystem this lstat-resolves for ".gitignore";
    // only the exact directory-entry spelling counts.
    write(".GITIGNORE", "src/\n");
    write("src/app.ts");
    const hank = makeHank(tempDir);
    expect(hank.isIgnored("src", true)).toBe(false);
    expect(hank.rootRuleSource()).toBeNull();
    expect(hank.readRulesFile()).toBeNull();
  });
});

describe("HankDir — mid-walk immutability (rules-only mirror)", () => {
  test("editing a .gitignore after first use does not change verdicts", () => {
    write(".gitignore", "old-rule/\n");
    write("late/x.txt");
    const hank = makeHank(tempDir);
    expect(hank.isIgnored("late", true)).toBe(false);
    // The live file changes; the mirror (and thus every verdict) must not.
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "late/\n");
    expect(hank.isIgnored("late", true)).toBe(false);
    expect(hank.isIgnored("late/x.txt", false)).toBe(false);
  });

  test("rootRuleSource reports the judged bytes — and only after first use", () => {
    write(".gitignore", "root-rules\n");
    const hank = makeHank(tempDir);
    // Never consulted → undefined (the lazy contract: no read, no spawn).
    expect(hank.rootRuleSource()).toBeUndefined();
    hank.isIgnored("anything", false);
    expect(hank.rootRuleSource()?.bytes.toString()).toBe("root-rules\n");
  });
});

describe("HankDir — laziness and errors", () => {
  test("constructing spawns nothing until first use", () => {
    // A nonexistent hank dir must not fail construction or disposal.
    const hank = new HankDir(path.join(tempDir, "does-not-exist"));
    hanks.push(hank);
    expect(() => hank.dispose()).not.toThrow();
    expect(hank.rootRuleSource()).toBeUndefined();
  });

  test.skipIf(isWindows)("a symlinked root .gitignore throws on first use", () => {
    write("real-rules", "dist/\n");
    fs.symlinkSync(path.join(tempDir, "real-rules"), path.join(tempDir, ".gitignore"));
    const hank = makeHank(tempDir);
    expect(() => hank.isIgnored("anything", false)).toThrow(/symlink/);
    expect(() => hank.readRulesFile()).toThrow(/symlink/);
  });

  test.skipIf(isWindows)(
    "a symlinked NESTED .gitignore is never read as rules (root-only policy)",
    () => {
      write("real-rules", "*.txt\n");
      fs.mkdirSync(path.join(tempDir, "sub"));
      fs.symlinkSync(path.join(tempDir, "real-rules"), path.join(tempDir, "sub", ".gitignore"));
      write("sub/notes.txt");
      const hank = makeHank(tempDir);
      const entry = hank.listDir("sub").find((e) => e.name === ".gitignore");
      expect(entry?.stats?.isSymbolicLink()).toBe(true);
      expect(hank.isIgnored("sub/notes.txt", false)).toBe(false);
    },
  );

  test("dispose is idempotent, removes the scratch dir, and re-initializes on next use", () => {
    write("x.txt");
    write(".gitignore", "gone/\n");
    const hank = makeHank(tempDir);
    hank.isIgnored("x.txt", false);
    hank.dispose();
    hank.dispose();
    expect(hank.rootRuleSource()).toBeUndefined();
    expect(hank.isIgnored("gone", true)).toBe(true);
  });

  test("reuse after disposal rejudges cached paths under the new rules", () => {
    write(".gitignore", "*.log\n");
    const hank = makeHank(tempDir);
    expect(hank.isIgnored("a.log", false)).toBe(true);
    expect(hank.isIgnored("build", true)).toBe(false);

    hank.dispose();
    write(".gitignore", "build/\n");
    expect(hank.rootRuleSource()).toBeUndefined();

    expect(hank.isIgnored("a.log", false)).toBe(false);
    expect(hank.isIgnored("b.log", false)).toBe(false);
    expect(hank.isIgnored("build", true)).toBe(true);
    expect(hank.rootRuleSource()?.bytes.toString()).toBe("build/\n");
  });

  test.skipIf(isWindows)(
    "a failed first use does not poison the instance — root rules apply after the cause is fixed",
    () => {
      write("real-rules", "blocked/\n");
      fs.symlinkSync(path.join(tempDir, "real-rules"), path.join(tempDir, ".gitignore"));
      write("blocked/x.txt");
      const hank = makeHank(tempDir);
      expect(() => hank.isIgnored("blocked", true)).toThrow(/symlink/);
      // Fix the cause: replace the symlink with a real rules file. The next
      // call must start clean and APPLY the root rules — not silently run
      // without them on a half-built mirror.
      fs.rmSync(path.join(tempDir, ".gitignore"));
      fs.writeFileSync(path.join(tempDir, ".gitignore"), "blocked/\n");
      expect(hank.isIgnored("blocked", true)).toBe(true);
      expect(hank.rootRuleSource()?.bytes.toString()).toBe("blocked/\n");
    },
  );

  test("verdicts are memoized per entry TYPE — a name reappearing as a directory is re-judged", () => {
    // "dist/" is a dir-only default: as a FILE the name is not ignored…
    write("dist", "a file today");
    const hank = makeHank(tempDir);
    expect(hank.isIgnored("dist", false)).toBe(false);
    // …and the same rel queried as a DIRECTORY must not reuse that verdict.
    fs.rmSync(path.join(tempDir, "dist"));
    fs.mkdirSync(path.join(tempDir, "dist"));
    expect(hank.isIgnored("dist", true)).toBe(true);
  });
});

describe("HankDir — the copy-tree walk", () => {
  const kinds = (entries: CopyTreeEntry[]) => entries.map((e) => `${e.kind}:${describeEntry(e)}`);
  function describeEntry(e: CopyTreeEntry): string {
    switch (e.kind) {
      case "violation":
        return e.violation.kind;
      default:
        return e.rel;
    }
  }

  test("yields directories, sorted entries, and kept subtrees in pre-order; ignored dirs are pruned", () => {
    write("tree/b.txt");
    write("tree/a.txt");
    write("tree/sub/z.txt");
    write("tree/sub/deep/y.txt");
    write("tree/node_modules/deep/huge.js");
    write("tree/debug.log");
    const hank = makeHank(tempDir);
    const entries = [...hank.walkCopyTree("tree", "./tree")];
    expect(kinds(entries)).toEqual([
      "dir:tree",
      "file:tree/a.txt",
      "file:tree/b.txt",
      "ignored:tree/debug.log",
      "ignored:tree/node_modules",
      "dir:tree/sub",
      "file:tree/sub/z.txt",
      "dir:tree/sub/deep",
      "file:tree/sub/deep/y.txt",
    ]);
    const pruned = entries.find((e) => e.kind === "ignored" && e.rel === "tree/node_modules");
    expect(pruned && pruned.kind === "ignored" ? pruned.isDir : null).toBe(true);
    // The pruned directory was never entered.
    expect(entries.some((e) => e.kind !== "violation" && e.rel.includes("huge.js"))).toBe(false);
  });

  test("dir events carry the entry count (ignored entries included) for empty-dir lint", () => {
    write("tree/keep.txt");
    fs.mkdirSync(path.join(tempDir, "tree", "empty"));
    fs.mkdirSync(path.join(tempDir, "tree", "only-junk"));
    write("tree/only-junk/x.log");
    const hank = makeHank(tempDir);
    const dirs = [...hank.walkCopyTree("tree", "./tree")].filter((e) => e.kind === "dir");
    const counts = Object.fromEntries(
      dirs.map((d) => (d.kind === "dir" ? [d.rel, d.entryCount] : ["", 0])),
    );
    expect(counts).toEqual({ tree: 3, "tree/empty": 0, "tree/only-junk": 1 });
  });

  test("an ignored root is the first (and only) event", () => {
    write("dist/out.js");
    const hank = makeHank(tempDir);
    expect(kinds([...hank.walkCopyTree("dist", "./dist")])).toEqual([
      "violation:tree-ignored-root",
    ]);
  });

  test("a nested rules file ends the walk as a violation, in sorted position", () => {
    write("tree/a.txt");
    write("tree/sub/.gitignore", "generated/\n");
    write("tree/sub/later.txt");
    write("tree/zzz.txt");
    const hank = makeHank(tempDir);
    const entries = [...hank.walkCopyTree("tree", "./tree")];
    const last = entries[entries.length - 1];
    expect(last?.kind).toBe("violation");
    if (last?.kind === "violation") {
      expect(last.violation).toEqual({
        kind: "tree-nested-gitignore",
        raw: "./tree",
        entry: path.join(hank.root, "tree", "sub", ".gitignore"),
      });
    }
    // Root-level siblings were all reported before the descent.
    expect(kinds(entries)).toContain("file:tree/zzz.txt");
    expect(kinds(entries)).not.toContain("file:tree/sub/later.txt");
  });

  test.skipIf(isWindows)(
    "a symlink in the kept tree is a violation; one under an ignored dir is invisible",
    () => {
      write("tree/keep.md");
      write("tree/node_modules/pkg/real.js");
      fs.symlinkSync(
        path.join(tempDir, "tree"),
        path.join(tempDir, "tree", "node_modules", "loop"),
      );
      const hank = makeHank(tempDir);
      expect(kinds([...hank.walkCopyTree("tree", "./tree")])).toEqual([
        "dir:tree",
        "file:tree/keep.md",
        "ignored:tree/node_modules",
      ]);
      fs.symlinkSync(path.join(tempDir, "tree", "keep.md"), path.join(tempDir, "tree", "link.md"));
      const entries = [...hank.walkCopyTree("tree", "./tree")];
      const violation = entries.find((e) => e.kind === "violation");
      expect(violation?.kind === "violation" ? violation.violation.kind : null).toBe(
        "tree-symlink",
      );
    },
  );

  test("validateCopyTree is the walk: first violation wins, vanished entries pass", () => {
    write("tree/keep.md");
    write("tree/sub/.gitignore", "x\n");
    const hank = makeHank(tempDir);
    expect(hank.validateCopyTree(hank.ref("./tree"))?.kind).toBe("tree-nested-gitignore");
    fs.rmSync(path.join(tempDir, "tree", "sub"), { recursive: true });
    expect(hank.validateCopyTree(hank.ref("./tree"))).toBeNull();
    // A file source has no tree and never consults the rules.
    const fresh = makeHank(tempDir);
    expect(fresh.validateCopyTree(fresh.ref("tree/keep.md"))).toBeNull();
    expect(fresh.rootRuleSource()).toBeUndefined();
    // A missing source is someone else's error (the existence walk).
    expect(fresh.validateCopyTree(fresh.ref("nope"))).toBeNull();
  });

  test("listDir judges a whole directory in one batch", () => {
    write("a/1.txt");
    write("a/2.txt");
    write("a/3.txt");
    const hank = makeHank(tempDir);
    const entries = hank.listDir("a");
    expect(entries.map((e) => e.name)).toEqual(["1.txt", "2.txt", "3.txt"]);
    expect(entries.every((e) => !e.ignored)).toBe(true);
  });
});

describe("HankDir — copyFilter and copyTo", () => {
  test("copyFilter prunes ignored directories and admits the kept tree", () => {
    write("tree/keep/file.txt");
    write("tree/node_modules/deep/huge.js");
    const hank = makeHank(tempDir);
    const filter = hank.copyFilter(path.join(tempDir, "tree"));
    expect(filter(path.join(tempDir, "tree", "node_modules"))).toBe(false);
    expect(filter(path.join(tempDir, "tree", "keep"))).toBe(true);
    expect(filter(path.join(tempDir, "tree", "keep", "file.txt"))).toBe(true);
  });

  test.skipIf(isWindows)(
    "symlinks inside an ignored directory are invisible (pruning happens first)",
    () => {
      write("tree/node_modules/pkg/real.js");
      fs.symlinkSync(
        path.join(tempDir, "tree"),
        path.join(tempDir, "tree", "node_modules", "loop"),
      );
      const hank = makeHank(tempDir);
      // Pruning happens before descent: building the filter (which
      // pre-walks the tree) never touches the symlink inside node_modules.
      expect(() => hank.copyFilter(path.join(tempDir, "tree"))).not.toThrow();
    },
  );

  test("the source root is always admitted, even when its name matches a rule", () => {
    write("debug.log", "explicitly copied");
    const hank = makeHank(tempDir);
    const filter = hank.copyFilter(path.join(tempDir, "debug.log"));
    expect(filter(path.join(tempDir, "debug.log"))).toBe(true);
  });

  test("descendants are filtered by the shared rules", () => {
    write("assets/keep.txt");
    write("assets/junk.log");
    const hank = makeHank(tempDir);
    const filter = hank.copyFilter(path.join(tempDir, "assets"));
    expect(filter(path.join(tempDir, "assets", "keep.txt"))).toBe(true);
    expect(filter(path.join(tempDir, "assets", "junk.log"))).toBe(false);
  });

  test("a top-level name like ..templates is inside the hank, not an escape", () => {
    write("..templates/file.log");
    write("..templates/file.txt");
    const hank = makeHank(tempDir);
    const filter = hank.copyFilter(path.join(tempDir, "..templates"));
    expect(filter(path.join(tempDir, "..templates", "file.txt"))).toBe(true);
    expect(filter(path.join(tempDir, "..templates", "file.log"))).toBe(false);
  });

  test.skipIf(isWindows)(
    "a symlink that appeared after validation FAILS the copy; an ignored one stays invisible",
    () => {
      write("assets/real.txt");
      fs.symlinkSync(
        path.join(tempDir, "assets", "real.txt"),
        path.join(tempDir, "assets", "sneaky.txt"),
      );
      write("assets/node_modules/inner.txt");
      fs.symlinkSync(
        path.join(tempDir, "assets", "real.txt"),
        path.join(tempDir, "assets", "node_modules", "hidden-link"),
      );
      const hank = makeHank(tempDir);
      const filter = hank.copyFilter(path.join(tempDir, "assets"));
      // Not ignored → refuse loudly rather than plant the link in the rig.
      expect(() => filter(path.join(tempDir, "assets", "sneaky.txt"))).toThrow(/symlink/);
      // Ignored (inside node_modules) → silently excluded, like every walk.
      expect(filter(path.join(tempDir, "assets", "node_modules"))).toBe(false);
    },
  );

  test("copyTo: a directory source is filtered, a file source is copied verbatim", async () => {
    write("assets/keep.txt", "kept");
    write("assets/junk.log", "junk");
    write("assets/node_modules/x.js", "junk");
    write("single.log", "explicit file");
    const hank = makeHank(tempDir);
    const dest = path.join(tempDir, "out");
    fs.mkdirSync(dest);
    await hank.copyTo(path.join(tempDir, "assets"), path.join(dest, "assets"));
    expect(fs.readFileSync(path.join(dest, "assets", "keep.txt"), "utf8")).toBe("kept");
    expect(fs.existsSync(path.join(dest, "assets", "junk.log"))).toBe(false);
    expect(fs.existsSync(path.join(dest, "assets", "node_modules"))).toBe(false);
    // A file source matching a rule is an explicit ref: copied, rules unread.
    const fileOnly = makeHank(tempDir);
    await fileOnly.copyTo(path.join(tempDir, "single.log"), path.join(dest, "single.log"));
    expect(fs.readFileSync(path.join(dest, "single.log"), "utf8")).toBe("explicit file");
    expect(fileOnly.rootRuleSource()).toBeUndefined();
  });
});

describe("HankDir — readRulesFile", () => {
  test("absent file returns null; present file returns bytes and mode", () => {
    const hank = makeHank(tempDir);
    expect(hank.readRulesFile()).toBeNull();
    write(".gitignore", "dist/\n");
    const rules = hank.readRulesFile();
    expect(rules?.bytes.toString()).toBe("dist/\n");
    expect(rules?.mode).toBe("644");
  });

  test.skipIf(isWindows)("symlinked .gitignore throws", () => {
    write("target", "dist/\n");
    fs.symlinkSync(path.join(tempDir, "target"), path.join(tempDir, ".gitignore"));
    expect(() => makeHank(tempDir).readRulesFile()).toThrow(/symlink/);
  });

  test.each(["ELOOP", "EMLINK", "ENOENT"])(
    "reports %s during capture as a rules-file replacement",
    (code) => {
      write(".gitignore", "dist/\n");
      const hank = makeHank(tempDir);
      const openSpy = spyOn(fs, "openSync").mockImplementation(() => {
        throw Object.assign(new Error("capture failed"), { code });
      });
      try {
        expect(() => hank.readRulesFile()).toThrow(
          `.gitignore at the hank root is not a regular file (${path.join(tempDir, ".gitignore")}); the copy-tree ignore rules must be a regular file`,
        );
      } finally {
        openSpy.mockRestore();
      }
    },
  );

  test.each(["EACCES", "EIO"])("propagates %s from capture unchanged", (code) => {
    write(".gitignore", "dist/\n");
    const hank = makeHank(tempDir);
    const failure = Object.assign(new Error("capture failed"), { code });
    const openSpy = spyOn(fs, "openSync").mockImplementation(() => {
      throw failure;
    });
    let caught: unknown;
    try {
      hank.readRulesFile();
    } catch (error) {
      caught = error;
    } finally {
      openSpy.mockRestore();
    }
    expect(caught).toBe(failure);
  });

  test.skipIf(isWindows)("takes rule bytes and executable mode from the opened file", () => {
    write(".gitignore", "original/\n");
    const rulesPath = path.join(tempDir, ".gitignore");
    fs.chmodSync(rulesPath, 0o755);
    const hank = makeHank(tempDir);
    const realOpen = fs.openSync;
    const openSpy = spyOn(fs, "openSync").mockImplementation(((
      ...args: Parameters<typeof fs.openSync>
    ) => {
      const fd = realOpen.apply(fs, args);
      if (args[0] === rulesPath) {
        fs.renameSync(rulesPath, `${rulesPath}.old`);
        fs.writeFileSync(rulesPath, "replacement/\n", { mode: 0o644 });
      }
      return fd;
    }) as typeof fs.openSync);
    try {
      const rules = hank.readRulesFile();
      expect(rules?.bytes.toString()).toBe("original/\n");
      expect(rules?.mode).toBe("755");
    } finally {
      openSpy.mockRestore();
    }
    expect(fs.readFileSync(rulesPath, "utf8")).toBe("replacement/\n");
  });

  test.skipIf(isWindows)("rejects a FIFO substituted before open without blocking", () => {
    write(".gitignore", "dist/\n");
    const rulesPath = path.join(tempDir, ".gitignore");
    const hank = makeHank(tempDir);
    const realOpen = fs.openSync;
    let capturedFd: number | undefined;
    const openSpy = spyOn(fs, "openSync").mockImplementation(((
      ...args: Parameters<typeof fs.openSync>
    ) => {
      if (args[0] !== rulesPath) return realOpen.apply(fs, args);
      // Fail instead of hanging the suite if nonblocking capture regresses.
      if ((Number(args[1]) & fs.constants.O_NONBLOCK) === 0) {
        throw new Error("Rules capture must use O_NONBLOCK");
      }
      fs.unlinkSync(rulesPath);
      execFileSync("mkfifo", [rulesPath]);
      capturedFd = realOpen.apply(fs, args);
      return capturedFd;
    }) as typeof fs.openSync);
    try {
      expect(() => hank.readRulesFile()).toThrow(
        `.gitignore at the hank root is not a regular file (${rulesPath}); the copy-tree ignore rules must be a regular file`,
      );
    } finally {
      openSpy.mockRestore();
    }
    expect(capturedFd).toBeDefined();
    expect(() => fs.fstatSync(capturedFd as number)).toThrow(/EBADF/);
  });
});
