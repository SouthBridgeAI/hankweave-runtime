/**
 * Runtime ↔ watchdog wiring. The watchdog mechanism itself is covered in
 * shutdown-watchdog-module.test.ts; these tests check the runtime's exit-code
 * policy and that shutdown paths drive the watchdog correctly. The production
 * hang this guards: a run that correctly detected an unrecoverable error but
 * never exited because a graceful-shutdown await never resolved.
 *
 * Tests build the runtime via Object.create(prototype) to avoid the heavy
 * constructor and install a ShutdownWatchdog with a tiny window and an injected
 * exit, so no real process.exit and no global timer spies are needed.
 */
import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { HankweaveRuntime } from "../../server/hankweave-runtime";
import { ShutdownWatchdog } from "../../server/shutdown-watchdog";

const WINDOW_MS = 25;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Wired = {
  logger: { log: (msg: string, level?: string) => void };
  stateManager: { getCurrentRun: () => { status: string } | null };
  watchdog: ShutdownWatchdog;
  exits: number[];
  computeExitCode: (reason: string, exitCode?: number) => number;
  forceShutdown: (reason: string, exitProcess?: boolean) => Promise<void>;
};

function makeRuntime(runStatus = "failed"): Wired {
  const rt = Object.create(HankweaveRuntime.prototype) as Wired & Record<string, unknown>;
  rt.logger = { log: () => {} };
  rt.stateManager = { getCurrentRun: () => ({ status: runStatus }) };
  rt.exits = [];
  rt.watchdog = new ShutdownWatchdog({
    timeoutMs: WINDOW_MS,
    log: () => {},
    exit: (code) => rt.exits.push(code),
  });
  // Fields forceShutdown() / cleanupCurrentCodon() touch: no running codon, no
  // open clients/servers, and a lock file path that does not exist.
  rt.currentCodon = undefined;
  rt.codonRunners = new Map();
  rt.pendingToolUses = new Map();
  rt.clients = new Map();
  rt.server = null;
  rt.proxyRunner = null;
  rt.config = { lockFile: path.join(os.tmpdir(), `nonexistent-lock-${Date.now()}`) };
  rt.uploadTrace = undefined;
  return rt;
}

describe("computeExitCode", () => {
  test("codon failure -> 1", () => {
    expect(makeRuntime().computeExitCode("codon failure")).toBe(1);
  });

  test("explicit override wins", () => {
    expect(makeRuntime().computeExitCode("codon failure", 0)).toBe(0);
    expect(makeRuntime().computeExitCode("SIGINT", 7)).toBe(7);
  });

  test("all codons completed reflects run status", () => {
    expect(makeRuntime("completed").computeExitCode("all codons completed")).toBe(0);
    expect(makeRuntime("failed").computeExitCode("all codons completed")).toBe(1);
    expect(makeRuntime("crashed").computeExitCode("all codons completed")).toBe(1);
  });

  test("user-initiated reasons are graceful (0), unknown reasons fail (1)", () => {
    expect(makeRuntime().computeExitCode("SIGINT")).toBe(0);
    expect(makeRuntime().computeExitCode("SIGTERM")).toBe(0);
    expect(makeRuntime().computeExitCode("client request")).toBe(0);
    expect(makeRuntime().computeExitCode("something unexpected")).toBe(1);
  });
});

describe("shutdown paths drive the watchdog", () => {
  test("a WEDGED forceShutdown force-exits with code 1 over a graceful pre-arm", async () => {
    // Escalation path: a graceful shutdown() pre-armed the watchdog with code 0,
    // then escalated to forceShutdown(). forceShutdown always exits 1, so it must
    // clear and re-arm with code 1 — otherwise, if its force-kill wedges, the
    // watchdog fires with the stale 0 and a failed shutdown is reported as
    // success. forceKill hangs forever here, so only the watchdog can exit.
    const rt = makeRuntime("completed");
    (rt as unknown as { currentCodon: unknown }).currentCodon = { codonId: "analyze" };
    (rt as unknown as { codonRunners: Map<string, unknown> }).codonRunners = new Map([
      ["analyze", { forceKill: () => new Promise<void>(() => {}) }],
    ]);

    rt.watchdog.arm("all codons completed", rt.computeExitCode("all codons completed")); // 0
    void rt.forceShutdown("all codons completed", true); // never resolves
    await sleep(WINDOW_MS * 3);

    expect(rt.exits).toEqual([1]);
  });

  test("forceShutdown in integration-test mode arms nothing", async () => {
    const rt = makeRuntime();
    (rt as unknown as { currentCodon: unknown }).currentCodon = { codonId: "analyze" };
    (rt as unknown as { codonRunners: Map<string, unknown> }).codonRunners = new Map([
      ["analyze", { forceKill: () => new Promise<void>(() => {}) }],
    ]);
    void rt.forceShutdown("running integration test", false);
    await sleep(WINDOW_MS * 3);
    expect(rt.watchdog.armed).toBe(false);
    expect(rt.exits).toEqual([]);
  });
});
