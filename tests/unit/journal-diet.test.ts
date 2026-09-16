/**
 * Finalize-time journal diet (events.jsonl diet P4).
 *
 * The defining contract: diet → restore → SHA-256 equals the original,
 * byte-for-byte, on every fixture — including a torn final line, corrupt
 * lines, and an empty journal. Identity means identity.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import { appendFile, chmod, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EventJournal } from "../../server/event-journal.js";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { FileEventStorage } from "../../server/storage/file-event-storage.js";
import {
  cleanStrayDietTmp,
  dietJournal,
  ensureJournalRestored,
  isDietedEventsDir,
  readJournalDietMeta,
  registerProcessOwnedLock,
  releaseProcessOwnedLock,
  restoreJournal,
} from "../../server/storage/journal-diet.js";
import { EventId } from "../../server/types/branded-types.js";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PLAN_GEN_JOURNAL = path.join(
  TEST_ROOT,
  "tests/fixtures/plan-gen-execution/.hankweave/events/events.jsonl",
);

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic pseudo-text so fixtures are stable without committing blobs. */
function syntheticBody(seed: number, bytes: number): string {
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
  let state = seed >>> 0;
  const parts: string[] = [];
  let length = 0;
  while (length < bytes) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const word = words[state % words.length];
    parts.push(word);
    length += word.length + 1;
  }
  return parts.join(" ").slice(0, bytes);
}

/**
 * Legacy pre-fingerprint file.updated shape with an inline `content` body.
 * Live events no longer carry content (they carry sha256/bytes/source), but
 * the diet must still handle historical journals that do — hence the cast
 * through unknown.
 */
function fileUpdatedEvent(id: string, filePath: string, content: string): ServerEvent {
  return {
    id: EventId(id),
    timestamp: new Date().toISOString(),
    type: "file.updated",
    data: {
      path: filePath,
      filename: path.basename(filePath),
      action: "modified",
      content,
    },
  } as unknown as ServerEvent;
}

function pongEvent(id: string): ServerEvent {
  return {
    id: EventId(id),
    timestamp: new Date().toISOString(),
    type: "pong",
    data: { message: `event ${id}`, timestamp: new Date().toISOString() },
  } as ServerEvent;
}

/** Minimal state.snapshot shape carrying an inline recentFileAccess body. */
function snapshotLine(id: string, filePath: string, content: string): string {
  return JSON.stringify({
    id,
    timestamp: new Date().toISOString(),
    type: "state.snapshot",
    data: {
      completedCodons: [],
      fileTree: [],
      totalCost: 0.125,
      totalTime: 42,
      recentFileAccess: { path: filePath, content, timestamp: new Date().toISOString() },
      isRollingBack: false,
    },
  });
}

describe("journal diet", () => {
  let eventsDir: string;
  let eventsPath: string;

  beforeEach(async () => {
    eventsDir = await mkdtemp(path.join(tmpdir(), "journal-diet-test-"));
    eventsPath = path.join(eventsDir, "events.jsonl");
  });

  afterEach(async () => {
    await rm(eventsDir, { recursive: true, force: true });
  });

  /** Write a raw journal file and return its bytes. */
  async function seedRaw(content: string | Buffer): Promise<Buffer> {
    const buf = typeof content === "string" ? Buffer.from(content, "utf-8") : content;
    await writeFile(eventsPath, buf);
    return buf;
  }

  /** Build a body-heavy journal through the real storage layer. */
  async function seedViaStorage(events: ServerEvent[]): Promise<Buffer> {
    const storage = new FileEventStorage(eventsDir);
    await storage.initialize();
    await storage.appendMany(events);
    await storage.close();
    return readFile(eventsPath);
  }

  describe("byte-identity round-trip (the phase's defining test)", () => {
    it("round-trips a synthetic body-heavy journal", async () => {
      const bigBodyA = syntheticBody(1, 64 * 1024);
      const bigBodyB = syntheticBody(2, 8 * 1024);
      const smallBody = syntheticBody(3, 512); // below threshold, stays inline
      const original = await seedViaStorage([
        pongEvent("ev-1"),
        fileUpdatedEvent("ev-2", "notes/catalog.md", bigBodyA),
        fileUpdatedEvent("ev-3", "queries.json", smallBody),
        fileUpdatedEvent("ev-4", "notes/catalog.md", bigBodyA), // repeat body
        fileUpdatedEvent("ev-5", "plan.md", bigBodyB),
        pongEvent("ev-6"),
      ]);
      const originalSha = sha256(original);

      const report = await dietJournal(eventsDir);
      expect(report.dieted).toBe(true);
      expect(report.originalSha256).toBe(originalSha);
      expect(report.extractedBodies).toBe(3); // ev-2, ev-4, ev-5
      expect(report.uniqueCasBodies).toBe(2); // A stored once, B once
      expect(fsSync.existsSync(eventsPath)).toBe(false);
      expect(isDietedEventsDir(eventsDir)).toBe(true);

      const restore = await restoreJournal(eventsDir);
      expect(restore.restored).toBe(true);
      expect(restore.sha256).toBe(originalSha);
      expect(sha256(await readFile(eventsPath))).toBe(originalSha);
    });

    it("round-trips the real plan-gen fixture", async () => {
      const original = await readFile(PLAN_GEN_JOURNAL);
      await seedRaw(original);
      const originalSha = sha256(original);

      const report = await dietJournal(eventsDir);
      expect(report.originalSha256).toBe(originalSha);

      const restore = await restoreJournal(eventsDir);
      expect(restore.sha256).toBe(originalSha);
      expect(sha256(await readFile(eventsPath))).toBe(originalSha);
    });

    it("round-trips an empty journal", async () => {
      const original = await seedRaw("");
      const originalSha = sha256(original);

      const report = await dietJournal(eventsDir);
      expect(report.dieted).toBe(true);
      expect(report.totalEvents).toBe(0);

      const restore = await restoreJournal(eventsDir);
      expect(restore.sha256).toBe(originalSha);
    });

    it("round-trips a journal with a torn last line, preserving the torn bytes", async () => {
      const body = syntheticBody(4, 8 * 1024);
      const complete = `${JSON.stringify(fileUpdatedEvent("ev-1", "a.md", body))}\n`;
      // Torn line is larger than the threshold and contains a content field —
      // it must still be preserved verbatim, never extracted.
      const torn = `{"id":"torn","type":"file.updated","data":{"path":"b.md","content":"${"x".repeat(8 * 1024)}`;
      const original = await seedRaw(complete + torn);
      const originalSha = sha256(original);

      await dietJournal(eventsDir);
      const restore = await restoreJournal(eventsDir);
      expect(restore.sha256).toBe(originalSha);
      const restored = (await readFile(eventsPath)).toString("utf-8");
      expect(restored.endsWith(torn.slice(-100))).toBe(true);
    });

    it("round-trips corrupt and blank lines verbatim", async () => {
      const body = syntheticBody(5, 8 * 1024);
      const original = await seedRaw(
        `${JSON.stringify(fileUpdatedEvent("ev-1", "a.md", body))}\n` +
          `%%% not json at all %%%\n` +
          `\n` +
          `${snapshotLine("ev-2", "a.md", body)}\n`,
      );
      const originalSha = sha256(original);

      const report = await dietJournal(eventsDir);
      // file.updated body + snapshot recentFileAccess body both extracted.
      expect(report.extractedBodies).toBe(2);
      expect(report.uniqueCasBodies).toBe(1); // identical body, one CAS entry

      const restore = await restoreJournal(eventsDir);
      expect(restore.sha256).toBe(originalSha);
    });

    it("leaves same-run-previous contentRef lines untouched", async () => {
      const line = JSON.stringify({
        id: "ev-1",
        timestamp: new Date().toISOString(),
        type: "file.updated",
        data: {
          path: "a.md",
          filename: "a.md",
          action: "modified",
          contentRef: {
            sha256: "a".repeat(64),
            bytes: 20759,
            encoding: "utf-8",
            ref: "same-run-previous",
          },
        },
      });
      const original = await seedRaw(`${line}\n`);
      const originalSha = sha256(original);

      const report = await dietJournal(eventsDir);
      expect(report.extractedBodies).toBe(0);
      expect(report.uniqueCasBodies).toBe(0);
      const restore = await restoreJournal(eventsDir);
      expect(restore.sha256).toBe(originalSha);
    });
  });

  describe("threshold", () => {
    it("extracts only bodies at or above the threshold", async () => {
      const big = syntheticBody(6, 4096); // exactly at default threshold
      const small = syntheticBody(7, 4095); // one byte under
      await seedViaStorage([
        fileUpdatedEvent("ev-1", "big.md", big),
        fileUpdatedEvent("ev-2", "small.md", small),
      ]);

      const report = await dietJournal(eventsDir);
      expect(report.extractedBodies).toBe(1);
      expect(report.uniqueCasBodies).toBe(1);

      // The small body must still be inline in the pointer journal.
      const { rehydrateDietedJournal } = await import("../../server/storage/journal-diet.js");
      const restoredLogical = (await rehydrateDietedJournal(eventsDir)).toString("utf-8");
      expect(restoredLogical).toContain(small);
    });

    it("honors a custom threshold", async () => {
      const body = syntheticBody(8, 1024);
      await seedViaStorage([fileUpdatedEvent("ev-1", "a.md", body)]);
      const report = await dietJournal(eventsDir, { thresholdBytes: 256 });
      expect(report.extractedBodies).toBe(1);
      const restore = await restoreJournal(eventsDir);
      expect(restore.restored).toBe(true);
    });
  });

  describe("idempotency", () => {
    it("dieting twice is a no-op the second time", async () => {
      await seedViaStorage([fileUpdatedEvent("ev-1", "a.md", syntheticBody(9, 8192))]);
      const first = await dietJournal(eventsDir);
      expect(first.dieted).toBe(true);

      const second = await dietJournal(eventsDir);
      expect(second.dieted).toBe(false);
      expect(second.alreadyDieted).toBe(true);
      expect(second.originalSha256).toBe(first.originalSha256);
      expect(second.totalEvents).toBe(first.totalEvents);
    });

    it("restoring twice verifies and reports no-op the second time", async () => {
      await seedViaStorage([fileUpdatedEvent("ev-1", "a.md", syntheticBody(10, 8192))]);
      await dietJournal(eventsDir);

      const first = await restoreJournal(eventsDir);
      expect(first.restored).toBe(true);
      const second = await restoreJournal(eventsDir);
      expect(second.restored).toBe(false);
      expect(second.alreadyRestored).toBe(true);
      expect(second.sha256).toBe(first.sha256);
    });

    it("re-diet after restore repairs a corrupt CAS entry from the journal", async () => {
      // Codex round 3 repro: restore, then corrupt the CAS entry. The
      // restored journal holds the authoritative body, so re-diet must
      // overwrite the bad entry and verify — not fail forever on it.
      await seedViaStorage([fileUpdatedEvent("ev-1", "a.md", syntheticBody(40, 8192))]);
      const first = await dietJournal(eventsDir);
      await restoreJournal(eventsDir);

      const casDir = path.join(eventsDir, "cas");
      const shard = fsSync.readdirSync(casDir)[0];
      const entry = fsSync.readdirSync(path.join(casDir, shard))[0];
      await writeFile(path.join(casDir, shard, entry), "not zstd at all");

      const redone = await dietJournal(eventsDir);
      expect(redone.dieted).toBe(true);
      expect(redone.originalSha256).toBe(first.originalSha256);
      const restore = await restoreJournal(eventsDir);
      expect(restore.sha256).toBe(first.originalSha256);
    });

    it("a damaged diet is reported as damaged, not alreadyDieted", async () => {
      // Codex round 3 repro: with events.jsonl gone and a CAS entry
      // corrupted, dietJournal returned alreadyDieted success while restore
      // failed. The no-op path must prove restorability first.
      await seedViaStorage([fileUpdatedEvent("ev-1", "a.md", syntheticBody(41, 8192))]);
      await dietJournal(eventsDir);

      const casDir = path.join(eventsDir, "cas");
      const shard = fsSync.readdirSync(casDir)[0];
      const entry = fsSync.readdirSync(path.join(casDir, shard))[0];
      await writeFile(path.join(casDir, shard, entry), "broken");

      await expect(dietJournal(eventsDir)).rejects.toThrow(/damaged, not complete/);
    });

    it("re-diet after restore verifies against the same original", async () => {
      const original = await seedViaStorage([
        fileUpdatedEvent("ev-1", "a.md", syntheticBody(11, 8192)),
      ]);
      const originalSha = sha256(original);
      await dietJournal(eventsDir);
      await restoreJournal(eventsDir);
      const redone = await dietJournal(eventsDir);
      expect(redone.dieted).toBe(true);
      expect(redone.originalSha256).toBe(originalSha);
      const restore = await restoreJournal(eventsDir);
      expect(restore.sha256).toBe(originalSha);
    });
  });

  describe("failure modes", () => {
    it("dieting a directory with no journal and no diet throws", async () => {
      await expect(dietJournal(eventsDir)).rejects.toThrow(/no events\.jsonl/);
    });

    it("restore fails loudly when a CAS body is missing", async () => {
      await seedViaStorage([fileUpdatedEvent("ev-1", "a.md", syntheticBody(12, 8192))]);
      const report = await dietJournal(eventsDir);
      expect(report.uniqueCasBodies).toBe(1);

      // Destroy the CAS.
      await rm(path.join(eventsDir, "cas"), { recursive: true, force: true });
      await expect(restoreJournal(eventsDir)).rejects.toThrow(/CAS body .* missing/);
      // Nothing half-written.
      expect(fsSync.existsSync(eventsPath)).toBe(false);
    });

    it("restore fails loudly when a CAS body is corrupt", async () => {
      await seedViaStorage([fileUpdatedEvent("ev-1", "a.md", syntheticBody(13, 8192))]);
      await dietJournal(eventsDir);

      // Overwrite the single CAS entry with a different (validly compressed) body.
      const casDir = path.join(eventsDir, "cas");
      const shard = fsSync.readdirSync(casDir)[0];
      const entry = fsSync.readdirSync(path.join(casDir, shard))[0];
      const { zstdCompressSync } = await import("node:zlib");
      await writeFile(
        path.join(casDir, shard, entry),
        zstdCompressSync(Buffer.from("not the original body")),
      );
      await expect(restoreJournal(eventsDir)).rejects.toThrow(/corrupt|hashes to/);
    });

    it("restore refuses to overwrite a mismatched events.jsonl", async () => {
      await seedViaStorage([fileUpdatedEvent("ev-1", "a.md", syntheticBody(14, 8192))]);
      await dietJournal(eventsDir);
      await writeFile(eventsPath, "something else entirely\n");
      await expect(restoreJournal(eventsDir)).rejects.toThrow(/Refusing to overwrite/);
    });

    it("restore on a non-dieted directory throws a clear error", async () => {
      await seedViaStorage([pongEvent("ev-1")]);
      await expect(restoreJournal(eventsDir)).rejects.toThrow(/not a dieted run directory/);
    });

    it("a mangled manifest degrades to 'not a dieted directory'", async () => {
      await seedViaStorage([fileUpdatedEvent("ev-1", "a.md", syntheticBody(15, 8192))]);
      await dietJournal(eventsDir);
      await writeFile(path.join(eventsDir, "journal.meta.json"), '{"schemaVersion": 999}');
      expect(await readJournalDietMeta(eventsDir)).toBeNull();
      await expect(restoreJournal(eventsDir)).rejects.toThrow(/not a dieted run directory/);
    });

    it("aborts (original intact) when the journal changes during the diet", async () => {
      // Codex review round: a live writer appending between the diet's read
      // and its unlink would lose those events. The pre-promotion
      // revalidation must catch the change and leave the original alone.
      const original = await seedViaStorage([
        fileUpdatedEvent("ev-1", "a.md", syntheticBody(30, 8192)),
      ]);
      const concurrentLine = `${JSON.stringify(pongEvent("ev-concurrent"))}\n`;

      await expect(
        dietJournal(eventsDir, {
          beforePromote: async () => {
            await appendFile(eventsPath, concurrentLine);
          },
        }),
      ).rejects.toThrow(/changed while the diet was running/);

      // Original journal intact WITH the concurrent append; nothing promoted.
      const survivor = await readFile(eventsPath);
      expect(survivor.toString("utf-8")).toBe(original.toString("utf-8") + concurrentLine);
      expect(isDietedEventsDir(eventsDir)).toBe(false);
      expect(fsSync.existsSync(path.join(eventsDir, "events.jsonl.zst"))).toBe(false);
      expect(fsSync.existsSync(path.join(eventsDir, "events.jsonl.zst.tmp"))).toBe(false);
      expect(fsSync.existsSync(path.join(eventsDir, "journal.meta.json.tmp"))).toBe(false);

      // The grown journal diets cleanly on the next (unraced) attempt.
      const report = await dietJournal(eventsDir);
      expect(report.dieted).toBe(true);
      const restore = await restoreJournal(eventsDir);
      expect(restore.sha256).toBe(report.originalSha256);
    });

    it("restore propagates read errors instead of clobbering an unreadable journal", async () => {
      // Codex review round: EACCES/EIO on the existing events.jsonl was
      // swallowed as "absent", and the restore rename silently overwrote a
      // file it could not even read. Only ENOENT may mean absent.
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        return; // root ignores file modes; the scenario cannot be built
      }
      if (process.platform === "win32") {
        return; // chmod(0) only sets the read-only attribute; reads still succeed
      }
      await seedViaStorage([fileUpdatedEvent("ev-1", "a.md", syntheticBody(31, 8192))]);
      await dietJournal(eventsDir);

      const foreign = "some newer journal the diet knows nothing about\n";
      await writeFile(eventsPath, foreign);
      await chmod(eventsPath, 0);
      try {
        await expect(restoreJournal(eventsDir)).rejects.toThrow(/EACCES|permission denied/i);
      } finally {
        await chmod(eventsPath, 0o600);
      }
      // The unreadable file was not replaced.
      expect((await readFile(eventsPath)).toString("utf-8")).toBe(foreign);
    });

    it("cleanStrayDietTmp removes crashed temp artifacts", async () => {
      await seedViaStorage([pongEvent("ev-1")]);
      const strays = [
        path.join(eventsDir, "events.jsonl.zst.tmp"),
        path.join(eventsDir, "journal.meta.json.tmp"),
        path.join(eventsDir, "events.jsonl.tmp"),
      ];
      for (const stray of strays) await writeFile(stray, "half-written");
      await cleanStrayDietTmp(eventsDir);
      for (const stray of strays) expect(fsSync.existsSync(stray)).toBe(false);
    });
  });

  describe("boot-path auto-restore", () => {
    it("ensureJournalRestored rehydrates a dieted execution and prunes the stale diet pair", async () => {
      // Build an execution-shaped directory: <exec>/.hankweave/events
      const execDir = await mkdtemp(path.join(tmpdir(), "journal-diet-exec-"));
      try {
        const dir = path.join(execDir, ".hankweave", "events");
        fsSync.mkdirSync(dir, { recursive: true });
        const storage = new FileEventStorage(dir);
        await storage.initialize();
        await storage.appendMany([fileUpdatedEvent("ev-1", "a.md", syntheticBody(16, 8192))]);
        await storage.close();
        const journalPath = path.join(dir, "events.jsonl");
        const originalSha = sha256(await readFile(journalPath));

        // Not dieted: a no-op that touches nothing.
        expect(await ensureJournalRestored(execDir)).toBeNull();
        expect(sha256(await readFile(journalPath))).toBe(originalSha);

        await dietJournal(dir);
        const logs: string[] = [];
        const report = await ensureJournalRestored(execDir, (m) => logs.push(m));

        // Byte-identical restore, announced.
        expect(report?.sha256).toBe(originalSha);
        expect(sha256(await readFile(journalPath))).toBe(originalSha);
        expect(logs.join("\n")).toContain("restored");
        // The stale diet pair is pruned (the journal is about to diverge),
        // the CAS kept for the next diet's dedup.
        expect(fsSync.existsSync(path.join(dir, "events.jsonl.zst"))).toBe(false);
        expect(fsSync.existsSync(path.join(dir, "journal.meta.json"))).toBe(false);
        expect(fsSync.existsSync(path.join(dir, "cas"))).toBe(true);

        // The restored directory re-diets cleanly on its next finalize.
        const redone = await dietJournal(dir);
        expect(redone.dieted).toBe(true);
        expect(redone.originalSha256).toBe(originalSha);
      } finally {
        await rm(execDir, { recursive: true, force: true });
      }
    });

    it("ensureJournalRestored finishes an interrupted prune (stale pair beside a live journal)", async () => {
      const execDir = await mkdtemp(path.join(tmpdir(), "journal-diet-exec-"));
      try {
        const dir = path.join(execDir, ".hankweave", "events");
        fsSync.mkdirSync(dir, { recursive: true });
        const storage = new FileEventStorage(dir);
        await storage.initialize();
        await storage.appendMany([fileUpdatedEvent("ev-1", "a.md", syntheticBody(21, 8192))]);
        await storage.close();
        const journalPath = path.join(dir, "events.jsonl");
        const originalSha = sha256(await readFile(journalPath));

        // A CLI restore keeps the diet pair — exactly the crashed-prune shape.
        await dietJournal(dir);
        await restoreJournal(dir);
        expect(fsSync.existsSync(path.join(dir, "events.jsonl.zst"))).toBe(true);

        const report = await ensureJournalRestored(execDir);
        expect(report).toBeNull(); // The journal itself needed no restore…
        // …but the stale pair is gone and the journal untouched.
        expect(fsSync.existsSync(path.join(dir, "events.jsonl.zst"))).toBe(false);
        expect(fsSync.existsSync(path.join(dir, "journal.meta.json"))).toBe(false);
        expect(sha256(await readFile(journalPath))).toBe(originalSha);
      } finally {
        await rm(execDir, { recursive: true, force: true });
      }
    });

    it("ensureJournalRestored refuses half a diet pair instead of burying it", async () => {
      const execDir = await mkdtemp(path.join(tmpdir(), "journal-diet-exec-"));
      try {
        const dir = path.join(execDir, ".hankweave", "events");
        fsSync.mkdirSync(dir, { recursive: true });
        const storage = new FileEventStorage(dir);
        await storage.initialize();
        await storage.appendMany([fileUpdatedEvent("ev-1", "a.md", syntheticBody(23, 8192))]);
        await storage.close();
        await dietJournal(dir);

        // Kill the manifest: only the compressed pointer journal survives.
        await rm(path.join(dir, "journal.meta.json"), { force: true });
        await expect(ensureJournalRestored(execDir)).rejects.toThrow(/incomplete diet artifacts/);
        // The surviving artifact was not touched.
        expect(fsSync.existsSync(path.join(dir, "events.jsonl.zst"))).toBe(true);
        expect(fsSync.existsSync(path.join(dir, "events.jsonl"))).toBe(false);
      } finally {
        await rm(execDir, { recursive: true, force: true });
      }
    });

    it("ensureJournalRestored refuses to mutate a directory owned by a live runtime", async () => {
      const execDir = await mkdtemp(path.join(tmpdir(), "journal-diet-exec-"));
      try {
        const dir = path.join(execDir, ".hankweave", "events");
        fsSync.mkdirSync(dir, { recursive: true });
        const storage = new FileEventStorage(dir);
        await storage.initialize();
        await storage.appendMany([fileUpdatedEvent("ev-1", "a.md", syntheticBody(29, 8192))]);
        await storage.close();
        await dietJournal(dir);
        const lockPath = path.join(execDir, ".hankweave", "runtime.lock");

        // Live FOREIGN owner (the test runner's pid): restore must refuse.
        await writeFile(
          lockPath,
          JSON.stringify({ pid: process.ppid, lastHeartbeat: new Date().toISOString() }),
        );
        await expect(ensureJournalRestored(execDir)).rejects.toThrow(/live runtime/);
        // Legacy bare-pid lock, same liveness: refuse.
        await writeFile(lockPath, String(process.ppid));
        await expect(ensureJournalRestored(execDir)).rejects.toThrow(/live runtime/);
        // Unparseable lock: liveness unknown — fail closed.
        await writeFile(lockPath, "@@@ not a lock @@@");
        await expect(ensureJournalRestored(execDir)).rejects.toThrow(/could not be parsed/);
        expect(fsSync.existsSync(path.join(dir, "events.jsonl"))).toBe(false);

        // A lock naming OUR OWN pid that this process REGISTERED is a live
        // in-process runtime: refuse.
        await writeFile(
          lockPath,
          JSON.stringify({ pid: process.pid, lastHeartbeat: new Date().toISOString() }),
        );
        registerProcessOwnedLock(lockPath, "test-owner-token");
        try {
          await expect(ensureJournalRestored(execDir)).rejects.toThrow(/this process/);
        } finally {
          releaseProcessOwnedLock("test-owner-token");
        }
        // Own-pid, unregistered, but heartbeat still FRESH: possibly a live
        // incumbent in another pid namespace sharing the volume — refuse.
        await expect(ensureJournalRestored(execDir)).rejects.toThrow(/another pid namespace/);

        // Own-pid, unregistered, heartbeat lapsed: the true recycled
        // leftover (restarted PID-1 container shape) — proceed.
        await writeFile(
          lockPath,
          JSON.stringify({
            pid: process.pid,
            lastHeartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
          }),
        );
        expect((await ensureJournalRestored(execDir))?.restored).toBe(true);

        // Dead owner: the lock is inert and the restore proceeds.
        await dietJournal(dir);
        await writeFile(
          lockPath,
          JSON.stringify({ pid: 999_999_999, lastHeartbeat: new Date().toISOString() }),
        );
        const report = await ensureJournalRestored(execDir);
        expect(report?.restored).toBe(true);

        // Stale-pair cleanup refuses under a live owner too: that shape is a
        // finalize diet mid-promotion, and the pair must survive.
        await dietJournal(dir);
        await restoreJournal(dir); // journal + pair side by side
        await writeFile(
          lockPath,
          JSON.stringify({ pid: process.ppid, lastHeartbeat: new Date().toISOString() }),
        );
        await expect(ensureJournalRestored(execDir)).rejects.toThrow(/live runtime/);
        expect(fsSync.existsSync(path.join(dir, "events.jsonl.zst"))).toBe(true);
      } finally {
        await rm(execDir, { recursive: true, force: true });
      }
    });

    it("cleanStrayDietTmp spares a live process's in-flight restore temp", async () => {
      await seedViaStorage([pongEvent("ev-1")]);
      // The parent process (the test runner) is live for the whole test and
      // is a foreign pid — unlike pid 1, it also exists on Windows.
      const liveForeign = path.join(eventsDir, `events.jsonl.tmp-${process.ppid}-42`);
      const deadForeign = path.join(eventsDir, "events.jsonl.tmp-999999999-42");
      const deadButYoung = path.join(eventsDir, "events.jsonl.tmp-999999998-42");
      const legacyFixed = path.join(eventsDir, "events.jsonl.tmp");
      for (const f of [liveForeign, deadForeign, deadButYoung, legacyFixed]) {
        await writeFile(f, "half-written");
      }
      // Old enough to be provably abandoned (the sweep spares young temps —
      // pid numbers are namespace-local, so age is the reliable signal).
      const old = new Date(Date.now() - 11 * 60 * 1000);
      await utimes(deadForeign, old, old);

      await cleanStrayDietTmp(eventsDir);

      expect(fsSync.existsSync(liveForeign)).toBe(true); // in flight — spared
      expect(fsSync.existsSync(deadForeign)).toBe(false); // crashed long ago — swept
      expect(fsSync.existsSync(deadButYoung)).toBe(true); // dead pid but young — spared
      expect(fsSync.existsSync(legacyFixed)).toBe(false); // historical name — swept
      await rm(liveForeign, { force: true });
      await rm(deadButYoung, { force: true });
    });

    it("ensureJournalRestored fails the boot on damaged diet artifacts", async () => {
      const execDir = await mkdtemp(path.join(tmpdir(), "journal-diet-exec-"));
      try {
        const dir = path.join(execDir, ".hankweave", "events");
        fsSync.mkdirSync(dir, { recursive: true });
        const storage = new FileEventStorage(dir);
        await storage.initialize();
        await storage.appendMany([fileUpdatedEvent("ev-1", "a.md", syntheticBody(19, 8192))]);
        await storage.close();
        await dietJournal(dir);

        // Corrupt the compressed pointer journal: restore must refuse, and
        // must not fabricate an events.jsonl.
        await writeFile(path.join(dir, "events.jsonl.zst"), "not zstd at all");
        await expect(ensureJournalRestored(execDir)).rejects.toThrow();
        expect(fsSync.existsSync(path.join(dir, "events.jsonl"))).toBe(false);
      } finally {
        await rm(execDir, { recursive: true, force: true });
      }
    });
  });

  describe("transparent reads on a dieted directory", () => {
    let originalBytes: Buffer;
    let events: ServerEvent[];

    beforeEach(async () => {
      events = [
        pongEvent("ev-1"),
        fileUpdatedEvent("ev-2", "a.md", syntheticBody(17, 16 * 1024)),
        pongEvent("ev-3"),
        fileUpdatedEvent("ev-4", "a.md", syntheticBody(18, 16 * 1024)),
        pongEvent("ev-5"),
      ];
      originalBytes = await seedViaStorage(events);
      await dietJournal(eventsDir);
    });

    it("FileEventStorage serves tail reads from the rehydrated journal", async () => {
      const storage = new FileEventStorage(eventsDir);
      await storage.initialize();
      const { events: tail, totalEvents, corruptLines } = await storage.getRecentEvents(3);
      expect(totalEvents).toBe(5);
      expect(corruptLines).toBe(0);
      expect(tail.map((e) => e.id)).toEqual(["ev-3", "ev-4", "ev-5"]);
      // Bodies come back inline, not as CAS pointers.
      const restored = tail[1] as unknown as { data: { content?: string } };
      expect(typeof restored.data.content).toBe("string");
      await storage.close();
    });

    it("cursor walks equal the pre-diet event stream", async () => {
      const storage = new FileEventStorage(eventsDir);
      await storage.initialize();
      const collected: ServerEvent[] = [];
      let cursor: string | null = null;
      while (true) {
        const page = await storage.getEventsAfter(cursor, 2);
        collected.push(...page.events);
        cursor = page.nextCursor;
        if (!page.hasMore) break;
      }
      expect(collected.map((e) => e.id)).toEqual(events.map((e) => e.id));
      await storage.close();
    });

    it("appends reject with the restore remedy", async () => {
      const storage = new FileEventStorage(eventsDir);
      await storage.initialize();
      await expect(storage.append(pongEvent("ev-6"))).rejects.toThrow(/--restore-journal/);
      // The dieted layout is untouched by the attempt.
      expect(fsSync.existsSync(eventsPath)).toBe(false);
      await storage.close();
    });

    it("streamAllEvents yields the logical JSONL, byte-identical to the original", async () => {
      // Decision 0.3.2: the stream contract is "yields the logical JSONL";
      // this is where the byte-identity assertion lives post-diet. Also
      // serves as the hankweave-trace reader smoke: trace consumes exactly
      // this stream shape.
      const journal = new EventJournal(new FileEventStorage(eventsDir));
      await journal.initialize();
      const stream = await journal.streamAllEvents();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(sha256(Buffer.concat(chunks))).toBe(sha256(originalBytes));
      await journal.close();
    });

    it("EventJournal.getAllEvents pages through the dieted journal", async () => {
      const journal = new EventJournal(new FileEventStorage(eventsDir));
      await journal.initialize();
      const seen: string[] = [];
      for await (const event of journal.getAllEvents()) {
        seen.push(String(event.id));
      }
      expect(seen).toEqual(events.map((e) => String(e.id)));
      await journal.close();
    });
  });

  describe("size gate (synthetic gladstone-class)", () => {
    it("diets a repeat-heavy body journal by at least 10x", async () => {
      // The investigation's mechanism in miniature: few unique bodies,
      // re-emitted many times (codon-start re-emission), bodies ≫ threshold.
      const uniqueBodies = Array.from({ length: 5 }, (_, i) => syntheticBody(100 + i, 200 * 1024));
      const batch: ServerEvent[] = [];
      for (let i = 0; i < 50; i++) {
        batch.push(fileUpdatedEvent(`ev-${i}`, `file-${i % 5}.md`, uniqueBodies[i % 5]));
      }
      const original = await seedViaStorage(batch);
      expect(original.length).toBeGreaterThan(9 * 1024 * 1024);

      const report = await dietJournal(eventsDir);
      expect(report.uniqueCasBodies).toBe(5);
      expect(report.dietedBytes).toBeLessThan(report.originalBytes / 10);

      const restore = await restoreJournal(eventsDir);
      expect(restore.sha256).toBe(report.originalSha256);
    });
  });
});
