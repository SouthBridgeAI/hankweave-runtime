import process from "node:process";
import { parseArgs, printHelp, readStdinTrimmed } from "./args.js";
import { SHIM_VERSION } from "./constants.js";
import { runSelfTest, runShim } from "./shim.js";

async function main(): Promise<number> {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
      printHelp();
      return 0;
    }

    if (args.version) {
      process.stdout.write(`${SHIM_VERSION}\n`);
      return 0;
    }

    if (args.selfTest) {
      return await runSelfTest();
    }

    const prompt = await readStdinTrimmed();
    if (!prompt) {
      return 0;
    }

    return await runShim(args, prompt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
