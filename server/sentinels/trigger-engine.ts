import type { ServerEvent } from "../schemas/event-schemas.js";
import type {
  EventTrigger,
  PatternStep,
  SentinelTrigger,
  SequenceTrigger,
} from "../types/sentinel-types.js";
import type { Logger } from "../utils.js";
import { evaluateConditions } from "./condition-evaluator.js";

/**
 * Base class for trigger engines.
 *
 * Trigger engines evaluate whether incoming events match configured
 * trigger criteria and return matching events for sentinel execution.
 *
 * Implementations:
 * - EventTriggerEngine: Stateless, evaluates each event independently
 * - SequenceTriggerEngine: Stateful, maintains history to detect patterns
 */
export abstract class TriggerEngine {
  /**
   * Process an incoming event against trigger criteria.
   *
   * @param event - Server event to evaluate
   * @returns Object with matched flag and array of matching events
   */
  abstract processEvent(event: ServerEvent): { matched: boolean; events: ServerEvent[] };

  /**
   * Reset engine state.
   * For stateless engines (Event): No-op
   * For stateful engines (Sequence): Clears history and trigger position
   */
  abstract reset(): void;
}

/**
 * Engine for evaluating simple event triggers.
 * Stateless - evaluates each event independently.
 *
 * Note: triggerId is for logging only and may collide between sentinels
 * with identical trigger configurations. This is intentional for grouping
 * related log messages from similar triggers.
 */
export class EventTriggerEngine extends TriggerEngine {
  private triggerId: string;

  constructor(
    private trigger: EventTrigger,
    private logger?: Logger,
  ) {
    super();
    // Note: Non-unique across sentinels - multiple sentinels with same
    // trigger configuration will share this ID for logging purposes
    this.triggerId = `EventTrigger-${trigger.on.join(",")}`;
  }

  processEvent(event: ServerEvent): { matched: boolean; events: ServerEvent[] } {
    // Check if event type matches (including wildcard)
    if (!this.trigger.on.includes(event.type) && !this.trigger.on.includes("*")) {
      return { matched: false, events: [] };
    }

    // Check conditions if any
    if (this.trigger.conditions && this.trigger.conditions.length > 0) {
      const conditionsMet = evaluateConditions(this.trigger.conditions, event.data);
      if (!conditionsMet) {
        return { matched: false, events: [] };
      }
    }

    // Event matches - keep this important log for understanding trigger behavior
    this.logger?.log(`[${this.triggerId}] MATCHED ${event.type}`, "debug");
    return { matched: true, events: [event] };
  }

  reset(): void {
    // Stateless - nothing to reset
  }
}

/**
 * Engine for evaluating sequence triggers.
 *
 * Stateful - maintains history of events matching interest filter and tracks
 * last trigger position to avoid re-matching same sequences.
 *
 * Pattern Matching:
 * - Consecutive mode (default): Matches if events appear back-to-back
 * - Non-consecutive mode: Matches if events appear in order (gaps allowed)
 *
 * Memory Management:
 * - Event history capped at maxHistorySize (1000 events)
 * - Oldest events dropped when limit exceeded
 * - Trigger position tracking prevents duplicate matches
 *
 * Wildcard Support:
 * - Interest filter can include "*" to track all events
 * - Pattern steps can use "*" to match any event type
 */
export class SequenceTriggerEngine extends TriggerEngine {
  private eventHistory: ServerEvent[] = [];
  private lastTriggerEventId: string | null = null;
  private maxHistorySize = 1000; // Prevent unbounded memory growth
  private triggerId: string;

  constructor(
    private trigger: SequenceTrigger,
    private logger?: Logger,
  ) {
    super();
    this.triggerId = `SequenceTrigger-${trigger.pattern.length}steps`;
  }

  /**
   * Process an event and check if it completes a sequence pattern.
   *
   * Processing steps:
   * 1. Add event to history if it matches interest filter
   * 2. Trim history if it exceeds maxHistorySize
   * 3. Check if this is the last event type in interest filter (optimization)
   * 4. Get search window (events since last trigger)
   * 5. Check if pattern matches in search window
   * 6. Update last trigger position if matched
   *
   * @param event - Server event to process
   * @returns Match result with matched flag and matching events
   */
  processEvent(event: ServerEvent): { matched: boolean; events: ServerEvent[] } {
    // Add to history if it matches interest filter (including wildcard)
    if (
      this.trigger.interestFilter.on.includes(event.type) ||
      this.trigger.interestFilter.on.includes("*")
    ) {
      this.eventHistory.push(event);

      // Trim history if too large
      if (this.eventHistory.length > this.maxHistorySize) {
        const beforeSize = this.eventHistory.length;
        this.eventHistory = this.eventHistory.slice(-this.maxHistorySize);
        this.logger?.log(
          `[${this.triggerId}] Trimmed history from ${beforeSize} to ${this.maxHistorySize} events`,
          "debug",
        );
      }
    }

    // Only check for pattern match if this is the last event type in interest filter
    // Exception: when interest filter contains "*", check pattern on every event
    const hasWildcardInterest = this.trigger.interestFilter.on.includes("*");

    if (!hasWildcardInterest) {
      const lastInterestType =
        this.trigger.interestFilter.on[this.trigger.interestFilter.on.length - 1];
      if (event.type !== lastInterestType) {
        return { matched: false, events: [] };
      }
    }

    // Get search window (events after last trigger)
    const searchWindow = this.getSearchWindow();

    // Check if pattern matches
    const matchResult = this.checkPatternMatch(searchWindow);

    if (matchResult.matched) {
      this.logger?.log(
        `[${this.triggerId}] PATTERN MATCHED with ${matchResult.events.length} events`,
        "info",
      );
      // Update last trigger position
      this.lastTriggerEventId = matchResult.events[matchResult.events.length - 1].id;
      return matchResult;
    }

    return { matched: false, events: [] };
  }

  private getSearchWindow(): ServerEvent[] {
    if (!this.lastTriggerEventId) {
      return this.eventHistory;
    }

    // Find index of last trigger event
    const lastIndex = this.eventHistory.findIndex((e) => e.id === this.lastTriggerEventId);
    if (lastIndex === -1) {
      // Last trigger event has been trimmed from history
      return this.eventHistory;
    }

    // Return events after last trigger
    return this.eventHistory.slice(lastIndex + 1);
  }

  private checkPatternMatch(events: ServerEvent[]): { matched: boolean; events: ServerEvent[] } {
    const pattern = this.trigger.pattern;
    const consecutive = this.trigger.options?.consecutive !== false; // Default true

    if (consecutive) {
      return this.checkConsecutivePattern(events, pattern);
    } else {
      return this.checkNonConsecutivePattern(events, pattern);
    }
  }

  /**
   * Check if events match pattern in consecutive order.
   *
   * Matches if the TAIL of the event array matches the pattern exactly.
   * All pattern steps must match in order with no gaps.
   *
   * Example:
   * Pattern: [toolUse, toolResult]
   * Events: [action, toolUse, toolResult, action]
   * Result: MATCH (tail matches)
   *
   * @param events - Events to check
   * @param pattern - Pattern steps to match
   * @returns Match result
   */
  private checkConsecutivePattern(
    events: ServerEvent[],
    pattern: PatternStep[],
  ): { matched: boolean; events: ServerEvent[] } {
    // Need at least as many events as pattern steps
    if (events.length < pattern.length) {
      return { matched: false, events: [] };
    }

    // Check if the tail matches the pattern
    const tailEvents = events.slice(-pattern.length);
    const matchedEvents: ServerEvent[] = [];

    for (let i = 0; i < pattern.length; i++) {
      const event = tailEvents[i];
      const step = pattern[i];

      // Check event type (including wildcard)
      if (step.type !== "*" && event.type !== step.type) {
        return { matched: false, events: [] };
      }

      // Check conditions
      if (step.conditions && !evaluateConditions(step.conditions, event.data)) {
        return { matched: false, events: [] };
      }

      matchedEvents.push(event);
    }

    return { matched: true, events: matchedEvents };
  }

  /**
   * Check if events match pattern in non-consecutive order.
   *
   * Matches if pattern steps appear in order, but gaps are allowed.
   * Uses greedy matching (first occurrence of each step).
   *
   * Example:
   * Pattern: [toolUse, toolResult]
   * Events: [action, toolUse, action, action, toolResult, action]
   * Result: MATCH (pattern found with gaps)
   *
   * @param events - Events to check
   * @param pattern - Pattern steps to match
   * @returns Match result
   */
  private checkNonConsecutivePattern(
    events: ServerEvent[],
    pattern: PatternStep[],
  ): { matched: boolean; events: ServerEvent[] } {
    const matchedEvents: ServerEvent[] = [];
    let patternIndex = 0;
    let eventIndex = 0;

    while (patternIndex < pattern.length && eventIndex < events.length) {
      const event = events[eventIndex];
      const step = pattern[patternIndex];

      // Check if this event matches the current pattern step (including wildcard)
      if (step.type === "*" || event.type === step.type) {
        // Check conditions
        if (!step.conditions || evaluateConditions(step.conditions, event.data)) {
          matchedEvents.push(event);
          patternIndex++;
        }
      }

      eventIndex++;
    }

    // Check if we matched the entire pattern
    if (patternIndex === pattern.length) {
      return { matched: true, events: matchedEvents };
    }

    return { matched: false, events: [] };
  }

  reset(): void {
    this.eventHistory = [];
    this.lastTriggerEventId = null;
  }
}

/**
 * Factory function to create the appropriate trigger engine
 */
export function createTriggerEngine(trigger: SentinelTrigger, logger?: Logger): TriggerEngine {
  switch (trigger.type) {
    case "event":
      return new EventTriggerEngine(trigger, logger);
    case "sequence":
      return new SequenceTriggerEngine(trigger, logger);
    default: {
      const exhaustiveCheck: never = trigger;
      // This should never happen due to exhaustive check, but TypeScript needs it
      throw new Error(`Unknown trigger type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
