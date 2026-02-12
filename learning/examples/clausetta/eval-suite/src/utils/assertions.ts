import type { TestError } from "../types.js";

/**
 * Custom assertion error with context
 */
export class AssertionError extends Error {
  expected?: string;
  actual?: string;
  context?: Record<string, unknown>;

  constructor(message: string, options?: { expected?: string; actual?: string; context?: Record<string, unknown> }) {
    super(message);
    this.name = "AssertionError";
    this.expected = options?.expected;
    this.actual = options?.actual;
    this.context = options?.context;
  }

  toTestError(): TestError {
    return {
      message: this.message,
      expected: this.expected,
      actual: this.actual,
      context: this.context,
    };
  }
}

/**
 * Assert a condition is true
 */
export function assert(
  condition: boolean,
  message: string,
  options?: { expected?: string; actual?: string; context?: Record<string, unknown> }
): asserts condition {
  if (!condition) {
    throw new AssertionError(message, options);
  }
}

/**
 * Assert two values are equal
 */
export function assertEqual<T>(
  actual: T,
  expected: T,
  message: string,
  context?: Record<string, unknown>
): void {
  if (actual !== expected) {
    throw new AssertionError(message, {
      expected: String(expected),
      actual: String(actual),
      context,
    });
  }
}

/**
 * Assert a string contains a substring (case-insensitive)
 */
export function assertContains(
  haystack: string,
  needle: string,
  message: string,
  context?: Record<string, unknown>
): void {
  if (!haystack.toLowerCase().includes(needle.toLowerCase())) {
    throw new AssertionError(message, {
      expected: `String containing "${needle}"`,
      actual: haystack.length > 200 ? haystack.slice(0, 200) + "..." : haystack,
      context,
    });
  }
}

/**
 * Assert a value matches a regex
 */
export function assertMatches(
  value: string,
  pattern: RegExp,
  message: string,
  context?: Record<string, unknown>
): void {
  if (!pattern.test(value)) {
    throw new AssertionError(message, {
      expected: `String matching ${pattern}`,
      actual: value,
      context,
    });
  }
}

/**
 * Assert a value is defined (not null or undefined)
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message: string,
  context?: Record<string, unknown>
): asserts value is T {
  if (value === null || value === undefined) {
    throw new AssertionError(message, {
      expected: "Defined value",
      actual: String(value),
      context,
    });
  }
}

/**
 * Assert an array has at least n elements
 */
export function assertMinLength(
  array: unknown[],
  minLength: number,
  message: string,
  context?: Record<string, unknown>
): void {
  if (array.length < minLength) {
    throw new AssertionError(message, {
      expected: `Array with at least ${minLength} elements`,
      actual: `Array with ${array.length} elements`,
      context,
    });
  }
}

/**
 * Assert array includes a value
 */
export function assertIncludes<T>(
  array: T[],
  value: T,
  message: string,
  context?: Record<string, unknown>
): void {
  if (!array.includes(value)) {
    throw new AssertionError(message, {
      expected: `Array including ${JSON.stringify(value)}`,
      actual: JSON.stringify(array),
      context,
    });
  }
}

