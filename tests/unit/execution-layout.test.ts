import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../../server/config.js";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { UnifiedFileResolver } from "../../server/file-resolver.js";

describe("execution-layout", () => {
  test("directory and file names are the on-disk spellings", () => {
    // These are the names other tools, docs and user scripts rely on. Changing
    // one is a migration, not a refactor.
    expect(ExecutionLayout.STATE_DIR).toBe(".hankweave");
    expect(ExecutionLayout.AGENT_ROOT).toBe("agentRoot");
    expect(ExecutionLayout.RIG_ARCHIVE).toBe("rigArchive");
    expect(ExecutionLayout.DATA_SOURCE).toBe("read_only_data_source");
    expect(ExecutionLayout.CHECKPOINTS).toBe("checkpoints");
    expect(ExecutionLayout.CHECKPOINT_GIT).toBe(".hankweavecheckpoints");
    expect(ExecutionLayout.EVENTS).toBe("events");
    expect(ExecutionLayout.RUNS).toBe("runs");
    expect(ExecutionLayout.EXECUTION_META_FILE).toBe("execution-meta.json");
    expect(ExecutionLayout.STATE_FILE).toBe("state.json");
    expect(ExecutionLayout.STATE_BACKUP_FILE).toBe("state.json.bak");
    expect(ExecutionLayout.RUNTIME_LOCK_FILE).toBe("runtime.lock");
    expect(ExecutionLayout.ARCHIVE_MANIFEST_FILE).toBe("archive-manifest.json");
    expect(ExecutionLayout.STATE_BACKUP_PREFIX).toBe(".hankweave.backup-");
    expect(ExecutionLayout.QUARANTINE_PREFIX).toBe(".hankweavecheckpoints-quarantine-");
    expect(ExecutionLayout.RIG_ARCHIVE_IGNORE_LINE).toBe("rigArchive/");
    expect(ExecutionLayout.DATA_SOURCE_PATHSPEC_EXCLUDE).toBe(":(exclude)read_only_data_source");
  });

  test("ExecutionLayout derives every path from one execution directory", () => {
    const root = path.join(os.tmpdir(), "hw-layout-test", "exec");
    const layout = new ExecutionLayout(root);
    const state = path.join(root, ".hankweave");
    const agentRoot = path.join(root, "agentRoot");

    expect({ ...layout }).toEqual({
      executionPath: root,
      stateDir: state,
      agentRootPath: agentRoot,
      rigArchivePath: path.join(root, "rigArchive"),
      dataPathInExecutionDir: path.join(agentRoot, "read_only_data_source"),
      checkpointsPath: path.join(state, "checkpoints"),
      checkpointGitDir: path.join(state, "checkpoints", ".hankweavecheckpoints"),
      metaPath: path.join(state, "execution-meta.json"),
      statePath: path.join(state, "state.json"),
      stateBackupPath: path.join(state, "state.json.bak"),
      lockPath: path.join(state, "runtime.lock"),
      eventsDir: path.join(state, "events"),
      runsDir: path.join(state, "runs"),
      archiveManifestPath: path.join(state, "archive-manifest.json"),
    });
  });

  test("the data link lives inside the agent workspace, not beside it", () => {
    // The pre-agentRoot layout put read_only_data_source at the execution root;
    // validate mode kept that spelling for months because nothing read it.
    const layout = new ExecutionLayout("/x");
    expect(layout.dataPathInExecutionDir).toBe(
      path.join("/x", "agentRoot", "read_only_data_source"),
    );
    expect(layout.dataPathInExecutionDir.startsWith(layout.agentRootPath + path.sep)).toBe(true);
  });

  test("ExecutionLayout is pure: it creates nothing", () => {
    const root = path.join(os.tmpdir(), `hw-layout-pure-${Date.now()}`);
    new ExecutionLayout(root);
    expect(fs.existsSync(root)).toBe(false);
  });

  test("DEFAULT_CONFIG.lockFile is the layout's runtime.lock relative to the execution dir", () => {
    const root = "/some/exec";
    expect(path.join(root, DEFAULT_CONFIG.lockFile)).toBe(new ExecutionLayout(root).lockPath);
  });

  test("timestamped siblings sit beside the directory they back up", () => {
    const layout = new ExecutionLayout("/x");
    expect(layout.stateBackupDir("2026-01-01T00-00-00")).toBe(
      path.join("/x", ".hankweave.backup-2026-01-01T00-00-00"),
    );
    expect(layout.quarantineGitDir("2026-01-01T00-00-00")).toBe(
      path.join(
        "/x",
        ".hankweave",
        "checkpoints",
        ".hankweavecheckpoints-quarantine-2026-01-01T00-00-00",
      ),
    );
  });

  test("a backed-up state directory keeps the live checkpoint shape", () => {
    const backup = path.join("/x", ".hankweave.backup-2026-01-01T00-00-00");
    expect(ExecutionLayout.forBackedUpStateDir(backup)).toEqual({
      checkpointsPath: path.join(backup, "checkpoints"),
      checkpointGitDir: path.join(backup, "checkpoints", ".hankweavecheckpoints"),
    });
  });

  test("name-level predicates match on the on-disk names only", () => {
    expect(ExecutionLayout.hasExecutionState([".hankweave", "agentRoot"])).toBe(true);
    expect(ExecutionLayout.hasExecutionState([".hankweave.backup-x", "agentRoot"])).toBe(false);
    expect(ExecutionLayout.isStateBackupDir(".hankweave.backup-2026-01-01T00-00-00")).toBe(true);
    expect(ExecutionLayout.isStateBackupDir(".hankweave")).toBe(false);
    expect(ExecutionLayout.isInsideStateBackup("/x/.hankweave.backup-1/checkpoints")).toBe(true);
    expect(ExecutionLayout.isInsideStateBackup("/x/.hankweave/checkpoints")).toBe(false);
  });

  test("MANDATORY_EXCLUDED_DIRS names exactly the protected work-tree paths", () => {
    expect([...ExecutionLayout.MANDATORY_EXCLUDED_DIRS]).toEqual([
      ".hankweave/checkpoints/.hankweavecheckpoints",
      ".hankweave/checkpoints/.hankweavecheckpoints-quarantine-*",
      ".hankweave.backup-*/checkpoints/.hankweavecheckpoints",
      ".hankweave.backup-*/checkpoints/.hankweavecheckpoints-quarantine-*",
      "read_only_data_source",
    ]);
  });
});

describe("mandatory exclusion policy follows the layout", () => {
  let workTree: string;
  const resolver = new UnifiedFileResolver();

  // One concrete instance of every protected directory (globs made concrete),
  // each holding a file that would otherwise be matched by "**/*".
  const protectedFiles = [
    ".hankweave/checkpoints/.hankweavecheckpoints/HEAD",
    ".hankweave/checkpoints/.hankweavecheckpoints-quarantine-2026-01-01T00-00-00/HEAD",
    ".hankweave.backup-2026-01-01T00-00-00/checkpoints/.hankweavecheckpoints/HEAD",
    ".hankweave.backup-2026-01-01T00-00-00/checkpoints/.hankweavecheckpoints-quarantine-x/HEAD",
    "read_only_data_source/input.csv",
    "read_only_data_source/nested/deep.txt",
  ];
  // Siblings the policy must NOT touch: ordinary work, and state files that
  // are not the shadow git directory (the resolver is not a .hankweave filter).
  const keptFiles = [
    "output.md",
    "src/main.ts",
    ".hankweave/state.json",
    ".hankweave/checkpoints/notes.txt",
    "not_read_only_data_source/x.txt",
    "sub/read_only_data_source/x.txt", // only the root-level link is protected
  ];

  beforeAll(async () => {
    workTree = await fs.promises.mkdtemp(path.join(os.tmpdir(), "hw-exclusion-"));
    for (const rel of [...protectedFiles, ...keptFiles]) {
      const abs = path.join(workTree, rel);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, rel);
    }
  });

  afterAll(async () => {
    await fs.promises.rm(workTree, { recursive: true, force: true });
  });

  test("resolveFiles drops every protected path and keeps everything else", async () => {
    const files = await resolver.resolveFiles(workTree, ["**/*"]);
    const got = new Set(files.map((f) => f.split(path.sep).join("/")));
    for (const rel of protectedFiles) {
      expect(got.has(rel)).toBe(false);
    }
    for (const rel of keptFiles) {
      expect(got.has(rel)).toBe(true);
    }
  });

  test("createPathMatcher agrees with resolveFiles on the protected set", async () => {
    const matcher = await resolver.createPathMatcher(workTree, ["**/*"]);
    for (const rel of protectedFiles) {
      expect(matcher.match(rel)).toBeNull();
    }
    for (const rel of keptFiles) {
      expect(matcher.match(rel)).toBe(rel);
    }
  });
});
