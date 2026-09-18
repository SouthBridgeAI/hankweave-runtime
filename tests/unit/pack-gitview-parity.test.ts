import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCodonSequence, validateHank } from "../../server/config.js";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { describeIgnoredEntries, HankDir } from "../../server/hank-dir.js";
import { computeClosure } from "../../server/pack/closure.js";
import { buildLock, serializeLock } from "../../server/pack/lock.js";
import { Logger } from "../../server/utils.js";
import { Workspace } from "../../server/workspace/index.js";

/**
 * The refactor's core promise, tested directly (spec:
 * intermediates/65-native-git-ignore/):
 *
 * 1. PARITY — the loader preflight, the pack closure, and the runtime rig
 *    copy judge one messy tree identically, and identically to real git.
 * 2. REPACK DETERMINISM — pack → extract → pack again reproduces the FULL
 *    hank.lock (codonInputs included, not just bundleHash), preserving the
 *    root .gitignore, including when empty.
 */

const tempDirs: string[] = [];
const views: HankDir[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const FIXTURE = path.resolve(process.cwd(), "tests/fixtures/pack-fixture");

/** A messy hank (pack-fixture + a second copy tree): ROOT-ONLY rules with
 * path-prefixed patterns and negations reaching into the copy tree,
 * explicitly ignored junk, a `.git` marker FILE, and included build outputs. */
function buildMessyHank(): string {
  const root = tempDir("parity-hank-");
  const hankDir = path.join(root, "pack-fixture");
  fs.cpSync(FIXTURE, hankDir, { recursive: true });
  const hankJsonPath = path.join(hankDir, "hank.json");
  const raw = JSON.parse(fs.readFileSync(hankJsonPath, "utf8"));
  raw.hank[0].rigSetup.push({ type: "copy", copy: { from: "templates/app", to: "app" } });
  fs.writeFileSync(hankJsonPath, `${JSON.stringify(raw, null, 2)}\n`);
  // ONE rules file, scoping into the tree with path prefixes.
  write(
    hankDir,
    ".gitignore",
    "node_modules/\n*.log\nroot-secret.txt\ntemplates/app/*.tmp\n!templates/app/keep.tmp\ntemplates/app/sub/generated/\n",
  );
  write(hankDir, "templates/app/main.ts", "export {}\n");
  write(hankDir, "templates/app/scratch.tmp", "junk\n");
  write(hankDir, "templates/app/keep.tmp", "negated back in\n");
  write(hankDir, "templates/app/sub/real.ts", "export {}\n");
  write(hankDir, "templates/app/sub/generated/out.js", "built\n");
  // Authored exclusions + coverage output included without a negation.
  write(hankDir, "templates/app/node_modules/pkg/index.js", "junk\n");
  write(hankDir, "templates/app/coverage/lcov.info", "re-admitted\n");
  write(hankDir, "templates/app/debug.log", "junk\n");
  // A .git MARKER FILE (worktree/submodule form).
  write(hankDir, "templates/app/vendor/.git", "gitdir: /machine/specific\n");
  write(hankDir, "templates/app/vendor/lib.ts", "export {}\n");
  return hankDir;
}

/** The kept set inside templates/app, as hank-relative POSIX paths. */
const EXPECTED_KEPT = [
  "templates/app/coverage/lcov.info",
  "templates/app/keep.tmp",
  "templates/app/main.ts",
  "templates/app/sub/real.ts",
  "templates/app/vendor/lib.ts",
].sort();

/** Ground truth from REAL git: init a repo displaced over the hank using
 * only its authored .gitignore, and list what it would keep. */
function gitGroundTruth(hankDir: string): string[] {
  const scratch = tempDir("parity-truth-");
  const gitDir = path.join(scratch, "gitdir");
  const env = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    HOME: scratch,
    XDG_CONFIG_HOME: scratch,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_DIR: gitDir,
    GIT_WORK_TREE: hankDir,
  } as NodeJS.ProcessEnv;
  execFileSync("git", ["init", "--quiet"], { cwd: hankDir, env });
  fs.mkdirSync(path.join(gitDir, "info"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "info", "exclude"), "");
  const out = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: hankDir,
    env,
    encoding: "utf8",
  });
  return out
    .split("\0")
    .filter((p) => p.length > 0 && p.startsWith("templates/app/"))
    .sort();
}

describe("three-consumer parity on one messy tree", () => {
  it("loader, packer, rig copy, and real git agree on the kept set", async () => {
    const hankDir = buildMessyHank();

    // 1. The LOADER accepts the hank (ignored junk invisible, kept tree clean).
    expect(() => loadCodonSequence({ configPath: path.join(hankDir, "hank.json") })).not.toThrow();

    // 2. The PACKER ships exactly the kept set (plus configs & rule files).
    const closure = computeClosure(hankDir);
    expect(closure.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(closure.ok).toBe(true);
    const packedTree = closure.files
      .map((f) => f.bundlePath)
      .filter((p) => p.startsWith("templates/app/"))
      .sort();
    expect(packedTree).toEqual(EXPECTED_KEPT);
    // The ONE rules file ships (root fold) — extraction judges identically.
    const allPaths = closure.files.map((f) => f.bundlePath);
    expect(allPaths).toContain(".gitignore");

    // 3. The RUNTIME copy filter admits exactly the kept set.
    const view = new HankDir(hankDir);
    views.push(view);
    const from = path.join(hankDir, "templates", "app");
    const filter = view.copyFilter(from);
    const copied: string[] = [];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        if (!filter(abs)) continue;
        const lst = fs.lstatSync(abs);
        if (lst.isDirectory()) walk(abs);
        else copied.push(path.relative(hankDir, abs).split(path.sep).join("/"));
      }
    };
    walk(from);
    expect(copied.sort()).toEqual(EXPECTED_KEPT);

    // 4. REAL GIT ground truth (the vendor/.git marker is git's own hard
    // exclusion, matching ours).
    expect(gitGroundTruth(hankDir)).toEqual(EXPECTED_KEPT);
  });
});

/** A hank with NO root .gitignore whose rig ships things the default rules
 * drop: a prebuilt `build/` and a `*.log` fixture. develop copied both. */
function buildDefaultsDropHank(): string {
  const root = tempDir("defaults-drop-hank-");
  const hankDir = path.join(root, "hank");
  write(hankDir, "prompts/one.md", "do the thing\n");
  write(hankDir, "rig/src/main.ts", "export {}\n");
  write(hankDir, "rig/build/artifact.txt", "prebuilt\n");
  write(hankDir, "rig/app.log", "fixture log\n");
  write(
    hankDir,
    "hank.json",
    `${JSON.stringify(
      {
        meta: { name: "defaults-drop", version: "1.0.0" },
        hank: [
          {
            id: "one",
            name: "one",
            model: "sonnet",
            continuationMode: "fresh",
            promptFile: "prompts/one.md",
            rigSetup: [{ type: "copy", copy: { from: "rig", to: "rig" } }],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return hankDir;
}

describe("what the ignore rules drop is reported by every consumer", () => {
  it("validator, packer, and rig copy name the same excluded entries in the same words", async () => {
    const hankDir = buildDefaultsDropHank();
    const expected = "2 entries excluded by the default ignore rules: rig/app.log, rig/build";

    // 1. The VALIDATOR (--validate, and startup through displayValidatedHank)
    // warns per copy root — the loader does not reject, so this is the
    // author's only line before the run.
    const executionPath = tempDir("defaults-drop-exec-");
    const result = await validateHank({
      configPath: path.join(hankDir, "hank.json"),
      executionPath,
      logger: new Logger("/dev/null"),
      skipSelfTests: true,
    });
    expect(result.warnings).toContain(`Codon 1 (one): Copy source "rig": ${expected}`);

    // 2. The PACKER's lint finding.
    const closure = computeClosure(hankDir);
    const finding = closure.findings.find((f) => f.category === "ignored-paths");
    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toBe(expected);
    expect(closure.files.map((f) => f.bundlePath).filter((p) => p.startsWith("rig/"))).toEqual([
      "rig/src/main.ts",
    ]);

    // 3. The RUNTIME rig copy reports what it dropped (the state manager
    // turns this into the rig-copy-excluded progress event).
    const agentRoot = path.join(executionPath, "agentRoot");
    fs.mkdirSync(agentRoot, { recursive: true });
    const ws = await Workspace.open(
      new ExecutionLayout(executionPath, { agentRootPath: agentRoot }),
    );
    const hank = new HankDir(hankDir);
    views.push(hank);
    const planted = await ws.rigs.plantCopy(hank, path.join(hankDir, "rig"), "rig");
    expect(planted.ignored.map((i) => i.rel)).toEqual(["rig/app.log", "rig/build"]);
    expect(describeIgnoredEntries(planted.ignored)).toBe(expected);
    expect(fs.existsSync(path.join(agentRoot, "rig", "src", "main.ts"))).toBe(true);
    expect(fs.existsSync(path.join(agentRoot, "rig", "build"))).toBe(false);
    expect(fs.existsSync(path.join(agentRoot, "rig", "app.log"))).toBe(false);
  });
});

describe("repack determinism canary", () => {
  it.each([false, true])(
    "pack → extract → pack reproduces the full lock (empty rules: %s)",
    (emptyRules) => {
      const hankDir = buildMessyHank();
      if (emptyRules) write(hankDir, ".gitignore", "");

      const closure1 = computeClosure(hankDir);
      expect(closure1.ok).toBe(true);
      if (emptyRules) {
        expect(closure1.files.find((file) => file.bundlePath === ".gitignore")?.bytes.length).toBe(
          0,
        );
        expect(closure1.files.map((file) => file.bundlePath)).toContain(
          "templates/app/node_modules/pkg/index.js",
        );
      }
      const lock1 = buildLock(closure1);

      // "Extract": materialize exactly the bundle members into a fresh dir.
      const extracted = tempDir("parity-extracted-");
      for (const entry of closure1.files) {
        const dest = path.join(extracted, ...entry.bundlePath.split("/"));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, entry.bytes);
        if (entry.mode === "755") fs.chmodSync(dest, 0o755);
      }

      const closure2 = computeClosure(extracted);
      expect(closure2.findings.filter((f) => f.severity === "error")).toEqual([]);
      expect(closure2.ok).toBe(true);
      const lock2 = buildLock(closure2);

      // Full-lock comparison: member set, tree hashes (via codonInputs), and
      // bundleHash — not bundleHash alone, which can survive a tree-hash
      // divergence when the member set happens to match.
      expect(serializeLock(lock2)).toBe(serializeLock(lock1));
    },
  );

  it("junk appearing in ignored directories leaves the lock byte-identical", () => {
    const hankDir = buildMessyHank();
    const lockBefore = serializeLock(buildLock(computeClosure(hankDir)));

    write(hankDir, "templates/app/node_modules/more/junk.js", "x");
    write(hankDir, "templates/app/another.log", "x");

    const lockAfter = serializeLock(buildLock(computeClosure(hankDir)));
    expect(lockAfter).toBe(lockBefore);
  });
});
