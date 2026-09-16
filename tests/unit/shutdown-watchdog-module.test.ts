/**
 * ShutdownWatchdog in isolation: real (tiny) timers, injected exit — no spies
 * on globals and never a real process.exit.
 */
import { describe, expect, test } from "bun:test";
import { ShutdownWatchdog, shutdownWatchdogWanted } from "../../server/shutdown-watchdog";

const WINDOW_MS = 25;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function make() {
  const exits: number[] = [];
  const logs: string[] = [];
  const wd = new ShutdownWatchdog({
    timeoutMs: WINDOW_MS,
    log: (m) => logs.push(m),
    exit: (code) => exits.push(code),
  });
  return { wd, exits, logs };
}

describe("shutdownWatchdogWanted", () => {
  test("only an exiting, non-integration-test shutdown wants a backstop", () => {
    expect(shutdownWatchdogWanted(true, "codon failure")).toBe(true);
    expect(shutdownWatchdogWanted(false, "codon failure")).toBe(false);
    expect(shutdownWatchdogWanted(true, "running integration test")).toBe(false);
  });
});

describe("ShutdownWatchdog", () => {
  test("arm fires once after the window with the given code and an error log", async () => {
    const { wd, exits, logs } = make();
    wd.arm("codon failure", 1);
    expect(wd.armed).toBe(true);
    await sleep(WINDOW_MS * 3);
    expect(exits).toEqual([1]);
    expect(wd.armed).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`exceeded ${WINDOW_MS}ms`);
    expect(logs[0]).toContain('"codon failure"');
    expect(logs[0]).toContain("(code 1)");
  });

  test("arm is idempotent: a second arm keeps the first timer and its code", async () => {
    const { wd, exits } = make();
    wd.arm("all codons completed", 0);
    wd.arm("codon failure", 1);
    await sleep(WINDOW_MS * 3);
    expect(exits).toEqual([0]);
  });

  test("clear cancels the pending exit; clearing when unarmed is harmless", async () => {
    const { wd, exits } = make();
    wd.clear();
    wd.arm("codon failure", 1);
    wd.clear();
    expect(wd.armed).toBe(false);
    await sleep(WINDOW_MS * 3);
    expect(exits).toEqual([]);
  });

  test("reset cancels the old timer and grants a FULL new window", async () => {
    // Finalize-time journal diet: the synchronous trace upload blocked the loop,
    // so the original timer is (nearly) due when reset runs. The diet must get a
    // full window, not the remainder — so nothing fires within the old deadline.
    const { wd, exits } = make();
    wd.arm("all codons completed", 0);
    await sleep(WINDOW_MS * 0.8);
    wd.reset("all codons completed", 0);
    await sleep(WINDOW_MS * 0.6); // past the ORIGINAL deadline
    expect(exits).toEqual([]);
    await sleep(WINDOW_MS * 2); // past the new one
    expect(exits).toEqual([0]);
  });

  test("reset takes the new code", async () => {
    const { wd, exits } = make();
    wd.arm("all codons completed", 0);
    wd.reset("all codons completed", 1);
    await sleep(WINDOW_MS * 3);
    expect(exits).toEqual([1]);
  });

  test("reset with nothing armed stays unarmed (tests never gain a force-exit timer)", async () => {
    const { wd, exits } = make();
    wd.reset("running integration test", 1);
    expect(wd.armed).toBe(false);
    await sleep(WINDOW_MS * 3);
    expect(exits).toEqual([]);
  });

  test("defaults exit to process.exit when not injected", () => {
    // Arm with an absurdly long window and clear immediately: proves the
    // default construction path works without ever letting the timer fire.
    const wd = new ShutdownWatchdog({ timeoutMs: 60_000, log: () => {} });
    wd.arm("codon failure", 1);
    expect(wd.armed).toBe(true);
    wd.clear();
    expect(wd.armed).toBe(false);
  });
});
