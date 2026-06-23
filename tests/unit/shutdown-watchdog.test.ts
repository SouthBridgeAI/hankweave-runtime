/**
 * Regression: shutdown() must guarantee the process exits even if an awaited
 * cleanup step wedges (a hung process kill, an in-flight SDK stream teardown, a
 * stuck sentinel/telemetry flush, or a pending state transition). The production
 * hang was a run that correctly detected an unrecoverable error but never exited
 * because a graceful-shutdown await never resolved and process.exit() (only
 * reached at the very end) was never called. armShutdownWatchdog() is the
 * backstop that force-exits after a bound regardless.
 *
 * Tests exercise the watchdog/exit-code helpers in isolation via
 * Object.create(prototype) to avoid the heavy runtime constructor, capturing the
 * scheduled timer through a setTimeout spy so no real wall-clock wait is needed.
 */
import { describe, expect, spyOn, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { TIMEOUTS } from "../../server/config";
import { HankweaveRuntime } from "../../server/hankweave-runtime";

type Watchdoggable = {
  logger: { log: (msg: string, level?: string) => void };
  stateManager: { getCurrentRun: () => { status: string } | null };
  shutdownWatchdog?: NodeJS.Timeout;
  computeExitCode: (reason: string, exitCode?: number) => number;
  armShutdownWatchdog: (reason: string, exitCode?: number) => void;
  clearShutdownWatchdog: () => void;
};

function makeRuntime(runStatus = "failed"): Watchdoggable {
  const rt = Object.create(HankweaveRuntime.prototype) as Watchdoggable;
  rt.logger = { log: () => {} };
  rt.stateManager = { getCurrentRun: () => ({ status: runStatus }) };
  rt.shutdownWatchdog = undefined;
  return rt;
}

type ForceShutdownable = Watchdoggable & {
  forceShutdown: (reason: string, exitProcess?: boolean) => Promise<void>;
};

// Stubs the fields forceShutdown() / cleanupCurrentCodon() touch so the method
// runs to completion without the heavy runtime constructor: no running codon, no
// open clients/servers, and a lock file path that does not exist.
function makeForceShutdownRuntime(runStatus = "failed"): ForceShutdownable {
  const rt = makeRuntime(runStatus) as ForceShutdownable & Record<string, unknown>;
  rt.currentCodon = undefined;
  rt.codonRunners = new Map();
  rt.pendingToolUses = new Map();
  rt.clients = new Map();
  rt.server = null;
  rt.proxyRunner = null;
  rt.config = { lockFile: path.join(os.tmpdir(), `nonexistent-lock-${Date.now()}`) };
  rt.uploadTrace = undefined;
  return rt as unknown as ForceShutdownable;
}

describe("computeExitCode", () => {
  test("codon failure -> 1", () => {
    expect(makeRuntime().computeExitCode("codon failure")).toBe(1);
  });

  test("explicit override wins", () => {
    expect(makeRuntime().computeExitCode("anything", 0)).toBe(0);
    expect(makeRuntime().computeExitCode("SIGINT", 7)).toBe(7);
  });

  test("all codons completed reflects run status", () => {
    expect(makeRuntime("failed").computeExitCode("all codons completed")).toBe(1);
    expect(makeRuntime("completed").computeExitCode("all codons completed")).toBe(0);
  });

  test("user-initiated reasons are graceful (0), unknown reasons fail (1)", () => {
    expect(makeRuntime().computeExitCode("SIGINT")).toBe(0);
    expect(makeRuntime().computeExitCode("client request")).toBe(0);
    expect(makeRuntime().computeExitCode("uncaughtException")).toBe(1);
  });
});

describe("shutdown watchdog", () => {
  test("arming schedules an unref'd force-exit that uses the computed code", () => {
    const rt = makeRuntime("failed");

    let captured: (() => void) | undefined;
    let unrefCalled = false;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void) => {
      captured = cb;
      return {
        unref: () => {
          unrefCalled = true;
        },
      } as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    const exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as never);

    try {
      rt.armShutdownWatchdog("codon failure");

      // Timer was scheduled at the watchdog bound and won't keep the loop alive.
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy.mock.calls[0][1]).toBe(TIMEOUTS.SHUTDOWN_WATCHDOG_MS);
      expect(unrefCalled).toBe(true);
      expect(rt.shutdownWatchdog).toBeDefined();

      // Firing the watchdog force-exits with the failure code.
      expect(captured).toBeDefined();
      captured?.();
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      setTimeoutSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test("arming is idempotent (does not stack timers)", () => {
    const rt = makeRuntime();
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((_cb: () => void) => {
      return { unref: () => {} } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
    try {
      rt.armShutdownWatchdog("codon failure");
      rt.armShutdownWatchdog("codon failure");
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  test("a WEDGED forceShutdown force-exits with code 1 over a graceful pre-arm", async () => {
    // Escalation path: a graceful shutdown() pre-armed the watchdog with code 0,
    // then escalated to forceShutdown(). forceShutdown always exits 1, so it must
    // clear and re-arm the watchdog with code 1 — otherwise, if its force-kill
    // wedges, the watchdog fires with the stale 0 and a failed shutdown is
    // reported as success. We make forceKill hang so forceShutdown never reaches
    // its own clear/normal-exit, leaving only the re-armed watchdog.
    const rt = makeForceShutdownRuntime("completed"); // graceful run → pre-arm computes 0
    // A current codon whose forceKill never resolves → forceShutdown wedges.
    (rt as unknown as { currentCodon: unknown }).currentCodon = { codonId: "analyze" };
    (rt as unknown as { codonRunners: Map<string, unknown> }).codonRunners = new Map([
      ["analyze", { forceKill: () => new Promise<void>(() => {}) }],
    ]);

    // Model timers by handle so a mocked clearTimeout actually removes them — the
    // surviving watchdog timer is then the one forceShutdown re-armed.
    const timers = new Map<object, { cb: () => void; delay: number }>();
    let seq = 0;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((
      cb: () => void,
      delay: number,
    ) => {
      const handle = { id: ++seq };
      timers.set(handle, { cb, delay });
      return handle as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((h: object) => {
      timers.delete(h);
    }) as unknown as typeof clearTimeout);
    const exitSpy = spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      // Pre-arm as a graceful shutdown() would (success code 0).
      rt.armShutdownWatchdog("all codons completed");
      // Escalate to forceShutdown. It arms (code 1) synchronously, then suspends
      // forever at the hanging forceKill — so we do NOT await it.
      void rt.forceShutdown("all codons completed", true);
      await Promise.resolve(); // let the synchronous prologue + arming settle

      // Exactly one watchdog survives (the re-armed one); firing it must exit 1.
      const watchdogs = [...timers.values()].filter(
        (t) => t.delay === TIMEOUTS.SHUTDOWN_WATCHDOG_MS,
      );
      expect(watchdogs.length).toBe(1);
      watchdogs[0].cb();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(exitSpy).not.toHaveBeenCalledWith(0);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test("clearing cancels the timer so graceful exit proceeds normally", () => {
    const rt = makeRuntime();
    let cleared: NodeJS.Timeout | undefined;
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(((_cb: () => void) => {
      return { unref: () => {} } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((
      t: NodeJS.Timeout,
    ) => {
      cleared = t;
    }) as unknown as typeof clearTimeout);
    try {
      rt.armShutdownWatchdog("codon failure");
      const armed = rt.shutdownWatchdog;
      rt.clearShutdownWatchdog();
      expect(cleared).toBe(armed);
      expect(rt.shutdownWatchdog).toBeUndefined();
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});
