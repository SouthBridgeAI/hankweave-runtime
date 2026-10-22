import fs from "node:fs";
import { ExecutionLayout } from "./execution-layout.js";
import { RuntimeLock } from "./runtime-lock.js";

/** Offline command: hold ownership until every journal write finishes. */
export async function maintainJournal(executionDir: string, isRestore: boolean): Promise<void> {
  const { dietJournal, restoreJournal } = await import("./storage/journal-diet.js");
  // Acquiring creates the execution root for runtime startup; a mistyped path
  // must fail here rather than leave an empty directory tree behind.
  if (!fs.existsSync(executionDir)) {
    throw new Error(`Execution directory not found: ${executionDir}`);
  }
  const lock = await RuntimeLock.acquire(executionDir);
  try {
    const eventsDir = new ExecutionLayout(executionDir).eventsDir;
    if (isRestore) {
      const report = await restoreJournal(eventsDir);
      console.log(
        `✓ Journal ${report.alreadyRestored ? "already restored and verified" : "restored"} (sha256 ${report.sha256})`,
      );
    } else {
      const report = await dietJournal(eventsDir);
      if (report.alreadyDieted) {
        console.log(`✓ Journal already dieted (${report.totalEvents} events)`);
      } else {
        console.log(
          `✓ Journal dieted: ${report.originalBytes} → ${report.dietedBytes} bytes ` +
            `(${report.uniqueCasBodies} unique bodies in CAS). Restore with: hankweave --restore-journal ${executionDir}`,
        );
      }
    }
  } finally {
    await lock.release();
  }
}
