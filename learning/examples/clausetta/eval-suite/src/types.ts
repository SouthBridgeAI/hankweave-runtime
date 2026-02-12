// ============================================
// SHIM OUTPUT MESSAGE TYPES
// ============================================

export interface SystemMessage {
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

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string | { is_error: true; error: string };
}

export type ContentBlock = TextContent | ThinkingContent | ToolUseContent;

export interface AssistantMessage {
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

export interface UserMessage {
  type: "user";
  message: {
    role: "user";
    content: ToolResultContent[];
  };
}

export interface ResultMessage {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  duration_api_ms?: number;
  num_turns: number;
  result: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: TokenUsage;
}

export type ShimMessage = SystemMessage | AssistantMessage | UserMessage | ResultMessage;

// ============================================
// TEST CONFIGURATION
// ============================================

export interface ShimConfig {
  /** Path to shim executable or command name */
  command: string;
  /** Base arguments to pass to the shim */
  baseArgs: string[];
  /** Model to use for tests */
  model: string;
  /** Test timeout in milliseconds */
  timeout: number;
  /** Directory for shim debug logs (if provided, --debug-dir will be passed) */
  debugDir?: string;
}

export interface RunOptions {
  /** The prompt to send via stdin */
  prompt: string;
  /** Model override (uses config.model if not specified) */
  model?: string;
  /** Additional CLI arguments */
  args?: string[];
  /** Timeout in ms (uses config.timeout if not specified) */
  timeout?: number;
  /** Signal to send during execution */
  signal?: { type: "SIGINT" | "SIGTERM"; afterMs: number };
  /** Files to create before running */
  fixtures?: Record<string, string | Buffer>;
  /** Working directory override */
  cwd?: string;
}

export interface RunResult {
  /** Exit code of the process */
  exitCode: number;
  /** Raw stdout content */
  stdout: string;
  /** Raw stderr content */
  stderr: string;
  /** Parsed messages from stdout */
  messages: ShimMessage[];
  /** Lines that failed to parse as JSON */
  parseErrors: string[];
  /** Total duration in ms */
  duration: number;
  /** Path to test workspace directory */
  workspace: string;
  /** Whether process was killed by signal */
  signaled: boolean;
}

// ============================================
// TEST RESULT TYPES
// ============================================

export interface TestError {
  message: string;
  expected?: string;
  actual?: string;
  context?: Record<string, unknown>;
}

export interface TestResult {
  name: string;
  passed: boolean;
  skipped?: boolean;
  duration: number;
  error?: TestError;
  logs: {
    stdout: string;
    stderr: string;
    workspace: string;
  };
}

export interface TestSuiteResult {
  shim: string;
  model: string;
  date: string;
  duration: number;
  passed: number;
  failed: number;
  skipped: number;
  results: TestResult[];
  runDir: string;
}

export type TestCategory = "core" | "tools" | "signals" | "sessions" | "errors" | "stress" | "validation" | "agentic";

// Forward declaration for WorkspaceManager to avoid circular imports
export interface WorkspaceManagerInterface {
  runDir: string;
  getTestDir(testName: string): string;
  createTestWorkspace(testName: string): Promise<string>;
  writeTestArtifacts(testName: string, artifacts: { input?: string; output?: string; stderr?: string }): Promise<void>;
  createFixtures(workspaceDir: string, fixtures: Record<string, string>): Promise<void>;
  fileExists(workspaceDir: string, path: string): Promise<boolean>;
  readFile(workspaceDir: string, path: string): Promise<string>;
  dirExists(workspaceDir: string, path: string): Promise<boolean>;
}

export interface TestDefinition {
  name: string;
  category: TestCategory;
  priority: "P1" | "P2" | "P3";
  run: (config: ShimConfig, workspace: WorkspaceManagerInterface) => Promise<TestResult>;
}

