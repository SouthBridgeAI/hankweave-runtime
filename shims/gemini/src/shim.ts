import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import {
  BusyStepTimeoutError,
  IdleTimeoutError,
  withAdaptiveTimeout,
} from "@shims/common/timeout";
import type { ShimArgs } from "./args.js";
import {
  KNOWN_TOOLS,
  MAX_INVALID_JSON_REPAIRS,
  MAX_SILENT_SUCCESS_RETRIES,
  SHIM_NAME,
  SHIM_VERSION,
} from "./constants.js";
import {
  bindDebugSession,
  captureStderr,
  type DebugCapture,
  writeUnknownLog,
} from "./debug.js";
import { ensureDir, findInvalidJsonFiles, sleep, writeJsonDebugLine } from "./filesystem.js";
import { generateMessageId, generateToolUseId, validateResumeSessionId } from "./ids.js";
import { formatGeminiOutputModel, getApiKeySource, normalizeModelForGeminiCli } from "./models.js";
import {
  countNumberedSteps,
  emit,
  flushStdout,
  shouldRetrySilentSuccessTurn,
  summarizeText,
  syntheticErrorMessage,
} from "./output.js";
import { loadGeminiSettingsAuthType, trackChildExit, which } from "./process-utils.js";
import {
  buildGeminiPrompt,
  buildInvalidJsonRepairPrompt,
  buildRemainingStepsPrompt,
  buildSilentTurnRecoveryPrompt,
} from "./prompts.js";
import type {
  AssistantMessage,
  RawGeminiEvent,
  ResultMessage,
  SystemMessage,
  UserMessage,
} from "./protocol.js";
import {
  aggregateInvocationUsage,
  extractMeaningfulToolContent,
  findGeminiSessionFile,
  readSessionFile,
  type SessionFileData,
  waitForToolRecord,
} from "./session-files.js";
import { extractToolFilePath, normalizeToolInput, normalizeToolName } from "./tools.js";

export async function runShim(args: ShimArgs, prompt: string): Promise<number> {
  const invocationStart = new Date().toISOString();
  const startTime = Date.now();
  const { outputModel, geminiModel } = normalizeModelForGeminiCli(args.model);
  const cwd = process.cwd();
  const debug: DebugCapture = {
    debugDir: args.debugDir,
    bufferedEvents: [],
    bufferedStderr: [],
  };

  if (debug.debugDir) {
    await ensureDir(debug.debugDir);
  }

  if (args.resume) {
    try {
      validateResumeSessionId(args.resume);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeUnknownLog(debug, `${message}\n`);
      throw error;
    }
  }

  const geminiPath = await which("gemini");
  if (!geminiPath) {
    process.stderr.write("Gemini CLI not found in PATH.\n");
    await writeUnknownLog(debug, "Gemini CLI not found in PATH.\n");
    return 1;
  }

  let interrupted = false;
  let activeChild: ChildProcessWithoutNullStreams | undefined;
  let systemEmitted = false;
  let resultEmitted = false;
  let sessionId = args.resume;
  let actualModel = outputModel;
  let durationApiMs = 0;
  let usage: ResultMessage["usage"] | undefined;
  let modelUsage: ResultMessage["model_usage"] | undefined;
  let finalIsError = false;
  let numTurns = 0;
  let remainingSilentSuccessRetries = MAX_SILENT_SUCCESS_RETRIES;
  let remainingInvalidJsonRepairs = MAX_INVALID_JSON_REPAIRS;
  let completionCheckIssued = false;
  let totalToolUseCount = 0;
  let resumeSessionId = args.resume;
  let attemptPrompt = buildGeminiPrompt(prompt, args.appendSystemPrompt);
  const toolIdMap = new Map<string, string>();
  const emittedToolUses = new Set<string>();
  const emittedToolResults = new Set<string>();
  const pendingToolResults = new Map<string, Extract<RawGeminiEvent, { type: "tool_result" }>>();
  const assistantTextChunks: string[] = [];
  let pendingAssistantText = "";
  let currentAssistantStreamHasDelta = false;
  let lastSyntheticError: string | undefined;
  const candidateJsonFiles = new Set<string>();
  const numberedStepCount = countNumberedSteps(prompt);

  const flushAssistantText = () => {
    if (!pendingAssistantText) return;
    assistantTextChunks.push(pendingAssistantText);
    const message: AssistantMessage = {
      type: "assistant",
      message: {
        id: generateMessageId(),
        type: "message",
        role: "assistant",
        model: actualModel,
        content: [{ type: "text", text: pendingAssistantText }],
        stop_reason: null,
      },
    };
    emit(message);
    pendingAssistantText = "";
    currentAssistantStreamHasDelta = false;
  };

  const emitFinalResult = async (isError: boolean, resultText: string): Promise<number> => {
    const result: ResultMessage = {
      type: "result",
      subtype: isError ? "error" : "success",
      is_error: isError,
      duration_ms: Date.now() - startTime,
      duration_api_ms: durationApiMs,
      num_turns: Math.max(1, numTurns),
      result: resultText,
      session_id: sessionId,
      usage,
      ...(modelUsage ? { model_usage: modelUsage } : {}),
    };
    emit(result);
    resultEmitted = true;
    finalIsError = isError;
    await flushStdout();
    return isError ? 1 : 0;
  };

  const maybeRepairInvalidJsonFiles = async (): Promise<"continue" | number | undefined> => {
    const invalidJsonFiles = await findInvalidJsonFiles(candidateJsonFiles);
    if (invalidJsonFiles.length === 0) {
      return undefined;
    }

    const invalidFileDescriptions = invalidJsonFiles.map(({ filePath, error }) => {
      const relativePath = path.relative(cwd, filePath) || filePath;
      return `${relativePath} (${error})`;
    });
    const errorText = `Gemini left invalid JSON files: ${invalidFileDescriptions.join("; ")}`;

    if (remainingInvalidJsonRepairs > 0 && sessionId) {
      remainingInvalidJsonRepairs -= 1;
      resumeSessionId = sessionId;
      attemptPrompt = buildInvalidJsonRepairPrompt(invalidFileDescriptions);
      if (args.verbose) {
        process.stderr.write(
          `[shim] Gemini left invalid JSON files for session ${sessionId}; requesting repair: ${invalidFileDescriptions.join(", ")}\n`,
        );
      }
      return "continue";
    }

    emit(syntheticErrorMessage("Agent Error", errorText));
    return await emitFinalResult(true, errorText);
  };

  const signalHandler = async () => {
    if (interrupted) return;
    interrupted = true;
    activeChild?.kill("SIGTERM");
    flushAssistantText();
    if (systemEmitted && !resultEmitted) {
      await emitFinalResult(false, summarizeText(assistantTextChunks.join("")));
    }
    process.exit(0);
  };

  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);

  try {
    while (true) {
      numTurns += 1;
      lastSyntheticError = undefined;
      let syntheticErrorEmitted = false;

      const child = spawnGemini({
        args,
        cwd,
        geminiModel,
        geminiPath,
        resumeSessionId,
      });
      activeChild = child;
      const childExitPromise = trackChildExit(child);
      child.stdin.write(attemptPrompt);
      child.stdin.end();

      child.stderr.on("data", async (chunk) => {
        const text = String(chunk);
        if (args.verbose) {
          process.stderr.write(`[gemini-stderr] ${text}`);
        }
        await captureStderr(debug, text);
      });

      const eventIterator = readGeminiEvents(child, debug, args.verbose);
      let attemptSawAssistantText = false;
      let attemptSawToolUse = false;
      let attemptSawToolResult = false;
      let retryDueToSilentSuccess = false;
      let continueWithFollowUpPrompt = false;

      const emitToolResultFromEvent = async (
        event: Extract<RawGeminiEvent, { type: "tool_result" }>,
      ): Promise<void> => {
        if (emittedToolResults.has(event.tool_id)) {
          return;
        }
        const publicToolId = toolIdMap.get(event.tool_id);
        if (!publicToolId) {
          pendingToolResults.set(event.tool_id, event);
          return;
        }

        const sessionData = sessionId ? await waitForToolRecord(sessionId, event.tool_id) : undefined;
        const contentText = sessionId
          ? extractMeaningfulToolContent(sessionData, event.tool_id, event.output)
          : event.output;

        const userMessage: UserMessage = {
          type: "user",
          message: {
            role: "user",
            content: [
              event.status === "error"
                ? {
                    type: "tool_result",
                    tool_use_id: publicToolId,
                    content: {
                      is_error: true,
                      error: event.error?.message || contentText || "Tool execution failed",
                    },
                  }
                : {
                    type: "tool_result",
                    tool_use_id: publicToolId,
                    content: contentText || `Tool completed: ${event.tool_id}`,
                  },
            ],
          },
        };
        emit(userMessage);
        emittedToolResults.add(event.tool_id);
      };

      try {
        attemptLoop: for await (const event of withAdaptiveTimeout(eventIterator, {
          idleTimeoutMs: args.idleTimeout * 1000,
          busyTimeoutMs: Math.max(args.idleTimeout * 1000, 300_000),
          onEvent(event, controller) {
            if (
              event.type === "tool_use" ||
              (event.type === "message" && event.role === "assistant" && event.content.length > 0)
            ) {
              controller.markBusy();
            }
            if (event.type === "result") {
              controller.markIdle();
            }
          },
        })) {
          switch (event.type) {
            case "init": {
              sessionId = event.session_id;
              actualModel = formatGeminiOutputModel(event.model || geminiModel || outputModel);
              await bindDebugSession(debug, sessionId);
              if (!systemEmitted) {
                const system: SystemMessage = {
                  type: "system",
                  subtype: "init",
                  cwd,
                  session_id: sessionId,
                  tools: KNOWN_TOOLS,
                  model: actualModel,
                  permissionMode: "bypassPermissions",
                  apiKeySource: getApiKeySource(),
                  mcp_servers: [],
                };
                emit(system);
                systemEmitted = true;
              }
              break;
            }
            case "message": {
              if (event.role !== "assistant") {
                break;
              }
              if (!event.content) {
                break;
              }
              if (event.delta) {
                currentAssistantStreamHasDelta = true;
                pendingAssistantText += event.content;
                if (event.content.trim().length > 0) {
                  attemptSawAssistantText = true;
                }
                break;
              }
              if (currentAssistantStreamHasDelta) {
                break;
              }
              pendingAssistantText += event.content;
              if (event.content.trim().length > 0) {
                attemptSawAssistantText = true;
              }
              break;
            }
            case "tool_use": {
              attemptSawToolUse = true;
              if (emittedToolUses.has(event.tool_id)) {
                break;
              }
              totalToolUseCount += 1;
              flushAssistantText();

              const publicToolId = toolIdMap.get(event.tool_id) ?? generateToolUseId();
              toolIdMap.set(event.tool_id, publicToolId);
              emittedToolUses.add(event.tool_id);

              const normalizedName = normalizeToolName(event.tool_name);
              const normalizedInput = normalizeToolInput(normalizedName, event.parameters);
              const candidateFilePath = extractToolFilePath(normalizedInput);
              if (
                candidateFilePath &&
                (normalizedName === "Write" || normalizedName === "Edit") &&
                candidateFilePath.toLowerCase().endsWith(".json")
              ) {
                candidateJsonFiles.add(path.resolve(cwd, candidateFilePath));
              }

              const toolUse: AssistantMessage = {
                type: "assistant",
                message: {
                  id: generateMessageId(),
                  type: "message",
                  role: "assistant",
                  model: actualModel,
                  content: [
                    {
                      type: "tool_use",
                      id: publicToolId,
                      name: normalizedName,
                      input: normalizedInput,
                    },
                  ],
                  stop_reason: "tool_use",
                },
              };
              emit(toolUse);

              const pendingResult = pendingToolResults.get(event.tool_id);
              if (pendingResult) {
                pendingToolResults.delete(event.tool_id);
                await emitToolResultFromEvent(pendingResult);
              }
              break;
            }
            case "tool_result": {
              attemptSawToolResult = true;
              flushAssistantText();
              await emitToolResultFromEvent(event);
              break;
            }
            case "error": {
              flushAssistantText();
              if (event.severity === "error") {
                lastSyntheticError = event.message;
                finalIsError = true;
                if (!syntheticErrorEmitted) {
                  emit(syntheticErrorMessage("Agent Error", event.message));
                  syntheticErrorEmitted = true;
                }
              }
              break;
            }
            case "result": {
              flushAssistantText();
              durationApiMs = Number(event.stats?.duration_ms ?? Date.now() - startTime);
              usage = {
                input_tokens: event.stats?.input_tokens,
                output_tokens: event.stats?.output_tokens,
                cache_read_input_tokens: event.stats?.cached,
              };
              const sessionData = sessionId ? await waitForSessionFile(sessionId) : undefined;
              modelUsage = aggregateInvocationUsage(sessionData, invocationStart);
              const isError = event.status === "error" || Boolean(lastSyntheticError) || Boolean(event.error?.message);

              if (isError && !syntheticErrorEmitted) {
                emit(
                  syntheticErrorMessage(
                    "Agent Error",
                    event.error?.message || lastSyntheticError || "Gemini CLI reported an error",
                  ),
                );
                syntheticErrorEmitted = true;
              }

              const silentSuccess = shouldRetrySilentSuccessTurn({
                isError,
                sawAssistantText: attemptSawAssistantText,
                sawToolUse: attemptSawToolUse,
                sawToolResult: attemptSawToolResult,
              });

              if (silentSuccess) {
                if (remainingSilentSuccessRetries > 0 && sessionId) {
                  remainingSilentSuccessRetries -= 1;
                  retryDueToSilentSuccess = true;
                  continueWithFollowUpPrompt = true;
                  resumeSessionId = sessionId;
                  attemptPrompt = buildSilentTurnRecoveryPrompt();
                  if (args.verbose) {
                    process.stderr.write(
                      `[shim] Gemini returned a silent success turn for session ${sessionId}; retrying with continuation prompt.\n`,
                    );
                  }
                  break attemptLoop;
                }

                const message = "Gemini completed with no assistant text or tool activity.";
                emit(syntheticErrorMessage("Agent Error", message));
                const emittedCode = await emitFinalResult(true, message);
                await childExitPromise;
                activeChild = undefined;
                return emittedCode;
              }

              const needsCompletionCheck =
                !isError &&
                !completionCheckIssued &&
                sessionId &&
                numberedStepCount >= 2 &&
                totalToolUseCount > 0 &&
                totalToolUseCount < numberedStepCount;

              if (needsCompletionCheck) {
                completionCheckIssued = true;
                continueWithFollowUpPrompt = true;
                resumeSessionId = sessionId;
                attemptPrompt = buildRemainingStepsPrompt();
                if (args.verbose) {
                  process.stderr.write(
                    `[shim] Gemini may have stopped before finishing a numbered task list for session ${sessionId}; requesting completion check.\n`,
                  );
                }
                break attemptLoop;
              }

              if (!isError) {
                const jsonRepairOutcome = await maybeRepairInvalidJsonFiles();
                if (jsonRepairOutcome === "continue") {
                  continueWithFollowUpPrompt = true;
                  break attemptLoop;
                }
                if (typeof jsonRepairOutcome === "number") {
                  await childExitPromise;
                  activeChild = undefined;
                  return jsonRepairOutcome;
                }
              }

              const resultText = isError
                ? event.error?.message || lastSyntheticError || "Gemini CLI reported an error"
                : summarizeText(assistantTextChunks.join(""));
              const emittedCode = await emitFinalResult(isError, resultText);
              await childExitPromise;
              activeChild = undefined;
              return emittedCode;
            }
          }
        }

        flushAssistantText();
        const exitCode = await childExitPromise;
        activeChild = undefined;

        if (retryDueToSilentSuccess || continueWithFollowUpPrompt) {
          continue;
        }

        if (!resultEmitted && systemEmitted) {
          const sessionData = sessionId ? await waitForSessionFile(sessionId) : undefined;
          modelUsage = aggregateInvocationUsage(sessionData, invocationStart);
          const success = exitCode === 0 && !lastSyntheticError;
          const silentSuccess = shouldRetrySilentSuccessTurn({
            isError: !success,
            sawAssistantText: attemptSawAssistantText,
            sawToolUse: attemptSawToolUse,
            sawToolResult: attemptSawToolResult,
          });

          if (silentSuccess) {
            if (remainingSilentSuccessRetries > 0 && sessionId) {
              remainingSilentSuccessRetries -= 1;
              resumeSessionId = sessionId;
              attemptPrompt = buildSilentTurnRecoveryPrompt();
              if (args.verbose) {
                process.stderr.write(
                  `[shim] Gemini exited after a silent success turn for session ${sessionId}; retrying with continuation prompt.\n`,
                );
              }
              continue;
            }
            const message = "Gemini completed with no assistant text or tool activity.";
            emit(syntheticErrorMessage("Agent Error", message));
            return await emitFinalResult(true, message);
          }

          const needsCompletionCheck =
            success &&
            !completionCheckIssued &&
            sessionId &&
            numberedStepCount >= 2 &&
            totalToolUseCount > 0 &&
            totalToolUseCount < numberedStepCount;

          if (needsCompletionCheck) {
            completionCheckIssued = true;
            resumeSessionId = sessionId;
            attemptPrompt = buildRemainingStepsPrompt();
            if (args.verbose) {
              process.stderr.write(
                `[shim] Gemini may have exited before finishing a numbered task list for session ${sessionId}; requesting completion check.\n`,
              );
            }
            continue;
          }

          if (success) {
            const jsonRepairOutcome = await maybeRepairInvalidJsonFiles();
            if (jsonRepairOutcome === "continue") {
              continue;
            }
            if (typeof jsonRepairOutcome === "number") {
              return jsonRepairOutcome;
            }
          } else if (!syntheticErrorEmitted) {
            emit(syntheticErrorMessage("Agent Error", lastSyntheticError || `Gemini CLI exited with code ${exitCode}`));
            syntheticErrorEmitted = true;
          }

          const resultText = success
            ? summarizeText(assistantTextChunks.join(""))
            : lastSyntheticError || `Gemini CLI exited with code ${exitCode}`;
          return await emitFinalResult(!success, resultText);
        }

        await flushStdout();
        return finalIsError ? 1 : exitCode === 0 ? 0 : 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const _isTimeout = error instanceof IdleTimeoutError || error instanceof BusyStepTimeoutError;
        if (args.verbose) {
          process.stderr.write(`[shim] ${message}\n`);
        }
        if (debug.debugDir && !sessionId) {
          await writeUnknownLog(debug, `${message}\n`);
        }

        activeChild?.kill("SIGKILL");
        activeChild = undefined;
        flushAssistantText();
        if (systemEmitted) {
          emit(syntheticErrorMessage("Agent Error", message));
          return await emitFinalResult(true, message);
        }

        process.stderr.write(`${message}\n`);
        await flushStdout();
        return 1;
      }
    }
  } finally {
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
  }
}

function spawnGemini({
  args,
  cwd,
  geminiModel,
  geminiPath,
  resumeSessionId,
}: {
  args: ShimArgs;
  cwd: string;
  geminiModel: string;
  geminiPath: string;
  resumeSessionId?: string;
}): ChildProcessWithoutNullStreams {
  const isWindows = process.platform === "win32";
  const geminiArgs = ["--model", geminiModel, "--output-format", "stream-json", "--approval-mode", "yolo"];

  if (resumeSessionId) {
    geminiArgs.push("--resume", resumeSessionId);
  }
  if (args.sandbox === "standard" || args.sandbox === "strict") {
    geminiArgs.push("--sandbox");
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: "0",
    GEMINI_SANDBOX: args.sandbox === "none" ? "false" : process.env.GEMINI_SANDBOX || "true",
    BASH_ENV: "",
  };

  if (args.sandbox === "strict" && process.platform === "darwin") {
    env.SEATBELT_PROFILE = "restrictive-open";
  }

  return spawn(geminiPath, geminiArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
    shell: isWindows,
  }) as unknown as ChildProcessWithoutNullStreams;
}

async function* readGeminiEvents(
  child: ChildProcessWithoutNullStreams,
  debug: DebugCapture,
  verbose: boolean,
): AsyncGenerator<RawGeminiEvent> {
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;

    let parsed: RawGeminiEvent;
    try {
      parsed = JSON.parse(line) as RawGeminiEvent;
    } catch {
      if (verbose) {
        process.stderr.write(`[shim] Skipping non-JSON Gemini stdout line: ${line}\n`);
      }
      continue;
    }

    if (debug.sessionId && debug.jsonlPath) {
      await writeJsonDebugLine(debug.jsonlPath, parsed);
    } else {
      debug.bufferedEvents.push(parsed);
    }

    yield parsed;
  }
}

async function waitForSessionFile(sessionId: string): Promise<SessionFileData | undefined> {
  const started = Date.now();
  while (Date.now() - started <= 2000) {
    const filePath = await findGeminiSessionFile(sessionId);
    if (filePath) {
      return await readSessionFile(sessionId);
    }
    await sleep(100);
  }
  return await readSessionFile(sessionId);
}

export async function runSelfTest(): Promise<number> {
  const geminiPath = await which("gemini");
  const authType = await loadGeminiSettingsAuthType();
  const checks = [
    {
      name: "agent_found",
      passed: Boolean(geminiPath),
      message: geminiPath ? `Found Gemini CLI at ${geminiPath}` : "Gemini CLI not found in PATH",
    },
    {
      name: "auth_configured",
      passed: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || authType),
      message:
        process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || authType
          ? `Authentication appears configured (${authType || "environment"})`
          : "No Gemini auth configuration detected",
    },
  ];
  const overallPassed = checks.every((check) => check.passed);
  const payload = {
    shim: { name: SHIM_NAME, version: SHIM_VERSION },
    agent: { name: "gemini", version: await detectGeminiVersion(), found: Boolean(geminiPath) },
    checks,
    overall: {
      passed: overallPassed,
      message: overallPassed ? "All checks passed" : "One or more checks failed",
    },
  };
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  return overallPassed ? 0 : 1;
}

async function detectGeminiVersion(): Promise<string> {
  const geminiPath = await which("gemini");
  if (!geminiPath) return "unknown";
  return await new Promise<string>((resolve) => {
    const isWindows = process.platform === "win32";
    const child = spawn(geminiPath, ["--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: isWindows,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("close", () => resolve(output.trim() || "unknown"));
    child.on("error", () => resolve("unknown"));
  });
}
