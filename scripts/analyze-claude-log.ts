#!/usr/bin/env bun

import fs from "node:fs";
import path from "node:path";
import { logMessageSchema } from "../types/claude-session-schema.js";
import type { LogMessage, AssistantMessage, SystemMessage, UserMessage, ResultMessage } from "../types/claude-session-schema.js";
import { z } from "zod";

// Color codes for terminal output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgRed: "\x1b[41m",
  bgMagenta: "\x1b[45m",
};

interface Options {
  limit?: number;
  showErrors: boolean;
  exportReport: boolean;
  verbose: boolean;
}

interface ParseResult {
  lineNumber: number;
  success: boolean;
  message?: LogMessage;
  errors?: z.ZodIssue[];
  rawLine: string;
}

function printUsage() {
  console.log(`${colors.bright}Claude Log Analyzer${colors.reset}\n`);
  console.log("A comprehensive tool to check, validate, and view Claude log files.\n");
  console.log("Usage: bun scripts/analyze-claude-log.ts <log-file-path> [options]");
  console.log("\nOptions:");
  console.log("  --limit <n>        Limit output to first n messages");
  console.log("  --show-errors      Show validation errors inline");
  console.log("  --export-report    Export detailed validation report");
  console.log("  --verbose          Show all message details");
  console.log("\nExample: bun scripts/analyze-claude-log.ts path/to/claude.log --limit 10 --show-errors");
}

function truncateText(text: string, maxLength = 200): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + "...";
}

function parseLogFile(filePath: string): ParseResult[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n").filter(line => line.trim());

  return lines.map((line, index) => {
    try {
      const parsed = JSON.parse(line);
      const result = logMessageSchema.safeParse(parsed);

      if (result.success) {
        return {
          lineNumber: index + 1,
          success: true,
          message: result.data,
          rawLine: line
        };
      } else {
        return {
          lineNumber: index + 1,
          success: false,
          errors: result.error.issues,
          rawLine: line
        };
      }
    } catch (error) {
      return {
        lineNumber: index + 1,
        success: false,
        errors: [{
          path: [],
          message: "Invalid JSON",
          code: "custom" as const,
          fatal: false
        } as z.ZodIssue],
        rawLine: line
      };
    }
  });
}

function printStatistics(results: ParseResult[]) {
  const total = results.length;
  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  const messageTypes: Record<string, number> = {};
  const toolIdFormats = { claude: 0, nonClaude: 0 };

  results.forEach(result => {
    if (result.success && result.message) {
      messageTypes[result.message.type] = (messageTypes[result.message.type] || 0) + 1;

      // Count tool ID formats
      if (result.message.type === "assistant") {
        const assistMsg = result.message as AssistantMessage;
        if (Array.isArray(assistMsg.message.content)) {
          assistMsg.message.content.forEach(content => {
            if (content.type === "tool_use") {
              if (content.id.startsWith("toolu_")) {
                toolIdFormats.claude++;
              } else if (content.id.startsWith("call_")) {
                toolIdFormats.nonClaude++;
              }
            }
          });
        }
      }
    }
  });

  console.log(`\n${colors.bright}=== Log File Statistics ===${colors.reset}`);
  console.log(`${colors.bright}Parse Results:${colors.reset}`);
  console.log(`  Total lines: ${colors.cyan}${total}${colors.reset}`);
  console.log(`  Successfully parsed: ${colors.green}${successful}${colors.reset} (${((successful / total) * 100).toFixed(1)}%)`);
  console.log(`  Failed to parse: ${colors.red}${failed}${colors.reset} (${((failed / total) * 100).toFixed(1)}%)`);

  console.log(`\n${colors.bright}Message Types:${colors.reset}`);
  Object.entries(messageTypes).forEach(([type, count]) => {
    console.log(`  ${type}: ${colors.cyan}${count}${colors.reset}`);
  });

  if (toolIdFormats.claude > 0 || toolIdFormats.nonClaude > 0) {
    console.log(`\n${colors.bright}Tool ID Formats:${colors.reset}`);
    console.log(`  Claude (toolu_): ${colors.cyan}${toolIdFormats.claude}${colors.reset}`);
    console.log(`  Non-Claude (call_): ${colors.cyan}${toolIdFormats.nonClaude}${colors.reset}`);
  }
}

function printSystemMessage(msg: SystemMessage) {
  console.log(`${colors.bgBlue}${colors.white} SYSTEM INIT ${colors.reset}`);
  console.log(`  Session ID: ${colors.cyan}${msg.session_id}${colors.reset}`);
  console.log(`  Model: ${colors.cyan}${msg.model}${colors.reset}`);
  console.log(`  Working Dir: ${colors.cyan}${msg.cwd}${colors.reset}`);
  console.log(`  Tools: ${colors.dim}${msg.tools.join(", ")}${colors.reset}`);
}

function printAssistantMessage(msg: AssistantMessage, verbose: boolean) {
  console.log(`${colors.bgGreen} ASSISTANT ${colors.reset}`);
  console.log(`  Message ID: ${colors.cyan}${msg.message.id}${colors.reset}`);
  console.log(`  Model: ${colors.cyan}${msg.message.model}${colors.reset}`);

  if (msg.message.usage) {
    const usage = msg.message.usage;
    console.log(`  Tokens: ${colors.dim}in:${usage.input_tokens} out:${usage.output_tokens}${colors.reset}`);
  }

  if (Array.isArray(msg.message.content)) {
    msg.message.content.forEach(content => {
      if (content.type === "text") {
        const text = verbose ? content.text : truncateText(content.text, 150);
        console.log(`  ${colors.bright}Text:${colors.reset} ${text}`);
      } else if (content.type === "tool_use") {
        console.log(`  ${colors.magenta}Tool Use:${colors.reset} ${content.name} (ID: ${colors.dim}${content.id}${colors.reset})`);
        if (verbose && content.input) {
          console.log(`    Input: ${colors.dim}${JSON.stringify(content.input, null, 2).split('\n').join('\n    ')}${colors.reset}`);
        }
      } else if (content.type === "thinking") {
        const thinking = verbose ? content.thinking : truncateText(content.thinking, 100);
        console.log(`  ${colors.yellow}Thinking:${colors.reset} ${colors.dim}${thinking}${colors.reset}`);
      }
    });
  } else if (typeof msg.message.content === "string") {
    const text = verbose ? msg.message.content : truncateText(msg.message.content, 150);
    console.log(`  ${colors.bright}Text:${colors.reset} ${text}`);
  }
}

function printUserMessage(msg: UserMessage, verbose: boolean) {
  console.log(`${colors.bgYellow}${colors.white} USER ${colors.reset}`);

  if (Array.isArray(msg.message.content)) {
    msg.message.content.forEach(content => {
      if (content.type === "text") {
        const text = verbose ? content.text : truncateText(content.text, 150);
        console.log(`  ${colors.bright}Text:${colors.reset} ${text}`);
      } else if (content.type === "tool_result") {
        console.log(`  ${colors.magenta}Tool Result:${colors.reset} ${content.tool_use_id}`);
        if (verbose) {
          const resultStr = typeof content.content === "string" ? content.content : JSON.stringify(content.content, null, 2);
          console.log(`    Result: ${colors.dim}${truncateText(resultStr, 300)}${colors.reset}`);
        }
      }
    });
  } else if (typeof msg.message.content === "string") {
    const text = verbose ? msg.message.content : truncateText(msg.message.content, 150);
    console.log(`  ${colors.bright}Text:${colors.reset} ${text}`);
  }
}

function printResultMessage(msg: ResultMessage) {
  const bgColor = msg.is_error ? colors.bgRed : colors.bgGreen;
  console.log(`${bgColor}${colors.white} RESULT: ${msg.subtype.toUpperCase()} ${colors.reset}`);
  console.log(`  Duration: ${colors.cyan}${msg.duration_ms}ms${colors.reset} (API: ${msg.duration_api_ms}ms)`);
  console.log(`  Turns: ${colors.cyan}${msg.num_turns}${colors.reset}`);

  if (msg.total_cost_usd !== undefined) {
    console.log(`  Cost: ${colors.cyan}$${msg.total_cost_usd.toFixed(4)}${colors.reset}`);
  }

  if (msg.is_error) {
    console.log(`  ${colors.red}Error:${colors.reset} ${truncateText(msg.result, 200)}`);
  } else {
    console.log(`  ${colors.green}Success:${colors.reset} ${truncateText(msg.result, 200)}`);
  }
}

function printMessage(result: ParseResult, options: Options) {
  console.log(`\n${colors.dim}[Line ${result.lineNumber}]${colors.reset}`);

  if (!result.success) {
    console.log(`${colors.bgRed}${colors.white} PARSE ERROR ${colors.reset}`);
    if (options.showErrors && result.errors) {
      result.errors.forEach(error => {
        console.log(`  ${colors.red}${error.path.join(".")}: ${error.message}${colors.reset}`);
      });
    }
    return;
  }

  if (!result.message) return;

  switch (result.message.type) {
    case "system":
      printSystemMessage(result.message as SystemMessage);
      break;
    case "assistant":
      printAssistantMessage(result.message as AssistantMessage, options.verbose);
      break;
    case "user":
      printUserMessage(result.message as UserMessage, options.verbose);
      break;
    case "result":
      printResultMessage(result.message as ResultMessage);
      break;
  }
}

function exportValidationReport(filePath: string, results: ParseResult[]) {
  const reportPath = filePath + ".analysis-report.json";

  const report = {
    summary: {
      file: filePath,
      timestamp: new Date().toISOString(),
      totalLines: results.length,
      validLines: results.filter(r => r.success).length,
      invalidLines: results.filter(r => !r.success).length,
      successRate: ((results.filter(r => r.success).length / results.length) * 100).toFixed(2) + "%"
    },
    errors: results
      .filter(r => !r.success)
      .map(r => ({
        line: r.lineNumber,
        errors: r.errors?.map(e => ({
          path: e.path.join("."),
          message: e.message,
          code: e.code
        })),
        sample: truncateText(r.rawLine, 200)
      })),
    messageTypeCounts: results
      .filter(r => r.success && r.message)
      .reduce((acc, r) => {
        const type = r.message!.type;
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {} as Record<string, number>)
  };

  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return reportPath;
}

// Main execution
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    process.exit(0);
  }

  const logFilePath = args[0];

  if (!fs.existsSync(logFilePath)) {
    console.error(`${colors.red}Error: File not found: ${logFilePath}${colors.reset}`);
    process.exit(1);
  }

  // Parse options
  const options: Options = {
    limit: undefined,
    showErrors: args.includes("--show-errors"),
    exportReport: args.includes("--export-report"),
    verbose: args.includes("--verbose")
  };

  const limitIndex = args.indexOf("--limit");
  if (limitIndex !== -1 && args[limitIndex + 1]) {
    options.limit = parseInt(args[limitIndex + 1]);
  }

  try {
    console.log(`${colors.bright}Analyzing: ${colors.cyan}${logFilePath}${colors.reset}`);
    console.log(`File size: ${colors.cyan}${fs.statSync(logFilePath).size} bytes${colors.reset}`);

    const results = parseLogFile(logFilePath);

    // Print statistics
    printStatistics(results);

    // Export report if requested
    if (options.exportReport) {
      const reportPath = exportValidationReport(logFilePath, results);
      console.log(`\n${colors.green}Detailed report exported to: ${reportPath}${colors.reset}`);
    }

    // Print messages
    const messagesToShow = options.limit ? results.slice(0, options.limit) : results;
    console.log(`\n${colors.bright}=== Message Details ===${colors.reset}`);
    console.log(`Showing ${messagesToShow.length} of ${results.length} messages\n`);

    messagesToShow.forEach(result => printMessage(result, options));

    if (options.limit && results.length > options.limit) {
      console.log(`\n${colors.dim}... ${results.length - options.limit} more messages not shown${colors.reset}`);
    }

  } catch (error) {
    console.error(`${colors.red}Error analyzing log file: ${error}${colors.reset}`);
    process.exit(1);
  }
}
