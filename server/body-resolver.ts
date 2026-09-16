import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WatchedFileUpdate } from "./codon-file-tracker.js";
import type { FileUpdatedEventData } from "./schemas/event-schemas.js";
import type { Logger } from "./utils.js";

interface RetainedBody {
  content: string;
  /** Bytes charged against the retention budget (body + entry overhead). */
  cost: number;
}

/**
 * Retained-body budget. Entries are evicted oldest-first once the total cost
 * exceeds it; a single body larger than the whole budget is never put in the
 * map (it gets the one-shot {@link BodyResolver.transient} slot instead).
 * Keeps N large watched files from pinning unbounded memory for a run.
 */
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;

/**
 * Flat cost added per retained entry on top of its body bytes, so that a
 * flood of distinct paths with tiny (or empty) bodies is still bounded by
 * the byte budget instead of growing the map without limit.
 */
const ENTRY_OVERHEAD_BYTES = 256;

/**
 * The `file.updated` chokepoint (fingerprint-events proposal): every
 * watched-file emission is hashed here, before emit(), so journal, wire, and
 * sentinels all see one identical object — the fingerprint form
 * (`sha256`/`bytes`/`source`), never a body. The journal carries claims,
 * fingerprints, and receipts; file state lives in checkpoints and on disk;
 * sentinels resolve bodies at the moment they ask, via {@link resolve}.
 *
 * Bodies are retained keyed by `sha256:path` (bounded by
 * {@link MAX_RETAINED_BYTES}, LRU): an event resolves the exact body its
 * fingerprint describes even after later emissions for the same path —
 * sequence-trigger histories and queued sentinel work see their own bodies,
 * not the newest one. Only when an entry has been evicted does resolution
 * fall through to a disk read, which returns the file as of resolution time —
 * verified against the event's fingerprint, with a logged warning on
 * mismatch.
 *
 * Lifecycle (owned by HankweaveRuntime): cleared on run start and on
 * rollback/checkpoint-restore, so retained bodies never describe state the
 * run has abandoned.
 */
export class BodyResolver {
  private readonly bodies = new Map<string, RetainedBody>();
  private retainedCost = 0;
  /**
   * One-shot slot for the most recent body too large for the map, so an
   * immediately-evaluated condition or template can still observe it. It is
   * replaced (or dropped) by the next {@link process} call — best-effort by
   * design: a delayed consumer (debounce/batch template) of an oversized
   * body falls through to the disk fallback. Holds at most one body at a
   * time, so it can exceed the map budget only by that single body — the
   * same transient cost emitting the event's inline body used to have.
   */
  private transient: { key: string; content: string } | undefined;
  private readonly agentRootPath: string;
  private readonly logger?: Logger;

  constructor(agentRootPath: string, logger?: Logger) {
    this.agentRootPath = agentRootPath;
    this.logger = logger;
  }

  /** Fingerprint one watched-file emission and retain its body for {@link resolve}. */
  process(update: WatchedFileUpdate): FileUpdatedEventData {
    const sha256 = createHash("sha256").update(update.content, "utf-8").digest("hex");
    const bytes = Buffer.byteLength(update.content, "utf-8");
    this.retain(bodyKey(update.path, sha256), update.content, bytes);

    return {
      path: update.path,
      filename: update.filename,
      action: update.action,
      sha256,
      bytes,
      source: update.source,
    };
  }

  /**
   * Resolve the body a `file.updated` event described, for sentinel views.
   *
   * Retained map first — an exact, fingerprint-addressed hit. Falls back to
   * reading the file from disk, hash-verified against the event's
   * fingerprint: a mismatch still returns the disk body — the most useful
   * thing a sentinel can operate on — but logs that the file moved on after
   * the event. Returns undefined only when no body is obtainable.
   */
  resolve(data: Pick<FileUpdatedEventData, "path" | "sha256">): string | undefined {
    const key = bodyKey(data.path, data.sha256);
    const retained = this.bodies.get(key);
    if (retained) return retained.content;
    if (this.transient?.key === key) return this.transient.content;

    const fullPath = path.join(this.agentRootPath, data.path);
    let content: string;
    try {
      content = fs.readFileSync(fullPath, "utf-8");
    } catch {
      this.logger?.log(
        `BodyResolver: cannot resolve body for ${data.path} (not retained, unreadable on disk)`,
        "error",
      );
      return undefined;
    }

    const diskSha = createHash("sha256").update(content, "utf-8").digest("hex");
    if (diskSha !== data.sha256) {
      this.logger?.log(
        `BodyResolver: ${data.path} changed after emission (event ${data.sha256.slice(0, 12)}…, disk ${diskSha.slice(0, 12)}…) — serving as-of-resolution body`,
        "info",
      );
    }
    return content;
  }

  clear(): void {
    this.bodies.clear();
    this.retainedCost = 0;
    this.transient = undefined;
  }

  private retain(key: string, content: string, bytes: number): void {
    const cost = bytes + ENTRY_OVERHEAD_BYTES;

    if (cost > MAX_RETAINED_BYTES) {
      // Too large for the budget: hold it in the one-shot slot only.
      this.transient = { key, content };
      return;
    }
    this.transient = undefined;

    const existing = this.bodies.get(key);
    if (existing) {
      // Refresh LRU position; the body is identical by construction (the key
      // embeds the content hash).
      this.bodies.delete(key);
      this.bodies.set(key, existing);
      return;
    }

    this.bodies.set(key, { content, cost });
    this.retainedCost += cost;

    for (const [oldestKey, oldest] of this.bodies) {
      if (this.retainedCost <= MAX_RETAINED_BYTES || oldestKey === key) break;
      this.bodies.delete(oldestKey);
      this.retainedCost -= oldest.cost;
    }
  }
}

function bodyKey(filePath: string, sha256: string): string {
  return `${sha256}:${filePath}`;
}
