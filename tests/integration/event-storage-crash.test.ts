/**
 * Crash-safety contract for the append-only event journal: a writer killed
 * mid-write (SIGKILL, no cleanup) must leave a file whose every complete line
 * is valid JSONL — at worst a single torn final line — and a fresh
 * FileEventStorage must initialize on the survivor and keep appending.
 *
 * Mirrors the investigation's 25/25 methodology (see
 * intermediates/60-shim-debug-diet/events-diet-implementation-plan.md).
 */
import { describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { FileEventStorage } from "../../server/storage/file-event-storage.js";
import { EventId } from "../../server/types/branded-types.js";

const CHILD_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "event-storage-crash-child.ts",
);
const ROUNDS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWrites(eventsPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await stat(eventsPath)).size > 0) return;
    } catch {
      // Not created yet.
    }
    await sleep(5);
  }
  throw new Error(`Child produced no journal writes within ${timeoutMs}ms`);
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
}

describe("FileEventStorage crash safety", () => {
  it(`survivor file is a valid JSONL prefix after SIGKILL x${ROUNDS}`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const dir = await mkdtemp(path.join(tmpdir(), "event-storage-crash-"));
      const eventsPath = path.join(dir, "events.jsonl");
      try {
        const child = spawn("bun", [CHILD_SCRIPT, dir], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr?.on("data", (data) => {
          stderr += data.toString();
        });

        // Kill only once real writes are flowing, at a jittered offset so
        // rounds die in different write states.
        await waitForWrites(eventsPath, 15_000);
        await sleep(5 + Math.floor(Math.random() * 50));
        child.kill("SIGKILL");
        await waitForExit(child);
        expect(child.signalCode).toBe("SIGKILL");
        expect(stderr).toBe("");

        // The survivor must be a strict prefix of what the child appended:
        // every complete line parses AND the ids run 0..N-1 with no skips,
        // duplicates, or reordering. Only the unterminated tail may be torn.
        const raw = await readFile(eventsPath, "utf-8");
        const lines = raw.split("\n");
        lines.pop();
        expect(lines.length).toBeGreaterThan(0);
        let expectedSequence = 0;
        for (const line of lines) {
          const event = JSON.parse(line) as ServerEvent;
          if (event.id !== `crash-${expectedSequence.toString().padStart(8, "0")}`) {
            throw new Error(
              `Not a prefix: expected crash-${expectedSequence} at line ${expectedSequence}, got ${event.id}`,
            );
          }
          expectedSequence += 1;
        }

        // The survivor must come back up and accept appends.
        const survivor = new FileEventStorage(dir);
        await survivor.initialize();
        await survivor.append({
          id: EventId(`post-crash-${round}`),
          timestamp: new Date().toISOString(),
          type: "pong",
          data: { message: "revived", timestamp: new Date().toISOString() },
        });
        const { events } = await survivor.getRecentEvents(1);
        expect(events[0]?.id).toBe(`post-crash-${round}`);
        await survivor.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }, 120_000);
});
