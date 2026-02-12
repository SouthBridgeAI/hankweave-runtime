import type { ShimConfig, TestResult, TestDefinition } from "../types.js";
import { runShim } from "../shim.js";
import { WorkspaceManager } from "../workspace.js";
import { assert, assertEqual, AssertionError } from "../utils/assertions.js";
import { getAllAssistantText, getToolNames } from "../utils/parsing.js";
import { getLogger } from "../logger.js";

/**
 * TEST: Deep Research Workflow
 * 
 * Tests complex agentic behavior:
 * - Web search / research capabilities
 * - Progress tracking with incremental file updates
 * - Multi-step research workflow
 * - PDF generation (if available)
 * - File download capabilities
 * 
 * This test verifies that the agent can handle open-ended research tasks
 * with multiple tool calls and file operations.
 */
async function runDeepResearchWorkflow(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "deep-research-workflow";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const prompt = `Can you use web search and thoroughly do deep research on the current state of the art knowledge when it comes to the benefits of interval training on runs? What happens in the body, what it does over a longer period, good intervals to run? Prioritize primary sources and scientific papers. Download primary sources if you need to. Maintain a progress_track.md with questions, answers, links, citations, etc. Keep adding to it as you go, and at the end create a comprehensive, well formatted pdf covering everything.`;

    const result = await runShim(
      config,
      {
        prompt,
        timeout: 600000, // 10 minutes - research takes time
      },
      workspace,
      testName
    );

    // The test is considered passing if:
    // 1. The process completes (exit 0 or 1 with meaningful work done)
    // 2. progress_track.md was created
    // 3. Some research content exists in the files

    // Check if progress_track.md was created
    const progressTrackExists = await workspace.fileExists(result.workspace, "progress_track.md");
    assert(progressTrackExists, "progress_track.md should be created during research");

    // Read the progress track content
    const progressContent = await workspace.readFile(result.workspace, "progress_track.md");
    assert(
      progressContent.length > 100,
      "progress_track.md should have substantial content",
      { contentLength: progressContent.length }
    );

    // Check for expected research-related content
    const contentLower = progressContent.toLowerCase();
    const hasResearchContent = 
      contentLower.includes("interval") ||
      contentLower.includes("training") ||
      contentLower.includes("research") ||
      contentLower.includes("benefit");
    
    assert(
      hasResearchContent,
      "progress_track.md should contain research-related content about interval training",
      { contentSnippet: progressContent.slice(0, 500) }
    );

    // Check for tool usage - should have used search/web tools
    const toolNames = getToolNames(result.messages);
    const assistantText = getAllAssistantText(result.messages);
    
    // Verify some research activity happened (web search, file writes, etc.)
    const hasWriteTools = toolNames.some(name => 
      name.toLowerCase().includes("write") || 
      name.toLowerCase().includes("edit")
    );
    assert(hasWriteTools, "Should have used write/edit tools to create progress_track.md", {
      toolsUsed: toolNames,
    });

    // Check for web search usage (various tool names)
    const hasSearchTools = toolNames.some(name => 
      name.toLowerCase().includes("search") ||
      name.toLowerCase().includes("web") ||
      name.toLowerCase().includes("browse") ||
      name.toLowerCase().includes("fetch")
    );
    
    // Web search is expected but may not be available in all agents
    // Log a warning if not found but don't fail
    if (!hasSearchTools) {
      logger.warn("No web search tools detected - agent may not have web search capability");
    }

    // Check if PDF was created (optional - not all agents can create PDFs)
    const pdfFiles = await listPdfFiles(workspace, result.workspace);
    if (pdfFiles.length > 0) {
      logger.info(`PDF files created: ${pdfFiles.join(", ")}`);
    } else {
      logger.warn("No PDF files created - agent may not have PDF generation capability");
    }

    // Verify exit was clean
    assert(
      result.exitCode === 0 || result.exitCode === 1,
      "Exit code should be 0 (success) or 1 (completed with issues)",
      { exitCode: result.exitCode }
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
 * Helper to list PDF files in workspace
 */
async function listPdfFiles(workspace: WorkspaceManager, workspaceDir: string): Promise<string[]> {
  try {
    const { readdir } = await import("fs/promises");
    const { join } = await import("path");
    const files = await readdir(workspaceDir, { recursive: true });
    return files.filter(f => f.toString().endsWith(".pdf")).map(f => f.toString());
  } catch {
    return [];
  }
}

/**
 * TEST: Multi-File Project Creation
 * 
 * Tests the ability to create a structured multi-file project
 * with interdependent files and proper organization.
 */
async function runMultiFileProjectCreation(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "multi-file-project-creation";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const prompt = `Create a simple TypeScript project with the following structure:
- package.json with basic config
- src/index.ts with a main function that imports and uses a utility
- src/utils/helpers.ts with at least 2 exported helper functions  
- README.md explaining what the project does
- tsconfig.json with standard settings

After creating all files, list what you created.`;

    const result = await runShim(
      config,
      {
        prompt,
        timeout: 180000, // 3 minutes
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0");

    // Verify required files exist
    const requiredFiles = [
      "package.json",
      "src/index.ts",
      "src/utils/helpers.ts",
      "README.md",
      "tsconfig.json",
    ];

    for (const file of requiredFiles) {
      const exists = await workspace.fileExists(result.workspace, file);
      assert(exists, `Required file should exist: ${file}`);
    }

    // Verify package.json is valid JSON
    const packageJson = await workspace.readFile(result.workspace, "package.json");
    try {
      JSON.parse(packageJson);
    } catch {
      throw new AssertionError("package.json should be valid JSON", {
        expected: "valid JSON",
        actual: packageJson.slice(0, 200),
      });
    }

    // Verify index.ts imports from utils
    const indexContent = await workspace.readFile(result.workspace, "src/index.ts");
    assert(
      indexContent.includes("import") || indexContent.includes("require"),
      "src/index.ts should import from utils",
      { content: indexContent }
    );

    // Verify helpers has exports
    const helpersContent = await workspace.readFile(result.workspace, "src/utils/helpers.ts");
    assert(
      helpersContent.includes("export"),
      "src/utils/helpers.ts should have exports",
      { content: helpersContent }
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
 * TEST: Iterative File Refinement
 * 
 * Tests the ability to create a file, then iteratively improve it
 * based on feedback within a single conversation.
 */
async function runIterativeFileRefinement(config: ShimConfig, workspace: WorkspaceManager): Promise<TestResult> {
  const testName = "iterative-file-refinement";
  const startTime = Date.now();
  const logger = getLogger();

  logger.testStart(testName);

  try {
    const prompt = `I need you to help me create and iteratively improve a file:

1. Create a file called "story.txt" with a very short 2-sentence story about a robot.
2. Read what you wrote.
3. Now edit the file to add a third sentence that adds a twist to the story.
4. Read it again to verify your changes.
5. Finally, add a title at the beginning of the file.
6. Show me the final content.`;

    const result = await runShim(
      config,
      {
        prompt,
        timeout: 120000, // 2 minutes
      },
      workspace,
      testName
    );

    assertEqual(result.exitCode, 0, "Expected exit code 0");

    // Verify story.txt exists
    const storyExists = await workspace.fileExists(result.workspace, "story.txt");
    assert(storyExists, "story.txt should exist");

    // Read final content
    const storyContent = await workspace.readFile(result.workspace, "story.txt");
    
    // Should have at least 3 sentences worth of content
    assert(
      storyContent.length > 100,
      "story.txt should have substantial content after iterations",
      { contentLength: storyContent.length }
    );

    // Verify tool usage shows multiple write/edit/replace operations
    const toolNames = getToolNames(result.messages);
    const writeOperations = toolNames.filter(name => {
      const lower = name.toLowerCase();
      return lower.includes("write") || 
             lower.includes("edit") || 
             lower.includes("replace") ||
             lower.includes("patch");
    });
    assert(
      writeOperations.length >= 2,
      "Should have multiple write/edit/replace operations for iterations",
      { toolsUsed: toolNames, writeOps: writeOperations.length }
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

// Export test definitions
export const agenticTests: TestDefinition[] = [
  {
    name: "deep-research-workflow",
    category: "agentic",
    priority: "P3",
    run: async (config, workspace) => runDeepResearchWorkflow(config, workspace as WorkspaceManager),
  },
  {
    name: "multi-file-project-creation",
    category: "agentic",
    priority: "P2",
    run: async (config, workspace) => runMultiFileProjectCreation(config, workspace as WorkspaceManager),
  },
  {
    name: "iterative-file-refinement",
    category: "agentic",
    priority: "P2",
    run: async (config, workspace) => runIterativeFileRefinement(config, workspace as WorkspaceManager),
  },
];

export { runDeepResearchWorkflow, runMultiFileProjectCreation, runIterativeFileRefinement };

