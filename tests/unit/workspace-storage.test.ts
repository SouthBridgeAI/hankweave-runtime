import { expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import {
  CheckpointId,
  CheckpointNotFoundError,
  CheckpointStorageError,
} from "../../server/workspace/checkpoints.js";
import { Workspace } from "../../server/workspace/index.js";
import type { WorkspaceStorage } from "../../server/workspace/storage.js";

test("file selections and recovery share an injected storage adapter", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-storage-"));
  try {
    const layout = new ExecutionLayout(root);
    const modified = new Date("2026-01-01T00:00:00Z");
    const base = CheckpointId("snapshot:base");
    const saved = CheckpointId("snapshot:one");
    const storage: WorkspaceStorage = {
      initialize: mock(async () => base),
      listFiles: mock(async () => [{ path: "note.txt", lastModified: modified }]),
      admitFile: mock((name) => (name === "note.txt" ? name : null)),
      readFile: mock((name) =>
        name === "note.txt" ? { content: "adapter contents", lastModified: modified } : null,
      ),
      historyNames: async () => ["run-one"],
      historyTip: async () => saved,
      getSnapshot: async (id) => ({
        id,
        parents: [base],
        message: "saved",
        timestamp: modified.toISOString(),
      }),
      resolveSnapshot: async (id) => {
        if (id === "base" || id === base) return base;
        throw new CheckpointNotFoundError(id);
      },
      saveSnapshot: mock(async () => saved),
      preserveSnapshot: mock(async () => ({
        id: "snapshot:recovery",
        history: "safety-copy",
        checkpointPaths: ["note.txt", "recorded.txt"],
      })),
      restoreSnapshot: mock(async () => {}),
      snapshotsBetween: async () => new Set([saved]),
      allSnapshotIds: async () => new Set([base, saved]),
      listSnapshots: async () => [
        { id: saved, parents: [base], message: "saved", timestamp: modified.toISOString() },
      ],
    };
    const workspace = await Workspace.open(layout, { storage });
    expect(storage.initialize).toHaveBeenCalledTimes(1);

    const files = workspace.files.select(["*.txt"]);
    expect(await files.files()).toEqual(["note.txt"]);
    expect(storage.listFiles).toHaveBeenCalledWith(["*.txt"]);
    expect(files.admit("hidden.txt")).toBeNull();
    expect(storage.admitFile).toHaveBeenCalledWith("hidden.txt", ["*.txt"]);
    expect(files.read("note.txt")).toEqual({ content: "adapter contents", lastModified: modified });
    expect(storage.readFile).toHaveBeenCalledWith("note.txt", ["*.txt"]);
    expect(await files.tree()).toEqual([
      {
        name: "note.txt",
        path: "note.txt",
        lastModified: modified.toISOString(),
        isDirectory: false,
        children: [],
      },
    ]);

    const history = workspace.checkpoints.history("run-one");
    const id = await history.checkpoint({ parent: base, message: "saved", patterns: ["*.txt"] });
    expect(id).toBe(saved);
    expect(storage.saveSnapshot).toHaveBeenCalledWith({
      history: "run-one",
      parent: base,
      message: "saved",
      patterns: ["*.txt"],
    });
    expect(await history.tip()).toBe(saved);
    expect(await history.list()).toEqual([
      { id: saved, parents: [base], message: "saved", timestamp: modified.toISOString() },
    ]);
    expect((await workspace.checkpoints.histories()).map((h) => h.name)).toEqual(["run-one"]);
    expect(await workspace.checkpoints.get(saved)).toEqual((await history.list())[0]);
    expect(await workspace.checkpoints.allReachableIds()).toEqual(new Set([base, saved]));

    // Target validation still precedes preservation, independent of the backend.
    await expect(
      workspace.recovery.prepare({
        target: "missing",
        baseline: saved,
        reason: "rollback",
        patterns: ["*.txt"],
      }),
    ).rejects.toBeInstanceOf(CheckpointNotFoundError);
    expect(storage.preserveSnapshot).not.toHaveBeenCalled();
    const recovery = await workspace.recovery.prepare({
      target: "base",
      baseline: saved,
      reason: "rollback",
      patterns: ["*.txt"],
    });
    expect(recovery.target).toBe(base);
    expect(recovery.snapshot.snapshotId).toBe(CheckpointId("snapshot:recovery"));
    expect(recovery.snapshot.branch).toBe("safety-copy");
    expect(recovery.snapshot.checkpointPaths).toEqual(["note.txt", "recorded.txt"]);
    expect(storage.preserveSnapshot).toHaveBeenCalledWith(
      saved,
      "Recovery snapshot before rollback",
      ["*.txt"],
    );
    expect(await workspace.checkpoints.reachableDifference(id, recovery.target)).toEqual(
      new Set([saved]),
    );
    await recovery.restoreIntermediate(saved);
    expect(storage.restoreSnapshot).toHaveBeenCalledWith(saved, ["note.txt", "recorded.txt"]);
    await recovery.restore();
    expect(storage.restoreSnapshot).toHaveBeenCalledWith(base, ["note.txt", "recorded.txt"]);
    expect(fs.existsSync(layout.checkpointsPath)).toBe(false);
    expect(fs.existsSync(layout.agentRootPath)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Opening must not query files, switch history, or mutate snapshots. */
function openingStorage(): WorkspaceStorage {
  const unexpected = (): never => {
    throw new Error("Unexpected workspace operation during opening");
  };
  return {
    initialize: mock(async () => "initial"),
    listSnapshots: mock(async () => []),
    listFiles: unexpected,
    admitFile: unexpected,
    readFile: unexpected,
    historyNames: unexpected,
    historyTip: unexpected,
    getSnapshot: unexpected,
    resolveSnapshot: unexpected,
    saveSnapshot: unexpected,
    preserveSnapshot: unexpected,
    restoreSnapshot: unexpected,
    snapshotsBetween: unexpected,
    allSnapshotIds: unexpected,
  };
}

test("opening waits for storage and readable history before publishing capabilities", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-opening-"));
  const initialized = Promise.withResolvers<string>();
  const enumerated = Promise.withResolvers<[]>();
  const enumerationStarted = Promise.withResolvers<void>();
  try {
    const storage = openingStorage();
    storage.initialize = mock(() => initialized.promise);
    storage.listSnapshots = mock(() => {
      enumerationStarted.resolve();
      return enumerated.promise;
    });
    let published = false;
    const opening = Workspace.open(new ExecutionLayout(root), { storage }).then((workspace) => {
      published = true;
      return workspace;
    });
    expect(storage.initialize).toHaveBeenCalledTimes(1);
    expect(storage.listSnapshots).not.toHaveBeenCalled();
    expect(published).toBe(false);
    initialized.resolve("initial");
    await enumerationStarted.promise;
    expect(published).toBe(false);
    enumerated.resolve([]);
    const workspace = await opening;
    expect(published).toBe(true);
    expect(storage.initialize).toHaveBeenCalledTimes(1);
    expect(storage.listSnapshots).toHaveBeenCalledTimes(1);
    expect(
      await workspace.archives.planRestore({ abandoned: new Set(), known: new Set() }),
    ).toEqual({ count: 0 });
  } finally {
    initialized.resolve("initial");
    enumerated.resolve([]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each(["initialize", "listSnapshots"] as const)(
  "opening rejects a %s failure before attempting archive loading",
  async (operation) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-opening-failure-"));
    try {
      const layout = new ExecutionLayout(root);
      fs.mkdirSync(layout.stateDir);
      // If opening incorrectly continues, parsing this would mask the storage failure.
      fs.writeFileSync(layout.archiveManifestPath, "invalid manifest");
      const storage = openingStorage();
      const failure = new Error(`injected ${operation} failure`);
      storage[operation] = mock(async () => {
        throw failure;
      });
      const error = await Workspace.open(layout, { storage }).catch((cause: unknown) => cause);
      if (operation === "initialize") {
        expect(error).toBe(failure);
        expect(storage.listSnapshots).not.toHaveBeenCalled();
      } else {
        expect(error).toBeInstanceOf(CheckpointStorageError);
        expect((error as Error).cause).toBe(failure);
      }
      expect(storage.initialize).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(layout.archiveManifestPath, "utf8")).toBe("invalid manifest");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
