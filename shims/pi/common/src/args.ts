export type SandboxLevel = "none" | "standard" | "strict";

const VALID_SANDBOX_LEVELS: readonly string[] = ["none", "standard", "strict"];

export interface ShimArguments {
  model: string;
  resume?: string;
  verbose: boolean;
  appendSystemPrompt?: string;
  debugDir?: string;
  idleTimeout: number;
  sandbox: SandboxLevel;
  selfTest: boolean;
  version: boolean;
  help: boolean;
}

/**
 * Parse command-line arguments (pre-sliced, no node/script prefix).
 *
 * @param argv - Arguments after node and script name (e.g. process.argv.slice(2))
 * @param aliases - Optional map of short flags to long flags (e.g. { "-m": "--model" })
 */
export function parseArgs(argv: string[], aliases?: Record<string, string>): ShimArguments {
  const args: ShimArguments = {
    model: "",
    verbose: false,
    idleTimeout: 120,
    sandbox: "none",
    selfTest: false,
    version: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];

    // Handle --arg=value format
    if (arg.includes("=")) {
      const [key, value] = arg.split("=", 2);
      argv.splice(i, 1, key, value);
      arg = key;
    }

    // Resolve alias
    if (aliases && arg in aliases) {
      arg = aliases[arg];
    }

    switch (arg) {
      case "--model":
        args.model = argv[++i];
        break;
      case "--resume":
        args.resume = argv[++i];
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--append-system-prompt":
        args.appendSystemPrompt = argv[++i];
        break;
      case "--debug-dir":
        args.debugDir = argv[++i];
        break;
      case "--idle-timeout": {
        const val = Number(argv[++i]);
        if (!Number.isFinite(val) || val <= 0) {
          console.error("Invalid --idle-timeout value: must be a positive number");
          process.exit(1);
        }
        args.idleTimeout = val;
        break;
      }
      case "--sandbox": {
        const level = argv[++i];
        if (!VALID_SANDBOX_LEVELS.includes(level)) {
          console.error(
            `Invalid --sandbox value: must be one of ${VALID_SANDBOX_LEVELS.join(", ")}`,
          );
          process.exit(1);
        }
        args.sandbox = level as SandboxLevel;
        break;
      }
      case "--self-test":
        args.selfTest = true;
        break;
      case "--version":
        args.version = true;
        break;
      case "--help":
        args.help = true;
        break;
      // Ignore unknown arguments for forward compatibility
    }
  }

  return args;
}
