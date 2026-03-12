import type { TokenUsage } from "@shims/common";

export interface OpencodeEvent {
  type: string;
  timestamp?: number;
  sessionID?: string;
  part?: Record<string, unknown>;
  error?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StepAccumulator {
  messageId: string;
  contentBlocks: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "tool_use"; id: string; name: string; input?: Record<string, unknown> }
  >;
  toolResults: Array<{
    type: "tool_result";
    tool_use_id: string;
    content: string | { is_error: true; error: string };
  }>;
}

export interface RunSummary {
  sawAnyContent: boolean;
  sawTerminalStop: boolean;
  totalCostUsd: number;
  totalUsage: TokenUsage;
  numTurns: number;
  finalResultText: string;
  lastToolSummary: string;
  firstEventTimestamp?: number;
  lastEventTimestamp?: number;
  opencodeSessionId?: string;
}
