import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import type { SandboxLevel } from "@shims/common/args";

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";
export const SESSION_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ResolvedModel {
  requestedModel: string;
  publicModel: string;
  sdkModel: string;
  reasoningEffort: ModelReasoningEffort;
}

export function generateSessionId(): string {
  return randomUUID();
}

export function generateMessageId(): string {
  return `msg_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

export function generateToolUseId(): string {
  return `toolu_${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
}

export function isValidSessionId(value: string | undefined): value is string {
  return typeof value === "string" && SESSION_ID_REGEX.test(value);
}

export function resolveModel(modelFromArgs: string): ResolvedModel {
  const requestedModel =
    modelFromArgs?.trim() || process.env.MODEL?.trim() || "gpt-5.1-codex-max";

  let sdkModel = requestedModel;

  // Strip provider prefix for SDK (it only wants the model name)
  if (sdkModel.includes("/")) {
    const [provider, model] = sdkModel.split("/", 2);
    if (provider.toLowerCase() === "openai" && model) {
      sdkModel = model;
    }
  }

  // Strip reasoning effort suffix from SDK model
  let reasoningEffort: ModelReasoningEffort = "high";
  const effortMatch = sdkModel.match(/^(.*)-(minimal|low|medium|high|xhigh)$/);
  if (effortMatch) {
    sdkModel = effortMatch[1];
    reasoningEffort = effortMatch[2] as ModelReasoningEffort;
  }

  // publicModel is the canonical provider-prefixed, effort-stripped model name
  // Per shim spec §3.8: non-Anthropic models use "provider/model" format
  const publicModel = `openai/${sdkModel}`;

  return {
    requestedModel,
    publicModel,
    sdkModel,
    reasoningEffort,
  };
}

export function mapSandbox(level: SandboxLevel): "danger-full-access" | "workspace-write" | "read-only" {
  switch (level) {
    case "strict":
      return "read-only";
    case "standard":
      return "workspace-write";
    case "none":
    default:
      return "danger-full-access";
  }
}

export function getCodexPathOverride(): string | undefined {
  const value = process.env.CODEX_PATH_OVERRIDE?.trim();
  return value ? value : undefined;
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function camelToSnakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function topLevelCamelToSnake(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[camelToSnakeKey(key)] = entry;
  }
  return result;
}

export async function flushStdout(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error | null) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    if (process.stdout.write("")) {
      done();
      return;
    }

    process.stdout.once("drain", () => done());
    process.stdout.once("error", (error) => done(error));
  });
}

export function makeAbsoluteCwd(cwd: string): string {
  return path.resolve(cwd);
}

export function toRelativePath(filePath: string, cwd: string): string {
  const absoluteCwd = path.resolve(cwd);
  const absolutePath = path.resolve(filePath);
  const relative = path.relative(absoluteCwd, absolutePath);
  return relative && !relative.startsWith("..") ? relative : absolutePath;
}
