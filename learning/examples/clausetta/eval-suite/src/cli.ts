import { Command } from "commander";
import { runTestSuite, createClaudeConfig, createShimConfig } from "./runner.js";
import { generateMarkdownReport, writeReports } from "./reporter.js";
import { initLogger, getLogger } from "./logger.js";
import { WorkspaceManager, generateRunId } from "./workspace.js";
import type { TestCategory } from "./types.js";
import { getAllTestNames } from "./tests/index.js";

const program = new Command();

program
  .name("shim-eval")
  .description("Evaluation suite for shim implementations")
  .version("1.0.0");

program
  .option("--shim <command>", "Shim command to test (default: claude)")
  .option("--model <model>", "Model to use for tests (default: sonnet)")
  .option("--test <name...>", "Run specific tests by name (can be repeated)")
  .option("--category <category>", "Run tests in a category (core, tools, signals, sessions, errors, stress)")
  .option("--timeout <ms>", "Test timeout in milliseconds (default: 180000)", "180000")
  .option("--parallel <n>", "Run up to N tests in parallel (default: 5)", "5")
  .option("--preserve", "Preserve test directories after run")
  .option("--verbose", "Enable verbose logging")
  .option("-o, --output <file>", "Write report to file")
  .option("--list", "List all available tests")
  .option("--base-args <args>", "Additional base arguments for the shim (comma-separated)")
  .action(async (options) => {
    // Initialize logger
    initLogger({ verbose: options.verbose || false });
    const logger = getLogger();

    // List tests if requested
    if (options.list) {
      console.log("Available tests:");
      for (const name of getAllTestNames()) {
        console.log(`  - ${name}`);
      }
      process.exit(0);
    }

    // Determine shim config
    let config;
    const timeout = parseInt(options.timeout, 10);

    if (!options.shim || options.shim === "claude") {
      // Use claude CLI with default settings
      config = createClaudeConfig(options.model || "sonnet", timeout);
      logger.info("Using claude CLI for testing");
    } else {
      // Custom shim
      const baseArgs = options.baseArgs ? options.baseArgs.split(",") : [];
      config = createShimConfig(options.shim, options.model || "sonnet", baseArgs, timeout);
      logger.info(`Using custom shim: ${options.shim}`);
    }

    // Run tests
    try {
      const parallel = parseInt(options.parallel, 10);
      const results = await runTestSuite(config, {
        tests: options.test && options.test.length > 0 ? options.test : undefined,
        category: options.category as TestCategory | undefined,
        preserve: options.preserve,
        parallel: parallel > 0 ? parallel : 1,
      });

      // Generate report
      const report = await generateMarkdownReport(results);

      // Write reports to run directory
      const workspace = new WorkspaceManager(process.cwd(), generateRunId(config.command.split("/").pop() || "unknown"));
      // Note: reports are already written by the runner, but we can also write to a custom location
      if (options.output) {
        const fs = await import("fs/promises");
        await fs.writeFile(options.output, report);
        logger.info(`Report written to: ${options.output}`);
      }

      // Print report location
      logger.info(`Full report available at: ${results.runDir}/report.md`);

      // Exit with appropriate code
      process.exit(results.failed > 0 ? 1 : 0);
    } catch (error) {
      logger.error(`Evaluation failed: ${error}`);
      process.exit(2);
    }
  });

// Parse and execute
program.parse();

