import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import {
  createZstdDecompress,
  constants as zlibConstants,
  zstdCompress,
  zstdDecompress,
} from "node:zlib";
import { ExecutionLayout } from "../execution-layout.js";
import { EVENTS_META_FILE } from "./event-storage.js";

/**
 * Finalize-time journal diet (events.jsonl diet P4).
 *
 * Once a run is finished its journal never gets appended to again, so at run
 * end file bodies at or above the threshold move out of the journal into a
 * per-run content-addressed store and the remaining pointer journal is
 * compressed whole:
 *
 *   .hankweave/events/
 *     events.jsonl.zst               pointer journal, zstd -3, whole-file
 *     journal.meta.json              diet manifest incl. originalSha256
 *     cas/<sha256-first2>/<sha>.zst  unique bodies, raw bytes, zstd -19
 *
 * The non-negotiable contract: `restoreJournal` rebuilds the original
 * events.jsonl BYTE-FOR-BYTE, proven by SHA-256. To guarantee that, the diet
 * only rewrites a line after proving the rewrite inverts to the exact
 * original bytes (per line, at diet time), and the whole diet is verified
 * from disk (decompress + rehydrate → sha256 equals original) before the
 * original is unlinked. Lines that do not provably round-trip stay inline —
 * correctness over compression.
 *
 * Everything here is pure functions over an events directory (no runtime
 * state), so the shutdown hook and the `--restore-journal` CLI share it.
 */

/** Bump when journal.meta.json's shape changes; older files are rejected. */
export const DIET_META_SCHEMA_VERSION = 1;
/** Bump when the on-disk diet layout changes (CAS layout, compression). */
export const DIET_VERSION = 1;
/** Bodies below this many bytes stay inline (threshold sweep was flat). */
export const JOURNAL_DIET_DEFAULT_THRESHOLD_BYTES = 4096;

const JOURNAL_ZSTD_LEVEL = 3;
const CAS_ZSTD_LEVEL = 19;

/**
 * Restore temps this process is actively publishing. cleanStrayDietTmp
 * spares them so two concurrent same-process restores cannot delete each
 * other's temp; own-pid temps NOT in this set are leftovers from a crashed
 * prior boot that recycled our pid, and are swept.
 */
const activeRestoreTmps = new Set<string>();

/**
 * runtime.lock paths THIS process currently holds. Distinguishes a live
 * in-process sibling (own pid AND registered — e.g. two runtimes in one test
 * process) from a recycled leftover (own pid, NOT registered — e.g. a
 * restarted PID-1 container meeting its dead predecessor's lock). The
 * runtime registers on lock creation and releases on lock removal.
 */
const processOwnedLocks = new Map<string, string>();

/**
 * Filesystem identity, not lexical: symlinked or case-aliased paths to the
 * same file must map to one registry key, or an alias would read a
 * registered path as unregistered. Falls back to canonicalizing the parent
 * directory when the file itself does not exist (a temp about to be
 * written, a lock released after unlink).
 */
function canonicalFilePath(filePath: string): string {
  try {
    return fsSync.realpathSync(filePath);
  } catch {
    try {
      return path.join(fsSync.realpathSync(path.dirname(filePath)), path.basename(filePath));
    } catch {
      return path.resolve(filePath);
    }
  }
}

/** Record that this process's runtime holds lockPath, under its ownerToken. */
export function registerProcessOwnedLock(lockPath: string, ownerToken: string): void {
  processOwnedLocks.set(canonicalFilePath(lockPath), ownerToken);
}

/**
 * Release by TOKEN, not path: a dangling-symlink lock can register under its
 * target realpath and later fail to re-derive that key once the link is
 * gone, so path-keyed release would leak the entry forever.
 */
export function releaseProcessOwnedLock(ownerToken: string): void {
  for (const [key, token] of processOwnedLocks) {
    if (token === ownerToken) processOwnedLocks.delete(key);
  }
}

export function isProcessOwnedLock(lockPath: string): boolean {
  return processOwnedLocks.has(canonicalFilePath(lockPath));
}

const EVENTS_FILE = "events.jsonl";
const DIETED_JOURNAL_FILE = "events.jsonl.zst";
const DIET_META_FILE = "journal.meta.json";
const CAS_DIR = "cas";

/**
 * Manifest for a dieted run. Supersedes the advisory events.meta.json for
 * finalized runs; `originalSha256` is the restore proof target.
 */
export interface JournalDietMeta {
  schemaVersion: number;
  dietVersion: number;
  /** Published event payload contract version, carried over from events.meta.json. */
  eventSchemaVersion?: number;
  totalEvents: number;
  originalSha256: string;
  originalBytes: number;
  segments: Array<{ id: number; events: number }>;
  dietedAt: string;
}

export interface DietReport {
  /** False when the directory was already dieted (no-op). */
  dieted: boolean;
  alreadyDieted: boolean;
  eventsDir: string;
  totalEvents: number;
  originalBytes: number;
  originalSha256: string;
  /** Journal lines rewritten to CAS pointers. */
  extractedBodies: number;
  /** Distinct bodies stored in the CAS. */
  uniqueCasBodies: number;
  /** Compressed on-disk size of the CAS. */
  casBytes: number;
  /** Compressed size of events.jsonl.zst. */
  journalBytes: number;
  /** journalBytes + casBytes + manifest size — the run's post-diet weight. */
  dietedBytes: number;
}

export interface RestoreReport {
  /** False when events.jsonl already existed and verified (no-op). */
  restored: boolean;
  alreadyRestored: boolean;
  eventsDir: string;
  bytes: number;
  sha256: string;
}

interface DietPaths {
  eventsFile: string;
  dietedJournal: string;
  dietedJournalTmp: string;
  meta: string;
  metaTmp: string;
  eventsMeta: string;
  casDir: string;
}

function dietPaths(eventsDir: string): DietPaths {
  return {
    eventsFile: path.join(eventsDir, EVENTS_FILE),
    dietedJournal: path.join(eventsDir, DIETED_JOURNAL_FILE),
    dietedJournalTmp: path.join(eventsDir, `${DIETED_JOURNAL_FILE}.tmp`),
    meta: path.join(eventsDir, DIET_META_FILE),
    metaTmp: path.join(eventsDir, `${DIET_META_FILE}.tmp`),
    eventsMeta: path.join(eventsDir, EVENTS_META_FILE),
    casDir: path.join(eventsDir, CAS_DIR),
  };
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// Async zstd: compression runs on the libuv threadpool, so the event loop —
// and with it the shutdown watchdog timer — keeps ticking while a large body
// is being squeezed at level 19. The sync variants would let one compression
// blow through the watchdog deadline unobserved.
const zstdCompressAsync = promisify(zstdCompress);
const zstdDecompressAsync = promisify(zstdDecompress);

function compress(data: Buffer, level: number): Promise<Buffer> {
  return zstdCompressAsync(data, {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: level },
  });
}

function decompress(data: Buffer): Promise<Buffer> {
  return zstdDecompressAsync(data);
}

/**
 * True when the directory holds a completed diet: the original journal is
 * gone and the diet pair (compressed journal + manifest) is present. A
 * directory where events.jsonl still exists is NOT dieted, whatever else is
 * there — the original is always the source of truth while it exists.
 */
export function isDietedEventsDir(eventsDir: string): boolean {
  const p = dietPaths(eventsDir);
  return (
    !fsSync.existsSync(p.eventsFile) &&
    fsSync.existsSync(p.dietedJournal) &&
    fsSync.existsSync(p.meta)
  );
}

/**
 * Boot-path auto-restore: a runtime starting or resuming on a dieted
 * directory rehydrates the journal in place (verified byte-identical) and
 * proceeds, instead of refusing. Damaged diet artifacts still fail the boot —
 * running against a hole is worse than not running.
 *
 * The diet pair (events.jsonl.zst + journal.meta.json) is pruned after the
 * restore: the runtime is about to append, so the manifest would describe a
 * journal that no longer exists — a stale manifest turns a later
 * `--restore-journal` into a confusing "refusing to overwrite" failure. The
 * CAS is kept: entries are content-addressed and verified on reuse, so the
 * run's next diet deduplicates against them for free.
 *
 * Returns the restore report, or null when the directory was not dieted.
 */
/**
 * Refuse to mutate an events directory whose runtime.lock names a live
 * process — the owner may be mid-run, or mid-shutdown with its finalize diet
 * in flight (promotion → unlink), and touching the journal in that window
 * loses data. Same fail-closed posture as the --diet-journal CLI: a lock we
 * cannot parse refuses too, because liveness is unknown. ESRCH is the only
 * proof of death; EPERM means alive under another uid.
 */
function assertNoLiveJournalOwner(
  executionPath: string,
  action: string,
  options: {
    /**
     * Pass a foreign LIVE pid whose heartbeat is parseably stale. Safe only
     * where a stalled owner cannot be mid-mutation of what we are about to
     * touch — the restore path qualifies (a dieted directory means the
     * owner's journal was already closed and dieted; a live-but-stalled or
     * pid-recycled "owner" would otherwise wedge auto-restore forever,
     * since the boot refusal fires before start()'s stale-lock recovery).
     * The stale-pair prune path must stay strict: that shape can be a
     * finalize diet mid-promotion.
     */
    allowStaleOwner?: boolean;
  } = {},
): void {
  const lockPath = new ExecutionLayout(executionPath).lockPath;
  let raw: string;
  try {
    raw = fsSync.readFileSync(lockPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return; // No lock — no owner.
    }
    // Present but unreadable (EACCES/EIO): liveness unknown — fail closed,
    // same as an unparseable lock. Only ENOENT means "no owner".
    throw new Error(
      `Journal ${action}: ${lockPath} exists but could not be read ` +
        `(${(error as Error).message}) — owner liveness is unknown, refusing.`,
    );
  }
  let pid: number | null = null;
  let heartbeatStale = false;
  try {
    const parsed = JSON.parse(raw) as unknown;
    // Only a POSITIVE integer is a pid: on POSIX, kill(-n, 0) probes process
    // GROUP n, so negative garbage must never reach the liveness check.
    if (parsed && typeof parsed === "object") {
      const info = parsed as Record<string, unknown>;
      const candidate = info.pid;
      if (typeof candidate === "number" && Number.isInteger(candidate) && candidate > 0) {
        pid = candidate;
      }
      if (typeof info.lastHeartbeat === "string") {
        const age = Date.now() - new Date(info.lastHeartbeat).getTime();
        // Unparseable heartbeat stays non-stale (fail closed).
        heartbeatStale = !Number.isNaN(age) && age > 120000;
      }
    } else if (typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0) {
      pid = parsed; // Legacy bare-pid lock parses as a JSON number.
    }
  } catch {
    const bare = Number(raw.trim());
    if (Number.isInteger(bare) && bare > 0) pid = bare;
  }
  if (pid === null) {
    throw new Error(
      `Journal ${action}: ${lockPath} exists but could not be parsed, so owner liveness is ` +
        `unknown — refusing. Remove the lock file if the runtime is not running.`,
    );
  }
  if (pid === process.pid) {
    if (isProcessOwnedLock(lockPath)) {
      // We wrote this lock: a live runtime in THIS process owns the
      // directory (two in-process runtimes, as integration tests do).
      throw new Error(
        `Journal ${action}: this process already holds ${lockPath} — refusing to touch a ` +
          `directory its own live runtime owns.`,
      );
    }
    if (heartbeatStale) {
      // A dead predecessor whose pid we recycled wrote it (classically: a
      // restarted PID-1 container) and its heartbeat has lapsed — kill(0)
      // on ourselves would read "alive" forever, so pass it through.
      return;
    }
    // Own pid, unregistered, but the heartbeat is fresh or unknown: this
    // may be a live incumbent in ANOTHER pid namespace sharing the volume
    // (both containers are PID 1) — pid identity proves nothing across
    // namespaces. Refuse; a genuine recycled leftover goes stale within
    // two minutes and then passes.
    throw new Error(
      `Journal ${action}: ${lockPath} names this process's pid but was not written by it, ` +
        `and its heartbeat is not stale — a live owner in another pid namespace may hold it. ` +
        `Retry after its heartbeat lapses, or remove the lock file if no runtime is running.`,
    );
  }
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
  if (alive) {
    if (options.allowStaleOwner && heartbeatStale) {
      // Live pid, lapsed heartbeat: a stalled owner or a recycled pid. The
      // caller vouched that a stalled owner cannot be mid-mutation here.
      return;
    }
    throw new Error(
      `Journal ${action}: a live runtime (PID: ${pid}) holds ${lockPath} — refusing to touch ` +
        `its event journal.`,
    );
  }
}

export async function ensureJournalRestored(
  executionPath: string,
  log: (message: string) => void = () => {},
): Promise<RestoreReport | null> {
  const eventsDir = new ExecutionLayout(executionPath).eventsDir;
  const p = dietPaths(eventsDir);
  const hasJournal = fsSync.existsSync(p.eventsFile);
  const hasZst = fsSync.existsSync(p.dietedJournal);
  const hasMeta = fsSync.existsSync(p.meta);

  if (hasJournal) {
    // While a VALID events.jsonl exists it is the source of truth, so a diet
    // pair beside it is stale — a crash between a restore's rename and its
    // prune, or between a diet's meta rename and its unlink. Finish the
    // prune here: leaving the pair invites a later --restore-journal to
    // refuse with "does not match the dieted original" once the journal
    // diverges. UNLESS a live owner holds the directory (a finalize diet
    // mid-promotion — the pair is about to become the only copy), or the
    // journal node cannot be PROVEN to carry the pair's content: deleting
    // the verified restorable copy on the say-so of an unvalidated node
    // (truncated write, junk, a directory or FIFO squatting the name)
    // would discard the only good journal.
    if (hasZst || hasMeta) {
      assertNoLiveJournalOwner(executionPath, "boot cleanup");
      const stat = await fs.lstat(p.eventsFile).catch(() => null);
      if (!stat?.isFile()) {
        throw new Error(
          `Journal boot cleanup: ${p.eventsFile} exists but is not a regular file, and diet ` +
            `artifacts sit beside it — refusing to choose. Inspect the directory by hand.`,
        );
      }
      if (hasMeta) {
        // The manifest must itself be a regular file before it is READ — a
        // FIFO (or symlink to a special file) squatting the name would hang
        // the read forever instead of refusing.
        const metaStat = await fs.lstat(p.meta).catch(() => null);
        if (!metaStat?.isFile()) {
          throw new Error(
            `Journal boot cleanup: ${p.meta} exists but is not a regular file, and a live ` +
              `${EVENTS_FILE} sits beside it — refusing to choose. Inspect the directory by hand.`,
          );
        }
        const meta = await readJournalDietMeta(eventsDir);
        const journalSha = sha256Hex(await fs.readFile(p.eventsFile));
        if (!meta || journalSha !== meta.originalSha256) {
          throw new Error(
            `Journal boot cleanup: ${EVENTS_FILE} in ${eventsDir} does not match the diet ` +
              `manifest beside it (${journalSha} vs ${meta?.originalSha256 ?? "unparseable meta"}) ` +
              `— one of them is damaged or foreign. Refusing to delete either; inspect by hand ` +
              `(hankweave --restore-journal can rebuild from the pair after removing the ` +
              `mismatched ${EVENTS_FILE}).`,
          );
        }
      }
      // Proven duplicate content (or an orphan zst that is unrestorable
      // without a manifest anyway) — the pair is safe to drop.
      await fs.rm(p.dietedJournal, { force: true });
      await fs.rm(p.meta, { force: true });
      log(
        "Removed a stale diet pair found beside the live events.jsonl " +
          "(verified duplicate of the journal; interrupted prune or diet)",
      );
    }
    return null;
  }

  // No journal: either a fresh directory, a complete diet, or damage. Half a
  // diet pair is damage — booting on would create an empty events.jsonl OVER
  // recoverable history (the surviving artifact), and the next finalize diet
  // would then overwrite that artifact from the empty journal.
  if (hasZst !== hasMeta) {
    const present = hasZst ? DIETED_JOURNAL_FILE : DIET_META_FILE;
    const missing = hasZst ? DIET_META_FILE : DIETED_JOURNAL_FILE;
    throw new Error(
      `Journal restore: ${eventsDir} has ${present} but no ${missing} and no ${EVENTS_FILE} — ` +
        `incomplete diet artifacts. Refusing to boot and bury recoverable history; ` +
        `inspect the directory before removing the leftover artifact.`,
    );
  }
  if (!hasZst) return null; // Fresh directory — nothing journaled yet.

  // Both artifacts must be regular files before anything READS them — a
  // FIFO or special-file symlink squatting either name would hang the
  // restore's reads forever instead of refusing.
  for (const artifact of [p.dietedJournal, p.meta]) {
    const stat = await fs.lstat(artifact).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(
        `Journal auto-restore: ${artifact} exists but is not a regular file — refusing to ` +
          `read it. Inspect the directory by hand.`,
      );
    }
  }

  assertNoLiveJournalOwner(executionPath, "auto-restore", { allowStaleOwner: true });
  const report = await restoreJournal(eventsDir);
  // Prune the now-stale pair — but only while the journal we just published
  // is still on disk. If a concurrent actor re-dieted in the gap (unlinking
  // events.jsonl), these artifacts are the ONLY copy again and must stay.
  if (fsSync.existsSync(p.eventsFile)) {
    await fs.rm(p.dietedJournal, { force: true });
    await fs.rm(p.meta, { force: true });
    log(
      `Event journal was dieted (compressed at a previous run's end); restored ` +
        `${report.bytes} bytes in place (sha256-verified) and pruned the stale diet pair`,
    );
  }
  return report;
}

/** Read + validate journal.meta.json; null when absent or unusable. */
export async function readJournalDietMeta(eventsDir: string): Promise<JournalDietMeta | null> {
  const p = dietPaths(eventsDir);
  let parsed: JournalDietMeta;
  try {
    parsed = JSON.parse(await fs.readFile(p.meta, "utf-8")) as JournalDietMeta;
  } catch {
    return null;
  }
  if (parsed.schemaVersion !== DIET_META_SCHEMA_VERSION) return null;
  if (parsed.dietVersion !== DIET_VERSION) return null;
  if (!Number.isInteger(parsed.totalEvents) || parsed.totalEvents < 0) return null;
  if (!Number.isInteger(parsed.originalBytes) || parsed.originalBytes < 0) return null;
  if (typeof parsed.originalSha256 !== "string" || !/^[0-9a-f]{64}$/.test(parsed.originalSha256)) {
    return null;
  }
  return parsed;
}

/**
 * Remove stray temp files from a crashed diet/restore. Safe to call any
 * time: temp files are never the source of truth.
 */
export async function cleanStrayDietTmp(eventsDir: string): Promise<void> {
  const p = dietPaths(eventsDir);
  for (const tmp of [p.dietedJournalTmp, p.metaTmp]) {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
  // Restore temps carry a per-process suffix (events.jsonl.tmp-<pid>-<rand>);
  // sweep by prefix, which also covers the historical fixed name. A temp
  // whose embedded pid is a live foreign process belongs to a restore in
  // flight — leave it, or that restore's link() publish fails on a file we
  // just deleted. Own-pid temps are swept unless registered as active
  // (two concurrent same-process restores must not eat each other's temp;
  // a crashed prior boot that recycled our pid still gets cleaned).
  try {
    for (const entry of await fs.readdir(eventsDir)) {
      if (!entry.startsWith(`${EVENTS_FILE}.tmp`)) continue;
      const fullPath = path.join(eventsDir, entry);
      const ownerPid = Number(entry.match(/\.tmp-(\d+)-/)?.[1]);
      if (Number.isInteger(ownerPid)) {
        // This process's in-flight temps are registered — always spared.
        if (activeRestoreTmps.has(canonicalFilePath(fullPath))) continue;
        // For everything else AGE is the only trustworthy signal: pid
        // numbers are namespace-local and recyclable in both directions (a
        // live-looking pid may be an unrelated process squatting a dead
        // owner's number; a dead-looking pid may be a live restore in
        // another namespace). Young temps are spared as possibly in flight;
        // old ones are provably abandoned — no restore publishes for 10
        // minutes — and swept regardless of pid liveness.
        try {
          const age = Date.now() - (await fs.stat(fullPath)).mtimeMs;
          if (age < 10 * 60 * 1000) continue;
        } catch {
          continue; // Vanished concurrently — nothing to sweep.
        }
      }
      await fs.rm(fullPath, { force: true }).catch(() => {});
    }
  } catch {
    // Directory unreadable/absent — nothing to sweep.
  }
  // CAS temp files carry a ".tmp-" suffix (see writeCasBody).
  let shards: string[];
  try {
    shards = await fs.readdir(p.casDir);
  } catch {
    return;
  }
  for (const shard of shards) {
    const shardDir = path.join(p.casDir, shard);
    let entries: string[];
    try {
      entries = await fs.readdir(shardDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.includes(".tmp-")) {
        await fs.rm(path.join(shardDir, entry), { force: true }).catch(() => {});
      }
    }
  }
}

// -------------
// Line transforms
// -------------

/**
 * The journal file is treated as parts joined by "\n" (0x0A). This
 * representation is byte-exact: joining `parts` with "\n" reproduces the
 * file, including blank lines and a torn (unterminated) final line.
 */
function splitParts(data: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  while (true) {
    const idx = data.indexOf(0x0a, start);
    if (idx === -1) {
      parts.push(data.subarray(start));
      return parts;
    }
    parts.push(data.subarray(start, idx));
    start = idx + 1;
  }
}

function joinParts(parts: Buffer[]): Buffer {
  const newline = Buffer.from("\n");
  const pieces: Buffer[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) pieces.push(newline);
    pieces.push(parts[i]);
  }
  return Buffer.concat(pieces);
}

/** Rebuild an object with `oldKey` replaced by `newKey: value` in place, preserving key order. */
function replaceKey(
  obj: Record<string, unknown>,
  oldKey: string,
  newKey: string,
  value: unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === oldKey) {
      out[newKey] = value;
    } else {
      out[k] = v;
    }
  }
  return out;
}

interface BodySite {
  /** The inline body string. */
  content: string;
  /** Rebuild the event with the body replaced by a contentRef. */
  toPointer: (contentRef: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Locate the inline file body in a parsed event, if any. Exactly the two
 * body-carrying shapes from the investigation: `file.updated`'s
 * `data.content` and `state.snapshot`'s `data.recentFileAccess.content`.
 */
function findInlineBody(event: Record<string, unknown>): BodySite | null {
  const data = event.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return null;

  if (event.type === "file.updated" && typeof data.content === "string") {
    const content = data.content;
    return {
      content,
      toPointer: (contentRef) => ({
        ...event,
        data: replaceKey(data, "content", "contentRef", contentRef),
      }),
    };
  }

  if (event.type === "state.snapshot") {
    const rfa = data.recentFileAccess as Record<string, unknown> | undefined;
    if (rfa && typeof rfa === "object" && typeof rfa.content === "string") {
      const content = rfa.content;
      return {
        content,
        toPointer: (contentRef) => ({
          ...event,
          data: {
            ...data,
            recentFileAccess: replaceKey(rfa, "content", "contentRef", contentRef),
          },
        }),
      };
    }
  }

  return null;
}

/** Locate a CAS pointer in a parsed event, if any (inverse of findInlineBody). */
function findCasPointer(
  event: Record<string, unknown>,
): { sha256: string; toInline: (content: string) => Record<string, unknown> } | null {
  const data = event.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return null;

  const isCasRef = (ref: unknown): ref is Record<string, unknown> =>
    typeof ref === "object" &&
    ref !== null &&
    (ref as Record<string, unknown>).ref === "cas" &&
    typeof (ref as Record<string, unknown>).sha256 === "string";

  if (event.type === "file.updated" && isCasRef(data.contentRef)) {
    const sha256 = (data.contentRef as Record<string, unknown>).sha256 as string;
    return {
      sha256,
      toInline: (content) => ({
        ...event,
        data: replaceKey(data, "contentRef", "content", content),
      }),
    };
  }

  if (event.type === "state.snapshot") {
    const rfa = data.recentFileAccess as Record<string, unknown> | undefined;
    if (rfa && typeof rfa === "object" && isCasRef(rfa.contentRef)) {
      const sha256 = (rfa.contentRef as Record<string, unknown>).sha256 as string;
      return {
        sha256,
        toInline: (content) => ({
          ...event,
          data: {
            ...data,
            recentFileAccess: replaceKey(rfa, "contentRef", "content", content),
          },
        }),
      };
    }
  }

  return null;
}

/**
 * Rehydrate one pointer line back to its inline form. Lines that don't parse
 * or carry no CAS pointer pass through unchanged. Throws when a referenced
 * body is missing from the lookup — a diet must never verify against a hole.
 */
function rehydrateLineString(line: string, lookupBody: (sha256: string) => string | null): string {
  const trimmed = line.trim();
  if (trimmed.length === 0) return line;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line;
  }
  if (typeof event !== "object" || event === null) return line;
  const pointer = findCasPointer(event);
  if (!pointer) return line;
  const body = lookupBody(pointer.sha256);
  if (body === null) {
    throw new Error(`Journal restore: CAS body ${pointer.sha256} is missing`);
  }
  return JSON.stringify(pointer.toInline(body));
}

interface DietedLine {
  pointer: Buffer;
  bodyBuf: Buffer;
  bodyStr: string;
  sha256: string;
}

/**
 * Try to rewrite one journal line to a CAS pointer. Returns null whenever
 * ANY step fails to prove byte-exact invertibility:
 *  - the line isn't valid UTF-8 that re-encodes to the same bytes,
 *  - it doesn't parse, or carries no inline body at/above the threshold,
 *  - the pointer line does not rehydrate to the exact original bytes.
 */
function tryDietLine(lineBuf: Buffer, thresholdBytes: number): DietedLine | null {
  if (lineBuf.length < thresholdBytes) return null;
  const lineStr = lineBuf.toString("utf-8");
  if (!Buffer.from(lineStr, "utf-8").equals(lineBuf)) return null;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(lineStr) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof event !== "object" || event === null) return null;

  const site = findInlineBody(event);
  if (!site) return null;
  const bodyBuf = Buffer.from(site.content, "utf-8");
  if (bodyBuf.length < thresholdBytes) return null;

  const sha256 = sha256Hex(bodyBuf);
  const contentRef = {
    sha256,
    bytes: bodyBuf.length,
    encoding: "utf-8",
    ref: "cas",
  };
  const pointerStr = JSON.stringify(site.toPointer(contentRef));

  // Invertibility proof: the pointer must rehydrate to the exact original
  // bytes. Any oddity (foreign writer, exotic escapes, duplicate keys)
  // fails here and the line simply stays inline.
  const roundTripped = rehydrateLineString(pointerStr, (sha) =>
    sha === sha256 ? site.content : null,
  );
  if (roundTripped !== lineStr) return null;

  return { pointer: Buffer.from(pointerStr, "utf-8"), bodyBuf, bodyStr: site.content, sha256 };
}

// -------------
// CAS
// -------------

function casBodyPath(casDir: string, sha256: string): string {
  return path.join(casDir, sha256.slice(0, 2), `${sha256}.zst`);
}

/** Write one body to the CAS (idempotent); returns its compressed on-disk size. */
async function writeCasBody(casDir: string, sha256: string, body: Buffer): Promise<number> {
  const target = casBodyPath(casDir, sha256);
  // Reuse an existing entry only after proving it decompresses to the right
  // bytes. A truncated/corrupt leftover (from a crash, or disk damage) must
  // be overwritten from the authoritative inline body we hold right now —
  // otherwise every re-diet of a restored journal fails verification forever
  // on an entry the journal itself could repair.
  try {
    const existing = await fs.readFile(target);
    const decompressed = await decompress(existing);
    if (sha256Hex(decompressed) === sha256) {
      return existing.length;
    }
  } catch {
    // Absent or unreadable/corrupt — (re)write below.
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const compressed = await compress(body, CAS_ZSTD_LEVEL);
  const tmp = `${target}.tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  await fs.writeFile(tmp, compressed);
  await fs.rename(tmp, target);
  return compressed.length;
}

/** Read + verify one body from the CAS; null when absent. */
async function readCasBody(casDir: string, sha256: string): Promise<string | null> {
  let compressed: Buffer;
  try {
    compressed = await fs.readFile(casBodyPath(casDir, sha256));
  } catch {
    return null;
  }
  const body = await decompress(compressed);
  const actual = sha256Hex(body);
  if (actual !== sha256) {
    throw new Error(
      `Journal restore: CAS body ${sha256} is corrupt on disk (content hashes to ${actual})`,
    );
  }
  return body.toString("utf-8");
}

// -------------
// Rehydration (shared by verify, restore, and transparent reads)
// -------------

/**
 * Rebuild the logical journal bytes from a pointer-journal buffer plus a
 * body lookup. Untouched lines pass through verbatim, so the result is
 * byte-identical to the pre-diet journal by construction.
 */
/**
 * Rehydrate one journal part (a line without its newline). Untouched parts
 * come back as the same buffer, so byte-identity is preserved by
 * construction — including non-UTF-8 bytes, which never hit the parser.
 */
async function rehydratePart(
  part: Buffer,
  lookupBody: (sha256: string) => Promise<string | null>,
): Promise<Buffer> {
  const str = part.toString("utf-8");
  // Fast path: a line that can't hold a CAS pointer passes through as-is.
  if (!str.includes('"cas"')) return part;

  const bodies = new Map<string, string | null>();
  // rehydrateLineString is sync; prefetch the (single) referenced body.
  let parsedEvent: Record<string, unknown> | null = null;
  try {
    parsedEvent = JSON.parse(str) as Record<string, unknown>;
  } catch {
    parsedEvent = null;
  }
  if (parsedEvent && typeof parsedEvent === "object") {
    const pointer = findCasPointer(parsedEvent);
    if (pointer) {
      bodies.set(pointer.sha256, await lookupBody(pointer.sha256));
    }
  }
  const rehydrated = rehydrateLineString(str, (sha) => bodies.get(sha) ?? null);
  return rehydrated === str ? part : Buffer.from(rehydrated, "utf-8");
}

async function rehydrateBuffer(
  pointerJournal: Buffer,
  lookupBody: (sha256: string) => Promise<string | null>,
): Promise<Buffer> {
  const parts = splitParts(pointerJournal);
  const out: Buffer[] = [];
  for (const part of parts) {
    out.push(await rehydratePart(part, lookupBody));
  }
  return joinParts(out);
}

/**
 * Rebuild the logical (pre-diet) journal bytes of a dieted directory in
 * memory. Used by verify (during the diet) and restore, where the whole
 * journal is needed at once anyway; per-run journals are tens of MB. For
 * streaming consumers use `createDietedJournalReadStream`, and for
 * line-at-a-time reads use `rehydrateDietedLine`.
 */
export async function rehydrateDietedJournal(eventsDir: string): Promise<Buffer> {
  const p = dietPaths(eventsDir);
  const pointerJournal = await decompress(await fs.readFile(p.dietedJournal));
  return rehydrateBuffer(pointerJournal, (sha) => readCasBody(p.casDir, sha));
}

/**
 * Decompress a dieted directory's POINTER journal (bodies stay in the CAS).
 * Cheap relative to full rehydration; callers rehydrate individual lines on
 * demand via `rehydrateDietedLine`.
 */
export async function readDietedPointerJournal(eventsDir: string): Promise<Buffer> {
  const p = dietPaths(eventsDir);
  return decompress(await fs.readFile(p.dietedJournal));
}

/** Rehydrate one pointer-journal line of a dieted directory on demand. */
export async function rehydrateDietedLine(eventsDir: string, line: string): Promise<string> {
  const p = dietPaths(eventsDir);
  const out = await rehydratePart(Buffer.from(line, "utf-8"), (sha) => readCasBody(p.casDir, sha));
  return out.toString("utf-8");
}

/**
 * Stream the logical (pre-diet) journal bytes of a dieted directory without
 * ever materializing the whole journal: the compressed pointer journal is
 * decompressed as a stream and each line is rehydrated as it passes.
 * Memory is bounded by the largest single line plus one CAS body.
 */
export function createDietedJournalReadStream(eventsDir: string): NodeJS.ReadableStream {
  const p = dietPaths(eventsDir);
  const lookup = (sha: string) => readCasBody(p.casDir, sha);

  async function* generate(): AsyncGenerator<Buffer> {
    const newline = Buffer.from("\n");
    const source = fsSync.createReadStream(p.dietedJournal);
    const unzstd = createZstdDecompress();
    source.on("error", (error) => unzstd.destroy(error));
    source.pipe(unzstd);

    let pending: Buffer = Buffer.alloc(0);
    for await (const chunk of unzstd) {
      const data = pending.length ? Buffer.concat([pending, chunk as Buffer]) : (chunk as Buffer);
      let start = 0;
      while (true) {
        const idx = data.indexOf(0x0a, start);
        if (idx === -1) break;
        yield await rehydratePart(data.subarray(start, idx), lookup);
        yield newline;
        start = idx + 1;
      }
      // Copy the remainder so the (possibly pooled) chunk can be released.
      pending = Buffer.from(data.subarray(start));
    }
    // Torn tail: never a complete line, emitted verbatim.
    if (pending.length > 0) yield pending;
  }

  return Readable.from(generate());
}

// -------------
// Diet
// -------------

/** Count parse-valid events among complete (newline-terminated) lines. */
function countEvents(parts: Buffer[]): number {
  // The final part is either "" (file ends in \n) or a torn line — never a
  // complete line, so it is never counted.
  let count = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const line = parts[i].toString("utf-8").trim();
    if (line.length === 0) continue;
    try {
      JSON.parse(line);
      count += 1;
    } catch {
      // Corrupt line: preserved verbatim, but it is not an event.
    }
  }
  return count;
}

/**
 * Diet a finished run's journal: extract large bodies to the CAS, compress
 * the pointer journal, write the manifest, verify the whole thing restores
 * byte-for-byte from disk, and only then unlink the original.
 *
 * Crash-safe: a crash at any point leaves either the intact original (temp
 * artifacts are advisory and cleaned on the next attempt) or a complete,
 * verified diet. Idempotent: dieting a dieted directory is a no-op.
 */
export async function dietJournal(
  eventsDir: string,
  options: {
    thresholdBytes?: number;
    /**
     * Runs after verification, just before promotion; throwing aborts the
     * diet with the original intact. The CLI uses it to re-check its
     * exclusivity claim; tests use it to inject concurrent writes.
     */
    beforePromote?: () => Promise<void> | void;
  } = {},
): Promise<DietReport> {
  const thresholdBytes = options.thresholdBytes ?? JOURNAL_DIET_DEFAULT_THRESHOLD_BYTES;
  const p = dietPaths(eventsDir);
  await cleanStrayDietTmp(eventsDir);

  let original: Buffer;
  try {
    original = await fs.readFile(p.eventsFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // No journal file. Either the directory is already dieted (no-op) or
    // there is nothing to diet.
    const meta = await readJournalDietMeta(eventsDir);
    if (meta && fsSync.existsSync(p.dietedJournal)) {
      // "Already dieted" must mean "already dieted AND restorable" —
      // otherwise a damaged .zst or CAS entry lets --diet-journal exit 0
      // while --restore-journal immediately fails. Prove the artifacts
      // still rehydrate to the recorded original before reporting no-op.
      let rehydratedSha: string;
      try {
        rehydratedSha = sha256Hex(await rehydrateDietedJournal(eventsDir));
      } catch (verifyError) {
        throw new Error(
          `Journal diet: ${eventsDir} looks dieted but its artifacts do not rehydrate ` +
            `(${(verifyError as Error).message}) — the diet is damaged, not complete`,
        );
      }
      if (rehydratedSha !== meta.originalSha256) {
        throw new Error(
          `Journal diet: ${eventsDir} looks dieted but rehydrates to ${rehydratedSha}, ` +
            `expected ${meta.originalSha256} — the diet is damaged, not complete`,
        );
      }
      const journalBytes = (await fs.stat(p.dietedJournal)).size;
      return {
        dieted: false,
        alreadyDieted: true,
        eventsDir,
        totalEvents: meta.totalEvents,
        originalBytes: meta.originalBytes,
        originalSha256: meta.originalSha256,
        extractedBodies: 0,
        uniqueCasBodies: 0,
        casBytes: await casDirSize(p.casDir),
        journalBytes,
        dietedBytes: journalBytes + (await casDirSize(p.casDir)) + (await fs.stat(p.meta)).size,
      };
    }
    throw new Error(`Journal diet: no ${EVENTS_FILE} in ${eventsDir} and no completed diet found`);
  }

  const originalSha256 = sha256Hex(original);
  const originalBytes = original.length;

  // Rewrite lines. The pointer file keeps the exact part structure of the
  // original, so untouched bytes (blank lines, corrupt lines, a torn tail)
  // survive verbatim.
  const parts = splitParts(original);
  const pointerParts: Buffer[] = [];
  const bodies = new Map<string, Buffer>();
  let extractedBodies = 0;
  for (let i = 0; i < parts.length; i++) {
    const isCompleteLine = i < parts.length - 1;
    const dieted = isCompleteLine ? tryDietLine(parts[i], thresholdBytes) : null;
    if (dieted) {
      pointerParts.push(dieted.pointer);
      if (!bodies.has(dieted.sha256)) bodies.set(dieted.sha256, dieted.bodyBuf);
      extractedBodies += 1;
    } else {
      pointerParts.push(parts[i]);
    }
  }
  const totalEvents = countEvents(parts);

  // Advisory sidecar: carry the event schema version into the diet manifest.
  let eventSchemaVersion: number | undefined;
  try {
    const sidecar = JSON.parse(await fs.readFile(p.eventsMeta, "utf-8")) as Record<string, unknown>;
    if (Number.isInteger(sidecar.eventSchemaVersion)) {
      eventSchemaVersion = sidecar.eventSchemaVersion as number;
    }
  } catch {
    // No sidecar — fine, it's advisory.
  }

  // 1. CAS first (content-addressed, idempotent, safe to leave behind).
  for (const [sha256, body] of bodies) {
    await writeCasBody(p.casDir, sha256, body);
  }

  // 2. Compressed pointer journal + manifest, as temp files.
  const pointerJournal = joinParts(pointerParts);
  const compressed = await compress(pointerJournal, JOURNAL_ZSTD_LEVEL);
  await fs.writeFile(p.dietedJournalTmp, compressed);

  const meta: JournalDietMeta = {
    schemaVersion: DIET_META_SCHEMA_VERSION,
    dietVersion: DIET_VERSION,
    ...(eventSchemaVersion !== undefined ? { eventSchemaVersion } : {}),
    totalEvents,
    originalSha256,
    originalBytes,
    segments: [{ id: 0, events: totalEvents }],
    dietedAt: new Date().toISOString(),
  };
  const metaJson = JSON.stringify(meta);
  await fs.writeFile(p.metaTmp, metaJson);

  // 3. Verify FROM DISK: what was actually written must restore to the
  //    original, byte-for-byte, before the original may be unlinked.
  const writtenPointer = await decompress(await fs.readFile(p.dietedJournalTmp));
  const rehydrated = await rehydrateBuffer(writtenPointer, (sha) => readCasBody(p.casDir, sha));
  const rehydratedSha = sha256Hex(rehydrated);
  if (rehydratedSha !== originalSha256) {
    await cleanStrayDietTmp(eventsDir);
    throw new Error(
      `Journal diet: verification failed for ${eventsDir} — rehydrated journal hashes to ` +
        `${rehydratedSha}, original is ${originalSha256}. Original left intact.`,
    );
  }

  await options.beforePromote?.();

  // 4. The journal must not have changed while the diet was running (a live
  //    runtime appending, or a resume racing the offline CLI, would make the
  //    verified diet a stale snapshot and lose the newer events on unlink).
  //    Re-read and compare right before promotion; this shrinks the race
  //    window from the whole extract+compress+verify span down to the final
  //    rename+unlink pair. Actual exclusion comes from the CLI's live-lock
  //    guard and from the runtime dieting only after its journal is closed.
  const currentBytes = await fs.readFile(p.eventsFile).catch(() => null);
  if (currentBytes === null || sha256Hex(currentBytes) !== originalSha256) {
    await cleanStrayDietTmp(eventsDir);
    throw new Error(
      `Journal diet: ${EVENTS_FILE} in ${eventsDir} changed while the diet was running — ` +
        `aborted, original left intact`,
    );
  }

  // 5. Promote atomically, then drop the original. A crash between these
  //    steps leaves original + verified diet side by side; the next diet run
  //    rebuilds deterministically from the original and finishes the unlink.
  await fs.rename(p.dietedJournalTmp, p.dietedJournal);
  await fs.rename(p.metaTmp, p.meta);
  await fs.rm(p.eventsFile, { force: true });
  await fs.rm(p.eventsMeta, { force: true });

  return {
    dieted: true,
    alreadyDieted: false,
    eventsDir,
    totalEvents,
    originalBytes,
    originalSha256,
    extractedBodies,
    uniqueCasBodies: bodies.size,
    casBytes: await casDirSize(p.casDir),
    journalBytes: compressed.length,
    dietedBytes: compressed.length + (await casDirSize(p.casDir)) + Buffer.byteLength(metaJson),
  };
}

async function casDirSize(casDir: string): Promise<number> {
  let total = 0;
  let shards: string[];
  try {
    shards = await fs.readdir(casDir);
  } catch {
    return 0;
  }
  for (const shard of shards) {
    const shardDir = path.join(casDir, shard);
    let entries: string[];
    try {
      entries = await fs.readdir(shardDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.includes(".tmp-")) continue;
      try {
        total += (await fs.stat(path.join(shardDir, entry))).size;
      } catch {
        // Removed concurrently.
      }
    }
  }
  return total;
}

// -------------
// Restore
// -------------

/**
 * Rebuild the original events.jsonl from a dieted directory and prove it:
 * the result's SHA-256 must equal the manifest's `originalSha256`, or the
 * restore fails without touching anything. The diet artifacts are kept —
 * restore is a view; re-dieting re-verifies as a no-op.
 */
export async function restoreJournal(eventsDir: string): Promise<RestoreReport> {
  const p = dietPaths(eventsDir);
  await cleanStrayDietTmp(eventsDir);

  const meta = await readJournalDietMeta(eventsDir);
  if (!meta) {
    throw new Error(
      `Journal restore: ${eventsDir} has no valid ${DIET_META_FILE} — not a dieted run directory`,
    );
  }

  // Already restored? Verify and report success instead of rewriting. Only
  // ENOENT means "absent" — any other read error (EACCES, EIO) must abort:
  // treating an unreadable-but-present journal as missing would let the
  // rename below silently clobber a file we could not even inspect.
  let existing: Buffer | null = null;
  try {
    existing = await fs.readFile(p.eventsFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    existing = null;
  }
  if (existing !== null) {
    const existingSha = sha256Hex(existing);
    if (existingSha !== meta.originalSha256) {
      throw new Error(
        `Journal restore: ${EVENTS_FILE} already exists in ${eventsDir} but does not match the ` +
          `dieted original (${existingSha} vs ${meta.originalSha256}). Refusing to overwrite it.`,
      );
    }
    return {
      restored: false,
      alreadyRestored: true,
      eventsDir,
      bytes: existing.length,
      sha256: existingSha,
    };
  }

  const rehydrated = await rehydrateDietedJournal(eventsDir);
  const sha = sha256Hex(rehydrated);
  if (sha !== meta.originalSha256) {
    throw new Error(
      `Journal restore: rehydrated journal hashes to ${sha}, expected ${meta.originalSha256} — ` +
        `the diet artifacts in ${eventsDir} are damaged`,
    );
  }

  // Publish create-if-absent: link() fails with EEXIST where rename() would
  // silently clobber. Two concurrent restores (or a restore racing a runtime
  // that already recreated and appended to the journal) must not replace a
  // live events.jsonl with an older snapshot — the loser re-verifies what
  // won instead. The temp name is per-process so concurrent writers cannot
  // interleave into each other's temp file.
  const restoreTmp = `${p.eventsFile}.tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  const restoreTmpKey = canonicalFilePath(restoreTmp);
  activeRestoreTmps.add(restoreTmpKey);
  try {
    await fs.writeFile(restoreTmp, rehydrated);
    try {
      await fs.link(restoreTmp, p.eventsFile);
    } catch (error) {
      // Filesystems without hard links (exFAT/FAT32, some SMB modes) cannot do
      // the create-if-absent publish; degrade to a checked rename. The check
      // shrinks the clobber window instead of eliminating it — the price of
      // the filesystem, not the default path.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EPERM") {
        if (fsSync.existsSync(p.eventsFile)) {
          await fs.rm(restoreTmp, { force: true }).catch(() => {});
          const current = await fs.readFile(p.eventsFile);
          const currentSha = sha256Hex(current);
          if (currentSha === meta.originalSha256) {
            return {
              restored: false,
              alreadyRestored: true,
              eventsDir,
              bytes: current.length,
              sha256: currentSha,
            };
          }
          throw new Error(
            `Journal restore: ${EVENTS_FILE} appeared in ${eventsDir} while restoring and does ` +
              `not match the dieted original (${currentSha} vs ${meta.originalSha256}). ` +
              `Refusing to overwrite it.`,
          );
        }
        await fs.rename(restoreTmp, p.eventsFile);
        return {
          restored: true,
          alreadyRestored: false,
          eventsDir,
          bytes: rehydrated.length,
          sha256: sha,
        };
      }
      await fs.rm(restoreTmp, { force: true }).catch(() => {});
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        const current = await fs.readFile(p.eventsFile);
        const currentSha = sha256Hex(current);
        if (currentSha === meta.originalSha256) {
          return {
            restored: false,
            alreadyRestored: true,
            eventsDir,
            bytes: current.length,
            sha256: currentSha,
          };
        }
        throw new Error(
          `Journal restore: ${EVENTS_FILE} appeared in ${eventsDir} while restoring and does ` +
            `not match the dieted original (${currentSha} vs ${meta.originalSha256}). ` +
            `Refusing to overwrite it.`,
        );
      }
      throw error;
    }
    await fs.rm(restoreTmp, { force: true }).catch(() => {});

    return {
      restored: true,
      alreadyRestored: false,
      eventsDir,
      bytes: rehydrated.length,
      sha256: sha,
    };
  } finally {
    activeRestoreTmps.delete(restoreTmpKey);
    // Best-effort: a write that failed mid-way (ENOSPC) must not strand a
    // large partial temp that an immediate retry then can't reclaim. On the
    // success paths the temp is already gone (unlinked or renamed) and this
    // is a no-op.
    await fs.rm(restoreTmp, { force: true }).catch(() => {});
  }
}
