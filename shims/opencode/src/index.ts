#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "@shims/common";
import pkg from "../package.json" with { type: "json" };
import { runSelfTest } from "./selftest.js";
import { runShim } from "./shim.js";
import { errorMessage } from "./utils/output.js";

function printHelp(): void {
  process.stdout.write(`opencode-shim\n\nUsage:\n  echo \"prompt\" | opencode-shim --model google/gemini-2.5-flash\n\nOptions:\n  --model <model>                Model name (required in normal mode)\n  --resume <session_id>          Resume a prior shim session\n  --verbose                      Verbose logs to stderr\n  --append-system-prompt <text>  Extra instruction to inject via OpenCode instructions\n  --idle-timeout <seconds>       Baseline idle timeout (default: 120)\n  --debug-dir <path>             Debug/session directory\n  --sandbox <level>              none | standard | strict\n  --self-test                    Run environment checks\n  --version                      Print version\n  --help                         Show help\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function appendUnknownDebugLog(debugDir: string | undefined, message: string): void {
  if (!debugDir) return;
  fs.mkdirSync(debugDir, { recursive: true });
  fs.appendFileSync(path.join(debugDir, "session-unknown.raw.log"), `${message}\n`, "utf8");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), {
    "-m": "--model",
    "-h": "--help",
    "-v": "--version",
  });

  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  if (args.selfTest) {
    return await runSelfTest(pkg.version);
  }

  const prompt = (await readStdin()).trim();
  if (!prompt) {
    return 0;
  }

  if (!args.model && !process.env.MODEL) {
    const message = "Missing required --model";
    appendUnknownDebugLog(args.debugDir, message);
    process.stderr.write(`${message}\n`);
    return 1;
  }

  try {
    return await runShim({ prompt, args });
  } catch (error) {
    const message = errorMessage(error);
    appendUnknownDebugLog(args.debugDir, message);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

const exitCode = await main();
process.exitCode = exitCode;
