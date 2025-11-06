/**
 * Type definitions for global test utilities and extensions.
 */

import type { ServerEvent } from "../../server/schemas/event-schemas.js";

declare global {
  var __TADPOLE_TEST_EVENT_TRACKER: ((id: string, events: ServerEvent[]) => void) | undefined;
}

export {};
