import type { ShimConfig, TestResult, TestDefinition } from "../types.js";
import { runShim } from "../shim.js";
import { WorkspaceManager } from "../workspace.js";
import { assert, assertEqual, assertContains, assertDefined, assertMinLength, AssertionError } from "../utils/assertions.js";
import { getSystemMessage, getResultMessage, getAllAssistantText, countMessageTypes } from "../utils/parsing.js";
import { isValidSessionId, isValidMessageId, validateSessionId } from "../utils/validation.js";
import { getLogger } from "../logger.js";

/**
 * TEST: Simple Response
 * Tests the most basic flow - prompt in, text response out, clean exit.
 */
async function runSimpleResponse(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "simple-response";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      { prompt: "Say hello. Just respond with a greeting." },
      workspace,
      testName
    );

    // Verify exit code
    assertEqual(result.exitCode, 0, "Expected exit code 0", {
      actual: result.exitCode,
      stderr: result.stderr.slice(0, 500),
    });

    // Verify no parse errors
    assertEqual(result.parseErrors.length, 0, "All output lines should be valid JSON", {
      parseErrors: result.parseErrors,
    });

    // Verify minimum message count
    assertMinLength(result.messages, 2, "Expected at least 2 messages (system + result)");

    // Verify first message is system init
    const firstMsg = result.messages[0];
    assertEqual(firstMsg.type, "system", "First message must be type 'system'");
    assertEqual((firstMsg as any).subtype, "init", "First message must have subtype 'init'");

    // Verify system init contents
    const systemMsg = getSystemMessage(result.messages);
    assertDefined(systemMsg, "System init message must exist");

    const sessionValidation = validateSessionId(systemMsg.session_id);
    assert(sessionValidation.valid, sessionValidation.reason || "Invalid session ID");

    assert(systemMsg.cwd.startsWith("/"), "cwd must be an absolute path", {
      actual: systemMsg.cwd,
    });

    assert(Array.isArray(systemMsg.tools), "tools must be an array");
    assertMinLength(systemMsg.tools, 1, "tools array must not be empty");

    assert(typeof systemMsg.model === "string" && systemMsg.model.length > 0, "model must be a non-empty string");

    // Verify last message is result
    const lastMsg = result.messages[result.messages.length - 1];
    assertEqual(lastMsg.type, "result", "Last message must be type 'result'");

    const resultMsg = getResultMessage(result.messages);
    assertDefined(resultMsg, "Result message must exist");
    assertEqual(resultMsg.is_error, false, "Result should not be an error");

    // Verify at least one assistant message with content
    const assistantText = getAllAssistantText(result.messages);
    assert(assistantText.length > 0, "Should have assistant text response");
    assertContains(assistantText, "hello", "Response should contain a greeting");

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
      error: err instanceof AssertionError ? err.toTestError() : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

/**
 * TEST: Multi-Turn Context
 * Verifies the agent maintains context within a session.
 */
async function runMultiTurnContext(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "multi-turn-context";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      { prompt: "My name is Alice. Remember that. What is my name? Just answer with the name." },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0");

    const assistantText = getAllAssistantText(result.messages);
    assertContains(assistantText, "Alice", "Response should contain 'Alice'");

    const resultMsg = getResultMessage(result.messages);
    assertDefined(resultMsg, "Result message must exist");
    assertEqual(resultMsg.is_error, false, "Result should not be an error");

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
      error: err instanceof AssertionError ? err.toTestError() : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

/**
 * TEST: Output Format - Valid JSONL
 * Verifies every line of stdout is valid JSON.
 */
async function runValidJsonl(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "valid-jsonl";
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

    // Check all lines are valid JSON
    assertEqual(result.parseErrors.length, 0, "All output lines should be valid JSON", {
      parseErrors: result.parseErrors,
      parseErrorCount: result.parseErrors.length,
    });

    // Check no blank lines in output
    const lines = result.stdout.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === "" && i < lines.length - 1) {
        // Allow trailing newline
        assert(false, `Unexpected blank line at line ${i + 1}`, { line: i + 1 });
      }
    }

    // Verify UTF-8 encoding (basic check - non-ASCII in response)
    // This is implicit as JS strings are UTF-16 internally but we're writing as UTF-8

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
      error: err instanceof AssertionError ? err.toTestError() : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

/**
 * TEST: Message Ordering
 * Verifies system init is first and result is last.
 */
async function runMessageOrdering(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "message-ordering";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      { prompt: "Count from 1 to 3." },
      workspace,
      testName
    );

    assertMinLength(result.messages, 2, "Need at least 2 messages");

    // First message must be system init
    const first = result.messages[0];
    assertEqual(first.type, "system", "First message must be system");
    assertEqual((first as any).subtype, "init", "First message must be system init");

    // Last message must be result
    const last = result.messages[result.messages.length - 1];
    assertEqual(last.type, "result", "Last message must be result");

    // Only one system init
    const systemCount = result.messages.filter((m) => m.type === "system").length;
    assertEqual(systemCount, 1, "Should have exactly one system init message");

    // Only one result
    const resultCount = result.messages.filter((m) => m.type === "result").length;
    assertEqual(resultCount, 1, "Should have exactly one result message");

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
      error: err instanceof AssertionError ? err.toTestError() : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

/**
 * TEST: Premature Completion
 * Verifies shim doesn't exit on initial "idle" before work starts.
 */
async function runPrematureCompletion(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "premature-completion";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      { prompt: "Count from 1 to 10, one number per line." },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0");

    const assistantText = getAllAssistantText(result.messages);

    // Should contain all numbers 1-10
    for (let i = 1; i <= 10; i++) {
      assertContains(assistantText, String(i), `Response should contain number ${i}`);
    }

    // Check usage if available
    const resultMsg = getResultMessage(result.messages);
    if (resultMsg?.usage?.input_tokens !== undefined) {
      assert(resultMsg.usage.input_tokens > 0, "input_tokens should be > 0 (not premature exit)", {
        input_tokens: resultMsg.usage.input_tokens,
      });
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
      error: err instanceof AssertionError ? err.toTestError() : { message: String(error) },
      logs: {
        stdout: "",
        stderr: "",
        workspace: workspace.getTestDir(testName),
      },
    };
  }
}

// Export test definitions
export const coreTests: TestDefinition[] = [
  {
    name: "simple-response",
    category: "core",
    priority: "P1",
    run: async (config, workspace) => runSimpleResponse(config, workspace as WorkspaceManager),
  },
  {
    name: "multi-turn-context",
    category: "core",
    priority: "P1",
    run: async (config, workspace) => runMultiTurnContext(config, workspace as WorkspaceManager),
  },
  {
    name: "valid-jsonl",
    category: "core",
    priority: "P1",
    run: async (config, workspace) => runValidJsonl(config, workspace as WorkspaceManager),
  },
  {
    name: "message-ordering",
    category: "core",
    priority: "P1",
    run: async (config, workspace) => runMessageOrdering(config, workspace as WorkspaceManager),
  },
  {
    name: "premature-completion",
    category: "core",
    priority: "P2",
    run: async (config, workspace) => runPrematureCompletion(config, workspace as WorkspaceManager),
  },
];

// Export individual runners for use in main runner
export { runSimpleResponse, runMultiTurnContext, runValidJsonl, runMessageOrdering, runPrematureCompletion };

