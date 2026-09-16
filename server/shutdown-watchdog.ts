/**
 * Shutdown watchdog: the force-exit backstop for graceful shutdown.
 *
 * Without it, any single awaited shutdown step that never resolves (a wedged
 * process kill, an in-flight SDK stream teardown, a hung sentinel/telemetry
 * flush, a pending state transition) would leave a run that already detected a
 * fatal condition hanging forever instead of exiting.
 *
 * The bound applies per WINDOW, not to the whole shutdown. The runtime re-arms
 * it (`reset`) after phases that block the event loop — the synchronous trace
 * upload — because a timer cannot fire while the loop is blocked, but an
 * overdue timer fires at the very next await and would kill the following phase
 * (the journal diet) mid-flight. Shutdown is therefore bounded by
 * cleanup ≤ window + upload ≤ its own spawnSync timeout + diet ≤ window.
 *
 * Exit-code policy lives in the runtime (it needs run state); this module takes
 * a resolved code. `exit` is injectable so tests never call process.exit.
 */

export interface ShutdownWatchdogDeps {
  /** Length of one window (TIMEOUTS.SHUTDOWN_WATCHDOG_MS in production). */
  timeoutMs: number;
  log: (message: string, level?: "error") => void;
  /** Defaults to process.exit. Inject in tests. */
  exit?: (code: number) => void;
}

/**
 * The one policy the runtime applies before arming: only a shutdown that will
 * exit the process needs a backstop, and the in-process integration-test
 * shutdown must never gain a real force-exit timer.
 */
export function shutdownWatchdogWanted(exitProcess: boolean, reason: string): boolean {
  return exitProcess && reason !== "running integration test";
}

export class ShutdownWatchdog {
  private timer?: NodeJS.Timeout;
  private readonly exit: (code: number) => void;

  constructor(private readonly deps: ShutdownWatchdogDeps) {
    this.exit = deps.exit ?? ((code) => process.exit(code));
  }

  get armed(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Schedule the force-exit. Idempotent: a second arm while one is pending is a
   * no-op (use `reset` for a fresh window). Unref'd so it never keeps the event
   * loop alive on its own.
   */
  arm(reason: string, exitCode: number): void {
    if (this.timer) return;
    const { timeoutMs } = this.deps;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.deps.log(
        `Shutdown watchdog: graceful shutdown exceeded ${timeoutMs}ms for "${reason}" — forcing exit (code ${exitCode})`,
        "error",
      );
      this.exit(exitCode);
    }, timeoutMs);
    this.timer.unref?.();
  }

  /** Cancel the pending force-exit. Safe when nothing is armed. */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Restart with a fresh full window — only if one is armed. A no-op otherwise,
   * so a shutdown that runs without a watchdog stays without one.
   */
  reset(reason: string, exitCode: number): void {
    if (!this.timer) return;
    this.clear();
    this.arm(reason, exitCode);
  }
}
