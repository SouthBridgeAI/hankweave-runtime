/**
 * First-Run Notice
 *
 * Shows a one-time notice about telemetry on first run.
 * Displayed after config resolution, before execution starts.
 */

import type { ResolvedTelemetryConfig } from "./telemetry-config.js";
import { hasNoticeBeenShown, markNoticeShown } from "./telemetry-identity.js";

// =============================================================================
// Notice Text
// =============================================================================

const NOTICE_TEXT = `
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  Hankweave collects anonymous usage statistics to help          │
│  improve the tool. No personal information, file contents,      │
│  or prompts are collected.                                      │
│                                                                 │
│  Learn more: https://docs.hankweave.dev/reference/telemetry     │
│  Opt out:    export HANKWEAVE_TELEMETRY=0                       │
│                                                                 │
│  This notice won't be shown again.                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
`;

// =============================================================================
// Notice Display
// =============================================================================

/**
 * Show the first-run telemetry notice if it hasn't been shown yet.
 *
 * Shows to ALL users, even if telemetry is already disabled,
 * because transparency is the goal.
 *
 * @param _config - Resolved telemetry config (unused but available for future use)
 */
export async function showFirstRunNotice(_config: ResolvedTelemetryConfig): Promise<void> {
  const alreadyShown = await hasNoticeBeenShown();
  if (alreadyShown) {
    return;
  }

  // Show the notice
  console.log(NOTICE_TEXT);

  // Mark as shown
  await markNoticeShown();
}
