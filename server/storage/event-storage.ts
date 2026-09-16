import type { ServerEvent } from "../schemas/event-schemas.js";
import { CURSOR_WORDS } from "./cursor-words.js";

/**
 * The live-run advisory sidecar FileEventStorage maintains next to
 * events.jsonl (event count + eventSchemaVersion). Defined here on the
 * storage contract so the diet (which carries its schema version into
 * journal.meta.json and deletes it at promotion) can share the name without
 * importing the storage implementation.
 */
export const EVENTS_META_FILE = "events.meta.json";

/**
 * One page of events from a cursor walk over the journal.
 */
export interface EventPage {
  events: ServerEvent[];
  /**
   * Opaque cursor addressing the position after the last line this page
   * consumed. Pass it back to `getEventsAfter` to resume; stable across
   * restarts because the journal is append-only.
   */
  nextCursor: string;
  /**
   * Whether at least one more complete line existed beyond this page at read
   * time. May over-report by one page when the trailing lines are corrupt;
   * a follow-up page then comes back empty with `hasMore: false`.
   */
  hasMore: boolean;
  /** Complete-but-unparseable lines skipped while producing this page. */
  corruptLines: number;
}

/**
 * Cursors encode `(segmentId, lineNo)` as five hyphen-joined words from the
 * frozen 512-entry CURSOR_WORDS list — base-512 digits, segment first. The
 * sorted vocabulary plus fixed word count make byte-wise token comparison
 * equal stream order (the offset contract Durable-Streams-style consumers
 * expect: compare freely, never parse), while the closed vocabulary makes a
 * fabricated or mistyped token fail validation instead of silently
 * addressing a wrong position. Today's single flat journal file is segment
 * 0; the segment id exists so segment rotation can slot in later without
 * changing any public shape. `lineNo` counts physical journal lines consumed
 * (including blank and corrupt lines) — never byte offsets, which would leak
 * the on-disk representation. Tokens are opaque to callers: mint with
 * encode, resume with decode, no arithmetic.
 */
const CURSOR_WORD_INDEX = new Map<string, number>(CURSOR_WORDS.map((word, i) => [word, i]));
const CURSOR_SEGMENTS = CURSOR_WORDS.length;
/** Lines addressable per segment (512^4); rotation must occur before this. */
const CURSOR_MAX_LINES = 2 ** 36;

export function encodeEventCursor(segmentId: number, lineNo: number): string {
  if (!Number.isInteger(segmentId) || segmentId < 0 || segmentId >= CURSOR_SEGMENTS) {
    throw new Error(`Event cursor segment out of range: ${segmentId}`);
  }
  if (!Number.isInteger(lineNo) || lineNo < 0 || lineNo >= CURSOR_MAX_LINES) {
    throw new Error(`Event cursor line out of range (rotate the segment): ${lineNo}`);
  }
  const digits = [
    segmentId,
    Math.floor(lineNo / 512 ** 3) % 512,
    Math.floor(lineNo / 512 ** 2) % 512,
    Math.floor(lineNo / 512) % 512,
    lineNo % 512,
  ];
  return digits.map((digit) => CURSOR_WORDS[digit]).join("-");
}

export function decodeEventCursor(cursor: string): { segmentId: number; lineNo: number } | null {
  const words = cursor.split("-");
  if (words.length !== 5) return null;
  const digits: number[] = [];
  for (const word of words) {
    const digit = CURSOR_WORD_INDEX.get(word);
    if (digit === undefined) return null;
    digits.push(digit);
  }
  const lineNo = digits[1] * 512 ** 3 + digits[2] * 512 ** 2 + digits[3] * 512 + digits[4];
  return { segmentId: digits[0], lineNo };
}

/**
 * Interface for event storage implementations.
 * Allows pluggable storage backends (memory, file-based, etc.)
 */
export interface IEventStorage {
  /**
   * Initialize the storage (required for some implementations like file-based storage)
   */
  initialize(): Promise<void>;

  /**
   * Append a new event to storage
   */
  append(event: ServerEvent): Promise<void>;

  /**
   * Append multiple events in bulk, optimized for large batches.
   * Implementations should ensure this is faster than calling append repeatedly.
   */
  appendMany(events: Iterable<ServerEvent>): Promise<void>;

  /**
   * Retrieve the most recent events in chronological order (oldest first)
   * along with the total number of events persisted. Unparseable journal
   * lines are skipped, not thrown, and reported via `corruptLines`.
   * @param limit Maximum number of events to return
   */
  getRecentEvents(limit: number): Promise<{
    events: ServerEvent[];
    totalEvents: number;
    corruptLines: number;
  }>;

  /**
   * Page forward through the journal from a cursor position. `null` starts
   * from the beginning. Corrupt lines are skipped (and counted), a torn
   * final line is never consumed, and the returned cursor resumes exactly
   * where this page stopped.
   */
  getEventsAfter(cursor: string | null, limit: number): Promise<EventPage>;

  /**
   * Get the total number of events in storage
   */
  getTotalEvents(): Promise<number>;

  /**
   * Create a readable stream of the underlying event log for download/streaming.
   */
  createReadStream(): Promise<NodeJS.ReadableStream>;

  /**
   * Flush and release any underlying resources. Appends after close reject;
   * close is idempotent.
   */
  close(): Promise<void>;
}
