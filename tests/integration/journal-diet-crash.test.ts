/**
 * Crash-safety contract for the finalize-time journal diet: a diet killed
 * mid-flight (SIGKILL, no cleanup) must leave every survivor directory in
 * one of exactly two states — "intact original" (events.jsonl byte-identical
 * to the pre-diet journal) or "complete, verified diet" (restore proves
 * byte-identity). Never neither, never a half-diet.
 *
 * Mirrors the events-diet plan's kill-matrix methodology (×25 at randomized
 * offsets, same shape as the P1 event-storage crash test).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { FileEventStorage } from "../../server/storage/file-event-storage.js";
import {
  dietJournal,
  isDietedEventsDir,
  restoreJournal,
} from "../../server/storage/journal-diet.js";
import { EventId } from "../../server/types/branded-types.js";

const CHILD_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "journal-diet-crash-child.ts",
);
const ROUNDS = 25;

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
}

/** Semi-compressible pseudo-random text (keeps zstd -19 honest and slow-ish). */
function noisyBody(seed: number, bytes: number): string {
  let state = seed >>> 0;
  const chunks: string[] = [];
  let length = 0;
  while (length < bytes) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const piece = state.toString(36);
    chunks.push(piece);
    length += piece.length;
  }
  return chunks.join("").slice(0, bytes);
}

describe("journal diet crash safety", () => {
  let templateJournal: string;
  let templateDir: string;
  let originalSha: string;

  beforeAll(async () => {
    // Build one body-heavy journal template; every round copies it into a
    // fresh directory. 8 unique 256 KB bodies × 6 emissions each ≈ 12 MB —
    // enough work that SIGKILL lands in CAS writes, compression, or the
    // rename window depending on the round's jitter.
    const dir = await mkdtemp(path.join(tmpdir(), "journal-diet-crash-template-"));
    templateDir = dir;
    const storage = new FileEventStorage(dir);
    await storage.initialize();
    const bodies = Array.from({ length: 8 }, (_, i) => noisyBody(1000 + i, 256 * 1024));
    const events: ServerEvent[] = [];
    let id = 0;
    for (let round = 0; round < 6; round++) {
      for (let b = 0; b < bodies.length; b++) {
        // Legacy pre-fingerprint file.updated shape (inline content body);
        // the diet still has to handle historical journals that carry it.
        events.push({
          id: EventId(`crash-${(id++).toString().padStart(6, "0")}`),
          timestamp: new Date().toISOString(),
          type: "file.updated",
          data: {
            path: `file-${b}.md`,
            filename: `file-${b}.md`,
            action: "modified",
            content: bodies[b],
          },
        } as unknown as ServerEvent);
      }
    }
    await storage.appendMany(events);
    await storage.close();
    templateJournal = path.join(dir, "events.jsonl");
    originalSha = sha256(await readFile(templateJournal));
  }, 60_000);

  afterAll(async () => {
    // The ~12 MB template lives in the system temp area; without this it
    // leaks once per suite run.
    if (templateDir) await rm(templateDir, { recursive: true, force: true });
  });

  it(`survivor is intact-original or verified-diet after SIGKILL x${ROUNDS}`, async () => {
    let sawIntactOriginal = 0;
    let sawVerifiedDiet = 0;

    for (let round = 0; round < ROUNDS; round++) {
      const eventsDir = await mkdtemp(path.join(tmpdir(), "journal-diet-crash-"));
      const eventsPath = path.join(eventsDir, "events.jsonl");
      try {
        await mkdir(eventsDir, { recursive: true });
        await copyFile(templateJournal, eventsPath);

        const child = spawn("bun", [CHILD_SCRIPT, eventsDir], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (data) => {
          stderr += data.toString();
        });
        const started = new Promise<void>((resolve) => {
          child.stdout?.on("data", (data) => {
            if (String(data).includes("DIET_START")) resolve();
          });
          child.once("exit", () => resolve());
        });
        await started;

        // Jittered kill offset: early rounds die in CAS writes, later ones
        // in compression/verify or the rename+unlink window; some rounds
        // let the diet finish entirely.
        await sleep(Math.floor(Math.random() * 600));
        child.kill("SIGKILL");
        await waitForExit(child);
        expect(stderr).toBe("");

        // The invariant: exactly one of the two safe states.
        if (fsSync.existsSync(eventsPath)) {
          // State A — the original journal is still the source of truth and
          // must be byte-identical to the template.
          expect(sha256(await readFile(eventsPath))).toBe(originalSha);
          sawIntactOriginal += 1;

          // And the crashed attempt must be finishable: re-diet + restore
          // round-trips from whatever temp/CAS debris the kill left behind.
          await dietJournal(eventsDir);
          const restore = await restoreJournal(eventsDir);
          expect(restore.sha256).toBe(originalSha);
        } else {
          // State B — the diet completed (verified before unlink); restore
          // must prove byte-identity.
          expect(isDietedEventsDir(eventsDir)).toBe(true);
          const restore = await restoreJournal(eventsDir);
          expect(restore.sha256).toBe(originalSha);
          sawVerifiedDiet += 1;
        }
      } finally {
        await rm(eventsDir, { recursive: true, force: true });
      }
    }

    // The matrix must actually exercise both survivor states; a run where
    // every kill landed after completion (or none completed) proves little.
    expect(sawIntactOriginal + sawVerifiedDiet).toBe(ROUNDS);
    expect(sawIntactOriginal).toBeGreaterThan(0);
  }, 300_000);
});
