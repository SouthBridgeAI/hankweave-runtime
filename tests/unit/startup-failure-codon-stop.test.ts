/**
 * Recovery with autostart can start a codon inside establishStartupRun(),
 * before the WebSocket server binds. If binding or port publication then
 * fails, start() must stop that agent before closing the journal and handing
 * the lease back to the command; otherwise the agent keeps writing into a
 * directory a successor may already own.
 *
 * Built via Object.create(prototype) like the other runtime unit tests to skip
 * the heavy constructor.
 */
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HankweaveRuntime } from "../../server/hankweave-runtime";

test("a codon started during recovery is killed before startup failure returns", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "startup-failure-"));
  const order: string[] = [];
  try {
    const rt = Object.create(HankweaveRuntime.prototype) as Record<string, unknown> & {
      start: () => Promise<number>;
    };
    rt.lock = { assertHeldFor() {} };
    rt.config = { executionPath: dir, version: "test" };
    rt.logger = { log() {}, disableFileLogging() {} };
    rt.pendingToolUses = new Map();
    rt.codonRunners = new Map([
      [
        "recovered",
        {
          kill: async () => {
            order.push("kill");
          },
          cleanup: async () => {
            order.push("cleanup");
          },
        },
      ],
    ]);
    rt.currentCodon = { codonId: "recovered", codon: { name: "recovered" } };
    rt.sentinelManager = { shutdown: async () => {} };
    rt.stateManager = { waitForPendingTransitions: async () => {} };
    rt.eventJournalAppendQueue = Promise.resolve();
    rt.eventJournal = {
      close: async () => {
        order.push("journal close");
      },
    };
    rt.initialize = async () => {
      throw new Error("injected bind failure");
    };

    await expect(rt.start()).rejects.toThrow("injected bind failure");

    expect(order).toEqual(["kill", "cleanup", "journal close"]);
    expect(rt.currentCodon).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
