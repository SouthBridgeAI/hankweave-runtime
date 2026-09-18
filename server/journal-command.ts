import fs from "node:fs";
import { ExecutionLayout } from "./execution-layout.js";

type RefuseJournalDiet = (why: string) => never;

function isPositivePid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parsedLockPid(parsed: unknown): number | undefined {
  if (isPositivePid(parsed)) return parsed;
  if (!parsed) return undefined;
  const pid = (parsed as { pid?: unknown }).pid;
  return isPositivePid(pid) ? pid : undefined;
}

function legacyLockPid(lockRaw: string | null): number | undefined {
  const trimmed = (lockRaw ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const bare = Number.parseInt(trimmed, 10);
  return bare > 0 ? bare : undefined;
}

function parseLockPid(lockRaw: string | null): number | undefined {
  try {
    return parsedLockPid(JSON.parse(lockRaw ?? ""));
  } catch {
    return legacyLockPid(lockRaw);
  }
}

function readJournalLock(lockPath: string, refuse: RefuseJournalDiet): string {
  try {
    return fs.readFileSync(lockPath, "utf-8");
  } catch {
    refuse("its runtime.lock exists but is unreadable");
  }
}

function assertStaleJournalLock(lockPid: number | undefined, refuse: RefuseJournalDiet): void {
  if (lockPid === undefined) {
    refuse("its runtime.lock could not be parsed, so liveness is unknown");
  }
  try {
    process.kill(lockPid, 0);
    refuse(`the execution appears to be running (pid ${lockPid} holds runtime.lock)`);
  } catch (error) {
    // Only ESRCH proves staleness; EPERM still means the process is alive.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      refuse(`pid ${lockPid} in runtime.lock appears to be alive`);
    }
  }
}

function readRenamedLock(stalePath: string): string | null {
  try {
    return fs.readFileSync(stalePath, "utf-8");
  } catch {
    return null;
  }
}

function restoreChangedLock(stalePath: string, lockPath: string): void {
  try {
    fs.renameSync(stalePath, lockPath);
  } catch {
    // Owner already re-created its lock; drop our copy.
    fs.rmSync(stalePath, { force: true });
  }
}

function removeStaleJournalLock(lockPath: string, refuse: RefuseJournalDiet): void {
  const lockRaw = readJournalLock(lockPath, refuse);
  // Current lock format is JSON {pid, ...}; the legacy format is a
  // bare numeric pid (exact — "123-corrupt" is NOT a legacy lock).
  // Anything else fails closed, matching the runtime's own
  // "Server already running" fallback for unparseable locks.
  // Only POSITIVE integers are pids: kill(-n, 0) probes process
  // GROUP n (and kill(0, 0) our own group), so zero/negative
  // garbage must fail closed, not read as a checkable pid.
  assertStaleJournalLock(parseLockPid(lockRaw), refuse);
  // Stale — remove it WITHOUT clobbering a lock that changed
  // hands after our liveness check: atomically rename the file
  // aside, confirm it is still the bytes we inspected, and only
  // then discard it. If a booting runtime replaced it in that
  // window, the rename captured the runtime's lock instead —
  // put it back and refuse.
  const stalePath = `${lockPath}.stale-${process.pid}`;
  try {
    fs.renameSync(lockPath, stalePath);
  } catch {
    refuse("its runtime.lock changed while being checked");
  }
  if (readRenamedLock(stalePath) !== lockRaw) {
    restoreChangedLock(stalePath, lockPath);
    refuse("its runtime.lock changed hands while being checked");
  }
  fs.rmSync(stalePath, { force: true });
}

function claimJournalLock(lockPath: string, ourLockPayload: () => string): void {
  // Atomic create-if-absent with full content: write a temp, then
  // link() it into place (EEXIST if someone else claimed first).
  // A plain "wx" write that failed midway (ENOSPC/EIO) would leave
  // a PARTIAL lock no later boot can parse — fail-closed guards
  // then refuse until it is deleted by hand.
  const claimTmp = `${lockPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(claimTmp, ourLockPayload());
    try {
      fs.linkSync(claimTmp, lockPath);
    } catch (linkError) {
      const code = (linkError as NodeJS.ErrnoException).code;
      if (["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(code ?? "")) {
        // Filesystems without hard links (exFAT/FAT32, some SMB):
        // fall back to exclusive-create. Partial-write risk on
        // failure is the price of the filesystem, not the default.
        fs.writeFileSync(lockPath, ourLockPayload(), { flag: "wx" });
      } else {
        throw linkError;
      }
    }
  } finally {
    fs.rmSync(claimTmp, { force: true });
  }
}

function acquireJournalDietLock(executionDir: string, layout: ExecutionLayout) {
  // Never diet under (or racing) a live runtime: its journal writer
  // would keep appending to the unlinked inode and those events would
  // be lost at close. The diet CLAIMS runtime.lock for its duration —
  // the same protocol a booting runtime honors ("Server already
  // running") — and fails CLOSED on any lock it cannot positively
  // identify as stale. (dietJournal additionally re-validates the
  // journal bytes and the lock's ownership right before promotion.)
  const lockPath = layout.lockPath;
  const refuse = (why: string): never => {
    console.error(
      `\nError: not dieting ${executionDir}: ${why}.\n` +
        `If you are certain no hankweave process is using this execution, ` +
        `remove ${lockPath} and retry.`,
    );
    process.exit(1);
  };
  const hasExecutionLayout = fs.existsSync(layout.stateDir);
  let claimedLock = false;
  // No runId in this maintenance lock: a runtime finding it after a
  // crashed diet would otherwise dispatch a bogus RunCrashed for a run
  // that never existed.
  const ourLockPayload = () =>
    JSON.stringify({
      pid: process.pid,
      lastHeartbeat: new Date().toISOString(),
    });
  const lockIsOurs = (): boolean => {
    try {
      const raw = fs.readFileSync(lockPath, "utf-8");
      return (JSON.parse(raw) as { pid?: number }).pid === process.pid;
    } catch {
      return false;
    }
  };
  // Flipped (permanently) the moment the lock is observed in someone
  // else's hands; beforePromote turns it into an abort.
  let lockLost = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  if (hasExecutionLayout) {
    if (fs.existsSync(lockPath)) {
      removeStaleJournalLock(lockPath, refuse);
    }
    try {
      claimJournalLock(lockPath, ourLockPayload);
      claimedLock = true;
    } catch {
      refuse("another process claimed runtime.lock while we were checking");
    }
    // A booting runtime treats a >2-minute-old heartbeat as stale, so
    // keep ours fresh across long diets (async zstd keeps timers
    // live). Refresh ONLY while the lock is still ours: if a runtime
    // ever replaced it (e.g. a long timer stall let our heartbeat go
    // stale), overwriting it back would hijack the runtime's lock —
    // instead mark the claim as permanently lost and let
    // beforePromote abort the diet.
    heartbeat = setInterval(() => {
      if (lockLost) return;
      if (!lockIsOurs()) {
        lockLost = true;
        clearInterval(heartbeat);
        return;
      }
      try {
        // Atomic replace: a mid-write failure must not leave a
        // partial lock behind (see the claim above).
        const hbTmp = `${lockPath}.tmp-${process.pid}`;
        fs.writeFileSync(hbTmp, ourLockPayload());
        fs.renameSync(hbTmp, lockPath);
      } catch {
        // Best effort; the beforePromote ownership check still guards.
      }
    }, 30_000);
  }

  const canReleaseLock = () => claimedLock && !lockLost && lockIsOurs();

  return {
    beforePromote: () => {
      if (!claimedLock) return;
      // Abort before promotion if ownership was ever lost.
      if (lockLost || !lockIsOurs()) {
        lockLost = true;
        throw new Error("runtime.lock changed hands during the diet");
      }
    },
    release: () => {
      clearInterval(heartbeat);
      if (canReleaseLock()) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Already gone — fine.
        }
      }
    },
  };
}

export async function maintainJournal(executionDir: string, isRestore: boolean): Promise<void> {
  const layout = new ExecutionLayout(executionDir);
  const eventsDir = layout.eventsDir;
  const { dietJournal, restoreJournal } = await import("./storage/journal-diet.js");
  if (isRestore) {
    const report = await restoreJournal(eventsDir);
    if (report.alreadyRestored) {
      console.log(`✓ Journal already restored and verified (sha256 ${report.sha256})`);
    } else {
      console.log(
        `✓ Journal restored: ${report.bytes} bytes, verified byte-for-byte (sha256 ${report.sha256})`,
      );
    }
    return;
  }

  const lock = acquireJournalDietLock(executionDir, layout);
  try {
    const report = await dietJournal(eventsDir, {
      beforePromote: lock.beforePromote,
    });
    if (report.alreadyDieted) {
      console.log(`✓ Journal already dieted (${report.totalEvents} events)`);
    } else {
      console.log(
        `✓ Journal dieted: ${report.originalBytes} → ${report.dietedBytes} bytes ` +
          `(${report.uniqueCasBodies} unique bodies in CAS). ` +
          `Restore with: hankweave --restore-journal ${executionDir}`,
      );
    }
  } finally {
    lock.release();
  }
}
