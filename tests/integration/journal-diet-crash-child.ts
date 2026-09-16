/**
 * Child process for the journal-diet crash test: diets the given events
 * directory once, then exits. Not a test file — spawned (and SIGKILLed at a
 * random offset) by journal-diet-crash.test.ts.
 */
import { dietJournal } from "../../server/storage/journal-diet.js";

const eventsDir = process.argv[2];
if (!eventsDir) {
  console.error("usage: bun journal-diet-crash-child.ts <events-dir>");
  process.exit(2);
}

// Signal readiness so the parent's kill window starts at actual diet work,
// not at Bun's startup cost.
console.log("DIET_START");
await dietJournal(eventsDir);
console.log("DIET_DONE");
