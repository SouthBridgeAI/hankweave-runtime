import type { ServerEvent } from "../schemas/event-schemas.js";
import type { ChroniclerConfig } from "../types/chronicler-types.js";
import type { TriggerEngine } from "./trigger-engine.js";
import { createTriggerEngine } from "./trigger-engine.js";
import type { Logger } from "../utils.js";

/**
 * Represents a single running Chronicler instance.
 * Manages its own trigger engine and execution strategy.
 */
export class Chronicler {
  private triggerEngine: TriggerEngine;
  private pendingEvents: ServerEvent[] = [];
  private debounceTimer?: Timer;
  private timeWindowTimer?: Timer;
  private eventCount = 0;
  private timeWindowStarted = false;
  private readonly MAX_BUFFER_SIZE = 10000;

  constructor(
    private config: ChroniclerConfig,
    private llmCall: (id: string, events: ServerEvent[]) => Promise<unknown>,
    private logger?: Logger,
  ) {
    this.triggerEngine = createTriggerEngine(config.trigger, logger);
    this.logger?.log(`[Chronicler:${config.id}] Initialized with ${config.execution.strategy} strategy`, 'debug');
  }

  /**
   * Handle an incoming event and check if it triggers this chronicler.
   */
  public handleEvent(event: ServerEvent): void {
    const triggerResult = this.triggerEngine.processEvent(event);

    if (triggerResult.matched) {
      this.logger?.log(
        `[Chronicler:${this.config.id}] ✓ Trigger MATCHED for ${event.type} - Strategy: ${this.config.execution.strategy}, Events: ${triggerResult.events.length}`,
        'debug'
      );

      const eventsToProcess = triggerResult.events;

      switch (this.config.execution.strategy) {
        case "immediate": {
          this.logger?.log(
            `[Chronicler:${this.config.id}] Executing immediately with ${eventsToProcess.length} events`,
            'info'
          );
          const startTime = Date.now();
          // Non-blocking call with error handling
          this.llmCall(this.config.id, eventsToProcess)
            .then(() => {
              this.logger?.log(
                `[Chronicler:${this.config.id}] Immediate execution completed in ${Date.now() - startTime}ms`,
                'debug'
              );
            })
            .catch(error => {
              console.error(`[Chronicler ${this.config.id}] Error in immediate LLM call:`, error);
              this.logger?.log(`[Chronicler:${this.config.id}] Error in immediate LLM call: ${error}`, 'error');
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
   * Execute with debounce - wait for quiet period before executing.
   */
  private executeDebounce(events: ServerEvent[], milliseconds: number): void {
    const wasDebouncing = !!this.debounceTimer;
    this.pendingEvents.push(...events);

    this.logger?.log(
      `[Chronicler:${this.config.id}] Debounce: New events: ${events.length}, Total pending: ${this.pendingEvents.length}, Timer active: ${wasDebouncing}, Delay: ${milliseconds}ms`,
      'debug'
    );

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      const eventCount = this.pendingEvents.length;
      if (eventCount > 0) {
        this.logger?.log(
          `[Chronicler:${this.config.id}] Debounce timer fired, processing ${eventCount} events`,
          'info'
        );

        const eventsToProcess = [...this.pendingEvents];
        this.pendingEvents = [];
        const startTime = Date.now();

        this.llmCall(this.config.id, eventsToProcess)
          .then(() => {
            this.logger?.log(
              `[Chronicler:${this.config.id}] Debounce execution completed: Events: ${eventCount}, Duration: ${Date.now() - startTime}ms`,
              'debug'
            );
          })
          .catch(error => {
            console.error(`[Chronicler ${this.config.id}] Error in debounced LLM call:`, error);
            this.logger?.log(`[Chronicler:${this.config.id}] Error in debounced LLM call: ${error}`, 'error');
          });
      }
    }, milliseconds);
  }

  /**
   * Execute after accumulating a certain count of events.
   */
  private executeCount(events: ServerEvent[], threshold: number): void {
    const previousCount = this.eventCount;
    this.pendingEvents.push(...events);
    this.eventCount += events.length;

    this.logger?.log(
      `[Chronicler:${this.config.id}] Count: New events: ${events.length}, Previous count: ${previousCount}, Current count: ${this.eventCount}, Threshold: ${threshold}`,
      'debug'
    );

    // Use a while loop to process all full batches
    while (this.eventCount >= threshold) {
      const eventsToProcess = this.pendingEvents.splice(0, threshold);
      this.eventCount -= threshold;

      this.logger?.log(
        `[Chronicler:${this.config.id}] Count threshold reached: Processing ${eventsToProcess.length} events, Remaining: ${this.pendingEvents.length}`,
        'info'
      );

      const startTime = Date.now();
      // Non-blocking call with error handling
      this.llmCall(this.config.id, eventsToProcess)
        .then(() => {
          this.logger?.log(
            `[Chronicler:${this.config.id}] Count execution completed in ${Date.now() - startTime}ms`,
            'debug'
          );
        })
        .catch(error => {
          console.error(`[Chronicler ${this.config.id}] Error in count-based LLM call:`, error);
          this.logger?.log(`[Chronicler:${this.config.id}] Error in count-based LLM call: ${error}`, 'error');
        });
    }
  }

  /**
   * Execute within time windows.
   */
  private executeTimeWindow(events: ServerEvent[], milliseconds: number): void {
    // Add events to the buffer
    this.pendingEvents.push(...events);

    // Start the periodic timer if not already running
    if (!this.timeWindowTimer) {
      this.logger?.log(
        `[Chronicler:${this.config.id}] Time window STARTED: Duration: ${milliseconds}ms, Initial events: ${this.pendingEvents.length}`,
        'info'
      );
      this.startTimeWindowLoop(milliseconds);
    } else {
      this.logger?.log(
        `[Chronicler:${this.config.id}] Time window active, added ${events.length} events (total: ${this.pendingEvents.length})`,
        'debug'
      );
    }
  }

  /**
   * Start a periodic time window loop that processes events at regular intervals.
   */
  private startTimeWindowLoop(milliseconds: number): void {
    // Clear any existing timer to be safe
    if (this.timeWindowTimer) {
      clearTimeout(this.timeWindowTimer);
    }

    const windowStartTime = Date.now();
    this.timeWindowTimer = setTimeout(() => {
      const eventCount = this.pendingEvents.length;

      if (eventCount > 0) {
        this.logger?.log(
          `[Chronicler:${this.config.id}] Time window CLOSING: Duration: ${Date.now() - windowStartTime}ms, Events collected: ${eventCount}`,
          'info'
        );

        // Copy and clear the buffer BEFORE the async call
        const eventsToProcess = [...this.pendingEvents];
        this.pendingEvents = [];
        const startTime = Date.now();

        // Non-blocking call with error handling
        this.llmCall(this.config.id, eventsToProcess)
          .then(() => {
            this.logger?.log(
              `[Chronicler:${this.config.id}] Time window execution completed: Events: ${eventCount}, Duration: ${Date.now() - startTime}ms`,
              'debug'
            );
          })
          .catch(error => {
            console.error(`[Chronicler ${this.config.id}] Error in timeWindow LLM call:`, error);
            this.logger?.log(`[Chronicler:${this.config.id}] Error in timeWindow LLM call: ${error}`, 'error');
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
      `[Chronicler:${this.config.id}] FLUSH requested: Pending events: ${this.pendingEvents.length}, Debounce timer active: ${!!this.debounceTimer}, Time window active: ${!!this.timeWindowTimer}`,
      'info'
    );

    // Clear any timers
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    if (this.timeWindowTimer) {
      clearTimeout(this.timeWindowTimer);
      this.timeWindowTimer = undefined;
      this.timeWindowStarted = false;
    }

    // Process any pending events
    if (this.pendingEvents.length > 0) {
      const eventCount = this.pendingEvents.length;
      const eventsToProcess = [...this.pendingEvents];
      this.pendingEvents = [];
      this.eventCount = 0;

      this.logger?.log(
        `[Chronicler:${this.config.id}] Flushing ${eventCount} pending events`,
        'info'
      );

      try {
        await this.llmCall(this.config.id, eventsToProcess);
        this.logger?.log(
          `[Chronicler:${this.config.id}] Flush completed successfully`,
          'debug'
        );
      } catch (error) {
        this.logger?.log(
          `[Chronicler:${this.config.id}] Error during flush: ${error}`,
          'error'
        );
        throw error;
      }
    } else {
      this.logger?.log(
        `[Chronicler:${this.config.id}] Flush completed - no pending events`,
        'debug'
      );
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
    // Clear all timers
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    if (this.timeWindowTimer) {
      clearTimeout(this.timeWindowTimer);
      this.timeWindowTimer = undefined;
    }

    // Clear pending events and reset state
    this.pendingEvents = [];
    this.eventCount = 0;
    this.timeWindowStarted = false;

    // Reset trigger engine
    this.triggerEngine.reset();
  }
}
