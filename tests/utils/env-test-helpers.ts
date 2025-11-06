/**
 * Utility functions for managing environment variables in tests
 */

/**
 * Captures the current state of environment variables
 * @returns A snapshot of process.env that can be restored later
 */
export function captureEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

/**
 * Restores environment variables to a previous state
 * This properly handles additions and deletions by:
 * 1. Removing any keys that weren't in the original
 * 2. Restoring values that were changed
 * 3. Re-adding keys that were deleted
 *
 * @param originalEnv - The environment snapshot to restore to
 */
export function restoreEnv(originalEnv: Record<string, string | undefined>): void {
  // First, remove any keys that were added after the snapshot
  const currentKeys = Object.keys(process.env);
  for (const key of currentKeys) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }

  // Then, restore all values from the original snapshot
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
