export interface ShimArgs {
  model: string;
  resume?: string;
  verbose: boolean;
  appendSystemPrompt?: string;
  debugDir?: string;
  idleTimeout: number;
  selfTest: boolean;
  version: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): ShimArgs {
  const args: ShimArgs = {
    model: process.env.MODEL || "composer-2.5-fast",
    verbose: false,
    idleTimeout: 120,
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
        const [, nextIndex] = takeValue(i, raw);
        i = nextIndex;
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
  process.stdout.write(`Cursor Agent shim

Usage:
  cursor-agent-shim --model <model> [options]

Options:
  -p                              Prompt via stdin (accepted, optional)
  --model <model>                 Cursor model id (passed through)
  --resume <session_id>           Resume a Cursor chat UUID
  --verbose                       Verbose stderr logging
  --append-system-prompt <text>   Prefixed onto the stdin prompt
  --idle-timeout <seconds>        Kill the agent after this much silence (default: 120)
  --debug-dir <path>              Write raw stream logs and session records
  --sandbox <level>               Accepted and ignored; the agent is spawned with --sandbox disabled
  --self-test                     Verify the agent binary and print JSON
  --version                       Print version
  --help                          Print help
`);
}

export async function readStdinTrimmed(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}
