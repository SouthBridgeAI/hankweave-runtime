/**
 * Unit tests for the rollback side of the archive manifest (issue #228):
 *
 * - selectEntriesToRestore: reachability-driven selection replacing the old
 *   list-order getEntriesAfterCheckpoint. Entries archived strictly after the
 *   rollback target on the abandoned line are restored (plus orphans);
 *   entries at/before the target, on foreign timelines, or with unknown SHAs
 *   stay archived. No "not found in manifest" error, ever.
 * - removeEntries: only the given (successfully restored) entries leave the
 *   manifest, and the file on disk reflects it after save().
 *
 * Uses a REAL temp checkpoint repo so the reachability sets come from actual
 * `git rev-list` / `git log --all` calls, exactly as the runtime computes them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { Logger } from "../../server/utils";
import { type ArchiveEntry, ArchiveManifestManager } from "../../server/workspace/archive-manifest";
import type { CheckpointId } from "../../server/workspace/checkpoints.js";
import { Workspace } from "../../server/workspace/index.js";
import { requireHistoryTip } from "../utils/checkpoint-history.js";

function makeEntry(overrides: Partial<ArchiveEntry> & { checkpointSha: string }): ArchiveEntry {
  return {
    sourcePath: overrides.sourcePath ?? "some/file.md",
    archivePath:
      overrides.archivePath ?? `rigArchive/codon/${overrides.sourcePath ?? "some/file.md"}`,
    codonId: overrides.codonId ?? "codon-x",
    checkpointSha: overrides.checkpointSha,
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    ...(overrides.loopContext ? { loopContext: overrides.loopContext } : {}),
  };
}

describe("archive manifest rollback selection (issue #228)", () => {
  let tempDir: string;
  let logPath: string;
  let logger: Logger;
  let workspace: Workspace;
  let manifest: ArchiveManifestManager;

  // Real checkpoint history: c1 -> c2 -> c3 on main, plus f1 on a sibling
  // branch off c2. Rolling back "to c2 from c3" abandons only c3.
  let c1: CheckpointId;
  let c2: CheckpointId;
  let c3: CheckpointId;
  let f1: CheckpointId;

  beforeEach(async () => {
    // OS tmpdir, not tests/test-area: real git repos in synced folders are
    // flaky (see the note in checkpoint-git.test.ts).
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hankweave-archive-rollback-"));
    logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    workspace = await Workspace.open(new ExecutionLayout(tempDir, { agentRootPath: tempDir }), {
      logger,
    });

    await fs.promises.writeFile(path.join(tempDir, "w.txt"), "1");
    c1 = await workspace.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(workspace.checkpoints.history("main")),
      message: "c1",
      patterns: ["*.txt"],
    });
    await fs.promises.writeFile(path.join(tempDir, "w.txt"), "2");
    c2 = await workspace.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(workspace.checkpoints.history("main")),
      message: "c2",
      patterns: ["*.txt"],
    });

    // Sibling timeline off c2, then back to main
    const sibling = workspace.checkpoints.history("sibling");
    await fs.promises.writeFile(path.join(tempDir, "w.txt"), "f");
    f1 = await sibling.checkpoint({ parent: c2, message: "f1", patterns: ["*.txt"] });

    await fs.promises.writeFile(path.join(tempDir, "w.txt"), "3");
    c3 = await workspace.checkpoints.history("main").checkpoint({
      parent: await requireHistoryTip(workspace.checkpoints.history("main")),
      message: "c3",
      patterns: ["*.txt"],
    });

    expect(c1 && c2 && c3 && f1).toBeTruthy();

    manifest = new ArchiveManifestManager(tempDir, logger);
    await manifest.load();
    await fs.promises.mkdir(path.join(tempDir, ".hankweave"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Compute the sets the runtime hands to selectEntriesToRestore for a rollback to `target`. */
  async function setsFor(
    target: CheckpointId,
  ): Promise<{ after: Set<string>; known: Set<string> }> {
    const head = await workspace.checkpoints.history("main").tip();
    if (!head) throw new Error("no HEAD");
    return {
      after: await workspace.checkpoints.reachableDifference(head, target),
      known: await workspace.checkpoints.allReachableIds(),
    };
  }

  test("empty manifest selects nothing and never logs the old manifest error", async () => {
    const { after, known } = await setsFor(c2);
    const selected = manifest.selectEntriesToRestore(after, known);
    expect(selected).toEqual([]);

    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).not.toContain("not found in manifest");
  });

  test("entries at/before target stay archived; entries after target are restored", async () => {
    const atC1 = makeEntry({ checkpointSha: c1, sourcePath: "at-c1.md" });
    const atC2 = makeEntry({ checkpointSha: c2, sourcePath: "at-c2.md" });
    const atC3 = makeEntry({ checkpointSha: c3, sourcePath: "at-c3.md" });
    await manifest.addEntry(atC1);
    await manifest.addEntry(atC2);
    await manifest.addEntry(atC3);

    const { after, known } = await setsFor(c2);
    const selected = manifest.selectEntriesToRestore(after, known);

    expect(selected).toEqual([atC3]);
  });

  test("orphan entries are always restored", async () => {
    const orphan = makeEntry({ checkpointSha: "orphan", sourcePath: "orphan.md" });
    const atC2 = makeEntry({ checkpointSha: c2, sourcePath: "at-c2.md" });
    await manifest.addEntry(orphan);
    await manifest.addEntry(atC2);

    const { after, known } = await setsFor(c2);
    const selected = manifest.selectEntriesToRestore(after, known);

    expect(selected).toEqual([orphan]);
  });

  test("foreign-timeline entries stay archived silently", async () => {
    const foreign = makeEntry({ checkpointSha: f1, sourcePath: "foreign.md" });
    const atC3 = makeEntry({ checkpointSha: c3, sourcePath: "at-c3.md" });
    await manifest.addEntry(foreign);
    await manifest.addEntry(atC3);

    const { after, known } = await setsFor(c2);
    const selected = manifest.selectEntriesToRestore(after, known);

    expect(selected).toEqual([atC3]);

    // Known-but-not-reachable is by design, not a warning
    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).not.toContain("unknown to the checkpoint repository");
  });

  test("entries with SHAs unknown to the repo stay archived with a warning", async () => {
    const unknown = makeEntry({
      checkpointSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      sourcePath: "unknown.md",
    });
    await manifest.addEntry(unknown);

    const { after, known } = await setsFor(c2);
    const selected = manifest.selectEntriesToRestore(after, known);

    expect(selected).toEqual([]);
    const log = fs.readFileSync(logPath, "utf-8");
    expect(log).toContain("unknown to the checkpoint repository");
    expect(log).toContain("unknown.md");
  });

  test("multiple entries sharing one checkpointSha are all treated alike", async () => {
    const e1 = makeEntry({ checkpointSha: c3, sourcePath: "one.md" });
    const e2 = makeEntry({ checkpointSha: c3, sourcePath: "two.md" });
    const e3 = makeEntry({ checkpointSha: c2, sourcePath: "stays-a.md" });
    const e4 = makeEntry({ checkpointSha: c2, sourcePath: "stays-b.md" });
    for (const e of [e1, e2, e3, e4]) await manifest.addEntry(e);

    const { after, known } = await setsFor(c2);
    const selected = manifest.selectEntriesToRestore(after, known);

    expect(selected).toEqual([e1, e2]);
  });

  test("removeEntries removes exactly the given entries and persists to disk", async () => {
    const restored1 = makeEntry({ checkpointSha: c3, sourcePath: "restored-1.md" });
    const failed = makeEntry({ checkpointSha: c3, sourcePath: "failed.md" });
    const restored2 = makeEntry({ checkpointSha: c3, sourcePath: "restored-2.md" });
    for (const e of [restored1, failed, restored2]) await manifest.addEntry(e);

    // Partial restore: only two entries succeeded — only they leave the manifest
    await manifest.removeEntries([restored1, restored2]);

    expect(manifest.getManifest().entries).toEqual([failed]);

    // Disk reflects it after save() (removeEntries saves internally)
    const fresh = new ArchiveManifestManager(tempDir, logger);
    const loaded = await fresh.load();
    expect(loaded.entries.length).toBe(1);
    expect(loaded.entries[0].sourcePath).toBe("failed.md");
  });

  test("removeEntries with an empty list is a no-op", async () => {
    const entry = makeEntry({ checkpointSha: c3 });
    await manifest.addEntry(entry);
    await manifest.removeEntries([]);
    expect(manifest.getManifest().entries).toEqual([entry]);
  });
});
