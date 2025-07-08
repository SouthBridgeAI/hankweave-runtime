import * as fs from "fs";
import * as path from "path";

export const TEST_AREA_PATH = path.join("tests", "test-area");

/**
 * Ensures the test area directory exists and is clean
 */
export async function ensureTestArea(): Promise<void> {
  // Create test-area directory if it doesn't exist
  await fs.promises.mkdir(TEST_AREA_PATH, { recursive: true });
}

/**
 * Gets a unique test directory path within the test area
 */
export function getTestDir(prefix: string): string {
  return path.join(TEST_AREA_PATH, `${prefix}-${Date.now()}`);
}