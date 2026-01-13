import type { StrandweaveConfig } from "./types/types.js";

/**
 * Flags that take a value (support both --flag=value and --flag value)
 */
const VALUE_FLAGS = new Set([
  "--config",
  "--data",
  "--execution",
  "--anthropic-base-url",
  "--port",
  "--model",
  "--idle-timeout",
  "--input",
]);

/**
 * Boolean flags (do not take a value)
 */
const BOOLEAN_FLAGS = new Set([
  "--headless",
  "--validate",
  "-v",
  "--cleanup",
  "-y",
  "--no-autostart",
  "--start-new",
  "--copy",
  "--proxy",
  "--without-proxy",
  "--init",
  "--help",
  "-h",
  "--force",
]);

/**
 * All known flags (union of VALUE_FLAGS and BOOLEAN_FLAGS)
 */
const ALL_KNOWN_FLAGS = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

/**
 * Get value for a flag, supporting both --flag=value (deprecated) and --flag value syntax.
 * Returns undefined if flag is not present.
 */
export function getFlagValue(args: string[], flagName: string): string | undefined {
  // Check for deprecated --flag=value syntax
  const equalsIndex = args.findIndex((arg) => arg.startsWith(`${flagName}=`));
  if (equalsIndex !== -1) {
    console.warn(
      `⚠️  Deprecation warning: '${args[equalsIndex]}' uses deprecated syntax. Use '${flagName} <value>' instead.`,
    );
    return args[equalsIndex].split("=")[1];
  }

  // Check for --flag value syntax
  const flagIndex = args.indexOf(flagName);
  if (flagIndex !== -1 && flagIndex + 1 < args.length) {
    const nextArg = args[flagIndex + 1];
    // Make sure next arg is not another flag
    if (!nextArg.startsWith("-")) {
      return nextArg;
    }
  }

  return undefined;
}

/**
 * Result of parsing CLI arguments
 */
export interface ParsedCliArgs extends Partial<StrandweaveConfig> {
  // Positional arguments
  strandPath?: string;
  dataPath?: string;

  // Value flags (not in StrandweaveConfig)
  configPath?: string; // --config
  dataFlag?: string; // --data
  executionPath?: string; // --execution
  inputText?: string; // --input

  // Boolean flags (not in StrandweaveConfig)
  headless?: boolean; // --headless
  validate?: boolean; // --validate, -v
  cleanup?: boolean; // --cleanup
  skipConfirmation?: boolean; // -y
  startNew?: boolean; // --start-new
  force?: boolean; // --force
  init?: boolean; // --init
  help?: boolean; // --help, -h
  copy?: boolean; // --copy
}

/**
 * Parse CLI arguments into a structured config object with positional args.
 * Extracts both configuration flags and positional arguments (strand path, data path).
 *
 * Positional argument logic:
 * - 0 positional args: both undefined
 * - 1 positional arg: treated as dataPath (strandPath will default to "strand.json")
 * - 2 positional args: first is strandPath, second is dataPath
 *
 * Throws errors for:
 * - Unknown flags
 * - Boolean flags with values (e.g., --headless=value)
 * - Value flags without values (e.g., --port with nothing after)
 * - More than 2 positional arguments
 */
export function parseCliArgs(args: string[]): ParsedCliArgs {
  const result: ParsedCliArgs = {};

  // Extract positional arguments with validation
  const positional: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    // Special case: single dash "-" is a positional arg (stdin indicator)
    if (arg === "-") {
      positional.push(arg);
      i++;
    } else if (arg.startsWith("-")) {
      // Check for --flag=value syntax
      const equalsIndex = arg.indexOf("=");
      const flagName = equalsIndex > 0 ? arg.substring(0, equalsIndex) : arg;

      // Validate: check if flag is known
      if (!ALL_KNOWN_FLAGS.has(flagName)) {
        throw new Error(`Unknown argument '${arg}'. Run with --help for available options.`);
      }

      if (BOOLEAN_FLAGS.has(flagName)) {
        // Validate: boolean flags should not have values
        if (equalsIndex > 0) {
          throw new Error(`Flag '${flagName}' does not take a value.`);
        }
        i++;
      } else if (VALUE_FLAGS.has(flagName)) {
        if (equalsIndex > 0) {
          // --flag=value syntax, just skip this arg
          i++;
        } else {
          // --flag value syntax, validate value exists and is not another flag
          if (i + 1 >= args.length || args[i + 1].startsWith("-")) {
            throw new Error(`Flag '${flagName}' requires a value.`);
          }
          i += 2;
        }
      }
    } else {
      // Positional argument
      positional.push(arg);
      i++;
    }
  }

  // Validate: no more than 2 positional arguments
  if (positional.length > 2) {
    throw new Error(
      `Too many positional arguments. Expected at most 2 (strand-path, data-path), got ${positional.length}.`,
    );
  }

  // Set positional args with smart logic:
  // If only 1 arg:
  //   - If it ends with .json, treat it as strandPath (strand config file)
  //   - Otherwise, treat it as dataPath (strand defaults to "strand.json")
  // If 2+ args, first is strandPath, second is dataPath
  if (positional.length === 1) {
    if (positional[0].endsWith(".json")) {
      result.strandPath = positional[0];
    } else {
      result.dataPath = positional[0];
    }
  } else if (positional.length === 2) {
    result.strandPath = positional[0];
    result.dataPath = positional[1];
  }

  // Parse port
  const portArg = getFlagValue(args, "--port");
  if (portArg) {
    result.port = parseInt(portArg, 10);
  }

  // Parse model
  const modelArg = getFlagValue(args, "--model");
  if (modelArg) {
    result.model = modelArg as "sonnet" | "opus";
  }

  // Parse anthropicBaseUrl
  const baseUrlArg = getFlagValue(args, "--anthropic-base-url");
  if (baseUrlArg) {
    result.anthropicBaseUrl = baseUrlArg;
  }

  // Parse autostart (inverse of --no-autostart)
  if (args.includes("--no-autostart")) {
    result.autostart = false;
  }

  // Parse proxy flags (proxy is OFF by default)
  if (args.includes("--proxy")) {
    result.withoutProxy = false; // Enable proxy
  }
  // Keep --without-proxy for backward compatibility (now redundant since proxy is off by default)
  if (args.includes("--without-proxy")) {
    result.withoutProxy = true;
  }

  // Parse idleTimeout
  const idleTimeoutArg = getFlagValue(args, "--idle-timeout");
  if (idleTimeoutArg) {
    result.idleTimeout = parseInt(idleTimeoutArg, 10);
  }

  // Parse value flags (non-config)
  result.configPath = getFlagValue(args, "--config");
  result.dataFlag = getFlagValue(args, "--data");
  result.executionPath = getFlagValue(args, "--execution");
  result.inputText = getFlagValue(args, "--input");

  // Parse boolean flags (non-config)
  result.headless = args.includes("--headless");
  result.validate = args.includes("--validate") || args.includes("-v");
  result.cleanup = args.includes("--cleanup");
  result.skipConfirmation = args.includes("-y");
  result.startNew = args.includes("--start-new");
  result.force = args.includes("--force");
  result.init = args.includes("--init");
  result.help = args.includes("--help") || args.includes("-h");
  result.copy = args.includes("--copy");

  return result;
}
