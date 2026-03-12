export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input?: Record<string, unknown> };

export interface ShimMessage {
  type: string;
  [key: string]: unknown;
}

export interface SystemMessage extends ShimMessage {
  type: "system";
  subtype: "init";
  cwd: string;
  session_id: string;
  tools: string[];
  model: string;
  permissionMode: "bypassPermissions" | "requestPermissions";
  apiKeySource: string;
  mcp_servers?: unknown[];
}

export interface AssistantMessage extends ShimMessage {
  type: "assistant";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: string;
    content: ContentBlock[] | string;
    usage?: TokenUsage;
    stop_reason?: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | null;
  };
}

export interface UserMessage extends ShimMessage {
  type: "user";
  message: {
    role: "user";
    content: Array<{
      type: "tool_result";
      tool_use_id: string;
      content: string | { is_error: true; error: string };
    }>;
  };
}

export interface ResultMessage extends ShimMessage {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: TokenUsage;
  model_usage?: Record<
    string,
    {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cost_usd: number;
    }
  >;
}

export type RawGeminiEvent =
  | { type: "init"; timestamp?: string; session_id: string; model: string }
  | { type: "message"; timestamp?: string; role: "user" | "assistant"; content: string; delta?: boolean }
  | { type: "tool_use"; timestamp?: string; tool_name: string; tool_id: string; parameters: Record<string, unknown> }
  | {
      type: "tool_result";
      timestamp?: string;
      tool_id: string;
      status: "success" | "error";
      output?: string;
      error?: { type?: string; message?: string };
    }
  | { type: "error"; timestamp?: string; severity: "warning" | "error"; message: string }
  | {
      type: "result";
      timestamp?: string;
      status: "success" | "error";
      error?: { type?: string; message?: string };
      stats?: {
        total_tokens?: number;
        input_tokens?: number;
        output_tokens?: number;
        cached?: number;
        input?: number;
        duration_ms?: number;
        tool_calls?: number;
      };
    };
