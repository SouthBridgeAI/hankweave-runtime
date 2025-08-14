import type { ServerEvent } from "../schemas/event-schemas.js";
import type { ChroniclerConfig } from "../types/chronicler-types.js";
import type { Logger } from "../utils.js";
import type { TriggerEngine } from "./trigger-engine.js";
import { createTriggerEngine } from "./trigger-engine.js";

/**
 * Represents a single running Chronicler instance.
 * Manages its own trigger engine and execution strategy.
 */
export class Chronicler {
  private triggerEngine: TriggerEngine;
  private pendingEvents: ServerEvent[] = [];
  private debounceTimer?: Timer;
  private timeWindowTimer?: Timer;
  private isFlushing = false;
  private readonly MAX_BUFFER_SIZE = 10000;

  constructor(
    private config: ChroniclerConfig,
    private llmCall: (id: string, events: ServerEvent[]) => Promise<unknown>,
    private logger?: Logger,
  ) {
    this.triggerEngine = createTriggerEngine(config.trigger, logger);
    this.logger?.log(
      `[Chronicler:${config.id}] Initialized with ${config.execution.strategy} strategy`,
      "debug",
    );
  }

  /**
   * Handle an incoming event and check if it triggers this chronicler.
   */
  public handleEvent(event: ServerEvent): void {
    if (this.isFlushing) {
      this.logger?.log(
        `[Chronicler:${this.config.id}] Skipping event ${event.type} due to active flush`,
        "debug",
      );
      return;
    }

    const triggerResult = this.triggerEngine.processEvent(event);

    if (triggerResult.matched) {
      this.logger?.log(
        `[Chronicler:${this.config.id}] ✓ Trigger MATCHED for ${event.type} - Strategy: ${this.config.execution.strategy}, Events: ${triggerResult.events.length}`,
        "debug",
      );

      const eventsToProcess = triggerResult.events;

      switch (this.config.execution.strategy) {
        case "immediate": {
          this.logger?.log(
            `[Chronicler:${this.config.id}] Executing immediately with ${eventsToProcess.length} events`,
            "info",
          );
          const startTime = Date.now();
          this.llmCall(this.config.id, eventsToProcess)
            .then(() => {
              this.logger?.log(
                `[Chronicler:${this.config.id}] Immediate execution completed in ${
                  Date.now() - startTime
                }ms`,
                "debug",
              );
            })
            .catch((error) => {
              console.error(`[Chronicler ${this.config.id}] Error in immediate LLM call:`, error);
              this.logger?.log(
                `[Chronicler:${this.config.id}] Error in immediate LLM call: ${error}`,
                "error",
              );
            });
          break;
        }
        case "debounce":
          this.executeDebounce(eventsToProcess, this.config.execution.milliseconds);
          break;
        case "count":
          this.executeCount(eventsToProcess, this.config.execution.threshold);
          break;
        case "timeWindow":
          this.executeTimeWindow(eventsToProcess, this.config.execution.milliseconds);
          break;
      }
    }
  }

  /**
   * Adds events to the pending buffer while enforcing a maximum size.
   */
  private addToBuffer(events: ServerEvent[]): void {
    this.pendingEvents.push(...events);

    // If the buffer exceeds the max size, we drop the oldest events.
    if (this.pendingEvents.length > this.MAX_BUFFER_SIZE) {
      const removedCount = this.pendingEvents.length - this.MAX_BUFFER_SIZE;
      this.pendingEvents.splice(0, removedCount);
      this.logger?.log(
        `[Chronicler:${this.config.id}] Buffer overflow. Dropped ${removedCount} oldest events. Current size: ${this.pendingEvents.length}`,
        "info",
      );
    }
  }

  /**
   * Execute with debounce - wait for quiet period before executing.
   */
  private executeDebounce(events: ServerEvent[], milliseconds: number): void {
    const wasDebouncing = !!this.debounceTimer;
    this.addToBuffer(events);

    this.logger?.log(
      `[Chronicler:${this.config.id}] Debounce: New events: ${events.length}, Total pending: ${this.pendingEvents.length}, Timer active: ${wasDebouncing}, Delay: ${milliseconds}ms`,
      "debug",
    );

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined; // Clear the timer ID before executing
      const eventCount = this.pendingEvents.length;
      if (eventCount > 0) {
        this.logger?.log(
          `[Chronicler:${this.config.id}] Debounce timer fired, processing ${eventCount} events`,
          "info",
        );

        const eventsToProcess = [...this.pendingEvents];
        this.pendingEvents = [];
        const startTime = Date.now();

        this.llmCall(this.config.id, eventsToProcess)
          .then(() => {
            this.logger?.log(
              `[Chronicler:${this.config.id}] Debounce execution completed: Events: ${eventCount}, Duration: ${
                Date.now() - startTime
              }ms`,
              "debug",
            );
          })
          .catch((error) => {
            console.error(`[Chronicler ${this.config.id}] Error in debounced LLM call:`, error);
            this.logger?.log(
              `[Chronicler:${this.config.id}] Error in debounced LLM call: ${error}`,
              "error",
            );
          });
      }
    }, milliseconds);
  }

  /**
   * Execute after accumulating a certain count of events.
   */
  private executeCount(events: ServerEvent[], threshold: number): void {
    const previousCount = this.pendingEvents.length;
    this.addToBuffer(events);

    this.logger?.log(
      `[Chronicler:${this.config.id}] Count: New events: ${
        events.length
      }, Previous count: ${previousCount}, Current count: ${
        this.pendingEvents.length
      }, Threshold: ${threshold}`,
      "debug",
    );

    while (this.pendingEvents.length >= threshold) {
      const eventsToProcess = this.pendingEvents.splice(0, threshold);

      this.logger?.log(
        `[Chronicler:${this.config.id}] Count threshold reached: Processing ${
          eventsToProcess.length
        } events, Remaining: ${this.pendingEvents.length}`,
        "info",
      );

      const startTime = Date.now();
      this.llmCall(this.config.id, eventsToProcess)
        .then(() => {
          this.logger?.log(
            `[Chronicler:${this.config.id}] Count execution completed in ${Date.now() - startTime}ms`,
            "debug",
          );
        })
        .catch((error) => {
          console.error(`[Chronicler ${this.config.id}] Error in count-based LLM call:`, error);
          this.logger?.log(
            `[Chronicler:${this.config.id}] Error in count-based LLM call: ${error}`,
            "error",
          );
        });
    }
  }

  /**
   * Add events to a buffer for time-based execution.
   */
  private executeTimeWindow(events: ServerEvent[], milliseconds: number): void {
    this.addToBuffer(events);

    if (!this.timeWindowTimer) {
      this.logger?.log(
        `[Chronicler:${this.config.id}] Time window STARTED: Duration: ${milliseconds}ms, Initial events: ${this.pendingEvents.length}`,
        "info",
      );
      this.startTimeWindowLoop(milliseconds);
    } else {
      this.logger?.log(
        `[Chronicler:${this.config.id}] Time window active, added ${events.length} events (total: ${this.pendingEvents.length})`,
        "debug",
      );
    }
  }

  /**
   * Start a periodic time window loop that processes events at regular intervals.
   */
  private startTimeWindowLoop(milliseconds: number): void {
    if (this.timeWindowTimer) {
      clearTimeout(this.timeWindowTimer);
    }

    const windowStartTime = Date.now();
    this.timeWindowTimer = setTimeout(() => {
      const eventCount = this.pendingEvents.length;
      if (eventCount > 0) {
        this.logger?.log(
          `[Chronicler:${this.config.id}] Time window CLOSING: Duration: ${
            Date.now() - windowStartTime
          }ms, Events collected: ${eventCount}`,
          "info",
        );

        const eventsToProcess = [...this.pendingEvents];
        this.pendingEvents = [];
        const startTime = Date.now();

        this.llmCall(this.config.id, eventsToProcess)
          .then(() => {
            this.logger?.log(
              `[Chronicler:${this.config.id}] Time window execution completed: Events: ${eventCount}, Duration: ${
                Date.now() - startTime
              }ms`,
              "debug",
            );
          })
          .catch((error) => {
            console.error(`[Chronicler ${this.config.id}] Error in timeWindow LLM call:`, error);
            this.logger?.log(
              `[Chronicler:${this.config.id}] Error in timeWindow LLM call: ${error}`,
              "error",
            );
          });
      }

      // Schedule the next execution
      this.startTimeWindowLoop(milliseconds);
    }, milliseconds);
  }

  /**
   * Flush any pending events (for debounce/timeWindow strategies).
   */
  public async flush(): Promise<void> {
    this.logger?.log(
      `[Chronicler:${this.config.id}] FLUSH requested: Pending events: ${
        this.pendingEvents.length
      }, Debounce timer active: ${!!this.debounceTimer}, Time window active: ${!!this.timeWindowTimer}`,
      "info",
    );

    this.isFlushing = true;
    this.destroyTimers(); // Clear timers without processing.

    if (this.pendingEvents.length > 0) {
      const eventCount = this.pendingEvents.length;
      const eventsToProcess = [...this.pendingEvents];
      this.pendingEvents = [];

      this.logger?.log(
        `[Chronicler:${this.config.id}] Flushing ${eventCount} pending events`,
        "info",
      );

      try {
        await this.llmCall(this.config.id, eventsToProcess);
        this.logger?.log(`[Chronicler:${this.config.id}] Flush completed successfully`, "debug");
      } catch (error) {
        this.logger?.log(`[Chronicler:${this.config.id}] Error during flush: ${error}`, "error");
        // Don't re-throw from flush, just log it.
      }
    } else {
      this.logger?.log(
        `[Chronicler:${this.config.id}] Flush completed - no pending events`,
        "debug",
      );
    }

    this.isFlushing = false;
  }

  /**
   * Helper to clear all active timers.
   */
  private destroyTimers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.timeWindowTimer) {
      clearTimeout(this.timeWindowTimer);
      this.timeWindowTimer = undefined;
    }
  }

  /**
   * Get the chronicler's ID.
   */
  public getId(): string {
    return this.config.id;
  }

  /**
   * Clean up all resources when destroying the chronicler.
   * Stops all timers and clears pending events.
   */
  public destroy(): void {
    this.destroyTimers();
    this.pendingEvents = [];
    this.triggerEngine.reset();
    this.logger?.log(`[Chronicler:${this.config.id}] Destroyed.`, "debug");
  }
}
