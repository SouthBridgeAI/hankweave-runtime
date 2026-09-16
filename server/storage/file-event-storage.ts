import { createReadStream as createFileReadStream, promises as fs } from "node:fs";
import * as path from "node:path";
import { EVENT_SCHEMA_VERSION, type ServerEvent } from "../schemas/event-schemas.js";
import {
  decodeEventCursor,
  EVENTS_META_FILE,
  type EventPage,
  encodeEventCursor,
  type IEventStorage,
} from "./event-storage.js";
import {
  createDietedJournalReadStream,
  isDietedEventsDir,
  readDietedPointerJournal,
  readJournalDietMeta,
  rehydrateDietedLine,
} from "./journal-diet.js";

/** Bump when the sidecar's shape changes; older files are ignored, not migrated. */
const META_SCHEMA_VERSION = 1;
/** Appended events between advisory meta flushes. */
const META_FLUSH_INTERVAL = 1000;
/** Max lines batched into a single write. */
const WRITE_CHUNK_LINES = 10_000;
/** Initial backwards window for tail reads; doubles until enough events or BOF. */
const TAIL_WINDOW_BYTES = 64 * 1024;
/** Buffer size for forward line scans. */
const SCAN_CHUNK_BYTES = 64 * 1024;
/** Remembered cursor→byte-offset positions so sequential paging seeks, not rescans. */
const CURSOR_CACHE_LIMIT = 64;

/**
 * Advisory sidecar so startup can skip rescanning the whole journal. The
 * journal file remains the only source of truth: on any mismatch we rescan
 * from the last offset the sidecar vouched for.
 */
interface JournalMeta {
  schemaVersion: number;
  /**
   * Version of the event payload contract the journal was written under
   * (file-level, never per-event — see EVENT_SCHEMA_VERSION). Informational
   * for post-run consumers; absent in pre-v2 sidecars.
   */
  eventSchemaVersion?: number;
  totalEvents: number;
  byteLength: number;
  lastEventId: string | null;
}

/**
 * File-based event storage keeping an append-only JSONL log.
 *
 * The file descriptor is opened once and held for the storage's lifetime;
 * reads open their own short-lived descriptors. Crash safety comes from the
 * append-only format plus a tolerant reader (corrupt lines are skipped, a
 * torn final line is healed on the next initialize), not from fsync.
 */
export class FileEventStorage implements IEventStorage {
  private readonly eventsFilePath: string;
  private readonly metaFilePath: string;
  private totalEvents = 0;
  private byteLength = 0;
  private lastEventId: string | null = null;
  private handle: fs.FileHandle | null = null;
  private closed = false;
  private appendsSinceMetaFlush = 0;
  /** Serializes writes so concurrent appendMany calls cannot interleave lines. */
  private writeChain: Promise<void> = Promise.resolve();
  private corruptLineWarned = false;
  private readonly cursorOffsets = new Map<number, number>();
  private readonly storageDir: string;
  /**
   * Read-only mode for a dieted (finalized + compressed) directory: reads
   * rehydrate the logical journal transparently, appends reject with a
   * restore remedy. The runtime auto-restores a dieted directory before
   * initializing storage, so it never sees this mode; it exists for offline
   * consumers (trace upload, tooling).
   */
  private dietedMode = false;
  private dietedLines: string[] | null = null;

  constructor(storagePath: string) {
    this.storageDir = storagePath;
    this.eventsFilePath = path.join(storagePath, "events.jsonl");
    this.metaFilePath = path.join(storagePath, EVENTS_META_FILE);
  }

  async initialize(): Promise<void> {
    // A dieted directory has no events.jsonl by design; opening in append
    // mode would create an empty one and desync the diet artifacts. Detect
    // it BEFORE touching the filesystem and switch to read-only mode.
    if (isDietedEventsDir(this.storageDir)) {
      const dietMeta = await readJournalDietMeta(this.storageDir);
      this.dietedMode = true;
      this.dietedLines = null;
      this.closed = false;
      this.totalEvents = dietMeta?.totalEvents ?? 0;
      return;
    }

    await fs.mkdir(path.dirname(this.eventsFilePath), { recursive: true });
    this.handle = await fs.open(this.eventsFilePath, "a");
    this.closed = false;

    let size = (await this.handle.stat()).size;

    // A crash can leave a torn final line. Terminate it now so new appends
    // start on a fresh line instead of concatenating onto the torn one; the
    // reader then skips the healed line as one corrupt line.
    if (size > 0 && !(await this.endsWithNewline(size))) {
      await this.writeAll(this.handle, Buffer.from("\n"));
      size += 1;
    }

    const meta = await this.readMeta();
    if (meta && meta.byteLength === size) {
      this.totalEvents = meta.totalEvents;
      this.byteLength = size;
      this.lastEventId = meta.lastEventId;
      return;
    }

    // Meta absent or stale (crash): rescan from the last offset it vouched
    // for, or from zero if it claims more bytes than exist (truncation).
    const trustedOffset = meta && meta.byteLength < size ? meta.byteLength : 0;
    const baseCount = meta && trustedOffset > 0 ? meta.totalEvents : 0;
    this.totalEvents = baseCount + (await this.countCompleteLines(trustedOffset));
    this.byteLength = size;
    const { events } = await this.getRecentEvents(1);
    this.lastEventId = events[events.length - 1]?.id ?? null;
    await this.writeMeta().catch(() => {});
  }

  async append(event: ServerEvent): Promise<void> {
    await this.appendMany([event]);
  }

  // Concurrent appendMany calls must not interleave their lines in the file,
  // so writes run one at a time in submission order. Rather than a real queue
  // data structure, `writeChain` is the tail of an invisible queue: a single
  // promise that always represents "the write currently in progress (or
  // already finished)". Each call grabs the current tail, attaches itself
  // after it, and becomes the new tail.
  async appendMany(events: Iterable<ServerEvent>): Promise<void> {
    // Step 1 — reject at submission, synchronously. close() sets `closed` and
    // *then* drains `writeChain`, so any append has exactly two fates: it got
    // past this check before close flipped the flag (and is therefore inside
    // the chain close() waits on), or it arrives after and is rejected here.
    // There is no in-between where an append sneaks in behind close()'s back
    // and writes after the final meta flush or the handle close.
    if (this.dietedMode) {
      throw new Error(
        `Event journal in ${this.storageDir} is dieted (finalized + compressed); appends are ` +
          `not allowed. Restore it first: hankweave --restore-journal <executionPath>`,
      );
    }
    if (this.closed) {
      throw new Error("FileEventStorage is closed; cannot append");
    }
    // Step 2 — wrap the actual write in a thunk so it doesn't start yet; it
    // only runs when the chain gets to it.
    const task = () => this.performAppend(events);
    // Step 3 — queue behind whatever write is in flight. Passing `task` as
    // both the success and failure handler means "run mine after the previous
    // one, whether it succeeded or failed"; without the second handler, one
    // failed write would reject the chain and every later append would
    // inherit that stale rejection instead of running.
    const result = this.writeChain.then(task, task);
    // Step 4 — become the new tail, but store a version with both outcomes
    // swallowed. The chain's only job is sequencing ("previous write is
    // done"), not carrying results; storing `result` directly would leave a
    // rejected promise sitting unhandled until the next append arrived
    // (Node's unhandled-rejection warning), and one failure could wedge the
    // queue.
    this.writeChain = result.then(
      () => {},
      () => {},
    );
    // Step 5 — hand the caller the *un*-swallowed promise: each caller sees
    // their own write's success or failure, but errors never propagate into
    // the shared queue.
    return result;
  }

  private async performAppend(events: Iterable<ServerEvent>): Promise<void> {
    const chunk: string[] = [];

    const flush = async () => {
      if (chunk.length === 0) return;
      const lines = chunk.length;
      const payload = `${chunk.join("\n")}\n`;
      chunk.length = 0;
      await this.writePayload(payload);
      this.totalEvents += lines;
      this.appendsSinceMetaFlush += lines;
      if (this.appendsSinceMetaFlush >= META_FLUSH_INTERVAL) {
        this.appendsSinceMetaFlush = 0;
        await this.writeMeta().catch(() => {});
      }
    };

    for (const event of events) {
      chunk.push(JSON.stringify(event));
      this.lastEventId = event.id;
      if (chunk.length >= WRITE_CHUNK_LINES) {
        await flush();
      }
    }

    await flush();
  }

  private async writePayload(payload: string): Promise<void> {
    if (!this.handle) {
      throw new Error("FileEventStorage not initialized");
    }
    const data = Buffer.from(payload, "utf-8");
    try {
      await this.writeAll(this.handle, data);
      this.byteLength += data.length;
    } catch {
      // The descriptor may have died (EBADF, disk detach). One reopen
      // attempt; if that also fails, the error surfaces to the caller's
      // append-queue catch — a journal write must never crash the run.
      try {
        await this.handle.close();
      } catch {
        // Already unusable.
      }
      this.handle = await fs.open(this.eventsFilePath, "a");
      // The failed attempt may have landed a partial fragment. Terminate it
      // first so the retried payload's first event can't fuse into it (the
      // fragment becomes one skipped corrupt line; a bare "\n" is a blank
      // line readers ignore), then resync byteLength from the file so the
      // meta sidecar stays honest about what's really on disk.
      await this.writeAll(this.handle, Buffer.from("\n"));
      await this.writeAll(this.handle, data);
      this.byteLength = (await this.handle.stat()).size;
    }
  }

  /** Write the whole buffer, looping over legal short writes. */
  private async writeAll(handle: fs.FileHandle, data: Buffer): Promise<void> {
    let written = 0;
    while (written < data.length) {
      const { bytesWritten } = await handle.write(data, written, data.length - written);
      if (bytesWritten <= 0) {
        throw new Error("Event journal write made no progress");
      }
      written += bytesWritten;
    }
  }

  async getRecentEvents(limit: number): Promise<{
    events: ServerEvent[];
    totalEvents: number;
    corruptLines: number;
  }> {
    const empty = { events: [], totalEvents: this.totalEvents, corruptLines: 0 };
    if (limit <= 0) return empty;

    if (this.dietedMode) {
      const lines = await this.loadDietedLines();
      const events: ServerEvent[] = [];
      let corruptLines = 0;
      // Walk backwards over complete lines until `limit` events are found,
      // mirroring the tail reader's semantics on a live journal. Only the
      // lines actually served get their CAS bodies rehydrated.
      for (let i = lines.length - 1; i >= 0 && events.length < limit; i--) {
        const parsed = await this.parseDietedLine(lines[i]);
        if (parsed === null) continue;
        if (parsed === "corrupt") {
          corruptLines += 1;
          continue;
        }
        events.push(parsed);
      }
      events.reverse();
      return { events, totalEvents: this.totalEvents, corruptLines };
    }

    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.eventsFilePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
      throw error;
    }

    try {
      const { size } = await handle.stat();
      if (size === 0) return empty;

      let window = TAIL_WINDOW_BYTES;
      while (true) {
        const start = Math.max(0, size - window);
        const buffer = Buffer.alloc(size - start);
        let filled = 0;
        while (filled < buffer.length) {
          const { bytesRead } = await handle.read(
            buffer,
            filled,
            buffer.length - filled,
            start + filled,
          );
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        let text = buffer.subarray(0, filled).toString("utf-8");

        if (start > 0) {
          // Drop the partial first line (and with it any torn multi-byte
          // character from slicing at an arbitrary byte offset).
          const firstNewline = text.indexOf("\n");
          if (firstNewline === -1) {
            window *= 2;
            continue;
          }
          text = text.slice(firstNewline + 1);
        }

        // Only newline-terminated lines are durable: drop a trailing fragment
        // (an in-flight write racing this read) so tail reads, cursor pages,
        // and totalEvents all agree on what exists. Torn crash leftovers are
        // newline-healed by initialize(), so they still surface as corrupt.
        if (!text.endsWith("\n")) {
          const lastNewline = text.lastIndexOf("\n");
          text = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
        }

        const { events, corruptLines } = this.parseLines(text);
        if (events.length >= limit || start === 0) {
          return {
            events: events.slice(-limit),
            totalEvents: this.totalEvents,
            corruptLines,
          };
        }
        window *= 2;
      }
    } finally {
      await handle.close();
    }
  }

  async getEventsAfter(cursor: string | null, limit: number): Promise<EventPage> {
    const position = cursor === null ? { segmentId: 0, lineNo: 0 } : decodeEventCursor(cursor);
    if (!position || position.segmentId !== 0) {
      throw new Error(`Invalid event cursor: ${cursor}`);
    }

    const startLine = position.lineNo;
    const emptyPage: EventPage = {
      events: [],
      nextCursor: encodeEventCursor(0, startLine),
      hasMore: false,
      corruptLines: 0,
    };
    if (limit <= 0) return emptyPage;

    if (this.dietedMode) {
      const lines = await this.loadDietedLines();
      const events: ServerEvent[] = [];
      let corruptLines = 0;
      let consumed = 0;
      let hasMore = false;
      for (let i = startLine; i < lines.length; i++) {
        if (events.length >= limit) {
          hasMore = true;
          break;
        }
        const parsed = await this.parseDietedLine(lines[i]);
        if (parsed === "corrupt") {
          corruptLines += 1;
        } else if (parsed !== null) {
          events.push(parsed);
        }
        consumed += 1;
      }
      return {
        events,
        nextCursor: encodeEventCursor(0, startLine + consumed),
        hasMore,
        corruptLines,
      };
    }

    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.eventsFilePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyPage;
      throw error;
    }

    try {
      let offset = 0;
      let toSkip = startLine;
      const cached = this.cursorOffsets.get(startLine);
      if (cached !== undefined) {
        offset = cached;
        toSkip = 0;
      }

      const events: ServerEvent[] = [];
      let corruptLines = 0;
      let consumed = 0;
      let consumedEndOffset = offset;
      let hasMore = false;

      await this.scanCompleteLines(handle, offset, (line, endOffset) => {
        if (toSkip > 0) {
          toSkip -= 1;
          return true;
        }
        if (events.length >= limit) {
          // Peeked line proves more data follows; it is not consumed, so the
          // cursor stays on the boundary before it.
          hasMore = true;
          return false;
        }
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          try {
            events.push(JSON.parse(trimmed) as ServerEvent);
          } catch {
            corruptLines += 1;
            this.warnCorruptLine();
          }
        }
        consumed += 1;
        consumedEndOffset = endOffset;
        return true;
      });

      const nextLine = startLine + consumed;
      if (consumed > 0) {
        this.rememberCursorOffset(nextLine, consumedEndOffset);
      }

      return {
        events,
        nextCursor: encodeEventCursor(0, nextLine),
        hasMore,
        corruptLines,
      };
    } finally {
      await handle.close();
    }
  }

  async getTotalEvents(): Promise<number> {
    return this.totalEvents;
  }

  async createReadStream(): Promise<NodeJS.ReadableStream> {
    if (this.dietedMode) {
      // Transparent read (diet decision 0.3.2): stream the logical journal
      // bytes, byte-identical to the pre-diet file. Streaming — memory is
      // bounded by one line + one CAS body, never the whole journal.
      return createDietedJournalReadStream(this.storageDir);
    }
    return createFileReadStream(this.eventsFilePath, { encoding: "utf-8" });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.dietedMode) {
      this.closed = true;
      this.dietedLines = null;
      return;
    }
    // Flip the flag before draining: appendMany rejects synchronously from
    // here on, so nothing can join the chain behind our back and race the
    // final meta flush or the handle close.
    this.closed = true;
    await this.writeChain.then(
      () => {},
      () => {},
    );
    await this.writeMeta().catch(() => {});
    if (this.handle) {
      const handle = this.handle;
      this.handle = null;
      await handle.close();
    }
  }

  // -------------
  // Internals
  // -------------

  /**
   * Lazily decompress a dieted directory's POINTER journal into physical
   * lines (bodies stay in the CAS until a specific line is served, so tail
   * and cursor reads never materialize the full logical journal). Line
   * numbering matches the original file exactly (the diet preserves line
   * structure), so cursors minted before the diet stay valid.
   */
  private async loadDietedLines(): Promise<string[]> {
    if (this.dietedLines) return this.dietedLines;
    const text = (await readDietedPointerJournal(this.storageDir)).toString("utf-8");
    const parts = text.split("\n");
    // The final part is "" for a newline-terminated file, or a torn final
    // line — never a complete, durable line in either case.
    parts.pop();
    this.dietedLines = parts;
    return parts;
  }

  /**
   * Serve one dieted pointer line as a parsed event: rehydrate its CAS body
   * (if it carries one), then parse. Returns null for blank/corrupt lines
   * (corrupt counted by the caller); throws when a CAS body is missing —
   * damaged diet artifacts must fail loudly, not serve partial events.
   */
  private async parseDietedLine(rawLine: string): Promise<ServerEvent | "corrupt" | null> {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) return null;
    const line = await rehydrateDietedLine(this.storageDir, rawLine);
    try {
      return JSON.parse(line.trim()) as ServerEvent;
    } catch {
      this.warnCorruptLine();
      return "corrupt";
    }
  }

  private parseLines(text: string): { events: ServerEvent[]; corruptLines: number } {
    const events: ServerEvent[] = [];
    let corruptLines = 0;
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      try {
        events.push(JSON.parse(line) as ServerEvent);
      } catch {
        // Corrupt or torn line: skip it rather than failing the whole read.
        corruptLines += 1;
        this.warnCorruptLine();
      }
    }
    return { events, corruptLines };
  }

  private warnCorruptLine(): void {
    if (this.corruptLineWarned) return;
    this.corruptLineWarned = true;
    console.warn(
      `Event journal at ${this.eventsFilePath} contains unparseable lines; skipping them`,
    );
  }

  /**
   * Feed complete (newline-terminated) lines to `onLine` with the byte offset
   * just past each line's newline. A torn final line is never emitted.
   * Splitting happens on the raw 0x0A byte, which is UTF-8 safe.
   */
  private async scanCompleteLines(
    handle: fs.FileHandle,
    startOffset: number,
    onLine: (line: string, endOffset: number) => boolean,
  ): Promise<void> {
    let position = startOffset;
    let pending: Buffer = Buffer.alloc(0);
    const buffer = Buffer.alloc(SCAN_CHUNK_BYTES);

    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) return;
      const chunkStart = position;
      position += bytesRead;
      const chunk = buffer.subarray(0, bytesRead);

      let searchFrom = 0;
      while (true) {
        const newlineIndex = chunk.indexOf(0x0a, searchFrom);
        if (newlineIndex === -1) break;
        const linePart = chunk.subarray(searchFrom, newlineIndex);
        const line =
          pending.length > 0
            ? Buffer.concat([pending, linePart]).toString("utf-8")
            : linePart.toString("utf-8");
        pending = Buffer.alloc(0);
        if (!onLine(line, chunkStart + newlineIndex + 1)) return;
        searchFrom = newlineIndex + 1;
      }

      const rest = chunk.subarray(searchFrom);
      // Copy: `buffer` is reused by the next read.
      pending = pending.length > 0 ? Buffer.concat([pending, rest]) : Buffer.from(rest);
    }
  }

  private rememberCursorOffset(lineNo: number, offset: number): void {
    if (this.cursorOffsets.has(lineNo)) this.cursorOffsets.delete(lineNo);
    this.cursorOffsets.set(lineNo, offset);
    if (this.cursorOffsets.size > CURSOR_CACHE_LIMIT) {
      const oldest = this.cursorOffsets.keys().next().value;
      if (oldest !== undefined) this.cursorOffsets.delete(oldest);
    }
  }

  private async countCompleteLines(fromOffset: number): Promise<number> {
    let count = 0;
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.eventsFilePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    try {
      // Parse-validate during the (rare) rescan so totalEvents counts only
      // events a reader can actually return — corrupt and healed-torn lines
      // must not inflate the count.
      await this.scanCompleteLines(handle, fromOffset, (line) => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return true;
        try {
          JSON.parse(trimmed);
          count += 1;
        } catch {
          this.warnCorruptLine();
        }
        return true;
      });
    } finally {
      await handle.close();
    }
    return count;
  }

  private async endsWithNewline(size: number): Promise<boolean> {
    const handle = await fs.open(this.eventsFilePath, "r");
    try {
      const buffer = Buffer.alloc(1);
      await handle.read(buffer, 0, 1, size - 1);
      return buffer[0] === 0x0a;
    } finally {
      await handle.close();
    }
  }

  private async readMeta(): Promise<JournalMeta | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.metaFilePath, "utf-8")) as JournalMeta;
      if (parsed.schemaVersion !== META_SCHEMA_VERSION) return null;
      // Counts and offsets must be sane non-negative integers — a mangled
      // sidecar must degrade to a rescan, never to a negative count or a
      // fractional read position.
      if (!Number.isInteger(parsed.totalEvents) || parsed.totalEvents < 0) return null;
      if (!Number.isInteger(parsed.byteLength) || parsed.byteLength < 0) return null;
      if (parsed.lastEventId !== null && typeof parsed.lastEventId !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async writeMeta(): Promise<void> {
    const meta: JournalMeta = {
      schemaVersion: META_SCHEMA_VERSION,
      eventSchemaVersion: EVENT_SCHEMA_VERSION,
      totalEvents: this.totalEvents,
      byteLength: this.byteLength,
      lastEventId: this.lastEventId,
    };
    // Write-then-rename so a crash can never leave a torn sidecar.
    const tempPath = `${this.metaFilePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(meta));
    await fs.rename(tempPath, this.metaFilePath);
  }
}
