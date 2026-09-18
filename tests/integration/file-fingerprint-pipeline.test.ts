import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BodyResolver } from "../../server/body-resolver.js";
import { CodonFileTracker } from "../../server/codon-file-tracker.js";
import { ExecutionLayout } from "../../server/execution-layout.js";
import type { FileUpdatedEvent, ServerEvent } from "../../server/schemas/event-schemas.js";
import { FileEventStorage } from "../../server/storage/file-event-storage.js";
import { EventId } from "../../server/types/branded-types.js";
import { Logger } from "../../server/utils.js";
import { Workspace } from "../../server/workspace/index.js";

/**
 * The fingerprint chokepoint at the runtime boundary, exercised through the
 * real emission sites: sequential CodonFileTrackers over one workspace
 * (codon-start re-emission plus tool-driven writes) feeding one per-run
 * BodyResolver, journaled by a real FileEventStorage. Mirrors the runtime's
 * runner.on("fileUpdated") wiring (fingerprint-events proposal).
 */
describe("file.updated fingerprint pipeline", () => {
  let tempDir: string;
  let agentDir: string;
  let eventsDir: string;
  let workspace: Workspace;
  let counter = 0;

  beforeEach(async () => {
    tempDir = path.resolve(
      "tests",
      "test-area",
      `temp-fingerprint-pipeline-${Date.now()}-${++counter}`,
    );
    agentDir = path.join(tempDir, "agent");
    eventsDir = path.join(tempDir, "events");
    await fs.promises.mkdir(agentDir, { recursive: true });
    await fs.promises.mkdir(eventsDir, { recursive: true });
    // The tracker enumerates through the git-native lister over a shadow
    // checkpoint repo, exactly as the runtime wires it.
    workspace = await Workspace.open(new ExecutionLayout(tempDir, { agentRootPath: agentDir }), {
      logger: new Logger(path.join(tempDir, "checkpoint-git.log")),
    });
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  function makeTracker(patterns: readonly string[]): CodonFileTracker {
    return new CodonFileTracker({
      logger: new Logger(path.join(tempDir, "tracker.log")),
      files: workspace.files,
      checkpointedFiles: patterns,
    });
  }

  function sha256(content: string): string {
    return createHash("sha256").update(content, "utf-8").digest("hex");
  }

  test("every emission journals as a fingerprint; bodies stay out of the journal entirely", async () => {
    // Workspace with two watched files, as a codon would leave it. One is
    // deliberately large: line size must not scale with body size.
    const catalogBody = "# catalog v1\n".repeat(20000); // ~254 KB
    const queriesBody = "SELECT 1\n".repeat(100);
    await fs.promises.writeFile(path.join(agentDir, "catalog.md"), catalogBody);
    await fs.promises.writeFile(path.join(agentDir, "queries.md"), queriesBody);

    const resolver = new BodyResolver(agentDir);
    const storage = new FileEventStorage(eventsDir);
    await storage.initialize();

    const journaled: FileUpdatedEvent[] = [];
    let eventSeq = 0;
    const journal = async (data: ReturnType<BodyResolver["process"]>) => {
      const event = {
        id: EventId(`evt-${++eventSeq}`),
        timestamp: new Date().toISOString(),
        type: "file.updated",
        data,
      } as FileUpdatedEvent;
      journaled.push(event);
      await storage.appendMany([event as ServerEvent]);
    };

    // Codon 1 starts: initial snapshot emits both files as codon-start.
    const codon1 = makeTracker(["*.md"]);
    codon1.on("fileUpdated", (data) => void journal(resolver.process(data)));
    await codon1.initialize();
    await codon1.drain();

    // Codon 1 rewrites the large file with identical content via a Write.
    codon1.observeToolUse(
      "Write",
      { file_path: path.join(agentDir, "catalog.md"), content: catalogBody },
      "toolu_rewrite",
    );
    await codon1.drain();
    await codon1.close();

    // Codon 2 starts: codon-start re-emission of both unchanged files.
    const codon2 = makeTracker(["*.md"]);
    codon2.on("fileUpdated", (data) => void journal(resolver.process(data)));
    await codon2.initialize();
    await codon2.drain();

    // Codon 2 actually changes a file: only the fingerprint moves. Land the
    // write on disk too, as the real tool would.
    await fs.promises.writeFile(path.join(agentDir, "queries.md"), "SELECT 2\n");
    codon2.observeToolUse(
      "Write",
      { file_path: path.join(agentDir, "queries.md"), content: "SELECT 2\n" },
      "toolu_change",
    );
    await codon2.drain();
    await codon2.close();
    await storage.close();

    // (a) Event cardinality is untouched: 2 initial + 1 rewrite +
    // 2 codon-start re-emissions + 1 real change.
    expect(journaled).toHaveLength(6);

    // (b) No event carries a body in any form.
    for (const event of journaled) {
      expect("content" in event.data).toBe(false);
      expect("contentRef" in event.data).toBe(false);
    }

    // (c) Fingerprints and sources tell the run's story exactly.
    const catalogEvents = journaled.filter((e) => e.data.path === "catalog.md");
    const queriesEvents = journaled.filter((e) => e.data.path === "queries.md");
    expect(catalogEvents.map((e) => e.data.source.kind)).toEqual([
      "codon-start",
      "tool_use",
      "codon-start",
    ]);
    expect(catalogEvents.every((e) => e.data.sha256 === sha256(catalogBody))).toBe(true);
    expect(catalogEvents[1].data.source).toEqual({ kind: "tool_use", toolUseId: "toolu_rewrite" });
    expect(queriesEvents.map((e) => e.data.sha256)).toEqual([
      sha256(queriesBody),
      sha256(queriesBody),
      sha256("SELECT 2\n"),
    ]);
    expect(queriesEvents[2].data.source).toEqual({ kind: "tool_use", toolUseId: "toolu_change" });
    expect(queriesEvents[2].data.bytes).toBe(Buffer.byteLength("SELECT 2\n", "utf-8"));

    // (d) Journal lines stay a few hundred bytes even for the ~254 KB body.
    const journalText = await fs.promises.readFile(path.join(eventsDir, "events.jsonl"), "utf-8");
    const lines = journalText.trim().split("\n");
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line.length).toBeLessThan(600);
    }

    // (e) The journal round-trips through storage identically (the
    // fingerprinting is emitter-side; the storage layer is untouched).
    const readBack = new FileEventStorage(eventsDir);
    await readBack.initialize();
    const page = await readBack.getEventsAfter(null, 100);
    expect(page.events.map((e) => e.id)).toEqual(journaled.map((e) => e.id));
    await readBack.close();

    // (f) The emitted bodies remain resolvable for sentinels — the retained
    // map serves the exact emission, and eviction/rollback falls back to a
    // hash-verified disk read.
    expect(resolver.resolve(catalogEvents[2].data)).toBe(catalogBody);
    resolver.clear();
    expect(resolver.resolve(queriesEvents[2].data)).toBe("SELECT 2\n");
  });

  test("a Write's fingerprint comes from the tool input, not the disk (attempt-time semantics)", async () => {
    // Disk deliberately still holds the pre-write body when the tool call is
    // observed — the emission must describe what the Write carried.
    await fs.promises.writeFile(path.join(agentDir, "doc.md"), "pre-write disk body");

    const resolver = new BodyResolver(agentDir);
    const events: ReturnType<BodyResolver["process"]>[] = [];
    const tracker = makeTracker(["*.md"]);
    tracker.on("fileUpdated", (data) => void events.push(resolver.process(data)));
    await tracker.initialize();

    tracker.observeToolUse(
      "Write",
      { file_path: path.join(agentDir, "doc.md"), content: "the write's own body" },
      "toolu_attempt",
    );
    await tracker.drain();
    await tracker.close();

    const writeEvent = events.at(-1);
    expect(writeEvent?.sha256).toBe(sha256("the write's own body"));
    expect(writeEvent?.bytes).toBe(Buffer.byteLength("the write's own body", "utf-8"));
    // And the retained body — what sentinels would see — is the input's, too.
    expect(writeEvent && resolver.resolve(writeEvent)).toBe("the write's own body");
  });

  test("a run restart clears retained bodies without changing what is journaled", async () => {
    await fs.promises.writeFile(path.join(agentDir, "notes.md"), "stable body");
    const resolver = new BodyResolver(agentDir);

    const run1Events: ReturnType<BodyResolver["process"]>[] = [];
    const run1 = makeTracker(["*.md"]);
    run1.on("fileUpdated", (data) => void run1Events.push(resolver.process(data)));
    await run1.initialize();
    await run1.close();

    // New run: startNewRun clears retained bodies; emissions are identical.
    resolver.clear();
    const run2Events: ReturnType<BodyResolver["process"]>[] = [];
    const run2 = makeTracker(["*.md"]);
    run2.on("fileUpdated", (data) => void run2Events.push(resolver.process(data)));
    await run2.initialize();
    await run2.close();

    expect(run1Events[0]).toEqual(run2Events[0]);
    expect(run2Events[0].sha256).toBe(sha256("stable body"));
    expect(run2Events[0].source).toEqual({ kind: "codon-start" });
  });
});
