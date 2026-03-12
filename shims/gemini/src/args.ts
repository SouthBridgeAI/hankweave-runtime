export interface ShimArgs {
  model: string;
  resume?: string;
  verbose: boolean;
  appendSystemPrompt?: string;
  debugDir?: string;
  idleTimeout: number;
  sandbox: "none" | "standard" | "strict";
  selfTest: boolean;
  version: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): ShimArgs {
  const args: ShimArgs = {
    model: process.env.MODEL || "gemini-2.5-flash",
    verbose: false,
    idleTimeout: 120,
    sandbox: "none",
    selfTest: false,
    version: false,
    help: false,
  };

  const takeValue = (index: number, current: string): [string | undefined, number] => {
    if (current.includes("=")) {
      const [, value] = current.split(/=(.*)/s, 2);
      return [value, index];
    }
    return [argv[index + 1], index + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] ?? "";
    const key = raw.includes("=") ? raw.split("=", 1)[0] : raw;

    switch (key) {
      case "-p":
        break;
      case "--model": {
        const [value, nextIndex] = takeValue(i, raw);
        if (value) {
          args.model = value;
          i = nextIndex;
        }
        break;
      }
      case "--resume": {
        const [value, nextIndex] = takeValue(i, raw);
        if (value) {
          args.resume = value;
          i = nextIndex;
        }
        break;
      }
      case "--verbose":
        args.verbose = true;
        break;
      case "--append-system-prompt": {
        const [value, nextIndex] = takeValue(i, raw);
        if (value !== undefined) {
          args.appendSystemPrompt = value;
          i = nextIndex;
        }
        break;
      }
      case "--debug-dir": {
        const [value, nextIndex] = takeValue(i, raw);
        if (value) {
          args.debugDir = value;
          i = nextIndex;
        }
        break;
      }
      case "--idle-timeout": {
        const [value, nextIndex] = takeValue(i, raw);
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error("Invalid --idle-timeout value: must be a positive number");
        }
        args.idleTimeout = parsed;
        i = nextIndex;
        break;
      }
      case "--sandbox": {
        const [value, nextIndex] = takeValue(i, raw);
        if (value === "none" || value === "standard" || value === "strict") {
          args.sandbox = value;
          i = nextIndex;
        } else {
          throw new Error("Invalid --sandbox value: must be one of none, standard, strict");
        }
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
      default:
        break;
    }
  }

  return args;
}

export function printHelp(): void {
  process.stdout.write(`Gemini CLI shim\n\nUsage:\n  gemini-cli-shim --model <model> [options]\n\nOptions:\n  -p                              Prompt via stdin (accepted, optional)\n  --model <model>                 Gemini model or alias (for example: gemini-2.5-flash, google/gemini-2.5-pro, flash, pro)\n  --resume <session_id>           Resume an existing Gemini session UUID\n  --verbose                       Verbose stderr logging\n  --append-system-prompt <text>   Extra system instructions appended to the internal shim prompt\n  --idle-timeout <seconds>        Baseline idle timeout before work starts (default: 120)\n  --debug-dir <path>              Write raw debug logs into this directory\n  --sandbox <level>               none | standard | strict\n  --self-test                     Verify environment and print JSON\n  --version                       Print version\n  --help                          Print help\n`);
}

export async function readStdinTrimmed(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}
