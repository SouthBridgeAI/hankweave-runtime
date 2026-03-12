import type { ShimMessage } from "./protocol.js";
import { NIL_UUID } from "./ids.js";

export function syntheticErrorMessage(
  prefix: "API Error" | "Agent Error",
  text: string,
  model = "<synthetic>",
) {
  return {
    type: "assistant",
    message: {
      id: NIL_UUID,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: `${prefix}: ${text}` }],
      stop_reason: null,
    },
  };
}

export function emit(message: ShimMessage): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

export async function flushStdout(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write("", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function summarizeText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "Completed successfully.";
  }
  return trimmed.length > 500 ? `${trimmed.slice(0, 497)}...` : trimmed;
}

export function countNumberedSteps(text: string): number {
  return text.match(/(?:^|\n)\s*\d+\.\s+/g)?.length ?? 0;
}

export function shouldRetrySilentSuccessTurn(input: {
  isError: boolean;
  sawAssistantText: boolean;
  sawToolUse: boolean;
  sawToolResult: boolean;
}): boolean {
  return !input.isError && !input.sawAssistantText && !input.sawToolUse && !input.sawToolResult;
}
