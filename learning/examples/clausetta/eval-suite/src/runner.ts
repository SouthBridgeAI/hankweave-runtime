import type { ShimConfig, TestResult, TestSuiteResult, TestDefinition, TestCategory } from "./types.js";
import { WorkspaceManager, generateRunId } from "./workspace.js";
import { getLogger } from "./logger.js";
import { allTests, getTestsByCategory, getTestByName } from "./tests/index.js";
import { generateMarkdownReport, generateJsonSummary } from "./reporter.js";

export interface RunnerOptions {
  /** Test names to run (runs all if empty) */
  tests?: string[];
  /** Category to run */
  category?: TestCategory;
  /** Whether to preserve test directories */
  preserve?: boolean;
  /** Max parallel test execution (default: 1 = sequential) */
  parallel?: number;
}

/**
 * Run the test suite
 */
export async function runTestSuite(
  config: ShimConfig,
  options: RunnerOptions = {}
): Promise<TestSuiteResult> {
  const logger = getLogger();
  const startTime = Date.now();

  // Generate run ID based on shim name
  const shimName = config.command.split("/").pop() || "unknown";
  const runId = generateRunId(shimName);

  logger.info(`Starting evaluation run: ${runId}`);
  logger.info(`Shim: ${config.command}`);
  logger.info(`Model: ${config.model}`);
  logger.separator();

  // Initialize workspace
  const workspace = new WorkspaceManager(process.cwd(), runId);
  await workspace.initialize();

  // Determine which tests to run
  let testsToRun: TestDefinition[] = [];

  if (options.tests && options.tests.length > 0) {
    // Run specific tests
    for (const name of options.tests) {
      const test = getTestByName(name);
      if (test) {
        testsToRun.push(test);
      } else {
        logger.warn(`Test not found: ${name}`);
      }
    }
  } else if (options.category) {
    // Run tests in a category
    testsToRun = getTestsByCategory(options.category);
    logger.info(`Running ${testsToRun.length} tests in category: ${options.category}`);
  } else {
    // Run all tests
    testsToRun = [...allTests];
    logger.info(`Running all ${testsToRun.length} tests`);
  }

  // Run tests
  const results: TestResult[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  const maxParallel = options.parallel ?? 1;

  if (maxParallel > 1) {
    logger.info(`Running tests with parallelism: ${maxParallel}`);
  }

  // Helper to run a single test
  const runSingleTest = async (test: TestDefinition): Promise<TestResult> => {
    try {
      return await test.run(config, workspace);
    } catch (error) {
      logger.error(`Test ${test.name} threw unexpected error: ${error}`);
      return {
        name: test.name,
        passed: false,
        duration: 0,
        error: {
          message: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
        },
        logs: {
          stdout: "",
          stderr: "",
          workspace: "",
        },
      };
    }
  };

  // Process results helper
  const processResult = (result: TestResult) => {
    results.push(result);
    if (result.skipped) {
      skipped++;
    } else if (result.passed) {
      passed++;
    } else {
      failed++;
    }
  };

  if (maxParallel <= 1) {
    // Sequential execution (original behavior)
    for (const test of testsToRun) {
      const result = await runSingleTest(test);
      processResult(result);
    }
  } else {
    // Parallel execution with concurrency limit using a semaphore pattern
    const runWithConcurrency = async <T>(
      items: T[],
      fn: (item: T) => Promise<void>,
      concurrency: number
    ): Promise<void> => {
      const queue = [...items];
      const workers: Promise<void>[] = [];

      const worker = async () => {
        while (queue.length > 0) {
          const item = queue.shift();
          if (item !== undefined) {
            await fn(item);
          }
        }
      };

      // Start workers up to concurrency limit
      for (let i = 0; i < Math.min(concurrency, items.length); i++) {
        workers.push(worker());
      }

      await Promise.all(workers);
    };

    await runWithConcurrency(
      testsToRun,
      async (test) => {
        const result = await runSingleTest(test);
        processResult(result);
      },
      maxParallel
    );
  }

  const duration = Date.now() - startTime;

  logger.summary(passed, failed, skipped, duration);

  const suiteResult: TestSuiteResult = {
    shim: shimName,
    model: config.model,
    date: new Date().toISOString(),
    duration,
    passed,
    failed,
    skipped,
    results,
    runDir: workspace.runDir,
  };

  // Write reports
  try {
    const report = await generateMarkdownReport(suiteResult, config);
    const summary = generateJsonSummary(suiteResult);
    await workspace.writeReport("report.md", report);
    await workspace.writeReport("summary.json", summary);
  } catch (error) {
    logger.error(`Failed to write reports: ${error}`);
  }

  return suiteResult;
}

/**
 * Create a shim config for the claude CLI
 */
export function createClaudeConfig(model: string = "sonnet", timeout: number = 120000): ShimConfig {
  return {
    command: "claude",
    baseArgs: [
      "--dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "--verbose", // Required for stream-json with -p
    ],
    model,
    timeout,
  };
}

/**
 * Create a shim config for a custom shim
 */
export function createShimConfig(
  command: string,
  model: string,
  baseArgs: string[] = [],
  timeout: number = 120000
): ShimConfig {
  return {
    command,
    baseArgs,
    model,
    timeout,
  };
}

