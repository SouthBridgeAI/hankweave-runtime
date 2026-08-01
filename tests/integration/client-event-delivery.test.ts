#!/usr/bin/env bun
/**
 * A client must be able to observe events the server emitted before that client
 * finished its handshake.
 *
 * This is a harness contract, not a runtime one. The runtime emits
 * `codon.started` for every codon, every time — verified directly. But `emit()`
 * only broadcasts to clients whose handshake has completed, and there is no
 * backfill unless the client asks for history. A client that connects after the
 * first codon has already begun never learns it started, so any assertion
 * counting events from the beginning of a run is quietly unreliable.
 *
 * Measured on a replay fixture before `launchHankweave` requested history:
 *
 *   TUI mode    3 of 5 runs missing the first codon's `codon.started`
 *   headless    5 of 5 (autostart fires before any client can connect)
 *
 * Making that deterministic takes two tricks, both load-bearing:
 *
 * - `--headless` calls `requestAutostart()` as soon as the server binds, so
 *   codon 1 runs with zero clients connected. Certainty, not chance.
 * - The last codon's replay log carries spaced timestamps. `ReplayProcessManager`
 *   paces itself off those, so the run stays open long enough to attach a second
 *   client mid-flight. Without it the server completes, shuts down, and deletes
 *   its replay tmpdir before anything can connect.
 */
import { describe, expect, test } from "bun:test";
import type { ServerEvent } from "../../server/schemas/event-schemas.js";
import type { HandshakeResponse } from "../../server/types/types.js";
import {
  connectHankweaveClient,
  type LaunchedServer,
  launchHankweave,
} from "../utils/hankweave-server-test-helpers.js";
import {
  assistantTextLine,
  type BuiltReplayFixture,
  buildReplayFixture,
  type LogLine,
  successResultLine,
} from "../utils/replay-fixture-builder.js";
import { getFreePort } from "../utils/test-helpers.js";

/** Codons that finish before any late client attaches. */
const EARLY_CODON_IDS = ["alpha", "beta"] as const;
/** Held open by paced timestamps so the server is still alive to connect to. */
const SLOW_CODON_ID = "omega";

const at = (line: LogLine, isoOffsetSeconds: number): LogLine => ({
  ...line,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, isoOffsetSeconds)).toISOString(),
});

function replayFixture(): BuiltReplayFixture {
  const session = (id: string) => ({ sessionId: `session-${id}` });
  return buildReplayFixture({
    codons: [
      ...EARLY_CODON_IDS.map((id) => ({
        id,
        logLines: [
          assistantTextLine(`working on ${id}`, session(id)),
          successResultLine(`${id} done`, session(id)),
        ],
      })),
      {
        id: SLOW_CODON_ID,
        // 6s and 12s apart; the replay pacer caps each gap at MAX_REPLAY_DELAY_MS
        // (5s), so this holds the run open for roughly ten seconds.
        logLines: [
          at(assistantTextLine("thinking", session(SLOW_CODON_ID)), 0),
          at(assistantTextLine("still thinking", session(SLOW_CODON_ID)), 6),
          at(successResultLine("omega done", session(SLOW_CODON_ID)), 12),
        ],
      },
    ],
  });
}

async function launchHeadless(
  fixture: BuiltReplayFixture,
  sendPreviousEvents?: boolean,
): Promise<LaunchedServer> {
  const port = await getFreePort();
  const server = await launchHankweave({
    port,
    configPath: fixture.configPath,
    dataDir: fixture.dataPath,
    replayDir: fixture.execDir,
    logPrefix: "[client-event-delivery]",
    extraArgs: ["--force", "--headless"],
    sendPreviousEvents,
  });
  // Required before any state polling: in replay mode the runtime works in a
  // temp copy of the execution directory, and the helper only learns that path
  // from the `server.ready` payload. Poll before it arrives and you are reading
  // a `tests/test-area/execution-*` that replay never created.
  await server.waitForEvent("server.ready", 30_000);
  return server;
}

/**
 * Wait on state.json, not on events — the whole premise here is that the event
 * stream may be incomplete, so it cannot also be the progress signal.
 */
async function waitForEarlyCodons(server: LaunchedServer): Promise<void> {
  await server.waitForState(
    (state) =>
      EARLY_CODON_IDS.every((id) =>
        state.runs[0]?.codons.some((c) => c.codonId === id && c.status === "completed"),
      ),
    60_000,
  );
}

function startedCodonIds(events: ServerEvent[]): string[] {
  const ids: string[] = [];
  for (const event of events) {
    if (event.type === "codon.started") ids.push(event.data.codonId);
  }
  return ids;
}

describe("client event delivery", () => {
  test("a client attaching mid-run can reconstruct codon.started for earlier codons", async () => {
    const fixture = replayFixture();
    let server: LaunchedServer | undefined;
    try {
      server = await launchHeadless(fixture);
      await waitForEarlyCodons(server);

      // Attaches only now — alpha and beta are provably finished, so their
      // events unambiguously predate this client.
      const late = await connectHankweaveClient(server.websocketServerUrl, {
        sendPreviousEvents: true,
      });
      const handshake = late.handshakeResponse as HandshakeResponse;
      late.client.close();

      const seen = startedCodonIds(handshake.data.eventHistory);
      for (const id of EARLY_CODON_IDS) expect(seen).toContain(id);
    } finally {
      await server?.kill().catch(() => {});
      fixture.cleanup();
    }
  }, 150_000);

  test("...and sees nothing at all if it does not ask for history", async () => {
    const fixture = replayFixture();
    let server: LaunchedServer | undefined;
    try {
      server = await launchHeadless(fixture);
      await waitForEarlyCodons(server);

      const late = await connectHankweaveClient(server.websocketServerUrl, {
        sendPreviousEvents: false,
      });
      const handshake = late.handshakeResponse as HandshakeResponse;
      late.client.close();

      // The failure mode, stated plainly: without history a late client is blind
      // to everything already emitted, while `totalEvents` shows the server knows
      // exactly what it sent.
      expect(handshake.data.eventHistory).toEqual([]);
      expect(handshake.data.totalEvents).toBeGreaterThan(0);
    } finally {
      await server?.kill().catch(() => {});
      fixture.cleanup();
    }
  }, 150_000);

  test("launchHankweave backfills pre-connection events only when asked", async () => {
    // Pins the default and the escape hatch in one place.
    //
    // Asserting "the client saw every codon.started" would be the obvious shape,
    // but it is a coin flip — measured 3 failures in 5 — because it turns on
    // whether codon 1 reaches `running` before the handshake lands. A guard that
    // fires 60% of the time is the very thing this suite exists to stop shipping.
    //
    // `RunStarted` is deterministic instead: `startNewRun()` runs inside
    // `HankweaveRuntime.start()` *before* `serve()` binds the socket, so no
    // client can ever observe it live. Seeing it at all proves backfill ran.
    const sawRunStarted = (server: LaunchedServer): boolean =>
      server
        .getEvents()
        .some((e) => e.type === "state.transition" && e.data.transitionType === "RunStarted");

    const optedIn = replayFixture();
    let withHistory: LaunchedServer | undefined;
    try {
      withHistory = await launchHeadless(optedIn, true);
      await waitForEarlyCodons(withHistory);
      expect(sawRunStarted(withHistory)).toBe(true);
    } finally {
      await withHistory?.kill().catch(() => {});
      optedIn.cleanup();
    }

    // The default stays off on purpose: `--replay` copies the source execution
    // directory whole, journal included, so backfill against a checked-in
    // fixture would replay the original recording's events into a live run.
    const byDefault = replayFixture();
    let noHistory: LaunchedServer | undefined;
    try {
      noHistory = await launchHeadless(byDefault);
      await waitForEarlyCodons(noHistory);
      expect(sawRunStarted(noHistory)).toBe(false);
    } finally {
      await noHistory?.kill().catch(() => {});
      byDefault.cleanup();
    }
  }, 150_000);
});

describe("handshake history and the live stream must not overlap", () => {
  test("a client that asks for history is never handed the same event twice", async () => {
    // `handleHandshake` sets `handshakeComplete: true` before awaiting the
    // journal read (hankweave-runtime.ts). That await is a suspension point: an
    // event emitted during it is broadcast live to the very client whose history
    // is still being assembled, and can then arrive a second time inside the
    // handshake response. The window is short, so this is a guard against a
    // known-narrow race rather than a reproduction of a frequent one.
    const fixture = replayFixture();
    let server: LaunchedServer | undefined;
    try {
      server = await launchHeadless(fixture, true);
      await waitForEarlyCodons(server);

      const seen = new Map<string, number>();
      for (const event of server.getEvents()) {
        seen.set(event.id, (seen.get(event.id) ?? 0) + 1);
      }
      const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);

      expect(duplicated).toEqual([]);
    } finally {
      await server?.kill().catch(() => {});
      fixture.cleanup();
    }
  }, 150_000);
});
