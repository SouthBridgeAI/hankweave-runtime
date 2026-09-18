import { SHIM_IDLE_TIMEOUT_MAX_SECONDS } from "./config.js";
import type { HankweaveConfig } from "./types/types.js";
import { isBundlePath } from "./utils.js";

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
  "--restore-journal",
  "--diet-journal",
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
  "--yes",
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
  "--no-wipe",
  "--ignore-rig-failures",
  "--attach",
  "--ignore-data-mismatch", // Deprecated: use --force instead
  "--overwrite-output",
]);

/**
 * All known flags (union of VALUE_FLAGS and BOOLEAN_FLAGS)
 */
export const ALL_KNOWN_FLAGS: ReadonlySet<string> = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);

/**
 * Help text for --help/-h. Lives next to the flag tables so the
 * help/parser parity test can compare it against ALL_KNOWN_FLAGS.
 */
export const HELP_TEXT = `
Hankweave Runtime - Codon Orchestration

Usage: hankweave [options] [config-or-data-path]
       hankweave <bundle.hank> [data-path]
       hankweave pack [hankPathOrDir] [options]

Commands:
  pack                      Create a deterministic .hank bundle + hank.lock
                            (own flag namespace; see: hankweave pack --help)

Arguments:
  config-or-data-path       Path to hank.json or project directory
                            When only one argument provided:
                            - If ends with .json: treated as hank-path
                            - If ends with .hank or .tar.zst: treated as a packed bundle
                              (verified against hank.lock and extracted to a directory named
                              by its bundleHash, reused on later runs after re-verification)
                            - Otherwise: treated as data-path
                            (a data directory literally named "pack" must be
                            written "./pack")

Execution Control:
  -e, --execution <path>    Use specific execution directory
                            Creates if doesn't exist, resumes if has state
  --replay <path>           Replay an execution from recorded logs (no LLM calls)
                            Mutually exclusive with --execution
  -n, --new, --start-new    Start new execution, never resume
                            Use -n -f to overwrite existing state
  -f, --force               Override safety checks (hash mismatch, existing state)
  --no-wipe                 With --start-new --force, preserve the existing
                            agentRoot/ workspace instead of wiping it
  -y, --yes                 Skip confirmation prompts
  --max-cost <dollars>      Set a run-wide cost ceiling in USD
  --max-time <seconds>      Set a run-wide wall-clock limit in seconds

Output:
  -o, --output <path>       Copy outputs to this path (default: stay in execution dir)
  --overwrite-output        Overwrite existing output files instead of renaming

Configuration:
  --config <path>           Path to hank.json (alternative to positional arg)
  --data <path>             Path to data source (default: config directory)
  -i, --input <text>        Use inline text as data input (highest priority)
  -m, --model <model>       Model override (sonnet|opus|gemini-flash|etc)

Server:
  -p, --port <port>         WebSocket server port (default: auto-select free port)
  --headless                Run without TUI (for CI/CD and scripts)
  --no-autostart            Don't automatically start codons
  --proxy                   Enable the LLM proxy server (disabled by default)
  --without-proxy           Disable the LLM proxy (this is the default)
  --anthropic-base-url <url>  Custom Anthropic API base URL
  --idle-timeout <seconds>  Idle timeout for WebSocket and proxy servers (0-255, 0 disables, default: 0)
  --shim-idle-timeout <seconds>   Harness idle timeout in seconds (default: 120, per-codon)

Other:
  --init                    Initialize a new hank in current directory
  -v, --validate            Validate configuration without running
  --cleanup                 Remove execution artifacts
  --restore-journal <path>  Rebuild a dieted execution's event journal (byte-for-byte, verified)
  --diet-journal <path>     Compress a finished execution's event journal (restorable)
  --copy                    Copy data instead of symlinking (for compatibility)
  --ignore-rig-failures     Ignore rig setup failures
  --attach                  Connect TUI to an already-running server (read-only mode)
  --ignore-data-mismatch    [Deprecated] Use --force instead
  -h, --help                Show this help
  --version                 Show version

Execution Safety:
  Hankweave implements a three-tier safety system for execution directories:
  - Tier 1: Cannot use ~/.hankweave-executions/ directly (reserved for auto-managed)
  - Tier 2: Directories with existing .hankweave/ require --force (backs up existing)
  - Tier 3: Non-empty directories show warning and prompt for confirmation

Examples:
  hankweave                           Run with hank.json in current directory
  hankweave ./my-project              Run project, resume if possible
  hankweave ./my-project -n           Start fresh execution (--new)
  hankweave -e ./my-exec              Use specific execution directory
  hankweave -o ./results              Copy outputs to ./results
  hankweave -m opus -p 8080           Use opus model on port 8080

Outputs are stored in the agent workspace (~/.hankweave-executions/{id}/agentRoot) by default.
Use --output to copy them elsewhere.
`;

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
    // Everything after the first "=" (a value may itself contain "=")
    return args[equalsIndex].slice(flagName.length + 1);
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
  skipConfirmation?: boolean; // --yes, -y
  startNew?: boolean; // --start-new, --new, -n
  force?: boolean; // --force, -f
  noWipe?: boolean; // --no-wipe (preserve agentRoot/ on --start-new --force)
  init?: boolean; // --init
  help?: boolean; // --help, -h
  showVersion?: boolean; // --version
  copy?: boolean; // --copy
  ignoreRigFailures?: boolean; // --ignore-rig-failures
  attach?: boolean; // --attach
  ignoreDataMismatch?: boolean; // --ignore-data-mismatch (deprecated, use --force)
  overwriteOutput?: boolean; // --overwrite-output
  replayDir?: string; // --replay <path> - replay from an execution directory dump
  restoreJournalPath?: string; // --restore-journal <executionPath> - rebuild a dieted event journal
  dietJournalPath?: string; // --diet-journal <executionPath> - diet a finished run's event journal offline
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
    if (
      positional[0].endsWith(".json") ||
      isBundlePath(positional[0]) ||
      looksLikeRemoteUrl(positional[0])
    ) {
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

  // Parse idleTimeout (strict integer; 0 is valid and disables the timeout)
  const idleTimeoutArg = getFlagValue(args, "--idle-timeout");
  if (idleTimeoutArg !== undefined) {
    const parsed = Number(idleTimeoutArg);
    if (!/^\d+$/.test(idleTimeoutArg) || !Number.isInteger(parsed) || parsed > 255) {
      throw new Error(
        `Invalid --idle-timeout value: "${idleTimeoutArg}" (must be an integer between 0 and 255; 0 disables the timeout)`,
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
  result.restoreJournalPath = getFlagValue(args, "--restore-journal");
  result.dietJournalPath = getFlagValue(args, "--diet-journal");

  // Parse boolean flags (non-config)
  result.headless = args.includes("--headless");
  result.validate = args.includes("--validate") || args.includes("-v");
  result.cleanup = args.includes("--cleanup");
  result.skipConfirmation = args.includes("--yes") || args.includes("-y");
  result.startNew = args.includes("--start-new") || args.includes("--new") || args.includes("-n");
  result.force = args.includes("--force") || args.includes("-f");
  result.noWipe = args.includes("--no-wipe");
  result.init = args.includes("--init");
  result.help = args.includes("--help") || args.includes("-h");
  result.showVersion = args.includes("--version");
  result.copy = args.includes("--copy");
  result.attach = args.includes("--attach");
  result.ignoreDataMismatch = args.includes("--ignore-data-mismatch");
  result.overwriteOutput = args.includes("--overwrite-output");

  return result;
}
