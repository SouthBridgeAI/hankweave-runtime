import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "../../server/execution-layout.js";
import { maintainJournal } from "../../server/journal-command.js";
import { RuntimeLock, RuntimeLockHeldError } from "../../server/runtime-lock.js";
import * as journal from "../../server/storage/journal-diet.js";

let root: string;
let dir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "journal-command-"));
  dir = path.join(root, "execution");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test.each([false, true])(
  "journal command refuses contention before doing work (restore: %s)",
  async (restore) => {
    const lock = await RuntimeLock.acquire(dir);
    try {
      await expect(maintainJournal(dir, restore)).rejects.toBeInstanceOf(RuntimeLockHeldError);
      // Acquiring the setup lease creates the execution root; refusal must add nothing.
      expect(fs.readdirSync(dir)).toEqual([ExecutionLayout.RUNTIME_LOCK]);
    } finally {
      await lock.release();
    }
  },
);

test.each([false, true])(
  "journal command refuses a missing execution directory without creating it (restore: %s)",
  async (restore) => {
    const missing = path.join(root, "nope", "deeper", "execution");
    await expect(maintainJournal(missing, restore)).rejects.toThrow(
      `Execution directory not found: ${missing}`,
    );
    expect(fs.existsSync(path.join(root, "nope"))).toBe(false);
  },
);

test("journal failure retains its identity and releases command ownership", async () => {
  fs.mkdirSync(dir);
  const failure = new Error("restore failed");
  const restore = spyOn(journal, "restoreJournal").mockImplementation(async () => {
    await expect(RuntimeLock.acquire(dir)).rejects.toBeInstanceOf(RuntimeLockHeldError);
    throw failure;
  });
  try {
    await expect(maintainJournal(dir, true)).rejects.toBe(failure);
  } finally {
    restore.mockRestore();
  }
  await (await RuntimeLock.acquire(dir)).release();
});
