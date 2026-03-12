/**
 * Idle timeout utility for wrapping async event iterators.
 *
 * Detects when an underlying agent has stopped producing events
 * and throws an error after a configurable duration of inactivity.
 */

export class IdleTimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Idle timeout: no events received for ${timeoutMs}ms`);
    this.name = "IdleTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Busy-step stall timeout.
 *
 * Distinct from a plain idle timeout: this indicates that the shim observed a
 * clear "work has started" signal (for example a step/turn start event), but
 * then saw no follow-up activity for an unusually long time.
 */
export class BusyStepTimeoutError extends Error {
  public readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Busy-step stall timeout: no observed activity for ${timeoutMs}ms`);
    this.name = "BusyStepTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export type StreamActivityState = "idle" | "busy";

export interface AdaptiveTimeoutController {
  markBusy(): void;
  markIdle(): void;
  readonly state: StreamActivityState;
}

export interface AdaptiveTimeoutOptions<T> {
  idleTimeoutMs: number;
  busyTimeoutMs?: number;
  onEvent?: (event: T, controller: AdaptiveTimeoutController) => void;
}

/**
 * Wraps an async iterable with an idle timeout. If no event is received
 * within `timeoutMs` milliseconds, throws an `IdleTimeoutError`.
 *
 * The timer resets on each received event, so long-running operations
 * that produce regular events will not be interrupted.
 */
export async function* withIdleTimeout<T>(
  events: AsyncIterable<T>,
  timeoutMs: number,
): AsyncGenerator<T> {
  const iterator = events[Symbol.asyncIterator]();
  try {
    while (true) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(new IdleTimeoutError(timeoutMs));
            }, timeoutMs);
          }),
        ]);
        if (result.done) break;
        yield result.value;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  } finally {
    // Fire-and-forget: don't await because the iterator may be stuck
    // on a hung promise (which is exactly why we're timing out).
    // In the normal completion case, return() on a finished iterator is a no-op.
    void iterator.return?.();
  }
}

/**
 * Adaptive timeout wrapper for sparse agent protocols.
 *
 * Some agents emit a "step started" or similar lifecycle event and then stay
 * quiet while the underlying model is still busy. For these protocols, a plain
 * event-gap timeout can create false positives. This helper lets the shim widen
 * the timeout window while a step is clearly in progress.
 */
export async function* withAdaptiveTimeout<T>(
  events: AsyncIterable<T>,
  options: AdaptiveTimeoutOptions<T>,
): AsyncGenerator<T> {
  const iterator = events[Symbol.asyncIterator]();
  // Explicit annotation prevents TS control-flow narrowing across the closure boundary
  let state = "idle" as StreamActivityState;
  const busyTimeoutMs = Math.max(
    options.busyTimeoutMs ?? options.idleTimeoutMs,
    options.idleTimeoutMs,
  );

  const controller: AdaptiveTimeoutController = {
    markBusy() {
      state = "busy";
    },
    markIdle() {
      state = "idle";
    },
    get state() {
      return state;
    },
  };

  try {
    while (true) {
      const timeoutMs = state === "busy" ? busyTimeoutMs : options.idleTimeoutMs;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          iterator.next(),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(
                state === "busy"
                  ? new BusyStepTimeoutError(timeoutMs)
                  : new IdleTimeoutError(timeoutMs),
              );
            }, timeoutMs);
          }),
        ]);
        if (result.done) break;
        options.onEvent?.(result.value, controller);
        yield result.value;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  } finally {
    void iterator.return?.();
  }
}
