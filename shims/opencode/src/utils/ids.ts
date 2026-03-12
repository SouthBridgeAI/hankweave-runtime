import { randomBytes, randomUUID } from "node:crypto";

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export function generateSessionId(): string {
  return randomUUID();
}

export function generateMessageId(): string {
  return `msg_${randomBytes(8).toString("hex")}`;
}

export function generateToolUseId(): string {
  return `toolu_${randomBytes(10).toString("hex")}`;
}

export function isUuidLike(value: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ||
    value === NIL_UUID
  );
}

export function normalizeMessageId(value: unknown): string {
  if (
    typeof value === "string" &&
    /^(msg_[a-zA-Z0-9]+|[0-9a-f-]{36})$/i.test(value)
  ) {
    return value;
  }

  return generateMessageId();
}
