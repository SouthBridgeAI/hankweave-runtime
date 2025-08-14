import type {
  ChroniclerTrigger,
  EventTrigger,
  PatternStep,
  SequenceTrigger,
} from "../types/chronicler-types.js";
import type { ServerEvent } from "../types/types.js";
import { evaluateConditions } from "./condition-evaluator.js";

/**
 * Base class for trigger engines
 */
export abstract class TriggerEngine {
  abstract processEvent(event: ServerEvent): { matched: boolean; events: ServerEvent[] };
  abstract reset(): void;
}

/**
 * Engine for evaluating simple event triggers
 * Stateless - evaluates each event independently
 */
export class EventTriggerEngine extends TriggerEngine {
  constructor(private trigger: EventTrigger) {
    super();
  }

  processEvent(event: ServerEvent): { matched: boolean; events: ServerEvent[] } {
    // Check if event type matches
    if (!this.trigger.on.includes(event.type)) {
      return { matched: false, events: [] };
    }

    // Check conditions if any
    if (this.trigger.conditions && this.trigger.conditions.length > 0) {
      const conditionsMet = evaluateConditions(this.trigger.conditions, event.data);
      if (!conditionsMet) {
        return { matched: false, events: [] };
      }
    }

    // Event matches
    return { matched: true, events: [event] };
  }

  reset(): void {
    // Stateless - nothing to reset
  }
}

/**
 * Engine for evaluating sequence triggers
 * Stateful - maintains history of events and last trigger position
 */
export class SequenceTriggerEngine extends TriggerEngine {
  private eventHistory: ServerEvent[] = [];
  private lastTriggerEventId: string | null = null;
  private maxHistorySize = 1000; // Prevent unbounded memory growth

  constructor(private trigger: SequenceTrigger) {
    super();
  }

  processEvent(event: ServerEvent): { matched: boolean; events: ServerEvent[] } {
    // Add to history if it matches interest filter
    if (this.trigger.interestFilter.on.includes(event.type)) {
      this.eventHistory.push(event);

      // Trim history if too large
      if (this.eventHistory.length > this.maxHistorySize) {
        this.eventHistory = this.eventHistory.slice(-this.maxHistorySize);
      }
    }

    // Only check for pattern match if this is the last event type in interest filter
    const lastInterestType =
      this.trigger.interestFilter.on[this.trigger.interestFilter.on.length - 1];
    if (event.type !== lastInterestType) {
      return { matched: false, events: [] };
    }

    // Get search window (events after last trigger)
    const searchWindow = this.getSearchWindow();

    // Check if pattern matches
    const matchResult = this.checkPatternMatch(searchWindow);

    if (matchResult.matched) {
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

      // Check event type
      if (event.type !== step.type) {
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

      // Check if this event matches the current pattern step
      if (event.type === step.type) {
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
export function createTriggerEngine(trigger: ChroniclerTrigger): TriggerEngine {
  switch (trigger.type) {
    case "event":
      return new EventTriggerEngine(trigger);
    case "sequence":
      return new SequenceTriggerEngine(trigger);
    default: {
      const exhaustiveCheck: never = trigger;
      // This should never happen due to exhaustive check, but TypeScript needs it
      throw new Error(`Unknown trigger type: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}
