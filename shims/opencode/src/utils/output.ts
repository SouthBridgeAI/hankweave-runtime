import type { ShimMessage } from "@shims/common";

export function emit(message: ShimMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export async function flushStdout(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write("", () => resolve());
  });
}

export function verboseLog(enabled: boolean, message: string, data?: unknown): void {
  if (!enabled) return;

  if (data === undefined) {
    process.stderr.write(`[opencode-shim] ${message}\n`);
    return;
  }

  const rendered = typeof data === "string" ? data : JSON.stringify(data);
  process.stderr.write(`[opencode-shim] ${message}: ${rendered}\n`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
