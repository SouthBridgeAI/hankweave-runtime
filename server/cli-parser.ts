import { SHIM_IDLE_TIMEOUT_MAX_SECONDS } from "./config.js";
import type { HankweaveConfig } from "./types/types.js";

/**
 * Show deprecation warnings for old flags.
 * Called after parsing to inform users about preferred alternatives.
 */
export function showDeprecationWarnings(args: ParsedCliArgs): void {
  if (args.ignoreDataMismatch) {
    console.warn(`⚠️  --ignore-data-mismatch is deprecated. Use --force instead.`);
  }
}

/**
 * Flags that take a value (support both --flag=value and --flag value)
 * Short aliases: -p (port), -o (output), -e (execution), -i (input), -m (model)
 */
const VALUE_FLAGS = new Set([
  "--config",
  "--data",
  "--execution",
  "-e",
  "--anthropic-base-url",
  "--port",
  "-p",
  "--model",
  "-m",
  "--idle-timeout",
  "--shim-idle-timeout",
  "--input",
  "-i",
  "--output",
  "-o",
  "--replay",
  "--max-cost",
  "--max-time",
]);

/**
 * Boolean flags (do not take a value)
 * Short aliases: -v (validate), -h (help), -y (skip confirmation), -n (start-new)
 */
const BOOLEAN_FLAGS = new Set([
  "--headless",
  "--validate",
  "-v",
  "--cleanup",
  "-y",
  "--no-autostart",
  "--start-new",
  "--new",
  "-n",
  "--copy",
  "--proxy",
  "--without-proxy",
  "--init",
  "--help",
  "-h",
  "--version",
  "--force",
  "-f",
  "--ignore-rig-failures",
  "--attach",
  "--ignore-data-mismatch", // Deprecated: use --force instead
  "--overwrite-output",
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
export interface ParsedCliArgs extends Omit<Partial<HankweaveConfig>, "version"> {
  // Positional arguments
  hankPath?: string;
  dataPath?: string;

  // Value flags (not in HankweaveConfig)
  configPath?: string; // --config
  dataFlag?: string; // --data
  executionPath?: string; // --execution, -e
  inputText?: string; // --input, -i
  outputPath?: string; // --output, -o

  // Boolean flags (not in HankweaveConfig)
  headless?: boolean; // --headless
  validate?: boolean; // --validate, -v
  cleanup?: boolean; // --cleanup
  skipConfirmation?: boolean; // -y
  startNew?: boolean; // --start-new, --new, -n
  force?: boolean; // --force, -f
  init?: boolean; // --init
  help?: boolean; // --help, -h
  showVersion?: boolean; // --version
  copy?: boolean; // --copy
  ignoreRigFailures?: boolean; // --ignore-rig-failures
  attach?: boolean; // --attach
  ignoreDataMismatch?: boolean; // --ignore-data-mismatch (deprecated, use --force)
  overwriteOutput?: boolean; // --overwrite-output
  replayDir?: string; // --replay <path> - replay from an execution directory dump
}

/**
 * Parse CLI arguments into a structured config object with positional args.
 * Extracts both configuration flags and positional arguments (hank path, data path).
 *
 * Positional argument logic:
 * - 0 positional args: both undefined
 * - 1 positional arg: treated as dataPath (hankPath will default to "hank.json")
 * - 2 positional args: first is hankPath, second is dataPath
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
      `Too many positional arguments. Expected at most 2 (hank-path, data-path), got ${positional.length}.`,
    );
  }

  // Set positional args with smart logic:
  // If only 1 arg:
  //   - If it ends with .json, treat it as hankPath (hank config file)
  //   - If it looks like a remote URL (https:// or git@), treat it as hankPath
  //   - Otherwise, treat it as dataPath (hank defaults to "hank.json")
  // If 2+ args, first is hankPath, second is dataPath
  const looksLikeRemoteUrl = (s: string) =>
    s.startsWith("https://") || s.startsWith("http://") || s.startsWith("git@");

  if (positional.length === 1) {
    if (positional[0].endsWith(".json") || looksLikeRemoteUrl(positional[0])) {
      result.hankPath = positional[0];
    } else {
      result.dataPath = positional[0];
    }
  } else if (positional.length === 2) {
    result.hankPath = positional[0];
    result.dataPath = positional[1];
  }

  // Parse port (-p, --port)
  const portArg = getFlagValue(args, "--port") || getFlagValue(args, "-p");
  if (portArg) {
    result.port = parseInt(portArg, 10);
  }

  // Parse model (-m, --model)
  const modelArg = getFlagValue(args, "--model") || getFlagValue(args, "-m");
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

  // Parse ignoreRigFailures (only set when flag is present)
  if (args.includes("--ignore-rig-failures")) {
    result.ignoreRigFailures = true;
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
    const parsed = parseInt(idleTimeoutArg, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 255) {
      throw new Error(
        `Invalid --idle-timeout value: "${idleTimeoutArg}" (must be a positive integer, max 255)`,
      );
    }
    result.idleTimeout = parsed;
  }

  // Parse shimIdleTimeout
  const shimIdleTimeoutArg = getFlagValue(args, "--shim-idle-timeout");
  if (shimIdleTimeoutArg) {
    const parsed = parseInt(shimIdleTimeoutArg, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > SHIM_IDLE_TIMEOUT_MAX_SECONDS) {
      throw new Error(
        `Invalid --shim-idle-timeout value: "${shimIdleTimeoutArg}" (must be a positive integer, max ${SHIM_IDLE_TIMEOUT_MAX_SECONDS})`,
      );
    }
    result.shimIdleTimeout = parsed;
  }

  // Parse maxCost (--max-cost)
  const maxCostArg = getFlagValue(args, "--max-cost");
  if (maxCostArg) {
    const parsed = parseFloat(maxCostArg);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`Invalid --max-cost value: "${maxCostArg}" (must be a positive number)`);
    }
    result.budget = { ...result.budget, maxDollars: parsed };
  }

  // Parse maxTime (--max-time)
  const maxTimeArg = getFlagValue(args, "--max-time");
  if (maxTimeArg) {
    const parsed = parseFloat(maxTimeArg);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid --max-time value: "${maxTimeArg}" (must be a positive number, in seconds)`,
      );
    }
    result.budget = { ...result.budget, maxTimeSeconds: parsed };
  }

  // Parse value flags (non-config)
  result.configPath = getFlagValue(args, "--config");
  result.dataFlag = getFlagValue(args, "--data");
  result.executionPath = getFlagValue(args, "--execution") || getFlagValue(args, "-e");
  result.inputText = getFlagValue(args, "--input") || getFlagValue(args, "-i");
  result.outputPath = getFlagValue(args, "--output") || getFlagValue(args, "-o");
  result.replayDir = getFlagValue(args, "--replay");

  // Parse boolean flags (non-config)
  result.headless = args.includes("--headless");
  result.validate = args.includes("--validate") || args.includes("-v");
  result.cleanup = args.includes("--cleanup");
  result.skipConfirmation = args.includes("-y");
  result.startNew = args.includes("--start-new") || args.includes("--new") || args.includes("-n");
  result.force = args.includes("--force") || args.includes("-f");
  result.init = args.includes("--init");
  result.help = args.includes("--help") || args.includes("-h");
  result.showVersion = args.includes("--version");
  result.copy = args.includes("--copy");
  result.attach = args.includes("--attach");
  result.ignoreDataMismatch = args.includes("--ignore-data-mismatch");
  result.overwriteOutput = args.includes("--overwrite-output");

  return result;
}
