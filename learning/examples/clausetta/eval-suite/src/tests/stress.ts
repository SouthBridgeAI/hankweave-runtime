import type { ShimConfig, TestResult, TestDefinition } from "../types.js";
import { runShim } from "../shim.js";
import { WorkspaceManager } from "../workspace.js";
import { assert, assertEqual, assertContains, assertDefined, AssertionError } from "../utils/assertions.js";
import { getResultMessage, getAllAssistantText } from "../utils/parsing.js";
import { getLogger } from "../logger.js";

/**
 * TEST: Large File Handling
 * Verifies can handle reading/writing larger files.
 */
async function runLargeFileHandling(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "large-file-handling";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    // Create large file fixture
    const lines: string[] = [];
    for (let i = 1; i <= 10000; i++) {
      lines.push(`Line ${i}: This is line number ${i} of the test file.`);
    }
    const largeFileContent = lines.join("\n");

    const result = await runShim(
      config,
      {
        prompt: "Read large.txt and tell me how many lines it has. Just give me the number.",
        fixtures: {
          "large.txt": largeFileContent,
        },
        timeout: 120000,
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0");

    // Response should mention approximately 10000 lines (could be 9999-10001 depending on counting)
    const assistantText = getAllAssistantText(result.messages);
    assert(
      assistantText.includes("10000") ||
      assistantText.includes("10,000") ||
      assistantText.includes("10 000") ||
      assistantText.includes("9999") ||
      assistantText.includes("9,999") ||
      assistantText.toLowerCase().includes("ten thousand"),
      "Response should mention approximately 10000 lines",
      { response: assistantText.slice(0, 500) }
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
 * TEST: Unicode Handling
 * Verifies non-ASCII characters work in prompts and files.
 */
async function runUnicodeHandling(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "unicode-handling";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const unicodeContent = "こんにちは 🌍 مرحبا";

    const result = await runShim(
      config,
      {
        prompt: "Read unicode.txt and repeat its contents back to me exactly.",
        fixtures: {
          "unicode.txt": unicodeContent,
        },
        timeout: 60000,
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0");

    // Response should contain the unicode characters
    const assistantText = getAllAssistantText(result.messages);
    assert(
      assistantText.includes("こんにちは") || assistantText.includes("🌍") || assistantText.includes("مرحبا"),
      "Response should contain unicode characters from file",
      { response: assistantText.slice(0, 500) }
    );

    // Verify output is valid UTF-8 by checking no parse errors occurred
    assertEqual(result.parseErrors.length, 0, "All output should be valid JSON (UTF-8)", {
      parseErrors: result.parseErrors,
    });

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
 * TEST: Binary File Handling
 * Verifies shim handles binary files in the workspace without crashing.
 */
async function runBinaryFileHandling(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "binary-file-handling";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    // Create a small binary file (random bytes)
    const binaryContent = Buffer.from([0x00, 0xff, 0x00, 0xff, 0xde, 0xad, 0xbe, 0xef]);

    const result = await runShim(
      config,
      {
        prompt: "Check the file data.bin and tell me how many bytes it has. Do not try to read it as text.",
        fixtures: {
          "data.bin": binaryContent,
        },
        timeout: 60000,
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0");

    // Response should mention 8 bytes
    const assistantText = getAllAssistantText(result.messages);
    assert(
      assistantText.includes("8") || assistantText.toLowerCase().includes("eight"),
      "Response should mention the file size (8 bytes)",
      { response: assistantText }
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
 * TEST: Large Output Handling
 * Verifies shim handles large amounts of streaming output.
 */
async function runLargeOutputHandling(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "large-output-handling";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const result = await runShim(
      config,
      {
        prompt: "Write a 2000 word essay about the future of AI. Make it very long and detailed.",
        timeout: 180000, // 3 minutes
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0");

    // Check that we got a substantial amount of output
    const assistantText = getAllAssistantText(result.messages);
    assert(assistantText.length > 5000, "Response should be reasonably long (>5000 chars)", {
      actualLength: assistantText.length,
    });

    // Verify all messages were parsed correctly
    assertEqual(result.parseErrors.length, 0, "Should have no parse errors even with large output");

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
export const stressTests: TestDefinition[] = [
  {
    name: "large-file-handling",
    category: "stress",
    priority: "P3",
    run: async (config, workspace) => runLargeFileHandling(config, workspace as WorkspaceManager),
  },
  {
    name: "unicode-handling",
    category: "stress",
    priority: "P3",
    run: async (config, workspace) => runUnicodeHandling(config, workspace as WorkspaceManager),
  },
  {
    name: "binary-file-handling",
    category: "stress",
    priority: "P3",
    run: async (config, workspace) => runBinaryFileHandling(config, workspace as WorkspaceManager),
  },
  {
    name: "large-output-handling",
    category: "stress",
    priority: "P3",
    run: async (config, workspace) => runLargeOutputHandling(config, workspace as WorkspaceManager),
  },
];

export { runLargeFileHandling, runUnicodeHandling, runBinaryFileHandling, runLargeOutputHandling };

