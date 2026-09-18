import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { Logger } from "../../server/utils";
import {
  CheckpointHistoryConflictError,
  CheckpointId,
} from "../../server/workspace/checkpoints.js";
import {
  CheckpointNotFoundError,
  CheckpointStorageError,
  GitWorkspaceStorage,
} from "../../server/workspace/git-storage";
import { Workspace } from "../../server/workspace/index.js";
import { requireHistoryTip } from "../utils/checkpoint-history.js";

const isWindows = process.platform === "win32";

/**
 * Checkpoints as the runtime takes them: through the Workspace, which owns
 * the mechanism, decides what a checkpoint stages, and hands GitWorkspaceStorage a
 * computed delta. The work tree is the execution directory itself here
 * (agentRootPath: tempDir), the pre-agentRoot layout the mandatory
 * exclusions still defend.
 */
describe("Checkpoints through the Workspace", () => {
  let tempDir: string;
  let ws: Workspace;
  let logger: Logger;

  beforeAll(async () => {
    // Check if git is available
    try {
      const proc = Bun.spawn(["git", "--version"]);
      await proc.exited;
    } catch (_error) {
      console.error("Git is not available in test environment");
      throw new Error("Git is required for GitWorkspaceStorage tests");
    }
  });

  beforeEach(async () => {
    // Real git repos in the OS tmpdir, NOT tests/test-area: this repo lives
    // in a Dropbox-synced tree, and the sync daemon touching .git internals
    // mid-commit made commit() return null across 25 tests in one parallel
    // sweep. os.tmpdir() is never synced. (test-area also carries a
    // com.dropbox.ignored xattr now, but tmpdir makes these tests safe on
    // any synced checkout, not just this machine.)
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-checkpoint-test-"));
    logger = new Logger(path.join(tempDir, "test.log"));
    ws = await workspaceOver(tempDir);
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const workspaceOver = (root: string) =>
    Workspace.open(new ExecutionLayout(root, { agentRootPath: root }), { logger });
  const gitDirOf = (root: string) =>
    path.join(root, ".hankweave", "checkpoints", ".hankweavecheckpoints");
  /** Ask the shadow repo directly, the way the tests always have. */
  const git = (args: string[]): string =>
    Bun.spawnSync(["git", ...args], {
      cwd: tempDir,
      env: { ...process.env, GIT_DIR: gitDirOf(tempDir), GIT_WORK_TREE: tempDir },
    })
      .stdout.toString()
      .trim();
  const treeOf = (sha: string) => git(["ls-tree", "-r", "--name-only", sha]).split("\n");
  const currentBranch = () => git(["branch", "--show-current"]);

  test("opening returns readable checkpoint history", async () => {
    expect(await ws.checkpoints.history("main").tip()).not.toBeNull();
    expect(await ws.checkpoints.history("main").list()).toHaveLength(1);
  });

  test("staged residue from a failed attempt is not granted tracked continuity", async () => {
    // Simulate a failed earlier commit attempt: a file staged into the
    // index but never committed, which the rules NOW ignore.
    fs.writeFileSync(path.join(tempDir, "secret.env"), "TOKEN=x");
    git(["add", "-f", "--", "secret.env"]);
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "secret.env\n");
    fs.writeFileSync(path.join(tempDir, "kept.txt"), "x");

    const sha = await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "post-residue checkpoint",
      patterns: ["**/*"],
    });
    const listed = treeOf(sha);
    // The private index starts from the explicit parent, so residue in the
    // shared index cannot make an ignored file part of the checkpoint.
    expect(listed).toContain("kept.txt");
    expect(listed).not.toContain("secret.env");
  });

  test("a tracked file replaced by a directory checkpoints the new child, not neither", async () => {
    fs.writeFileSync(path.join(tempDir, "foo"), "was a file");
    await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "track foo as file",
      patterns: ["**/*"],
    });

    // The agent replaces the file `foo` with a directory `foo/bar`.
    fs.rmSync(path.join(tempDir, "foo"));
    fs.mkdirSync(path.join(tempDir, "foo"));
    fs.writeFileSync(path.join(tempDir, "foo", "bar"), "now a child");
    const second = await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "foo became a directory",
      patterns: ["**/*"],
    });

    // Removals run before adds, so `rm --cached -r foo` cannot wipe the
    // freshly staged `foo/bar` — the checkpoint contains the child.
    const listed = treeOf(second);
    expect(listed).toContain("foo/bar");
    expect(listed).not.toContain("foo");
  });

  test("an empty pattern set still records deletions without retaining earlier patterns", async () => {
    fs.writeFileSync(path.join(tempDir, "doomed.txt"), "x");
    await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "track doomed",
      patterns: ["**/*"],
    });

    fs.rmSync(path.join(tempDir, "doomed.txt"));
    fs.writeFileSync(path.join(tempDir, "new.txt"), "must remain untracked");
    const second = await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "no patterns, deletion still recorded",
      patterns: [],
    });
    expect(treeOf(second)).not.toContain("new.txt");
    expect(treeOf(second)).not.toContain("doomed.txt");
  });

  test("opening builds the shadow repository where the layout says", async () => {
    expect(fs.existsSync(gitDirOf(tempDir))).toBe(true);
  });

  test("only files matching the tracked patterns are checkpointed", async () => {
    await fs.promises.writeFile(path.join(tempDir, "test.log"), "log content");
    await fs.promises.writeFile(path.join(tempDir, "test.tmp"), "tmp content");
    await fs.promises.writeFile(path.join(tempDir, "test.txt"), "txt content");

    const sha = await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "Test commit",
      patterns: ["*.log", "*.tmp"],
    });
    const listed = treeOf(sha);
    expect(listed).toContain("test.log");
    expect(listed).toContain("test.tmp");
    expect(listed).not.toContain("test.txt");
  });

  test("checkpoint returns a full commit id", async () => {
    await fs.promises.writeFile(path.join(tempDir, "test.txt"), "test content");
    const sha = await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "Test commit",
      patterns: ["*.txt"],
    });
    expect(sha).toMatch(/^[a-f0-9]{40,64}$/);
    expect(await ws.checkpoints.history("main").tip()).toBe(sha);
  });

  test("checkpoint creates an empty commit when nothing changed", async () => {
    const headBefore = git(["rev-parse", "HEAD"]);

    const sha = await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "Empty commit",
      patterns: ["*.txt"],
    });
    expect(sha).toMatch(/^[a-f0-9]{40,64}$/);
    expect(sha).not.toBe(headBefore);
    expect(git(["rev-parse", "HEAD"])).toBe(headBefore);
    expect(await ws.checkpoints.history("main").tip()).toBe(sha);
  });

  test("recording on a named history leaves HEAD, main, and the shared index untouched", async () => {
    const parent = await requireHistoryTip(ws.checkpoints.history("main"));
    const index = fs.readFileSync(path.join(gitDirOf(tempDir), "index"));
    expect(currentBranch()).toBe("");
    fs.writeFileSync(path.join(tempDir, "test.txt"), "test content");
    const history = ws.checkpoints.history("test-branch");
    expect(await history.tip()).toBeNull();
    const sha = await history.checkpoint({ parent, message: "Branch commit", patterns: ["*.txt"] });
    expect(await history.tip()).toBe(sha);
    expect(await ws.checkpoints.history("main").tip()).toBe(parent);
    expect(git(["rev-parse", "HEAD"])).toBe(parent);
    expect(currentBranch()).toBe("");
    expect(fs.readFileSync(path.join(gitDirOf(tempDir), "index"))).toEqual(index);
    expect(fs.readFileSync(path.join(tempDir, "test.txt"), "utf8")).toBe("test content");
  });

  test("handles complex patterns correctly", async () => {
    await fs.promises.mkdir(path.join(tempDir, "src", "components"), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, "src", "utils"), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, "src", "components", "Button.tsx"), "export {}");
    await fs.promises.writeFile(path.join(tempDir, "src", "utils", "helper.ts"), "export {}");
    await fs.promises.writeFile(path.join(tempDir, "README.md"), "# Test");

    const sha = await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "Add files",
      patterns: ["src/**/*.tsx", "src/**/*.ts", "*.md"],
    });
    const listed = treeOf(sha);
    expect(listed).toContain("src/components/Button.tsx");
    expect(listed).toContain("src/utils/helper.ts");
    expect(listed).toContain("README.md");
  });

  test("history handles do not select or create branches", async () => {
    const main = ws.checkpoints.history("main");
    const parent = await requireHistoryTip(main);
    const feature = ws.checkpoints.history("new-feature-branch");
    expect(await feature.tip()).toBeNull();
    expect(await feature.list()).toEqual([]);
    expect((await ws.checkpoints.histories()).map((h) => h.name)).toEqual(["main"]);
    expect(git(["rev-parse", "HEAD"])).toBe(parent);
    expect(await main.tip()).toBe(parent);
    expect(currentBranch()).toBe("");
  });

  test("restore puts the work tree at a checkpoint", async () => {
    const file1 = path.join(tempDir, "file1.txt");
    await fs.promises.writeFile(file1, "content 1");
    const commit1 = await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "First commit",
      patterns: ["*.txt"],
    });

    const file2 = path.join(tempDir, "file2.txt");
    await fs.promises.writeFile(file2, "content 2");
    await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "Second commit",
      patterns: ["*.txt"],
    });
    expect(fs.existsSync(file1)).toBe(true);
    expect(fs.existsSync(file2)).toBe(true);

    const recovery = await ws.recovery.prepare({
      target: commit1,
      baseline: await requireHistoryTip(ws.checkpoints.history("main")),
      reason: "test",
      patterns: [],
    });
    await recovery.restore();
    expect(fs.existsSync(file1)).toBe(true);
    expect(fs.existsSync(file2)).toBe(false);
  });

  test("restore throws for a non-existent checkpoint", async () => {
    await expect(
      ws.recovery.prepare({
        target: "nonexistent123",
        baseline: await requireHistoryTip(ws.checkpoints.history("main")),
        reason: "test",
        patterns: [],
      }),
    ).rejects.toThrow("Checkpoint nonexistent123 not found in repository");
  });

  test("each history lists its ancestry without assigning shared commits a branch", async () => {
    // Two checkpoints on main
    const mainFile = path.join(tempDir, "main.txt");
    await fs.promises.writeFile(mainFile, "one");
    await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "main: first",
      patterns: ["*.txt"],
    });
    await fs.promises.writeFile(mainFile, "two");
    await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "main: second",
      patterns: ["*.txt"],
    });

    // Two checkpoints on a run branch
    const run = ws.checkpoints.history("run-1757489464604-eicnq");
    await fs.promises.writeFile(path.join(tempDir, "feature1.txt"), "f1");
    await run.checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "feature: first",
      patterns: ["*.txt"],
    });
    await fs.promises.writeFile(path.join(tempDir, "feature2.txt"), "f2");
    await run.checkpoint({
      parent: await requireHistoryTip(run),
      message: "feature: second",
      patterns: ["*.txt"],
    });

    const checkpoints = await run.list();
    expect(checkpoints).toHaveLength(5);
    expect(checkpoints.map((c) => c.message)).toEqual([
      "feature: second",
      "feature: first",
      "main: second",
      "main: first",
      "Initial checkpoint setup",
    ]);
    expect((await ws.checkpoints.history("main").list()).map((c) => c.message)).toEqual([
      "main: second",
      "main: first",
      "Initial checkpoint setup",
    ]);
  }, 15000);

  test("allReachableIds returns ids across histories", async () => {
    await fs.promises.writeFile(path.join(tempDir, "m.txt"), "m1");
    const m1 = await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "m1",
      patterns: ["*.txt"],
    });
    await fs.promises.writeFile(path.join(tempDir, "m.txt"), "m2");
    const m2 = await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "m2",
      patterns: ["*.txt"],
    });

    const featureHistory = ws.checkpoints.history("feat-a");
    await fs.promises.writeFile(path.join(tempDir, "f1.txt"), "f1");
    const f1 = await featureHistory.checkpoint({ parent: m2, message: "f1", patterns: ["*.txt"] });
    await fs.promises.writeFile(path.join(tempDir, "f2.txt"), "f2");
    const f2 = await featureHistory.checkpoint({ parent: f1, message: "f2", patterns: ["*.txt"] });

    const ids = await ws.checkpoints.allReachableIds();
    for (const sha of [m1, m2, f1, f2]) expect(ids.has(sha)).toBe(true);
  });

  test("opening detects and reuses an existing repository", async () => {
    await fs.promises.writeFile(path.join(tempDir, "marker.txt"), "test");
    const firstCommit = await ws.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(ws.checkpoints.history("main")),
      message: "Marker commit",
      patterns: ["*.txt"],
    });

    const again = await workspaceOver(tempDir);

    expect(await again.checkpoints.history("main").tip()).toBe(firstCommit);
    expect(git(["log", "--oneline", "-1", "refs/heads/main"])).toContain("Marker commit");
  });

  test("concurrent writes from the same parent publish once and reject stale writers", async () => {
    const history = ws.checkpoints.history("main");
    const parent = await requireHistoryTip(history);
    fs.writeFileSync(path.join(tempDir, "test.txt"), "shared contents");
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        history.checkpoint({ parent, message: `Parallel commit ${i}`, patterns: ["*.txt"] }),
      ),
    );
    const successful = results.filter((r) => r.status === "fulfilled");
    expect(successful).toHaveLength(1);
    expect(await history.tip()).toBe(successful[0].value);
    for (const result of results) {
      if (result.status === "rejected")
        expect(result.reason).toBeInstanceOf(CheckpointHistoryConflictError);
    }
    expect((await history.list()).map((c) => c.id)).toEqual([successful[0].value, parent]);
    expect(git(["rev-parse", "HEAD"])).toBe(parent);
  });

  test("opening migrates a legacy .git directory to .hankweavecheckpoints", async () => {
    // tmpdir, not test-area — see the beforeEach note on synced folders.
    const migrationTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-migration-test-"));
    const checkpointPath = path.join(migrationTempDir, ".hankweave", "checkpoints");

    try {
      // Create legacy structure with a real git repo
      await fs.promises.mkdir(checkpointPath, { recursive: true });
      const legacyGitDir = path.join(checkpointPath, ".git");
      await Bun.spawn(["git", "init", "--bare", legacyGitDir]).exited;
      expect(fs.existsSync(legacyGitDir)).toBe(true);
      expect(fs.existsSync(path.join(checkpointPath, ".hankweavecheckpoints"))).toBe(false);

      // Booting a workspace over it triggers the migration
      await Workspace.open(
        new ExecutionLayout(migrationTempDir, { agentRootPath: migrationTempDir }),
        { logger: new Logger(path.join(migrationTempDir, "test.log")) },
      );

      expect(fs.existsSync(legacyGitDir)).toBe(false);
      expect(fs.existsSync(path.join(checkpointPath, ".hankweavecheckpoints"))).toBe(true);
    } finally {
      rmSync(migrationTempDir, { recursive: true, force: true });
    }
  });

  describe("rollback reachability helpers (issue #228)", () => {
    test("history tip returns the published checkpoint", async () => {
      await fs.promises.writeFile(path.join(tempDir, "h.txt"), "h");
      const sha = await ws.checkpoints.history("main").checkpoint({
        parent: await requireHistoryTip(ws.checkpoints.history("main")),
        message: "head commit",
        patterns: ["*.txt"],
      });
      expect(await ws.checkpoints.history("main").tip()).toBe(sha);
    });

    test("reachableDifference returns commits strictly after target on a linear history", async () => {
      await fs.promises.writeFile(path.join(tempDir, "l.txt"), "1");
      const c1 = await ws.checkpoints.history("main").checkpoint({
        parent: await requireHistoryTip(ws.checkpoints.history("main")),
        message: "c1",
        patterns: ["*.txt"],
      });
      await fs.promises.writeFile(path.join(tempDir, "l.txt"), "2");
      const c2 = await ws.checkpoints.history("main").checkpoint({
        parent: await requireHistoryTip(ws.checkpoints.history("main")),
        message: "c2",
        patterns: ["*.txt"],
      });
      await fs.promises.writeFile(path.join(tempDir, "l.txt"), "3");
      const c3 = await ws.checkpoints.history("main").checkpoint({
        parent: await requireHistoryTip(ws.checkpoints.history("main")),
        message: "c3",
        patterns: ["*.txt"],
      });

      const between = await ws.checkpoints.reachableDifference(c3, c1);
      expect(between.has(c1)).toBe(false); // target itself excluded
      expect(between.has(c2)).toBe(true);
      expect(between.has(c3)).toBe(true);
    });

    test("reachableDifference excludes sibling-branch (foreign) commits", async () => {
      await fs.promises.writeFile(path.join(tempDir, "s.txt"), "base");
      const base = await ws.checkpoints.history("main").checkpoint({
        parent: await requireHistoryTip(ws.checkpoints.history("main")),
        message: "base",
        patterns: ["*.txt"],
      });

      // Sibling branch off base, then back to main
      const featureHistory = ws.checkpoints.history("feat-a");
      await fs.promises.writeFile(path.join(tempDir, "s.txt"), "feature");
      const feature = await featureHistory.checkpoint({
        parent: base,
        message: "feature",
        patterns: ["*.txt"],
      });

      await fs.promises.writeFile(path.join(tempDir, "s.txt"), "main-after");
      const mainAfter = await ws.checkpoints.history("main").checkpoint({
        parent: await requireHistoryTip(ws.checkpoints.history("main")),
        message: "main after",
        patterns: ["*.txt"],
      });

      const between = await ws.checkpoints.reachableDifference(mainAfter, base);
      expect(between.has(mainAfter)).toBe(true);
      expect(between.has(feature)).toBe(false); // foreign branch stays out
      expect(between.has(base)).toBe(false);
    });

    test("reachableDifference returns an empty set when target equals origin", async () => {
      await fs.promises.writeFile(path.join(tempDir, "e.txt"), "e");
      const sha = await ws.checkpoints.history("main").checkpoint({
        parent: await requireHistoryTip(ws.checkpoints.history("main")),
        message: "only",
        patterns: ["*.txt"],
      });
      expect((await ws.checkpoints.reachableDifference(sha, sha)).size).toBe(0);
    });

    test("reachableDifference throws CheckpointStorageError for unknown ids", async () => {
      const head = await ws.checkpoints.history("main").tip();
      if (!head) throw new Error("expected an initial checkpoint");
      await expect(
        ws.checkpoints.reachableDifference(
          head,
          CheckpointId("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
        ),
      ).rejects.toBeInstanceOf(CheckpointStorageError);
    });
  });

  test("checkpoint directory is not detected as git submodule when committed", async () => {
    const submoduleTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-submodule-test-"));

    try {
      await fs.promises.mkdir(submoduleTempDir, { recursive: true });

      // Initialize a parent git repo
      await Bun.spawn(["git", "init"], { cwd: submoduleTempDir }).exited;
      await Bun.spawn(["git", "config", "user.email", "test@test.com"], {
        cwd: submoduleTempDir,
      }).exited;
      await Bun.spawn(["git", "config", "user.name", "Test"], {
        cwd: submoduleTempDir,
      }).exited;

      // Create checkpoint structure with .hankweavecheckpoints
      const checkpointPath = path.join(submoduleTempDir, ".hankweave", "checkpoints");
      const hwgitPath = path.join(checkpointPath, ".hankweavecheckpoints");
      await fs.promises.mkdir(hwgitPath, { recursive: true });
      await fs.promises.writeFile(path.join(hwgitPath, "HEAD"), "ref: refs/heads/main");

      // Stage the .hankweave directory
      await Bun.spawn(["git", "add", ".hankweave"], { cwd: submoduleTempDir }).exited;

      // Check for submodule mode (160000)
      const proc = Bun.spawn(["git", "ls-files", "--stage"], {
        cwd: submoduleTempDir,
      });
      const output = await new Response(proc.stdout).text();

      // Should NOT contain mode 160000 (submodule)
      expect(output).not.toContain("160000");

      // Should contain the .hankweavecheckpoints files as regular files
      expect(output).toContain(".hankweave/checkpoints/.hankweavecheckpoints/HEAD");
    } finally {
      rmSync(submoduleTempDir, { recursive: true, force: true });
    }
  });
});

/**
 * The mechanism on its own: crash-safe initialization, the three-way
 * resolver, and the plumbing (intermediates/66-crash-safe-checkpoints).
 * Fixtures reproduce the on-disk footprint of a SIGKILL at each point of the
 * build, using the production layout: a bare-style git dir at
 * .hankweave/checkpoints/.hankweavecheckpoints addressed via GIT_DIR — never
 * a nested .git. Deltas are hand-written: GitWorkspaceStorage stages exactly what
 * it is given.
 */
describe("GitWorkspaceStorage crash-safe initialization", () => {
  let tempDir: string;
  let logger: Logger;
  let logPath: string;

  const gitDirOf = (root: string) =>
    path.join(root, ".hankweave", "checkpoints", ".hankweavecheckpoints");

  async function git(root: string, args: string[]): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: root,
      env: { ...process.env, GIT_DIR: gitDirOf(root), GIT_WORK_TREE: root },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { code, out: out.trim() };
  }

  /** A repo folder exactly as a kill between `git init` and the first commit leaves it. */
  async function makeUnbornRepo(root: string): Promise<void> {
    fs.mkdirSync(path.dirname(gitDirOf(root)), { recursive: true });
    const r = await git(root, ["init", "--initial-branch=main"]);
    expect(r.code).toBe(0);
    expect((await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).code).not.toBe(0);
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-crashsafe-test-"));
    logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const readLog = () => (fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "");
  const siblingsOfRepo = () =>
    fs.readdirSync(path.join(tempDir, ".hankweave", "checkpoints")).sort();

  /** The mechanism over the production layout, work tree = execution dir. */
  const mechanism = () =>
    new GitWorkspaceStorage(
      {
        checkpointDir: path.join(tempDir, ".hankweave", "checkpoints"),
        workTree: tempDir,
        legacyBackupScanRoot: tempDir,
      },
      logger,
    );
  const boot = (cg: GitWorkspaceStorage = mechanism()) => cg.initialize();
  /** One checkpoint of exactly these files, the way the Workspace sequences it. */
  async function record(
    cg: GitWorkspaceStorage,
    message: string,
    addPaths: string[],
  ): Promise<string> {
    const parent = await cg.historyTip("main");
    if (parent === null) throw new Error("Missing main history");
    return cg.saveSnapshot({
      history: "main",
      parent,
      message,
      patterns: addPaths,
    });
  }

  test("a fresh build leaves no temp folder behind", async () => {
    const sha = await boot();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(siblingsOfRepo()).toEqual([".gitconfig", ".hankweavecheckpoints"]);
    expect((await git(tempDir, ["rev-parse", "HEAD"])).out).toBe(sha);
    // The owner's info/exclude is written into a fresh repo.
    expect(fs.readFileSync(path.join(gitDirOf(tempDir), "info", "exclude"), "utf-8")).toBe(
      ExecutionLayout.CHECKPOINT_INFO_EXCLUDE,
    );
  });

  test("an unborn repo (killed between init and first commit) is rebuilt", async () => {
    await makeUnbornRepo(tempDir);
    // Locks the killed builder may have left behind go with the folder.
    fs.writeFileSync(path.join(gitDirOf(tempDir), "index.lock"), "");
    fs.writeFileSync(path.join(gitDirOf(tempDir), "config.lock"), "");

    const cg = mechanism();
    const sha = await boot(cg);

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await git(tempDir, ["rev-parse", "HEAD"])).out).toBe(sha);
    expect(readLog()).toContain("has no resolvable HEAD; removing it and building a fresh one");
    expect(siblingsOfRepo()).toEqual([".gitconfig", ".hankweavecheckpoints"]);
    expect(fs.existsSync(path.join(gitDirOf(tempDir), "index.lock"))).toBe(false);
    expect((await git(tempDir, ["config", "user.name"])).out).toBe("Hankweave Runtime");

    // The rebuilt repo is fully usable: checkpoints commit and resolve.
    await fs.promises.writeFile(path.join(tempDir, "a.txt"), "a");
    const commit = await record(cg, "after rebuild", ["a.txt"]);
    await expect(cg.resolveSnapshot(commit)).resolves.toBe(commit);
  });

  test("a second boot over a rebuilt repo reuses it", async () => {
    await makeUnbornRepo(tempDir);
    const built = await boot();
    const sha = await boot();
    expect(sha).toBe(built);
    expect(readLog()).toContain(`Using existing shadow git repository with HEAD: ${built}`);
  });

  test("a temp build folder from a dead builder (kill before rename) is swept", async () => {
    const checkpointsDir = path.dirname(gitDirOf(tempDir));
    fs.mkdirSync(checkpointsDir, { recursive: true });
    const stale = path.join(checkpointsDir, ".hankweavecheckpoints.tmp-999999-1");
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, "HEAD"), "ref: refs/heads/main\n");

    await boot();

    expect(fs.existsSync(stale)).toBe(false);
    expect(readLog()).toContain("Removing stale checkpoint build folder");
  });

  test("a repo with objects but no resolvable HEAD is rebuilt from scratch", async () => {
    const seed = mechanism();
    await boot(seed);
    await fs.promises.writeFile(path.join(tempDir, "keep.txt"), "history");
    const kept = await record(seed, "history behind a lost ref", ["keep.txt"]);

    // Lose the refs but keep the objects: HEAD now points at a branch that is gone.
    const gitDir = gitDirOf(tempDir);
    rmSync(path.join(gitDir, "refs", "heads"), { recursive: true, force: true });
    fs.mkdirSync(path.join(gitDir, "refs", "heads"));
    rmSync(path.join(gitDir, "packed-refs"), { force: true });
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    expect((await git(tempDir, ["rev-parse", "--verify", "--quiet", "HEAD"])).code).not.toBe(0);

    const cg = mechanism();
    const sha = await boot(cg);

    // Nothing is kept aside: the folder was replaced, and the old SHA is gone.
    expect(siblingsOfRepo()).toEqual([".gitconfig", ".hankweavecheckpoints"]);
    expect((await git(tempDir, ["rev-parse", "HEAD"])).out).toBe(sha);
    await expect(cg.resolveSnapshot(kept)).rejects.toBeInstanceOf(CheckpointNotFoundError);
    expect(readLog()).toContain("has no resolvable HEAD; removing it and building a fresh one");
  });

  describe("resolveSnapshot", () => {
    test("full SHA and unambiguous prefix resolve; unknown and empty references are not found", async () => {
      const cg = mechanism();
      await boot(cg);
      await fs.promises.writeFile(path.join(tempDir, "x.txt"), "x");
      const sha = await record(cg, "populate", ["x.txt"]);

      await expect(cg.resolveSnapshot(sha)).resolves.toBe(sha);
      await expect(cg.resolveSnapshot(sha.slice(0, 8))).resolves.toBe(sha);
      for (const missing of ["0123456789abcdef0123456789abcdef01234567", "", "abc"]) {
        await expect(cg.resolveSnapshot(missing)).rejects.toBeInstanceOf(CheckpointNotFoundError);
      }
    });

    test("before initialization the failure is storage trouble, never 'not found'", async () => {
      const cg = mechanism();
      await expect(
        cg.resolveSnapshot("0123456789abcdef0123456789abcdef01234567"),
      ).rejects.toBeInstanceOf(CheckpointStorageError);
    });
  });

  test("resetToCheckpoint refuses an empty reference on a populated repo", async () => {
    const cg = mechanism();
    await boot(cg);
    await fs.promises.writeFile(path.join(tempDir, "x.txt"), "x");
    await record(cg, "populate", ["x.txt"]);

    await expect(cg.restoreSnapshot("", [])).rejects.toBeInstanceOf(CheckpointNotFoundError);
    await expect(cg.restoreSnapshot("abc", [])).rejects.toBeInstanceOf(CheckpointNotFoundError);
  });

  test("file queries fail closed and refuse before initialization", async () => {
    const cg = mechanism();
    expect(() => cg.admitFile("x.txt", ["**"])).toThrow("Git repository not initialized");
    await expect(cg.listFiles(["**"])).rejects.toThrow("Git repository not initialized");

    await boot(cg);
    fs.writeFileSync(path.join(tempDir, "x.txt"), "x");
    expect(await cg.listFiles(["**"])).toContainEqual({
      path: "x.txt",
      lastModified: fs.statSync(path.join(tempDir, "x.txt")).mtime,
    });
    expect(cg.admitFile("x.txt", ["**"])).toBe("x.txt");
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "x.txt\n");
    expect(cg.admitFile("x.txt", ["**"])).toBeNull();
    expect((await cg.listFiles(["**"])).map((file) => file.path)).not.toContain("x.txt");

    // A broken index must produce a storage failure, never an empty list.
    fs.writeFileSync(path.join(gitDirOf(tempDir), "index"), "broken index");
    await expect(cg.listFiles(["**"])).rejects.toThrow(/refusing to guess/);
  });

  test("stale git locks in a healthy repo are cleared at boot so recovery can check out", async () => {
    // A kill during an ordinary checkpoint leaves index.lock (and, inside a
    // branch update, a ref lock). HEAD resolves, so the repo is "healthy" —
    // but `checkout --force` would fail on the lock every boot.
    const first = mechanism();
    await boot(first);
    await fs.promises.writeFile(path.join(tempDir, "a.txt"), "a");
    const sha = await record(first, "checkpoint", ["a.txt"]);
    fs.writeFileSync(path.join(gitDirOf(tempDir), "index.lock"), "");
    fs.writeFileSync(path.join(gitDirOf(tempDir), "refs", "heads", "main.lock"), "");

    const cg = mechanism();
    expect(await boot(cg)).toBe((await git(tempDir, ["rev-parse", "HEAD"])).out);
    expect(await cg.historyTip("main")).toBe(sha);

    expect(fs.existsSync(path.join(gitDirOf(tempDir), "index.lock"))).toBe(false);
    expect(fs.existsSync(path.join(gitDirOf(tempDir), "refs", "heads", "main.lock"))).toBe(false);
    expect(readLog()).toContain("Removing stale git lock index.lock");
    await expect(cg.restoreSnapshot(sha, [])).resolves.toBeUndefined();
  });

  test("a truncated HEAD stops the boot with the folder intact; it is not a torn build", async () => {
    // Same empty footprint as an unborn repo, but HEAD itself is empty. Git
    // writes HEAD through HEAD.lock + rename, so a kill cannot leave this;
    // it is disk trouble, and rev-parse exits 128 ("not a git repository")
    // rather than 1. Rebuilding here would be the same rm -rf that an
    // unreadable HEAD on a populated repo gets, so stop instead.
    await makeUnbornRepo(tempDir);
    fs.writeFileSync(path.join(gitDirOf(tempDir), "HEAD"), "");

    await expect(boot()).rejects.toThrow(CheckpointStorageError);

    expect(readLog()).not.toContain("has no resolvable HEAD; removing it and building a fresh one");
    expect(siblingsOfRepo()).toEqual([".hankweavecheckpoints"]);
    expect(fs.readFileSync(path.join(gitDirOf(tempDir), "HEAD"), "utf-8")).toBe("");
  });

  // Root ignores mode bits, so the unreadable-HEAD fixture cannot be built there.
  const notRoot = typeof process.getuid === "function" && process.getuid() !== 0;
  test.skipIf(!notRoot)(
    "a repo git cannot read (rev-parse exit 128) stops the boot and keeps every checkpoint",
    async () => {
      // A healthy repo: one checkpoint, one recovery snapshot.
      const first = mechanism();
      await boot(first);
      fs.writeFileSync(path.join(tempDir, "work.txt"), "checkpointed work");
      const checkpoint = await record(first, "completed:one", ["work.txt"]);
      const snapshot = await first.preserveSnapshot(checkpoint, "probe", ["work.txt"]);
      expect(checkpoint).toMatch(/^[0-9a-f]{40}$/);
      expect(snapshot.id).toMatch(/^[0-9a-f]{40}$/);

      // One file becomes unreadable: a permission glitch, not a torn build.
      // Before PR #242 review finding 2, this rebuilt the repo and deleted
      // every run-* branch and recovery/* snapshot.
      const headPath = path.join(gitDirOf(tempDir), "HEAD");
      fs.chmodSync(headPath, 0o000);
      try {
        await expect(boot()).rejects.toThrow(CheckpointStorageError);
      } finally {
        fs.chmodSync(headPath, 0o644);
      }

      expect(readLog()).not.toContain(
        "has no resolvable HEAD; removing it and building a fresh one",
      );
      const again = mechanism();
      await boot(again);
      await again.resolveSnapshot(checkpoint);
      expect(fs.readdirSync(path.join(gitDirOf(tempDir), "refs", "heads"))).toContain("recovery");
    },
  );

  test("an existing SHA-256 repository checkpoints and resolves end to end", async () => {
    // GIT_DEFAULT_HASH=sha256 (or init.defaultObjectFormat) makes `git init`
    // build such a repo; ids are 64 hex chars and simple-git's commit output
    // (core.abbrev=40) truncates them. The stored reference must still match
    // what enumeration returns.
    fs.mkdirSync(path.dirname(gitDirOf(tempDir)), { recursive: true });
    const init = await git(tempDir, ["init", "--object-format=sha256", "--initial-branch=main"]);
    expect(init.code).toBe(0);
    // GitWorkspaceStorage points HOME at the checkpoint folder, so the only identity
    // its commits can see is the repo's own config — which a repo it built
    // carries, and which this hand-built fixture must carry too. Without it
    // git falls back to auto-detection, which fails on CI runners whose
    // account has no display name (Linux) or no domain (Windows).
    expect((await git(tempDir, ["config", "user.name", "t"])).code).toBe(0);
    expect((await git(tempDir, ["config", "user.email", "t@t"])).code).toBe(0);
    expect((await git(tempDir, ["commit", "-q", "--allow-empty", "-m", "root"])).code).toBe(0);

    const cg = mechanism();
    await boot(cg);
    expect(readLog()).toContain("Using existing shadow git repository with HEAD");

    await fs.promises.writeFile(path.join(tempDir, "a.txt"), "a");
    const sha = await record(cg, "sha256 checkpoint", ["a.txt"]);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    await expect(cg.resolveSnapshot(sha)).resolves.toBe(sha);
    expect((await cg.allSnapshotIds()).has(sha)).toBe(true);
    expect((await cg.listSnapshots()).some((c) => c.id === sha)).toBe(true);
    await expect(cg.restoreSnapshot(sha, [])).resolves.toBeUndefined();
  });

  test("listSnapshots reports unreadable storage instead of answering 'no checkpoints'", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    if (process.platform === "win32") return; // chmod is a no-op on Windows; the dir stays readable
    const cg = mechanism();
    await boot(cg);
    await fs.promises.writeFile(path.join(tempDir, "x.txt"), "x");
    const sha = await record(cg, "populate", ["x.txt"]);
    expect((await cg.listSnapshots()).some((c) => c.id === sha)).toBe(true);

    // Storage that git cannot read must surface as an error, never as [].
    // (A dangling ref is not enough: `git branch -v` silently drops it.)
    const objects = path.join(gitDirOf(tempDir), "objects");
    fs.chmodSync(objects, 0o000);
    try {
      await expect(cg.listSnapshots()).rejects.toBeInstanceOf(CheckpointStorageError);
    } finally {
      fs.chmodSync(objects, 0o755);
    }
  });

  describe("recovery preserves files against an explicit baseline", () => {
    const workspace = async () => {
      const ws = await Workspace.open(new ExecutionLayout(tempDir, { agentRootPath: tempDir }), {
        logger,
      });

      return ws;
    };

    test("keeps the current contents of a tracked file that .gitignore now matches", async () => {
      const ws = await workspace();
      await fs.promises.writeFile(path.join(tempDir, "notes.txt"), "v1");
      const baseline = await ws.checkpoints.history("main").checkpoint({
        parent: await requireHistoryTip(ws.checkpoints.history("main")),
        message: "track notes",
        patterns: ["*.txt"],
      });

      const head = (await git(tempDir, ["rev-parse", "HEAD"])).out;
      expect(baseline).not.toBe(head);
      // Later the file is modified AND ignored — the empty-index footgun.
      await fs.promises.writeFile(path.join(tempDir, "notes.txt"), "v2");
      await fs.promises.appendFile(path.join(tempDir, ".gitignore"), "notes.txt\n");

      const { branch, snapshotId } = await ws.recovery.preserve({
        baseline: await requireHistoryTip(ws.checkpoints.history("main")),
        reason: "test",
        patterns: [],
      });
      expect(branch).toMatch(/^recovery\//);
      expect((await git(tempDir, ["show", `${snapshotId}:notes.txt`])).out).toBe("v2");
      expect((await git(tempDir, ["rev-parse", branch])).out).toBe(snapshotId);
      // HEAD, the real index and the work tree are untouched.
      expect((await git(tempDir, ["rev-parse", "HEAD"])).out).toBe(head);
      expect(fs.readFileSync(path.join(tempDir, "notes.txt"), "utf-8")).toBe("v2");
    });

    test("drops a read_only_data_source that HEAD already tracks", async () => {
      // HEAD can be an older snapshot (or a hand-made commit) that carries the
      // data tree; seeding the index from it must not carry the tree forward.
      const ws = await workspace();
      fs.mkdirSync(path.join(tempDir, "read_only_data_source"), { recursive: true });
      await fs.promises.writeFile(path.join(tempDir, "read_only_data_source", "d.bin"), "data");
      expect((await git(tempDir, ["add", "-f", "read_only_data_source/d.bin"])).code).toBe(0);
      expect((await git(tempDir, ["commit", "-q", "-m", "tracks data"])).code).toBe(0);
      expect((await git(tempDir, ["ls-tree", "-r", "--name-only", "HEAD"])).out).toContain(
        "read_only_data_source/d.bin",
      );

      const { snapshotId } = await ws.recovery.preserve({
        baseline: CheckpointId((await git(tempDir, ["rev-parse", "HEAD"])).out),
        reason: "test",
        patterns: [],
      });
      const files = (await git(tempDir, ["ls-tree", "-r", "--name-only", snapshotId])).out;
      expect(files).not.toContain("read_only_data_source");
    });

    test("excludes a copied read_only_data_source like every normal checkpoint", async () => {
      const ws = await workspace();
      fs.mkdirSync(path.join(tempDir, "read_only_data_source", "deep"), { recursive: true });
      await fs.promises.writeFile(
        path.join(tempDir, "read_only_data_source", "deep", "big.bin"),
        "dataset",
      );
      await fs.promises.writeFile(path.join(tempDir, "work.txt"), "w");

      const { snapshotId } = await ws.recovery.preserve({
        baseline: await requireHistoryTip(ws.checkpoints.history("main")),
        reason: "test",
        patterns: [],
      });
      const files = (await git(tempDir, ["ls-tree", "-r", "--name-only", snapshotId])).out.split(
        "\n",
      );
      expect(files).toContain("work.txt");
      expect(files.some((f) => f.startsWith("read_only_data_source"))).toBe(false);
    });

    test("records untracked files and the deletion of tracked ones", async () => {
      const ws = await workspace();
      await fs.promises.writeFile(path.join(tempDir, "gone.txt"), "x");
      await ws.checkpoints.history("main").checkpoint({
        parent: await requireHistoryTip(ws.checkpoints.history("main")),
        message: "track gone",
        patterns: ["*.txt"],
      });
      fs.rmSync(path.join(tempDir, "gone.txt"));
      await fs.promises.writeFile(path.join(tempDir, "never-tracked.md"), "untracked work");

      const { snapshotId } = await ws.recovery.preserve({
        baseline: await requireHistoryTip(ws.checkpoints.history("main")),
        reason: "test",
        patterns: [],
      });
      const files = (await git(tempDir, ["ls-tree", "-r", "--name-only", snapshotId])).out.split(
        "\n",
      );
      expect(files).toContain("never-tracked.md");
      expect(files).not.toContain("gone.txt");
    });

    test.skipIf(isWindows)(
      "a symlink is not a workspace file, so the snapshot leaves it out",
      async () => {
        // The snapshot uses the workspace's own definition of a file (regular
        // files through real directories) — the same one checkpoints and the
        // file tree use — instead of `git add -A`, which would record the link.
        const ws = await workspace();
        await fs.promises.writeFile(path.join(tempDir, "real.txt"), "real");
        fs.symlinkSync(path.join(tempDir, "real.txt"), path.join(tempDir, "link.txt"));

        const { snapshotId } = await ws.recovery.preserve({
          baseline: await requireHistoryTip(ws.checkpoints.history("main")),
          reason: "test",
          patterns: [],
        });
        const files = (await git(tempDir, ["ls-tree", "-r", "--name-only", snapshotId])).out.split(
          "\n",
        );
        expect(files).toContain("real.txt");
        expect(files).not.toContain("link.txt");
      },
    );
  });
});
