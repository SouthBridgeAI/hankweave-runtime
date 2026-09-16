/**
 * Child process for the event-storage crash test: appends events in a tight
 * loop until the parent SIGKILLs it. Not a test file — spawned by
 * event-storage-crash.test.ts.
 */
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import { FileEventStorage } from "../../server/storage/file-event-storage.js";
import { EventId } from "../../server/types/branded-types.js";

const storageDir = process.argv[2];
if (!storageDir) {
  console.error("usage: bun event-storage-crash-child.ts <storage-dir>");
  process.exit(2);
}

const storage = new FileEventStorage(storageDir);
await storage.initialize();

let sequence = 0;
// Vary line lengths so kills land at unpredictable byte offsets.
while (true) {
  const batch: ServerEvent[] = [];
  for (let i = 0; i < 25; i++) {
    const id = sequence++;
    batch.push({
      id: EventId(`crash-${id.toString().padStart(8, "0")}`),
      timestamp: new Date().toISOString(),
      type: "pong",
      data: {
        message: "x".repeat(1 + (id % 211)),
        timestamp: new Date().toISOString(),
      },
    });
  }
  await storage.appendMany(batch);
}
