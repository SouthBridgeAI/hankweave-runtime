#!/usr/bin/env bun
/**
 * A corrupt line in events.jsonl must not break client connection.
 *
 * Before the tolerant tail reader, `getMostRecentEvents` parsed the whole
 * journal with a bare JSON.parse: one torn line (a crash mid-write is enough)
 * threw a SyntaxError inside the WS handshake and every history-requesting
 * client failed to connect — reproduced during the events.jsonl
 * investigation (intermediates/60-shim-debug-diet).
 *
 * This test seeds a journal with valid events plus a torn (unterminated,
 * half-written) line, reboots the runtime on that directory, and asserts the
 * handshake with `sendPreviousEvents` succeeds and serves the valid events
 * while skipping the torn one. Keyless and codon-free: --no-autostart
 * everywhere, so it runs with zero API spend.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { connectHankweaveClient, launchHankweave } from "../utils/hankweave-server-test-helpers.js";
import {
  generateTestTimestamp,
  getFreePort,
  rimrafSimple,
  waitForCondition,
  waitForPortFree,
} from "../utils/test-helpers.js";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_AREA = path.join(TEST_ROOT, "tests/test-area");
const KEYLESS_CONFIG = path.join(TEST_ROOT, "tests/config/test-codons-keyless.config.json");

function seedEventLine(id: string): string {
  return `${JSON.stringify({
    id,
    timestamp: new Date().toISOString(),
    type: "pong",
    data: { message: `seed ${id}`, timestamp: new Date().toISOString() },
  })}\n`;
}

describe("WS handshake survives a corrupt event journal", () => {
  const dirsToCleanup: string[] = [];

  afterEach(async () => {
    for (const dir of dirsToCleanup) {
      await rimrafSimple(dir);
    }
    dirsToCleanup.length = 0;
  });

  test("handshake with history succeeds when events.jsonl has a torn line", async () => {
    fs.mkdirSync(TEST_AREA, { recursive: true });
    const execDir = path.join(TEST_AREA, `torn-journal-${generateTestTimestamp()}`);
    dirsToCleanup.push(execDir);
    const journalPath = path.join(execDir, ".hankweave", "events", "events.jsonl");

    // Step 1: scaffold the execution directory with a clean boot (no codons).
    // dietOnFinalize (on by default) would swap events.jsonl for the diet
    // pair at shutdown; the append below would then create a FRESH journal
    // beside that pair, and boot cleanup rightly refuses a journal that
    // does not match the manifest next to it. This test is about torn lines
    // in a RAW journal, so keep the journal raw.
    const port = await getFreePort();
    const firstServer = await launchHankweave({
      port,
      configPath: KEYLESS_CONFIG,
      executionDir: execDir,
      extraArgs: ["--no-autostart"],
      env: { HANKWEAVE_RUNTIME_DIET_ON_FINALIZE: "false" },
    });
    try {
      await firstServer.waitForEvent("server.ready", 30_000);
      await waitForCondition(() => fs.existsSync(journalPath));
    } finally {
      await firstServer.stop();
    }
    await waitForCondition(() => !firstServer.hasLockFile());
    await waitForPortFree(port);

    // Step 2: plant three valid events, then a torn line — exactly what a
    // crash mid-write leaves behind (no trailing newline, half a JSON object).
    fs.appendFileSync(
      journalPath,
      seedEventLine("seed-event-1") +
        seedEventLine("seed-event-2") +
        seedEventLine("seed-event-3") +
        '{"id":"torn-event","timestamp":"2026-08-',
    );

    // Step 3: reboot on the corrupted directory and request history in the
    // handshake. launchHankweave itself fails if the handshake never
    // completes, so a regression to the parse-everything reader reds here.
    const secondServer = await launchHankweave({
      port,
      configPath: KEYLESS_CONFIG,
      executionDir: execDir,
      reuseTestDirectory: true,
      sendPreviousEvents: true,
      extraArgs: ["--no-autostart"],
    });
    try {
      await secondServer.waitForEvent("server.ready", 30_000);

      // A second client inspects the raw handshake response.
      const { client, handshakeResponse } = await connectHankweaveClient(
        secondServer.websocketServerUrl,
        { sendPreviousEvents: true },
      );
      try {
        const history = handshakeResponse?.data.eventHistory ?? [];
        const ids = history.map((event) => String(event.id));
        expect(ids).toContain("seed-event-1");
        expect(ids).toContain("seed-event-2");
        expect(ids).toContain("seed-event-3");
        expect(ids).not.toContain("torn-event");
      } finally {
        client.close();
      }
    } finally {
      await secondServer.stop();
    }
  }, 120_000);
});
