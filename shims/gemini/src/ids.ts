export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateResumeSessionId(value: string): void {
  if (!UUID_V4_REGEX.test(value)) {
    throw new Error(`Invalid session ID: ${value}`);
  }
}

export function generateMessageId(): string {
  return `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function generateToolUseId(): string {
  return `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
