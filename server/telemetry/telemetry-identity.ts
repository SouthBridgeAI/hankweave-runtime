/**
 * Telemetry Identity Management
 *
 * Manages the anonymous client ID for telemetry.
 * Stored at ~/.hankweave/telemetry.json (or $HANKWEAVE_CACHE_DIR/telemetry.json).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TelemetryIdentity } from "./telemetry-types.js";

// =============================================================================
// Constants
// =============================================================================

function getTelemetryDir(): string {
  const cacheDir = process.env.HANKWEAVE_CACHE_DIR;
  if (cacheDir) {
    return cacheDir;
  }
  return path.join(os.homedir(), ".hankweave");
}

function getTelemetryFilePath(): string {
  return path.join(getTelemetryDir(), "telemetry.json");
}

// =============================================================================
// Identity Management
// =============================================================================

/**
 * Get or create a persistent anonymous client ID.
 *
 * On first call, generates a random UUID v4 and persists it.
 * On subsequent calls, reads and returns the existing ID.
 *
 * @returns The anonymous client ID
 */
export async function getOrCreateClientId(): Promise<string> {
  const filePath = getTelemetryFilePath();

  try {
    // Try to read existing identity
    const content = await fs.promises.readFile(filePath, "utf-8");
    const identity: TelemetryIdentity = JSON.parse(content);
    if (identity.clientId) {
      return identity.clientId;
    }
  } catch {
    // File doesn't exist or is invalid - create new identity
  }

  // Generate new identity
  const identity: TelemetryIdentity = {
    clientId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };

  // Persist it
  try {
    const dir = getTelemetryDir();
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(identity, null, 2));
  } catch {
    // Silent fail - telemetry identity is best-effort
  }

  return identity.clientId;
}

/**
 * Check if this is the first run (no telemetry.json exists).
 */
export function isFirstRun(): boolean {
  const filePath = getTelemetryFilePath();
  return !fs.existsSync(filePath);
}

/**
 * Check if the first-run notice has been shown.
 */
export async function hasNoticeBeenShown(): Promise<boolean> {
  const filePath = getTelemetryFilePath();

  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const identity: TelemetryIdentity = JSON.parse(content);
    return !!identity.noticeShownAt;
  } catch {
    return false;
  }
}

/**
 * Mark the first-run notice as shown.
 */
export async function markNoticeShown(): Promise<void> {
  const filePath = getTelemetryFilePath();

  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    const identity: TelemetryIdentity = JSON.parse(content);
    identity.noticeShownAt = new Date().toISOString();
    await fs.promises.writeFile(filePath, JSON.stringify(identity, null, 2));
  } catch {
    // Silent fail
  }
}
