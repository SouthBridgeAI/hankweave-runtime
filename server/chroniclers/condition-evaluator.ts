import { getValueByPath } from "../config-validation/chronicler.schema.js";
import type { Condition } from "../types/chronicler-types.js";

/**
 * Evaluates a single condition against event data.
 *
 * Note: eventData is typed as Record<string, unknown> intentionally because:
 * - Event data structure varies by event type (discriminated union)
 * - Condition paths are strings defined at runtime (from JSON config)
 * - We cannot statically verify path existence or value types at compile time
 * - Runtime type checking happens inside the function for each operator
 *
 * Using 'unknown' accurately represents our compile-time knowledge and forces
 * proper runtime validation rather than unsafe type assertions.
 *
 * @param condition - The condition to evaluate
 * @param eventData - The event data to evaluate against (from ServerEvent.data)
 * @returns true if the condition matches, false otherwise
 */
export function evaluateCondition(
  condition: Condition,
  eventData: Record<string, unknown>,
): boolean {
  const actualValue = getValueByPath(eventData, condition.path);

  // If path doesn't exist in the data, condition fails
  if (actualValue === undefined) {
    return false;
  }

  switch (condition.operator) {
    case "equals":
      return actualValue === condition.value;

    case "notEquals":
      return actualValue !== condition.value;

    case "in":
      return (
        Array.isArray(condition.value) && condition.value.includes(actualValue as string | number)
      );

    case "notIn":
      return (
        Array.isArray(condition.value) && !condition.value.includes(actualValue as string | number)
      );

    case "contains": {
      // For string contains
      if (typeof actualValue === "string" && typeof condition.value === "string") {
        return actualValue.includes(condition.value);
      }
      // For array contains
      if (Array.isArray(actualValue)) {
        return actualValue.includes(condition.value);
      }
      return false;
    }

    case "matches": {
      if (typeof actualValue === "string" && typeof condition.value === "string") {
        try {
          const regex = new RegExp(condition.value);
          return regex.test(actualValue);
        } catch {
          // Invalid regex
          return false;
        }
      }
      return false;
    }

    case "greaterThan": {
      return (
        typeof actualValue === "number" &&
        typeof condition.value === "number" &&
        actualValue > condition.value
      );
    }

    case "lessThan": {
      return (
        typeof actualValue === "number" &&
        typeof condition.value === "number" &&
        actualValue < condition.value
      );
    }

    default:
      // Unknown operator
      return false;
  }
}

/**
 * Evaluates multiple conditions against event data
 * All conditions must pass (AND logic)
 * @param conditions Array of conditions to evaluate
 * @param eventData The event data to evaluate against (from ServerEvent.data)
 * @returns true if all conditions match, false otherwise
 */
export function evaluateConditions(
  conditions: Condition[],
  eventData: Record<string, unknown>,
): boolean {
  if (!conditions || conditions.length === 0) {
    return true; // No conditions means always match
  }

  return conditions.every((condition) => evaluateCondition(condition, eventData));
}
