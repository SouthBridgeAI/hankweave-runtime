import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";

export class SessionEventQueue<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private done = false;
  private error: Error | undefined;

  push(event: T): void {
    if (this.done) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: event, done: false });
      return;
    }

    this.queue.push(event);
  }

  fail(error: Error): void {
    if (this.done) {
      return;
    }

    this.done = true;
    this.error = error;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  close(): void {
    if (this.done) {
      return;
    }

    this.done = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift();
          if (value === undefined) {
            return { value: undefined as never, done: true };
          }
          return { value, done: false };
        }

        if (this.error) {
          throw this.error;
        }

        if (this.done) {
          return { value: undefined as never, done: true };
        }

        return await new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
      return: async () => {
        this.close();
        return { value: undefined as never, done: true };
      },
    };
  }
}

export type PiWatchdogEvent = Pick<AgentSessionEvent, "type">;

export function isPiWatchdogActivityEvent(event: PiWatchdogEvent): boolean {
  switch (event.type) {
    case "agent_start":
    case "turn_start":
    case "message_start":
    case "message_update":
    case "message_end":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "turn_end":
    case "agent_end":
    case "auto_retry_start":
    case "auto_retry_end":
    case "auto_compaction_start":
    case "auto_compaction_end":
      return true;
    default:
      return false;
  }
}

export function applyPiWatchdogEvent(
  event: PiWatchdogEvent,
  controller: {
    markBusy(): void;
    markIdle(): void;
  },
): void {
  switch (event.type) {
    case "turn_start":
    case "message_start":
    case "message_update":
    case "message_end":
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
    case "auto_retry_start":
    case "auto_retry_end":
    case "auto_compaction_start":
    case "auto_compaction_end":
      controller.markBusy();
      break;
    case "turn_end":
    case "agent_end":
      controller.markIdle();
      break;
  }
}
