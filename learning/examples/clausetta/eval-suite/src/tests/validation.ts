import type { ShimConfig, TestResult, TestDefinition } from "../types.js";
import { runShim } from "../shim.js";
import { WorkspaceManager } from "../workspace.js";
import {
  assert,
  assertEqual,
  assertDefined,
  AssertionError,
} from "../utils/assertions.js";
import {
  getSystemMessage,
  getToolUseCalls,
  getToolResults,
} from "../utils/parsing.js";
import { getLogger } from "../logger.js";

/**
 * Standard tool names that are valid in the tools array
 */
const VALID_TOOL_NAMES = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "LS",
  "Task",
  "Agent",
  "MultiEdit",
  "Notebook",
  "WebSearch",
  "WebFetch",
  "TodoRead",
  "TodoWrite",
  "CodeSearch",
];

/**
 * Invalid tool names that should never appear
 */
const INVALID_TOOL_NAMES = ["invalid", "unknown", "", "undefined", "null"];

/**
 * TEST: Tools Array Valid
 * Verifies system init tools array contains only valid tool names.
 */
async function runToolsArrayValid(
  config: ShimConfig,
  workspace: WorkspaceManager
): Promise<TestResult> {
  const testName = "tools-array-valid";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      { prompt: "Say hello briefly." },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0");

    const systemMsg = getSystemMessage(result.messages);
    assertDefined(systemMsg, "System init message must exist");

    // Check tools array exists and is non-empty
    assert(Array.isArray(systemMsg.tools), "tools must be an array");
    assert(systemMsg.tools.length > 0, "tools array must not be empty");

    // Check for invalid tool names
    const invalidTools: string[] = [];
    for (const tool of systemMsg.tools) {
      const toolLower = tool.toLowerCase();
      if (
        INVALID_TOOL_NAMES.includes(toolLower) ||
        tool.trim() === "" ||
        tool === "undefined" ||
        tool === "null"
      ) {
        invalidTools.push(tool);
      }
    }

    assert(
      invalidTools.length === 0,
      `Tools array contains invalid entries: ${invalidTools.join(", ")}`,
      {
        context: {
          invalidTools,
          allTools: systemMsg.tools,
        },
      }
    );

    // Warn (but don't fail) if tools aren't in the standard set
    const nonStandardTools = systemMsg.tools.filter(
      (t) => !VALID_TOOL_NAMES.includes(t)
    );
    if (nonStandardTools.length > 0) {
      logger.debug(
        `Non-standard tools (OK but unusual): ${nonStandardTools.join(", ")}`
      );
    }

    const duration = Date.now() - startTime;
    logger.testPass(testName, duration);

    return {
      name: testName,
      passed: true,
      duration,
      logs: {
        stdout: result.stdout,
        stderr: result.stderr,
        workspace: result.workspace,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const err = error as AssertionError;
    logger.testFail(testName, duration, err.message);

    return {
      name: testName,
      passed: false,
      duration,
      error:
        err instanceof AssertionError
          ? err.toTestError()
          : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

/**
 * TEST: Tool Result Content
 * Verifies tool results contain actual content, not empty strings.
 */
async function runToolResultContent(
  config: ShimConfig,
  workspace: WorkspaceManager
): Promise<TestResult> {
  const testName = "tool-result-content";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    // Create a file first, then read it - both should produce non-empty results
    const result = await runShim(
      config,
      {
        prompt: `Create a file called test_content.txt containing "hello world", then read it back and tell me what it says.`,
        timeout: 60000,
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0", {
      stderr: result.stderr.slice(0, 500),
    });

    // Get tool results
    const toolResults = getToolResults(result.messages);

    // Should have at least one tool result (for the read)
    assert(toolResults.length > 0, "Should have at least one tool result", {
      context: { messageCount: result.messages.length },
    });

    // Check for empty tool results
    const emptyResults: string[] = [];
    for (const toolResult of toolResults) {
      const content = toolResult.content;
      if (typeof content === "string") {
        // For Read operations, content should not be empty
        // For Write operations, empty might be OK (just confirmation)
        // We'll flag any empty ones as warnings
        if (content === "" || content.trim() === "") {
          emptyResults.push(toolResult.tool_use_id);
        }
      }
    }

    // Find the corresponding tool_use to see what operations had empty results
    const toolUses = getToolUseCalls(result.messages);
    const emptyReadResults: string[] = [];

    for (const emptyId of emptyResults) {
      const toolUse = toolUses.find((t) => t.id === emptyId);
      if (toolUse) {
        const name = toolUse.name.toLowerCase();
        // Read, Bash, Grep, Glob should always have content
        if (["read", "bash", "grep", "glob", "ls"].includes(name)) {
          emptyReadResults.push(`${toolUse.name}(${emptyId})`);
        }
      }
    }

    assert(
      emptyReadResults.length === 0,
      `Tool results that should have content are empty: ${emptyReadResults.join(
        ", "
      )}`,
      {
        context: {
          emptyReadResults,
          totalToolResults: toolResults.length,
        },
      }
    );

    const duration = Date.now() - startTime;
    logger.testPass(testName, duration);

    return {
      name: testName,
      passed: true,
      duration,
      logs: {
        stdout: result.stdout,
        stderr: result.stderr,
        workspace: result.workspace,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const err = error as AssertionError;
    logger.testFail(testName, duration, err.message);

    return {
      name: testName,
      passed: false,
      duration,
      error:
        err instanceof AssertionError
          ? err.toTestError()
          : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

/**
 * TEST: Message Ordering Strict
 * Verifies tool_use always comes before its corresponding tool_result.
 */
async function runMessageOrderingStrict(
  config: ShimConfig,
  workspace: WorkspaceManager
): Promise<TestResult> {
  const testName = "message-ordering-strict";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      {
        prompt: `Create a file called order_test.txt with "test" content.`,
        timeout: 60000,
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0");

    // Track which tool_use IDs we've seen
    const seenToolUseIds = new Set<string>();
    const orderViolations: string[] = [];

    // Walk through messages in order
    for (const msg of result.messages) {
      if (msg.type === "assistant") {
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use") {
              seenToolUseIds.add(block.id);
            }
          }
        }
      } else if (msg.type === "user") {
        for (const content of msg.message.content) {
          if (content.type === "tool_result") {
            // Check if we've seen the corresponding tool_use
            if (!seenToolUseIds.has(content.tool_use_id)) {
              orderViolations.push(content.tool_use_id);
            }
          }
        }
      }
    }

    assert(
      orderViolations.length === 0,
      `tool_result appeared before tool_use for IDs: ${orderViolations.join(
        ", "
      )}`,
      {
        context: {
          orderViolations,
          seenToolUseIds: [...seenToolUseIds],
        },
      }
    );

    const duration = Date.now() - startTime;
    logger.testPass(testName, duration);

    return {
      name: testName,
      passed: true,
      duration,
      logs: {
        stdout: result.stdout,
        stderr: result.stderr,
        workspace: result.workspace,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const err = error as AssertionError;
    logger.testFail(testName, duration, err.message);

    return {
      name: testName,
      passed: false,
      duration,
      error:
        err instanceof AssertionError
          ? err.toTestError()
          : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

/**
 * TEST: No Shell Pollution
 * Verifies tool results don't contain shell initialization errors.
 */
async function runNoShellPollution(
  config: ShimConfig,
  workspace: WorkspaceManager
): Promise<TestResult> {
  const testName = "no-shell-pollution";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  // Common shell init error patterns
  const SHELL_POLLUTION_PATTERNS = [
    /shellenv\.sh/i,
    /\.bashrc/i,
    /\.zshrc/i,
    /\.profile/i,
    /Operation not permitted/i,
    /command not found:.*nvm/i,
    /command not found:.*rbenv/i,
    /pyenv: no such command/i,
  ];

  try {
    const result = await runShim(
      config,
      {
        prompt: `Run the command "echo clean_output_test" and tell me what it outputs.`,
        timeout: 60000,
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0");

    // Get all tool results
    const toolResults = getToolResults(result.messages);
    const pollutedResults: { id: string; pattern: string; content: string }[] =
      [];

    for (const toolResult of toolResults) {
      const content =
        typeof toolResult.content === "string"
          ? toolResult.content
          : JSON.stringify(toolResult.content);

      for (const pattern of SHELL_POLLUTION_PATTERNS) {
        if (pattern.test(content)) {
          pollutedResults.push({
            id: toolResult.tool_use_id,
            pattern: pattern.toString(),
            content: content.slice(0, 200),
          });
          break; // One pattern match is enough
        }
      }
    }

    assert(
      pollutedResults.length === 0,
      `Tool results contain shell initialization pollution`,
      {
        context: {
          pollutedResults,
          hint: "Use non-interactive shells (bash -c) instead of login shells (bash -l)",
        },
      }
    );

    const duration = Date.now() - startTime;
    logger.testPass(testName, duration);

    return {
      name: testName,
      passed: true,
      duration,
      logs: {
        stdout: result.stdout,
        stderr: result.stderr,
        workspace: result.workspace,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const err = error as AssertionError;
    logger.testFail(testName, duration, err.message);

    return {
      name: testName,
      passed: false,
      duration,
      error:
        err instanceof AssertionError
          ? err.toTestError()
          : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

/**
 * TEST: Tool Name Not Unknown
 * Verifies tool_use messages have proper tool names, not "unknown".
 */
async function runToolNameNotUnknown(
  config: ShimConfig,
  workspace: WorkspaceManager
): Promise<TestResult> {
  const testName = "tool-name-not-unknown";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      {
        prompt: `Create a file called name_test.txt with "test" and then list the current directory.`,
        timeout: 60000,
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0");

    const toolCalls = getToolUseCalls(result.messages);

    // Should have at least one tool call
    assert(toolCalls.length > 0, "Should have at least one tool call");

    // Check for "unknown" tool names
    const unknownTools = toolCalls.filter(
      (t) =>
        t.name.toLowerCase() === "unknown" ||
        t.name === "" ||
        t.name === "undefined"
    );

    assert(
      unknownTools.length === 0,
      `Tool calls have "unknown" or empty names`,
      {
        context: {
          unknownTools: unknownTools.map((t) => ({ id: t.id, name: t.name })),
          allTools: toolCalls.map((t) => ({ id: t.id, name: t.name })),
        },
      }
    );

    const duration = Date.now() - startTime;
    logger.testPass(testName, duration);

    return {
      name: testName,
      passed: true,
      duration,
      logs: {
        stdout: result.stdout,
        stderr: result.stderr,
        workspace: result.workspace,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const err = error as AssertionError;
    logger.testFail(testName, duration, err.message);

    return {
      name: testName,
      passed: false,
      duration,
      error:
        err instanceof AssertionError
          ? err.toTestError()
          : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

/**
 * TEST: Tool Input Not Empty
 * Verifies tool_use messages contain actual input parameters, not empty objects.
 * This is critical - without inputs, the orchestrator can't understand what the agent is doing.
 */
async function runToolInputNotEmpty(
  config: ShimConfig,
  workspace: WorkspaceManager
): Promise<TestResult> {
  const testName = "tool-input-not-empty";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      {
        prompt: `Create a file called input_test.txt containing exactly "hello world 123". Then read it back and tell me what it says.`,
        timeout: 90000,
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0", {
      stderr: result.stderr.slice(0, 500),
    });

    const toolCalls = getToolUseCalls(result.messages);

    // Should have at least one tool call (Write)
    assert(toolCalls.length > 0, "Should have at least one tool call");

    // Check for empty inputs - tools that MUST have inputs
    const toolsRequiringInput = [
      "write",
      "read",
      "edit",
      "bash",
      "grep",
      "glob",
    ];
    const emptyInputTools: { id: string; name: string }[] = [];

    for (const tool of toolCalls) {
      const toolNameLower = tool.name.toLowerCase();

      // Check if this tool type requires input
      if (toolsRequiringInput.some((t) => toolNameLower.includes(t))) {
        const input = tool.input;

        // Check if input is missing, empty object, or has no meaningful content
        const isEmpty =
          !input ||
          (typeof input === "object" && Object.keys(input).length === 0);

        if (isEmpty) {
          emptyInputTools.push({ id: tool.id, name: tool.name });
        }
      }
    }

    assert(
      emptyInputTools.length === 0,
      `Tool calls have empty inputs - orchestrator cannot understand what agent is doing`,
      {
        context: {
          emptyInputTools,
          allTools: toolCalls.map((t) => ({
            id: t.id,
            name: t.name,
            inputKeys: t.input ? Object.keys(t.input) : [],
          })),
          hint: "Shim must extract tool input parameters from agent events",
        },
      }
    );

    const duration = Date.now() - startTime;
    logger.testPass(testName, duration);

    return {
      name: testName,
      passed: true,
      duration,
      logs: {
        stdout: result.stdout,
        stderr: result.stderr,
        workspace: result.workspace,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const err = error as AssertionError;
    logger.testFail(testName, duration, err.message);

    return {
      name: testName,
      passed: false,
      duration,
      error:
        err instanceof AssertionError
          ? err.toTestError()
          : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

/**
 * TEST: Tool Results Emitted
 * Verifies that tool_result messages are emitted for tool_use messages.
 * Without tool results, the conversation history is incomplete and orchestrators
 * cannot understand what happened during tool execution.
 */
async function runToolResultsEmitted(
  config: ShimConfig,
  workspace: WorkspaceManager
): Promise<TestResult> {
  const testName = "tool-results-emitted";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      {
        prompt: `Create a file called result_test.txt with "test content" and read it back.`,
        timeout: 120000, // 2 minutes - allow for API rate limiting during parallel runs
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0", {
      stderr: result.stderr.slice(0, 500),
    });

    const toolCalls = getToolUseCalls(result.messages);
    const toolResults = getToolResults(result.messages);

    // Should have tool calls
    assert(toolCalls.length > 0, "Should have at least one tool call");

    // Check tool call/result ratio
    // Note: Not every tool_use requires a tool_result (some may be pending),
    // but we should have SOME results if tools were executed
    const toolCallIds = new Set(toolCalls.map((t) => t.id));
    const toolResultIds = new Set(toolResults.map((t) => t.tool_use_id));

    // Count how many tool calls have matching results
    const matchedResults = [...toolCallIds].filter((id) =>
      toolResultIds.has(id)
    ).length;

    // At minimum, we expect at least 50% of tool calls to have results
    // (allowing for the last tool call to potentially not have a result yet)
    const matchRatio = matchedResults / toolCalls.length;

    assert(
      toolResults.length > 0,
      `No tool_result messages emitted - shim is not capturing tool execution results`,
      {
        context: {
          toolCallCount: toolCalls.length,
          toolResultCount: toolResults.length,
          toolCallIds: [...toolCallIds],
          toolResultIds: [...toolResultIds],
          hint: "Shim must emit user messages with tool_result for each tool execution",
        },
      }
    );

    assert(
      matchRatio >= 0.5,
      `Too few tool results match tool calls (${Math.round(
        matchRatio * 100
      )}% matched)`,
      {
        context: {
          toolCallCount: toolCalls.length,
          toolResultCount: toolResults.length,
          matchedResults,
          orphanToolUseIds: [...toolCallIds].filter(
            (id) => !toolResultIds.has(id)
          ),
          orphanToolResultIds: [...toolResultIds].filter(
            (id) => !toolCallIds.has(id)
          ),
        },
      }
    );

    const duration = Date.now() - startTime;
    logger.testPass(testName, duration);

    return {
      name: testName,
      passed: true,
      duration,
      logs: {
        stdout: result.stdout,
        stderr: result.stderr,
        workspace: result.workspace,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const err = error as AssertionError;
    logger.testFail(testName, duration, err.message);

    return {
      name: testName,
      passed: false,
      duration,
      error:
        err instanceof AssertionError
          ? err.toTestError()
          : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

/**
 * TEST: Tool ID Format Valid
 * Verifies tool_use IDs follow the expected format (toolu_* or similar).
 */
async function runToolIdFormatValid(
  config: ShimConfig,
  workspace: WorkspaceManager
): Promise<TestResult> {
  const testName = "tool-id-format-valid";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      {
        prompt: `Create a file called id_test.txt with "test"`,
        timeout: 60000,
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0");

    const toolCalls = getToolUseCalls(result.messages);

    if (toolCalls.length === 0) {
      // No tool calls - test passes vacuously
      const duration = Date.now() - startTime;
      logger.testPass(testName, duration);
      return {
        name: testName,
        passed: true,
        duration,
        logs: {
          stdout: result.stdout,
          stderr: result.stderr,
          workspace: result.workspace,
        },
      };
    }

    // Valid ID patterns:
    // - toolu_[alphanumeric]+ (Anthropic style)
    // - call_[hex]+ (OpenAI style)
    // - UUID format
    const validPatterns = [
      /^toolu_[a-zA-Z0-9]+$/,
      /^call_[a-fA-F0-9]+$/,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    ];

    const invalidIdTools: { id: string; name: string }[] = [];

    for (const tool of toolCalls) {
      const matchesAny = validPatterns.some((pattern) => pattern.test(tool.id));
      if (!matchesAny) {
        invalidIdTools.push({ id: tool.id, name: tool.name });
      }
    }

    assert(
      invalidIdTools.length === 0,
      `Tool IDs do not follow expected format (toolu_*, call_*, or UUID)`,
      {
        context: {
          invalidIdTools,
          validFormats: ["toolu_[alphanumeric]+", "call_[hex]+", "UUID"],
          hint: "Shim should generate tool IDs in toolu_* format",
        },
      }
    );

    const duration = Date.now() - startTime;
    logger.testPass(testName, duration);

    return {
      name: testName,
      passed: true,
      duration,
      logs: {
        stdout: result.stdout,
        stderr: result.stderr,
        workspace: result.workspace,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const err = error as AssertionError;
    logger.testFail(testName, duration, err.message);

    return {
      name: testName,
      passed: false,
      duration,
      error:
        err instanceof AssertionError
          ? err.toTestError()
          : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

/**
 * TEST: Parallel Execution Support
 * Verifies shim can run multiple instances concurrently without port conflicts.
 * Per spec Section 1.4, shims MUST use dynamic port allocation.
 */
async function runParallelExecution(
  config: ShimConfig,
  workspace: WorkspaceManager
): Promise<TestResult> {
  const testName = "parallel-execution";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    // Run 3 instances concurrently - this should NOT cause port conflicts
    // if the shim properly uses dynamic port allocation
    const instances = 3;
    const prompt = "Say just 'hi' and nothing else.";

    const promises = Array.from({ length: instances }, async (_, i) => {
      try {
        const result = await runShim(
          config,
          { prompt },
          workspace,
          `${testName}-instance-${i}`
        );
        return { index: i, result, error: null as unknown };
      } catch (error) {
        return { index: i, result: null, error };
      }
    });

    const results = await Promise.all(promises);

    // Check for port conflict errors
    const portConflicts = results.filter((r) => {
      if (r.error) {
        const errStr = String(r.error);
        return (
          errStr.includes("EADDRINUSE") ||
          errStr.includes("port") ||
          errStr.includes("address already in use")
        );
      }
      if (r.result?.stderr) {
        return (
          r.result.stderr.includes("EADDRINUSE") ||
          (r.result.stderr.includes("port") &&
            r.result.stderr.includes("in use"))
        );
      }
      return false;
    });

    assert(
      portConflicts.length === 0,
      `Port conflicts detected in ${portConflicts.length}/${instances} instances. ` +
        `Per spec Section 1.4, shims MUST use dynamic port allocation to support parallel execution.`,
      {
        context: {
          conflicts: portConflicts.map((c) => ({
            index: c.index,
            error: String(c.error || c.result?.stderr),
          })),
        },
      }
    );

    // At least 2 out of 3 should succeed (allowing some tolerance for other issues)
    const successCount = results.filter(
      (r) => r.result && r.result.exitCode === 0
    ).length;

    assert(
      successCount >= 2,
      `Expected at least 2/${instances} instances to succeed, got ${successCount}. ` +
        `Failures may indicate port conflicts or resource contention.`,
      {
        context: {
          results: results.map((r) => ({
            index: r.index,
            exitCode: r.result?.exitCode,
            error: r.error ? String(r.error) : null,
          })),
        },
      }
    );

    const duration = Date.now() - startTime;
    logger.testPass(testName, duration);
    return {
      name: testName,
      passed: true,
      duration,
      logs: {
        stdout: results.map((r) => r.result?.stdout || "").join("\n---\n"),
        stderr: results.map((r) => r.result?.stderr || "").join("\n---\n"),
        workspace: workspace.getTestDir(testName),
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const err = error as AssertionError;
    logger.testFail(testName, duration, err.message);

    return {
      name: testName,
      passed: false,
      duration,
      error:
        err instanceof AssertionError
          ? err.toTestError()
          : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

// Export test definitions
export const validationTests: TestDefinition[] = [
  {
    name: "tools-array-valid",
    category: "validation",
    priority: "P1",
    run: async (config, workspace) =>
      runToolsArrayValid(config, workspace as WorkspaceManager),
  },
  {
    name: "tool-result-content",
    category: "validation",
    priority: "P1",
    run: async (config, workspace) =>
      runToolResultContent(config, workspace as WorkspaceManager),
  },
  {
    name: "message-ordering-strict",
    category: "validation",
    priority: "P1",
    run: async (config, workspace) =>
      runMessageOrderingStrict(config, workspace as WorkspaceManager),
  },
  {
    name: "no-shell-pollution",
    category: "validation",
    priority: "P2",
    run: async (config, workspace) =>
      runNoShellPollution(config, workspace as WorkspaceManager),
  },
  {
    name: "tool-name-not-unknown",
    category: "validation",
    priority: "P1",
    run: async (config, workspace) =>
      runToolNameNotUnknown(config, workspace as WorkspaceManager),
  },
  {
    name: "tool-input-not-empty",
    category: "validation",
    priority: "P1",
    run: async (config, workspace) =>
      runToolInputNotEmpty(config, workspace as WorkspaceManager),
  },
  {
    name: "tool-results-emitted",
    category: "validation",
    priority: "P1",
    run: async (config, workspace) =>
      runToolResultsEmitted(config, workspace as WorkspaceManager),
  },
  {
    name: "tool-id-format-valid",
    category: "validation",
    priority: "P2",
    run: async (config, workspace) =>
      runToolIdFormatValid(config, workspace as WorkspaceManager),
  },
  {
    name: "parallel-execution",
    category: "validation",
    priority: "P1",
    run: async (config, workspace) =>
      runParallelExecution(config, workspace as WorkspaceManager),
  },
];

export {
  runToolsArrayValid,
  runToolResultContent,
  runMessageOrderingStrict,
  runNoShellPollution,
  runToolNameNotUnknown,
  runToolInputNotEmpty,
  runToolResultsEmitted,
  runToolIdFormatValid,
  runParallelExecution,
};
