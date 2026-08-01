import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Clean up test-area after unit tests
const testAreaPath = path.resolve("tests", "test-area");

// Cleanup targets LEAKS, not live state: the runner's parallel default means
// another suite (or another `bun run test` in a second terminal) may be
// mid-flight while this runs — deleting a fresh dir under a live server rips
// out its state.json and lock file. Anything a test creates is used within
// seconds; only dirs this stale are abandoned. Same discipline as the
// replay-tmpdir sweep below.
const MAX_AGE_MS = 60 * 60 * 1000;

async function cleanupTestArea() {
  try {
    await fs.promises.mkdir(testAreaPath, { recursive: true });

    // Get all items in test-area
    const items = await fs.promises.readdir(testAreaPath);

    // Remove EVERY aged entry, whatever its name. This used to match only
    // temp-test-*/.hankweave — and the accumulated execution-* residue took
    // the whole test suite down (intermediates/56 §incident): live e2e runs
    // install node_modules inside their agent workspaces, ~40 leftover
    // execution dirs reached 281k directories, `bun test`'s discovery crawl
    // then held >10,237 directory fds, and past that threshold Bun spawns
    // every child with CLOSED stdio — all output silently vanishes.
    // test-area is residue by definition (pre-test:cleanup blanket-deletes
    // it); an hour of age is the only liveness signal we need.
    for (const item of items) {
      const itemPath = path.join(testAreaPath, item);
      const stats = await fs.promises.stat(itemPath);

      if (!stats.isDirectory()) continue;
      if (Date.now() - stats.mtimeMs < MAX_AGE_MS) continue;
      console.log(`Cleaning up: ${item}`);
      await fs.promises.rm(itemPath, { recursive: true, force: true });
    }

    console.log("✅ Test area cleaned up");
  } catch (error) {
    console.error("Error cleaning up test area:", error);
  }
}

/**
 * Sweep leaked replay working copies out of the OS tmpdir.
 *
 * `--replay` copies the whole execution directory to `$TMPDIR/hankweave-replay-*`
 * and removes it in a `process.on("exit")` hook — which never fires when the
 * process dies by signal, and the test runner SIGKILLs wedged process groups by
 * design. Found 198 of these (a full execution-dir copy each) accumulated over
 * two days of runs.
 *
 * Only dirs older than an hour are swept, so concurrent runs — including other
 * checkouts sharing this machine — are never touched.
 */
async function cleanupLeakedReplayDirs() {
  const tmp = os.tmpdir();
  const cutoff = Date.now() - 60 * 60 * 1000;
  let swept = 0;
  try {
    for (const item of await fs.promises.readdir(tmp)) {
      if (!item.startsWith("hankweave-replay-")) continue;
      const itemPath = path.join(tmp, item);
      try {
        const stats = await fs.promises.stat(itemPath);
        if (stats.isDirectory() && stats.mtimeMs < cutoff) {
          await fs.promises.rm(itemPath, { recursive: true, force: true });
          swept++;
        }
      } catch {
        // Raced another cleaner or the owning process; skip.
      }
    }
  } catch {
    // tmpdir unreadable — nothing to do.
  }
  if (swept > 0) console.log(`✅ Swept ${swept} stale hankweave-replay-* dir(s) from ${tmp}`);
}

// Run cleanup
await cleanupTestArea();
await cleanupLeakedReplayDirs();
