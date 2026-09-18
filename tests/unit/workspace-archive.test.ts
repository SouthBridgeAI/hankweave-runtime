import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { StateManager } from "../../server/state-manager.js";
import { Logger } from "../../server/utils.js";
import { type ArchiveOwner, WorkspaceArchive } from "../../server/workspace/archive.js";
import type { ArchiveEntry } from "../../server/workspace/archive-manifest.js";
import { CheckpointId, CheckpointService } from "../../server/workspace/checkpoints.js";
import { WorkspaceFiles } from "../../server/workspace/files.js";
import { GitWorkspaceStorage } from "../../server/workspace/git-storage.js";
import { Workspace } from "../../server/workspace/index.js";
import { requireHistoryTip } from "../utils/checkpoint-history.js";

let directory: string;
let layout: ExecutionLayout;
let workspace: Workspace;
const history = {
  abandoned: new Set(["c2", "c3"].map(CheckpointId)),
  known: new Set(["c1", "c2", "c3", "other"].map(CheckpointId)),
};

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-archive-"));
  layout = new ExecutionLayout(directory);
  fs.mkdirSync(layout.agentRootPath);
  workspace = await Workspace.open(layout);
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function put(relative: string, content = "result"): void {
  const absolute = path.join(layout.agentRootPath, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function entries(): ArchiveEntry[] {
  return JSON.parse(fs.readFileSync(layout.archiveManifestPath, "utf8")).entries;
}

function archivedContent(entry: ArchiveEntry): string {
  return fs.readFileSync(path.join(directory, entry.archivePath), "utf8");
}

async function archive(relative: string, codonId = "step", checkpoint = "c2") {
  return workspace.archives.archive(
    workspace.files.select([relative]),
    { kind: "codon", codonId },
    CheckpointId(checkpoint),
  );
}

async function reopenWith(records: ArchiveEntry[]): Promise<void> {
  fs.writeFileSync(
    layout.archiveManifestPath,
    JSON.stringify({ version: "1.0.0", entries: records }),
  );
  workspace = await Workspace.open(layout);
}

function failManifestWrite() {
  const writeFile = fs.promises.writeFile.bind(fs.promises);
  return spyOn(fs.promises, "writeFile").mockImplementation((...args) => {
    if (String(args[0]).startsWith(`${layout.archiveManifestPath}.`)) {
      return Promise.reject(Object.assign(new Error("manifest disk full"), { code: "ENOSPC" }));
    }
    return writeFile(...args);
  });
}

describe("Workspace archive ownership", () => {
  test("logical owners preserve the existing layout and manifest format across reopen", async () => {
    const cases: Array<[ArchiveOwner, string, string]> = [
      [{ kind: "codon", codonId: "step" }, "one.txt", "rigArchive/step/one.txt"],
      [
        { kind: "iteration", codonId: "step#1", loopId: "loop", iteration: 1 },
        "two.txt",
        "rigArchive/loop-1/step-1/two.txt",
      ],
      [{ kind: "loop", loopId: "loop" }, "three.txt", "rigArchive/loop-loop/three.txt"],
    ];
    for (const [owner, file] of cases) {
      put(file);
      expect(
        await workspace.archives.archive(workspace.files.select([file]), owner, CheckpointId("c2")),
      ).toEqual([{ path: file, status: "archived" }]);
    }
    const records = entries();
    expect(records.map((entry) => entry.archivePath.split(path.sep).join("/"))).toEqual(
      cases.map((c) => c[2]),
    );
    expect(records[1].loopContext).toEqual({ loopId: "loop", iteration: 1 });
    expect(records[2].loopContext).toBeUndefined();
    workspace = await Workspace.open(layout);

    const plan = await workspace.archives.planRestore(history);
    expect(plan.count).toBe(3);
    expect(Object.keys(plan)).toEqual(["count"]);
    expect(
      (await workspace.archives.restore(plan)).every((outcome) => outcome.status === "restored"),
    ).toBe(true);
    expect(entries()).toEqual([]);
  });

  test("archive selection honors ignore rules and directory patterns", async () => {
    put("out/result.txt");
    put("out/ignored.txt");
    put(".gitignore", "ignored.txt\n");
    expect(await archive("out")).toEqual([{ path: "out/result.txt", status: "archived" }]);
    expect(fs.existsSync(path.join(layout.agentRootPath, "out/ignored.txt"))).toBe(true);
    expect(entries().map((entry) => entry.sourcePath)).toEqual(["out/result.txt"]);
  });

  test("plans select abandoned checkpoints and orphans, retaining unrelated records", async () => {
    for (const checkpoint of ["c1", "c2", "other", "unknown", "orphan"]) {
      put(`${checkpoint}.txt`);
      await archive(`${checkpoint}.txt`, checkpoint, checkpoint);
    }
    const plan = await workspace.archives.planRestore(history);
    expect(plan.count).toBe(2);
    expect((await workspace.archives.restore(plan)).map((result) => result.path)).toEqual([
      "c2.txt",
      "orphan.txt",
    ]);
    expect(entries().map((entry) => entry.checkpointSha)).toEqual(["c1", "other", "unknown"]);
  });

  test("a missing archive is a failure and keeps its manifest record", async () => {
    put("report.txt");
    await archive("report.txt");
    const [entry] = entries();
    const plan = await workspace.archives.planRestore(history);
    fs.unlinkSync(path.join(directory, entry.archivePath));
    expect(await workspace.archives.restore(plan)).toEqual([
      { path: "report.txt", status: "archive-missing", error: "Archive not found" },
    ]);
    expect(entries()).toEqual([entry]);
    expect(fs.existsSync(path.join(layout.agentRootPath, "report.txt"))).toBe(false);
  });

  test("pre-existing destinations are protected, while later entries in a batch replace earlier ones", async () => {
    put("report.txt", "old");
    await archive("report.txt", "old", "c2");
    put("report.txt", "new");
    await archive("report.txt", "new", "c3");
    put("protected.txt", "archived");
    await archive("protected.txt");
    put("protected.txt", "checkpoint version");
    const records = entries();
    const results = await workspace.archives.restore(await workspace.archives.planRestore(history));
    expect(results.map((result) => result.status)).toEqual([
      "restored",
      "restored",
      "destination-protected",
    ]);
    expect(fs.readFileSync(path.join(layout.agentRootPath, "report.txt"), "utf8")).toBe("new");
    expect(fs.readFileSync(path.join(layout.agentRootPath, "protected.txt"), "utf8")).toBe(
      "checkpoint version",
    );
    expect(entries()).toEqual([records[2]]);
    expect(archivedContent(records[2])).toBe("archived");
    expect(fs.existsSync(path.join(layout.rigArchivePath, "old"))).toBe(false);
  });

  test("overwriting an archive replaces its record and invalidates old plans", async () => {
    put("report.txt", "old");
    await archive("report.txt", "step", "c2");
    const stale = await workspace.archives.planRestore(history);
    put("report.txt", "new");
    await archive("report.txt", "step", "c3");
    expect(entries()).toHaveLength(1);
    expect(entries()[0].checkpointSha).toBe("c3");
    expect((await workspace.archives.restore(stale))[0].status).toBe("failed");
    expect(archivedContent(entries()[0])).toBe("new");
    expect(
      (await workspace.archives.restore(await workspace.archives.planRestore(history)))[0].status,
    ).toBe("restored");
  });

  test("plans cannot be forged, reused, or passed to another workspace", async () => {
    put("a.txt");
    await archive("a.txt");
    const plan = await workspace.archives.planRestore(history);
    await expect((await Workspace.open(layout)).archives.restore(plan)).rejects.toThrow(
      "does not belong",
    );
    await expect(workspace.archives.restore({ count: 1 })).rejects.toThrow("does not belong");
    await workspace.archives.restore(plan);
    await expect(workspace.archives.restore(plan)).rejects.toThrow("already used");
  });

  test("an archive manifest write failure preserves the source and previous archive", async () => {
    put("a.txt", "old");
    await archive("a.txt", "step", "c2");
    const before = entries();
    put("a.txt", "new");
    const failure = failManifestWrite();
    try {
      expect((await archive("a.txt", "step", "c3"))[0].status).toBe("failed");
    } finally {
      failure.mockRestore();
    }
    expect(fs.readFileSync(path.join(layout.agentRootPath, "a.txt"), "utf8")).toBe("new");
    expect(entries()).toEqual(before);
    expect(archivedContent(before[0])).toBe("old");
    expect(
      (
        await workspace.archives.planRestore({
          abandoned: new Set([CheckpointId("c3")]),
          known: history.known,
        })
      ).count,
    ).toBe(0);
    expect(fs.readdirSync(path.join(layout.rigArchivePath, "step"))).toEqual(["a.txt"]);
  });

  test("a restore manifest write failure preserves the archive and its record", async () => {
    put("a.txt");
    await archive("a.txt");
    const before = entries();
    const plan = await workspace.archives.planRestore(history);
    const failure = failManifestWrite();
    try {
      expect((await workspace.archives.restore(plan))[0].status).toBe("failed");
    } finally {
      failure.mockRestore();
    }
    expect(entries()).toEqual(before);
    expect(archivedContent(before[0])).toBe("result");
    expect((await workspace.archives.planRestore(history)).count).toBe(1);
    expect(fs.existsSync(path.join(layout.agentRootPath, "a.txt"))).toBe(false);
    expect(
      (await workspace.archives.restore(await workspace.archives.planRestore(history)))[0].status,
    ).toBe("restored");
  });

  test("a failed later copy leaves the earlier restored version intact", async () => {
    put("report.txt", "old");
    await archive("report.txt", "old", "c2");
    put("report.txt", "new");
    await archive("report.txt", "new", "c3");
    const newer = entries()[1];
    const source = path.join(directory, newer.archivePath);
    const copy = fs.promises.cp.bind(fs.promises);
    const failure = spyOn(fs.promises, "cp").mockImplementation(async (...args) => {
      if (String(args[0]) === source) {
        fs.writeFileSync(String(args[1]), "partial copy");
        throw new Error("copy failed");
      }
      return copy(...args);
    });
    try {
      const results = await workspace.archives.restore(
        await workspace.archives.planRestore(history),
      );
      expect(results.map((result) => result.status)).toEqual(["restored", "failed"]);
    } finally {
      failure.mockRestore();
    }
    expect(fs.readFileSync(path.join(layout.agentRootPath, "report.txt"), "utf8")).toBe("old");
    expect(entries()).toEqual([newer]);
    expect(archivedContent(newer)).toBe("new");
    expect(fs.readdirSync(layout.agentRootPath)).toEqual(["report.txt"]);
  });

  test("a failed manifest replacement keeps the previous JSON and file versions", async () => {
    put("a.txt", "old");
    await archive("a.txt");
    const before = fs.readFileSync(layout.archiveManifestPath, "utf8");
    put("a.txt", "new");
    const rename = fs.promises.rename.bind(fs.promises);
    const failure = spyOn(fs.promises, "rename").mockImplementation((...args) => {
      if (String(args[1]) === layout.archiveManifestPath) {
        return Promise.reject(Object.assign(new Error("manifest rename failed"), { code: "EIO" }));
      }
      return rename(...args);
    });
    try {
      expect((await archive("a.txt", "step", "c3"))[0].status).toBe("failed");
    } finally {
      failure.mockRestore();
    }
    expect(fs.readFileSync(layout.archiveManifestPath, "utf8")).toBe(before);
    expect(archivedContent(entries()[0])).toBe("old");
    expect(fs.readFileSync(path.join(layout.agentRootPath, "a.txt"), "utf8")).toBe("new");
    expect(fs.readdirSync(layout.stateDir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  test("cancellation starts no archive writes", async () => {
    put("a.txt");
    await expect(
      workspace.archives.archive(
        workspace.files.select(["a.txt"]),
        { kind: "codon", codonId: "step" },
        CheckpointId("c2"),
        {
          shouldAbort: () => true,
        },
      ),
    ).rejects.toThrow("aborted");
    expect(fs.readFileSync(path.join(layout.agentRootPath, "a.txt"), "utf8")).toBe("result");
    expect(fs.existsSync(layout.rigArchivePath)).toBe(false);
  });

  test("cancellation between restore entries leaves completed entries persisted", async () => {
    put("a.txt");
    put("b.txt");
    await workspace.archives.archive(
      workspace.files.select(["*.txt"]),
      { kind: "codon", codonId: "step" },
      CheckpointId("c2"),
    );
    const plan = await workspace.archives.planRestore(history);
    await expect(
      workspace.archives.restore(plan, { shouldAbort: () => entries().length === 1 }),
    ).rejects.toThrow("aborted");
    expect(entries().map((entry) => entry.sourcePath)).toEqual(["b.txt"]);
    expect(fs.readFileSync(path.join(layout.agentRootPath, "a.txt"), "utf8")).toBe("result");
    expect(fs.existsSync(path.join(layout.agentRootPath, "b.txt"))).toBe(false);
    expect(archivedContent(entries()[0])).toBe("result");
  });

  test("overlapping archive requests retain both manifest entries", async () => {
    put("a.txt");
    put("b.txt");
    await Promise.all([archive("a.txt"), archive("b.txt")]);
    expect(
      entries()
        .map((entry) => entry.sourcePath)
        .sort(),
    ).toEqual(["a.txt", "b.txt"]);
  });

  test("malformed manifests fail initialization without replacing the ledger", async () => {
    const invalid = '{"version":"1.0.0","entries":[{}]}';
    fs.writeFileSync(layout.archiveManifestPath, invalid);
    await expect(Workspace.open(layout)).rejects.toThrow();
    expect(fs.readFileSync(layout.archiveManifestPath, "utf8")).toBe(invalid);
  });

  test("checkpoint-only consumers work despite a malformed archive manifest", async () => {
    const invalid = '{"version":"1.0.0","entries":[{}]}';
    fs.writeFileSync(layout.archiveManifestPath, invalid);
    const storage = new GitWorkspaceStorage({
      checkpointDir: layout.checkpointsPath,
      workTree: layout.agentRootPath,
    });
    const checkpoints = await CheckpointService.open(storage);
    const files = new WorkspaceFiles(storage);
    const state = new StateManager(layout, new Logger(path.join(directory, "state.log")));
    state.setWorkspaceCheckpoints(checkpoints);
    await state.initialize();
    put("result.txt");
    const id = await checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(checkpoints.history("main")),
      message: "independent checkpoint",
      patterns: ["*.txt"],
    });
    expect(await checkpoints.history("main").tip()).toBe(id);
    expect(await files.select(["*.txt"]).files()).toEqual(["result.txt"]);
    await expect(WorkspaceArchive.open(layout)).rejects.toThrow();
    expect(fs.readFileSync(layout.archiveManifestPath, "utf8")).toBe(invalid);
  });

  test("archives open and restore with no checkpoint repository", async () => {
    put("result.txt", "saved output");
    await archive("result.txt");
    // The archive ledger and copies are independent of checkpoint storage.
    fs.rmSync(layout.checkpointsPath, { recursive: true });
    const archives = await WorkspaceArchive.open(layout);
    const plan = await archives.planRestore(history);
    expect(await archives.restore(plan)).toEqual([{ path: "result.txt", status: "restored" }]);
    expect(fs.existsSync(layout.checkpointsPath)).toBe(false);
    expect(fs.readFileSync(path.join(layout.agentRootPath, "result.txt"), "utf8")).toBe(
      "saved output",
    );
    expect(entries()).toEqual([]);
  });
});

describe("Workspace mutation boundaries", () => {
  test("rig mutations reject escapes, roots, and protected targets", async () => {
    const source = path.join(directory, "template.txt");
    fs.writeFileSync(source, "template");
    put("keep.txt", "keep");
    for (const candidate of [
      "",
      ".",
      "out/..",
      "..",
      "../template.txt",
      source,
      "read_only_data_source",
      ".hankweave",
      "nested/.git",
    ]) {
      await expect(workspace.rigs.removePath(candidate)).rejects.toThrow();
      await expect(workspace.rigs.plantCopy(null, source, candidate)).rejects.toThrow();
    }
    expect(fs.readFileSync(source, "utf8")).toBe("template");
    expect(fs.readFileSync(path.join(layout.agentRootPath, "keep.txt"), "utf8")).toBe("keep");
    put(".gitignore", "ignored/\n");
    put("ignored/a.txt");
    expect(await workspace.rigs.removePath("ignored")).toBe(true);
  });

  test("archive identities cannot select storage outside their namespace", async () => {
    put("a.txt");
    for (const codonId of ["../escape", ".", "..", "nested/path", "nested\\path", ""]) {
      await expect(
        workspace.archives.archive(
          workspace.files.select(["a.txt"]),
          { kind: "codon", codonId },
          CheckpointId("c2"),
        ),
      ).rejects.toThrow("identity");
    }
    expect(fs.readFileSync(path.join(layout.agentRootPath, "a.txt"), "utf8")).toBe("result");
  });

  test("persisted archive and destination paths cannot escape their roots", async () => {
    put("a.txt");
    await archive("a.txt");
    const [original] = entries();
    fs.writeFileSync(path.join(directory, "outside.txt"), "outside");
    const invalid = [
      { ...original, sourcePath: "../outside.txt" },
      { ...original, sourcePath: "." },
      { ...original, sourcePath: "read_only_data_source/data.txt" },
      { ...original, archivePath: "outside.txt" },
      { ...original, archivePath: "rigArchive/../outside.txt" },
      { ...original, archivePath: "rigArchive" },
    ];
    await reopenWith(invalid);
    const results = await workspace.archives.restore(await workspace.archives.planRestore(history));
    expect(results.map((result) => result.status)).toEqual(invalid.map(() => "failed"));
    expect(entries()).toEqual(invalid);
    expect(fs.readFileSync(path.join(directory, "outside.txt"), "utf8")).toBe("outside");
    expect(archivedContent(original)).toBe("result");
  });

  test.skipIf(process.platform === "win32")(
    "symlink ancestors cannot redirect rig or archive mutations",
    async () => {
      const outside = path.join(directory, "outside");
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, "data.txt"), "outside");
      fs.symlinkSync(outside, path.join(layout.agentRootPath, "link"));
      await expect(workspace.rigs.removePath("link/data.txt")).rejects.toThrow("ancestor");
      await expect(
        workspace.rigs.plantCopy(null, path.join(outside, "data.txt"), "link/data.txt"),
      ).rejects.toThrow("ancestor");
      put("a.txt");
      fs.symlinkSync(outside, layout.rigArchivePath);
      expect((await archive("a.txt"))[0].status).toBe("failed");
      expect(fs.readdirSync(outside)).toEqual(["data.txt"]);
      expect(fs.readFileSync(path.join(outside, "data.txt"), "utf8")).toBe("outside");
    },
  );

  test.skipIf(process.platform === "win32")(
    "restoration rechecks archive and destination ancestors after planning",
    async () => {
      put("out/a.txt");
      await archive("out");
      const plan = await workspace.archives.planRestore(history);
      fs.rmdirSync(path.join(layout.agentRootPath, "out"));
      fs.symlinkSync(directory, path.join(layout.agentRootPath, "out"));
      expect((await workspace.archives.restore(plan))[0].status).toBe("failed");
      expect(entries()).toHaveLength(1);
      expect(fs.existsSync(path.join(directory, "a.txt"))).toBe(false);
      fs.unlinkSync(path.join(layout.agentRootPath, "out"));
      const [entry] = entries();
      fs.renameSync(path.join(layout.rigArchivePath, "step"), path.join(directory, "saved"));
      fs.symlinkSync(path.join(directory, "saved"), path.join(layout.rigArchivePath, "step"));
      expect(
        (await workspace.archives.restore(await workspace.archives.planRestore(history)))[0].status,
      ).toBe("failed");
      expect(entries()).toEqual([entry]);
      expect(fs.readFileSync(path.join(directory, "saved/out/a.txt"), "utf8")).toBe("result");
    },
  );

  test("legacy directory archives restore their tree and reject protected descendants", async () => {
    const base: ArchiveEntry = {
      sourcePath: "legacy",
      archivePath: "rigArchive/old/tree",
      codonId: "old",
      checkpointSha: "c2",
      timestamp: new Date().toISOString(),
    };
    fs.mkdirSync(path.join(directory, base.archivePath), { recursive: true });
    fs.writeFileSync(path.join(directory, base.archivePath, "a.txt"), "legacy");
    await reopenWith([base]);
    expect(
      (await workspace.archives.restore(await workspace.archives.planRestore(history)))[0].status,
    ).toBe("restored");
    expect(fs.readFileSync(path.join(layout.agentRootPath, "legacy/a.txt"), "utf8")).toBe("legacy");
    fs.mkdirSync(path.join(directory, base.archivePath, ".git"), { recursive: true });
    fs.writeFileSync(path.join(directory, base.archivePath, ".git/config"), "metadata");
    await reopenWith([{ ...base, sourcePath: "unsafe" }]);
    expect(
      (await workspace.archives.restore(await workspace.archives.planRestore(history)))[0].status,
    ).toBe("failed");
    expect(fs.existsSync(path.join(layout.agentRootPath, "unsafe"))).toBe(false);
    expect(entries()).toHaveLength(1);
  });
});
