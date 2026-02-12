import type { ShimConfig, TestResult, TestDefinition } from "../types.js";
import { runShim } from "../shim.js";
import { WorkspaceManager } from "../workspace.js";
import { assert, assertEqual, assertContains, assertDefined, assertMinLength, AssertionError } from "../utils/assertions.js";
import { getSystemMessage, getResultMessage, getAllAssistantText, getToolUseCalls, getToolResults, checkToolPairing, getUniqueToolNames } from "../utils/parsing.js";
import { isValidToolUseId, validateToolUseId } from "../utils/validation.js";
import { getLogger } from "../logger.js";

/**
 * TEST: Tool Workflow
 * Tests multiple tool operations - Write, Read, file verification.
 */
async function runToolWorkflow(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "tool-workflow";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      {
        prompt: `Please do the following in order:
1. Create a file called data.txt containing exactly "test data 123"
2. Read data.txt and tell me what it contains
3. Create a file called summary.txt containing "Read complete"`,
        timeout: 120000, // 2 minutes for tool operations
      },
      workspace,
      testName
    );

    // Verify exit code
    assertEqual(result.exitCode, 0, "Expected exit code 0", {
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 500),
    });

    // Verify files exist
    const dataExists = await workspace.fileExists(result.workspace, "data.txt");
    assert(dataExists, "File data.txt should exist");

    const summaryExists = await workspace.fileExists(result.workspace, "summary.txt");
    assert(summaryExists, "File summary.txt should exist");

    // Verify file contents
    const dataContent = await workspace.readFile(result.workspace, "data.txt");
    assertContains(dataContent, "test data 123", "data.txt should contain 'test data 123'");

    const summaryContent = await workspace.readFile(result.workspace, "summary.txt");
    assertContains(summaryContent, "Read complete", "summary.txt should contain 'Read complete'");

    // Verify agent reported what it read
    const assistantText = getAllAssistantText(result.messages);
    assertContains(assistantText, "test data 123", "Agent should report file contents");

    // Verify tool calls
    const toolCalls = getToolUseCalls(result.messages);
    assertMinLength(toolCalls, 3, "Should have at least 3 tool calls (2 writes + 1 read)");

    // Check tool names include Write and Read
    const toolNames = getUniqueToolNames(result.messages);
    assert(
      toolNames.some((n) => n.toLowerCase().includes("write") || n === "Write"),
      "Should use Write tool",
      { toolNames }
    );
    assert(
      toolNames.some((n) => n.toLowerCase().includes("read") || n === "Read"),
      "Should use Read tool",
      { toolNames }
    );

    // Verify tool pairing
    const pairing = checkToolPairing(result.messages);
    assert(pairing.paired, "All tool_use should have matching tool_result", {
      orphanToolUseIds: pairing.orphanToolUseIds,
      orphanToolResultIds: pairing.orphanToolResultIds,
    });

    // Verify tool IDs are valid
    for (const toolCall of toolCalls) {
      const validation = validateToolUseId(toolCall.id);
      assert(validation.valid, validation.reason || `Invalid tool ID: ${toolCall.id}`);
      assert(toolCall.name !== "unknown", `Tool name should not be "unknown"`, {
        toolId: toolCall.id,
        toolName: toolCall.name,
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

/**
 * TEST: Bash Command Execution
 * Verifies shell commands execute and output is captured.
 */
async function runBashCommand(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "bash-command";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      {
        prompt: `Run the command "echo hello_from_bash" and tell me what it outputs.
Then create a file called bash_test.txt containing the output.`,
        timeout: 60000,
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0");

    // Verify response mentions the output
    const assistantText = getAllAssistantText(result.messages);
    assertContains(assistantText, "hello_from_bash", "Response should mention command output");

    // Verify file exists and contains output
    const fileExists = await workspace.fileExists(result.workspace, "bash_test.txt");
    assert(fileExists, "File bash_test.txt should exist");

    const fileContent = await workspace.readFile(result.workspace, "bash_test.txt");
    assertContains(fileContent, "hello_from_bash", "File should contain command output");

    // Verify Bash tool was used
    const toolNames = getUniqueToolNames(result.messages);
    assert(
      toolNames.some((n) => n.toLowerCase().includes("bash") || n === "Bash" || n.toLowerCase().includes("shell")),
      "Should use Bash/shell tool",
      { toolNames }
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
 * TEST: Tool Completion Waiting
 * Verifies shim waits for slow tool operations to complete.
 */
async function runToolCompletionWaiting(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "tool-completion-waiting";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      {
        prompt: `Run the command "sleep 3 && echo done" and tell me what it outputs.`,
        timeout: 60000,
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0");

    // Duration should be at least 3 seconds
    assert(result.duration >= 3000, "Duration should be at least 3000ms (waited for sleep)", {
      duration: result.duration,
    });

    // Response should contain "done"
    const assistantText = getAllAssistantText(result.messages);
    assertContains(assistantText, "done", "Response should contain 'done' from command output");

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
 * TEST: Complex Workflow
 * A realistic multi-step workflow testing many behaviors at once.
 */
async function runComplexWorkflow(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "complex-workflow";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      {
        prompt: `I need you to do a small project:

1. Create a directory structure:
   - project/
     - src/
     - docs/

2. Create project/src/main.py with a simple "Hello World" Python script

3. Create project/docs/README.md with a brief description

4. List all files you created

5. Read main.py and tell me what it does`,
        timeout: 180000, // 3 minutes
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0", {
      stderr: result.stderr.slice(0, 500),
    });

    // Verify directories exist
    const srcExists = await workspace.dirExists(result.workspace, "project/src");
    assert(srcExists, "Directory project/src should exist");

    const docsExists = await workspace.dirExists(result.workspace, "project/docs");
    assert(docsExists, "Directory project/docs should exist");

    // Verify files exist
    const mainPyExists = await workspace.fileExists(result.workspace, "project/src/main.py");
    assert(mainPyExists, "File project/src/main.py should exist");

    const readmeExists = await workspace.fileExists(result.workspace, "project/docs/README.md");
    assert(readmeExists, "File project/docs/README.md should exist");

    // Verify main.py contains Python code
    const mainPyContent = await workspace.readFile(result.workspace, "project/src/main.py");
    assert(
      mainPyContent.includes("print") || mainPyContent.includes("Hello"),
      "main.py should contain Python code",
      { content: mainPyContent }
    );

    // Verify tool pairing
    const pairing = checkToolPairing(result.messages);
    assert(pairing.paired, "All tool_use should have matching tool_result", {
      orphanToolUseIds: pairing.orphanToolUseIds,
    });

    // Verify multiple tool types were used
    const toolNames = getUniqueToolNames(result.messages);
    assertMinLength(toolNames, 2, "Should use at least 2 different tool types", { toolNames });

    // Response should describe what main.py does
    const assistantText = getAllAssistantText(result.messages);
    assert(
      assistantText.toLowerCase().includes("hello") ||
        assistantText.toLowerCase().includes("print") ||
        assistantText.toLowerCase().includes("python"),
      "Response should describe what main.py does"
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
 * TEST: Permission Handling
 * Verifies operations that might need permissions don't hang.
 */
async function runPermissionHandling(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "permission-handling";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      {
        prompt: `Create a file called test.txt with "hello" and run "ls -la"`,
        timeout: config.timeout, // Use global timeout for consistency
      },
      workspace,
      testName
    );

    // Should complete (not hang)
    assertEqual(result.exitCode, 0, "Expected exit code 0");

    // File should exist
    const fileExists = await workspace.fileExists(result.workspace, "test.txt");
    assert(fileExists, "File test.txt should exist");

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
export const toolTests: TestDefinition[] = [
  {
    name: "tool-workflow",
    category: "tools",
    priority: "P1",
    run: async (config, workspace) => runToolWorkflow(config, workspace as WorkspaceManager),
  },
  {
    name: "bash-command",
    category: "tools",
    priority: "P1",
    run: async (config, workspace) => runBashCommand(config, workspace as WorkspaceManager),
  },
  {
    name: "tool-completion-waiting",
    category: "tools",
    priority: "P2",
    run: async (config, workspace) => runToolCompletionWaiting(config, workspace as WorkspaceManager),
  },
  {
    name: "complex-workflow",
    category: "tools",
    priority: "P1",
    run: async (config, workspace) => runComplexWorkflow(config, workspace as WorkspaceManager),
  },
  {
    name: "permission-handling",
    category: "tools",
    priority: "P2",
    run: async (config, workspace) => runPermissionHandling(config, workspace as WorkspaceManager),
  },
];

export { runToolWorkflow, runBashCommand, runToolCompletionWaiting, runComplexWorkflow, runPermissionHandling };

