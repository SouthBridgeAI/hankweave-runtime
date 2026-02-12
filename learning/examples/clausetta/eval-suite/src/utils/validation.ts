/**
 * ID format validation utilities
 */

// UUID v4 format
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Message ID format (msg_* or UUID)
const MESSAGE_ID_REGEX = /^(msg_[a-zA-Z0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// Tool use ID format (toolu_* or call_*)
const TOOL_USE_ID_REGEX = /^(toolu_[a-zA-Z0-9]+|call_[a-fA-F0-9]+)$/;

/**
 * Validates a session ID is in UUID v4 format
 */
export function isValidSessionId(id: string): boolean {
  return UUID_V4_REGEX.test(id);
}

/**
 * Validates a message ID is in correct format
 */
export function isValidMessageId(id: string): boolean {
  return MESSAGE_ID_REGEX.test(id);
}

/**
 * Validates a tool use ID is in correct format
 */
export function isValidToolUseId(id: string): boolean {
  return TOOL_USE_ID_REGEX.test(id);
}

/**
 * Returns validation details for debugging
 */
export function validateSessionId(id: string): { valid: boolean; reason?: string } {
  if (!id) {
    return { valid: false, reason: "Session ID is empty or undefined" };
  }
  if (!UUID_V4_REGEX.test(id)) {
    return {
      valid: false,
      reason: `Session ID "${id}" does not match UUID v4 format (xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx)`,
    };
  }
  return { valid: true };
}

export function validateMessageId(id: string): { valid: boolean; reason?: string } {
  if (!id) {
    return { valid: false, reason: "Message ID is empty or undefined" };
  }
  if (!MESSAGE_ID_REGEX.test(id)) {
    return {
      valid: false,
      reason: `Message ID "${id}" does not match expected format (msg_* or UUID)`,
    };
  }
  return { valid: true };
}

export function validateToolUseId(id: string): { valid: boolean; reason?: string } {
  if (!id) {
    return { valid: false, reason: "Tool use ID is empty or undefined" };
  }
  if (!TOOL_USE_ID_REGEX.test(id)) {
    return {
      valid: false,
      reason: `Tool use ID "${id}" does not match expected format (toolu_* or call_*)`,
    };
  }
  return { valid: true };
}

