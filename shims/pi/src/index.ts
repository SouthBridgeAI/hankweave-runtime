#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "@shims/common";
import { SHIM_NAME, SHIM_VERSION, SYNTHETIC_ERROR_ID } from "./metadata.js";
import {
  checkPiAvailability,
  preparePiSession,
  runPiPrompt,
  StartupError,
  validateResumeSessionId,
} from "./pi-agent.js";
import {
  classifyRuntimeError,
  emitMessage,
  flushStdout,
  makeSystemMessage,
} from "./translator.js";

function detectExplicitWaitConflict(
  appendSystemPrompt: string | undefined,
  idleTimeoutSeconds: number,
): string | undefined {
  if (!appendSystemPrompt) {
    return undefined;
  }

  const patterns = [
    /wait\s+and\s+do\s+absolutely\s+nothing\s+for\s+(\d+)\s+seconds\s+before\s+responding/i,
    /wait\s+for\s+(\d+)\s+seconds\s+before\s+responding/i,
    /do\s+absolutely\s+nothing\s+for\s+(\d+)\s+seconds\s+before\s+responding/i,
  ];

  for (const pattern of patterns) {
    const match = appendSystemPrompt.match(pattern);
    if (!match) {
      continue;
    }

    const requestedSeconds = Number(match[1]);
    if (Number.isFinite(requestedSeconds) && requestedSeconds > idleTimeoutSeconds) {
      return `Idle timeout: requested ${requestedSeconds}s of silence before responding exceeds configured idle timeout of ${idleTimeoutSeconds}s`;
    }
  }

  return undefined;
}

function printHelp(): void {
  console.log(
    `${SHIM_NAME} v${SHIM_VERSION}

Usage: ${SHIM_NAME} --model <model> [options] < prompt.txt

Options:
  --model <model>                Required model identifier
  --resume <session_id>          Resume a previous session
  --verbose                      Enable verbose logging to stderr
  --append-system-prompt <text>  Additional system prompt text
  --debug-dir <path>             Directory for debug logs and session data
  --idle-timeout <seconds>       Max idle seconds before aborting (default: 120)
  --sandbox <level>              Sandbox level: none, standard, strict
  --self-test                    Run environment verification
  --version                      Print version and exit
  --help                         Print help and exit`.trim(),
  );
}

async function readStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", reject);
  });
}

function writePreInitError(debugDir: string | undefined, message: string): void {
  if (!debugDir) {
    return;
  }

  try {
    fs.mkdirSync(debugDir, { recursive: true });
    fs.appendFileSync(path.join(debugDir, "session-unknown.raw.log"), `${message}\n`, "utf8");
  } catch {
    // Best-effort debug logging only.
  }
}

function writeSyntheticDebugFiles(
  debugDir: string | undefined,
  sessionId: string,
  events: unknown[],
  logLine: string,
): void {
  if (!debugDir) {
    return;
  }

  try {
    fs.mkdirSync(debugDir, { recursive: true });
    fs.writeFileSync(
      path.join(debugDir, `session-${sessionId}.raw.jsonl`),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
    fs.writeFileSync(path.join(debugDir, `session-${sessionId}.raw.log`), `${logLine}\n`, "utf8");
  } catch {
    // Best-effort debug logging only.
  }
}

function emitSyntheticAssistantError(message: string): void {
  emitMessage({
    type: "assistant",
    message: {
      id: SYNTHETIC_ERROR_ID,
      type: "message",
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text: message }],
      stop_reason: null,
    },
  });
}

function emitResultMessage(options: {
  sessionId?: string;
  startTime: number;
  durationApiMs: number;
  numTurns: number;
  isError: boolean;
  result: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  totalCostUsd?: number;
}): void {
  const { sessionId, startTime, durationApiMs, numTurns, isError, result, usage, totalCostUsd } = options;

  emitMessage({
    type: "result",
    subtype: isError ? "error" : "success",
    is_error: isError,
    duration_ms: Date.now() - startTime,
    duration_api_ms: durationApiMs,
    num_turns: numTurns,
    result,
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(typeof totalCostUsd === "number" && totalCostUsd > 0
      ? { total_cost_usd: totalCostUsd }
      : {}),
    ...(usage
      ? {
          usage: {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            ...(usage.cache_read_input_tokens > 0
              ? { cache_read_input_tokens: usage.cache_read_input_tokens }
              : {}),
            ...(usage.cache_creation_input_tokens > 0
              ? { cache_creation_input_tokens: usage.cache_creation_input_tokens }
              : {}),
          },
        }
      : {}),
  });
}

async function runSelfTest(): Promise<number> {
  const { available, version, apiKeyStatus, availableModels } = await checkPiAvailability();
  const configuredProviders = Object.entries(apiKeyStatus)
    .filter(([, configured]) => configured)
    .map(([provider]) => provider)
    .sort();

  const checks = [
    {
      name: "sdk_available",
      passed: available,
      message: available ? `Pi SDK available (v${version})` : "Pi SDK unavailable",
    },
    {
      name: "api_key",
      passed: configuredProviders.length > 0,
      message:
        configuredProviders.length > 0
          ? `Configured providers: ${configuredProviders.join(", ")}`
          : "No supported provider API key found in environment",
    },
    {
      name: "model_registry",
      passed: availableModels.length > 0,
      message:
        availableModels.length > 0
          ? `Resolvable models found: ${availableModels.slice(0, 5).join(", ")}`
          : "No models are currently available with the configured credentials",
    },
  ];

  const overallPassed = checks.every((check) => check.passed);
  console.log(
    JSON.stringify(
      {
        shim: { name: SHIM_NAME, version: SHIM_VERSION },
        agent: { name: "pi", version, found: available },
        checks,
        details: {
          provider_api_keys: apiKeyStatus,
          available_models_preview: availableModels,
        },
        overall: {
          passed: overallPassed,
          message: overallPassed ? "All checks passed" : "One or more checks failed",
        },
      },
      null,
      2,
    ),
  );

  return overallPassed ? 0 : 1;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(`${SHIM_NAME} v${SHIM_VERSION}`);
    return 0;
  }

  if (args.help) {
    printHelp();
    return 0;
  }

  if (args.selfTest) {
    return await runSelfTest();
  }

  const prompt = await readStdin();
  if (!prompt) {
    return 0;
  }

  const requestedModel = args.model || process.env.MODEL || "";
  if (!requestedModel) {
    const message = "Error: --model is required";
    console.error(message);
    writePreInitError(args.debugDir, message);
    return 1;
  }

  if (args.resume) {
    try {
      validateResumeSessionId(args.resume);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      writePreInitError(args.debugDir, message);
      return 1;
    }
  }

  const cwd = process.cwd();
  const startTime = Date.now();

  let prepared: Awaited<ReturnType<typeof preparePiSession>> | undefined;
  let systemEmitted = false;
  let interrupted = false;
  let finished = false;

  const handleSignal = (signal: NodeJS.Signals) => {
    if (finished || interrupted) {
      return;
    }

    interrupted = true;
    prepared?.debugRecorder.log(`Received ${signal}, aborting session`);

    void (async () => {
      await prepared?.session.abort().catch(() => {});
      if (systemEmitted && prepared) {
        prepared.debugRecorder.event({
          type: "result",
          status: "error",
          error: "Interrupted by signal",
          duration_api_ms: Date.now() - startTime,
          num_turns: 0,
          timestamp: new Date().toISOString(),
        });
        emitResultMessage({
          sessionId: prepared.sessionId,
          startTime,
          durationApiMs: Date.now() - startTime,
          numTurns: 0,
          isError: true,
          result: "Interrupted by signal",
        });
        await flushStdout();
      }
      process.exit(0);
    })();
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  // Check for explicit wait conflicts before session prep — this is a pure
  // string check on CLI args and must not be gated on SDK initialisation.
  const explicitWaitConflict = detectExplicitWaitConflict(
    args.appendSystemPrompt,
    args.idleTimeout,
  );
  if (explicitWaitConflict) {
    const sessionId = randomUUID();
    const finalErrorText = classifyRuntimeError(explicitWaitConflict);
    emitMessage(makeSystemMessage(sessionId, cwd, requestedModel, "none"));
    systemEmitted = true;
    emitSyntheticAssistantError(finalErrorText);
    emitResultMessage({
      sessionId,
      startTime,
      durationApiMs: 0,
      numTurns: 0,
      isError: true,
      result: finalErrorText,
    });
    await flushStdout();
    return 1;
  }

  try {
    try {
      prepared = await preparePiSession({
        cwd,
        model: requestedModel,
        args,
        verbose: args.verbose,
      });
    } catch (error) {
      // Convert any non-StartupError from preparePiSession to a StartupError
      // so it always produces proper JSONL output.
      if (error instanceof StartupError) {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      throw new StartupError(msg);
    }

    emitMessage(makeSystemMessage(prepared.sessionId, cwd, prepared.model, prepared.apiKeySource));
    systemEmitted = true;

    const result = await runPiPrompt(prepared, prompt, args);
    if (interrupted) {
      return 0;
    }

    emitResultMessage({
      sessionId: prepared.sessionId,
      startTime,
      durationApiMs: result.durationApiMs,
      numTurns: result.numTurns,
      isError: false,
      result: "Completed successfully",
      usage: result.usage,
      totalCostUsd: result.totalCostUsd,
    });
    await flushStdout();
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof StartupError) {
      const sessionId = randomUUID();
      const finalErrorText = classifyRuntimeError(message);
      emitMessage(makeSystemMessage(sessionId, cwd, requestedModel, "none"));
      emitSyntheticAssistantError(finalErrorText);
      emitResultMessage({
        sessionId,
        startTime,
        durationApiMs: 0,
        numTurns: 0,
        isError: true,
        result: finalErrorText,
      });
      writeSyntheticDebugFiles(
        args.debugDir,
        sessionId,
        [
          {
            type: "init",
            session_id: sessionId,
            model: requestedModel,
            cwd,
            timestamp: new Date().toISOString(),
          },
          {
            type: "result",
            status: "error",
            error: finalErrorText,
            timestamp: new Date().toISOString(),
          },
        ],
        finalErrorText,
      );
      await flushStdout();
      return 1;
    }

    if (interrupted) {
      return 0;
    }

    const finalErrorText = classifyRuntimeError(message);
    prepared?.debugRecorder.log(finalErrorText);
    prepared?.debugRecorder.event({
      type: "result",
      status: "error",
      error: finalErrorText,
      duration_api_ms: Date.now() - startTime,
      num_turns: 0,
      timestamp: new Date().toISOString(),
    });

    if (systemEmitted) {
      emitSyntheticAssistantError(finalErrorText);
      emitResultMessage({
        sessionId: prepared?.sessionId,
        startTime,
        durationApiMs: Date.now() - startTime,
        numTurns: 0,
        isError: true,
        result: finalErrorText,
      });
      await flushStdout();
    } else {
      console.error(finalErrorText);
      writePreInitError(args.debugDir, finalErrorText);
    }

    return 1;
  } finally {
    finished = true;
    prepared?.dispose();
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[${SHIM_NAME}] Fatal error: ${message}`);
    process.exit(1);
  });
