import chalk from "chalk";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LoggerOptions {
  verbose: boolean;
}

/**
 * Simple logger for the eval suite
 */
export class Logger {
  private verbose: boolean;

  constructor(options: LoggerOptions) {
    this.verbose = options.verbose;
  }

  private timestamp(): string {
    return new Date().toISOString().slice(11, 23);
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.verbose) {
      console.error(chalk.gray(`[${this.timestamp()}] DEBUG: ${message}`), ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    console.error(chalk.blue(`[${this.timestamp()}] INFO: ${message}`), ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    console.error(chalk.yellow(`[${this.timestamp()}] WARN: ${message}`), ...args);
  }

  error(message: string, ...args: unknown[]): void {
    console.error(chalk.red(`[${this.timestamp()}] ERROR: ${message}`), ...args);
  }

  success(message: string, ...args: unknown[]): void {
    console.error(chalk.green(`[${this.timestamp()}] ✓ ${message}`), ...args);
  }

  failure(message: string, ...args: unknown[]): void {
    console.error(chalk.red(`[${this.timestamp()}] ✗ ${message}`), ...args);
  }

  testStart(testName: string): void {
    console.error(chalk.cyan(`[${this.timestamp()}] Running: ${testName}`));
  }

  testPass(testName: string, duration: number): void {
    console.error(chalk.green(`[${this.timestamp()}] ✓ PASS: ${testName} (${duration}ms)`));
  }

  testFail(testName: string, duration: number, error: string): void {
    console.error(chalk.red(`[${this.timestamp()}] ✗ FAIL: ${testName} (${duration}ms)`));
    console.error(chalk.red(`  Error: ${error}`));
  }

  testSkip(testName: string, reason: string): void {
    console.error(chalk.yellow(`[${this.timestamp()}] ⏭ SKIP: ${testName} - ${reason}`));
  }

  separator(): void {
    console.error(chalk.gray("─".repeat(60)));
  }

  summary(passed: number, failed: number, skipped: number, duration: number): void {
    this.separator();
    const total = passed + failed + skipped;
    const durationStr = (duration / 1000).toFixed(1);

    console.error("");
    console.error(chalk.bold("Summary:"));
    console.error(chalk.green(`  ✓ ${passed} passed`));
    if (failed > 0) {
      console.error(chalk.red(`  ✗ ${failed} failed`));
    }
    if (skipped > 0) {
      console.error(chalk.yellow(`  ⏭ ${skipped} skipped`));
    }
    console.error(chalk.gray(`  Total: ${total} tests in ${durationStr}s`));
    console.error("");
  }
}

// Global logger instance
let globalLogger: Logger | null = null;

export function initLogger(options: LoggerOptions): Logger {
  globalLogger = new Logger(options);
  return globalLogger;
}

export function getLogger(): Logger {
  if (!globalLogger) {
    globalLogger = new Logger({ verbose: false });
  }
  return globalLogger;
}

