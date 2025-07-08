import { z } from "zod";

/**
 * Claude Code Session Log Schema
 *
 * This schema defines the structure of Claude Code session logs captured from
 * data analysis experiments across different domains (healthcare, financial, technical).
 *
 * Each log file contains a complete conversation session with tool usage,
 * including system initialization, assistant responses, user inputs, and tool results.
 */

// UUID v4 format validation
const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "Must be a valid UUID v4",
  );

// Tool names available in Claude Code
const toolNames = [
  "Task",
  "Bash",
  "Glob",
  "Grep",
  "LS",
  "exit_plan_mode",
  "Read",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookRead",
  "NotebookEdit",
  "WebFetch",
  "TodoRead",
  "TodoWrite",
  "WebSearch",
] as const;

export const toolNameSchema = z.enum(toolNames);

// Claude model identifier - accepting the full model name from logs
const modelSchema = z.string().regex(/^claude-.*$/, "Must be a Claude model identifier");

// Permission mode for Claude Code
const permissionModeSchema = z.enum(["bypassPermissions", "requestPermissions"]);

// API key source
const apiKeySourceSchema = z.enum(["ANTHROPIC_API_KEY", "env"]);

/**
 * System Message Schema
 *
 * Appears at the beginning of each session to initialize the Claude Code environment.
 * Contains session metadata, tool configuration, and working directory information.
 */
export const systemMessageSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),

  // Working directory where Claude Code is operating
  cwd: z.string().min(1, "Working directory cannot be empty"),

  // Unique session identifier for this conversation
  session_id: uuidSchema,

  // Available tools for this session (standard Claude Code toolset)
  tools: z.array(toolNameSchema).min(1, "Must have at least one tool"),

  // MCP (Model Context Protocol) servers - typically empty array
  mcp_servers: z.array(z.unknown()).default([]),

  // Claude model being used
  model: modelSchema,

  // Permission mode for tool execution
  permissionMode: permissionModeSchema,

  // Source of API key configuration
  apiKeySource: apiKeySourceSchema,
});

/**
 * Tool Use Content Schema
 *
 * Represents a tool invocation within an assistant message.
 * Contains the tool name, unique ID, and input parameters.
 */
export const toolUseContentSchema = z.object({
  type: z.literal("tool_use"),

  // Unique identifier for this tool use (format: toolu_[alphanumeric])
  id: z.string().regex(/^toolu_[a-zA-Z0-9]+$/, "Invalid tool use ID format"),

  // Name of the tool being invoked
  name: toolNameSchema,

  // Input parameters for the tool (varies by tool type)
  input: z.record(z.unknown()).optional(),
});

/**
 * Text Content Schema
 *
 * Represents plain text content within a message.
 */
export const textContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/**
 * Thinking Content Schema
 *
 * Represents Claude's internal thinking process (when enabled).
 */
export const thinkingContentSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
});

/**
 * Tool Result Content Schema
 *
 * Represents the result of a tool execution within a user message.
 */
export const toolResultContentSchema = z.object({
  type: z.literal("tool_result"),

  // ID of the tool use this result corresponds to
  tool_use_id: z.string().regex(/^toolu_[a-zA-Z0-9]+$/, "Invalid tool use ID format"),

  // Result content from tool execution (can be string or complex object)
  content: z.union([z.string(), z.record(z.unknown())]),
});

/**
 * Message Content Schema
 *
 * Union of all possible content types within a message.
 */
export const messageContentSchema = z.union([
  toolUseContentSchema,
  textContentSchema,
  thinkingContentSchema,
  toolResultContentSchema,
]);

/**
 * Assistant Message Schema
 *
 * Represents Claude's responses, including text and tool use requests.
 */
export const assistantMessageSchema = z.object({
  type: z.literal("assistant"),

  message: z.object({
    // Message identifier
    id: z.string().regex(/^msg_[a-zA-Z0-9]+$/, "Invalid message ID format"),

    type: z.literal("message"),
    role: z.literal("assistant"),

    // Claude model used for this response
    model: modelSchema,

    // Message content (can be text, tool use, or thinking)
    content: z.union([
      z.array(messageContentSchema),
      z.string(), // Sometimes content is just a string
    ]),

    // Token usage information (optional)
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        cache_creation_input_tokens: z.number().int().nonnegative().optional(),
        cache_read_input_tokens: z.number().int().nonnegative().optional(),
      })
      .optional(),

    // Stop reason for the response (can be null)
    stop_reason: z.enum(["end_turn", "max_tokens", "stop_sequence", "tool_use"]).nullable(),

    // Stop sequence used (if applicable, can be null)
    stop_sequence: z.string().nullable(),
  }),
});

/**
 * User Message Schema
 *
 * Represents user input or tool results being provided to Claude.
 */
export const userMessageSchema = z.object({
  type: z.literal("user"),

  message: z.object({
    role: z.literal("user"),

    // Message content (typically tool results or user input)
    content: z.union([
      z.array(messageContentSchema),
      z.string(), // Sometimes content is just a string
    ]),
  }),
});

/**
 * Result Message Schema
 *
 * Appears at the end of each session to summarize the conversation outcome.
 */
export const resultMessageSchema = z.object({
  type: z.literal("result"),
  subtype: z.enum(["success", "error"]),

  // Whether the session ended in error
  is_error: z.boolean(),

  // Total duration of the session in milliseconds
  duration_ms: z.number().int().nonnegative(),

  // Total API time in milliseconds
  duration_api_ms: z.number().int().nonnegative(),

  // Number of conversation turns
  num_turns: z.number().int().nonnegative(),

  // Final result or summary of the session
  result: z.string(),

  // Session ID
  session_id: z.string().optional(),

  // Total cost in USD
  total_cost_usd: z.number().optional(),

  // Token usage summary
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().optional(),
      output_tokens: z.number().int().nonnegative().optional(),
      cache_creation_input_tokens: z.number().int().nonnegative().optional(),
      cache_read_input_tokens: z.number().int().nonnegative().optional(),
      server_tool_use: z
        .object({
          web_search_requests: z.number().int().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
});

/**
 * Log Message Schema
 *
 * Union of all possible message types in a Claude Code session log.
 */
export const logMessageSchema = z.union([
  systemMessageSchema,
  assistantMessageSchema,
  userMessageSchema,
  resultMessageSchema,
]);

/**
 * Session Log Schema
 *
 * Represents a complete Claude Code session log file.
 * Each file contains an array of messages representing the full conversation.
 */
export const sessionLogSchema = z
  .array(logMessageSchema)
  .min(1, "Session must contain at least one message");

/**
 * Session Metadata Schema
 *
 * Extracted metadata from a session log for analysis purposes.
 */
export const sessionMetadataSchema = z.object({
  // File information
  filename: z.string(),
  session_id: uuidSchema,

  // Session characteristics
  total_messages: z.number().int().nonnegative(),
  message_type_counts: z.record(z.number().int().nonnegative()),

  // Tool usage
  tools_used: z.array(toolNameSchema),
  tool_use_count: z.number().int().nonnegative(),

  // Session outcome
  duration_ms: z.number().int().nonnegative().optional(),
  duration_api_ms: z.number().int().nonnegative().optional(),
  num_turns: z.number().int().nonnegative().optional(),
  success: z.boolean().optional(),

  // Working directory
  cwd: z.string(),

  // Model used
  model: modelSchema,
});

// Export type definitions for TypeScript usage
export type SystemMessage = z.infer<typeof systemMessageSchema>;
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export type UserMessage = z.infer<typeof userMessageSchema>;
export type ResultMessage = z.infer<typeof resultMessageSchema>;
export type LogMessage = z.infer<typeof logMessageSchema>;
export type SessionLog = z.infer<typeof sessionLogSchema>;
export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;
export type ToolName = z.infer<typeof toolNameSchema>;
export type MessageContent = z.infer<typeof messageContentSchema>;
export type ToolUseContent = z.infer<typeof toolUseContentSchema>;
export type TextContent = z.infer<typeof textContentSchema>;
export type ThinkingContent = z.infer<typeof thinkingContentSchema>;
export type ToolResultContent = z.infer<typeof toolResultContentSchema>;
