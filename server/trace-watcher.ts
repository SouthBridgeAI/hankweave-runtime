import { exec } from "node:child_process";
import { constants, rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionLayout } from "./execution-layout.js";
import type { HankweaveState } from "./types/state-types.js";

import { detectRuntime, escapeShellArg, type Logger } from "./utils.js";

export function isTraceEnabled(): boolean {
  return !!(process.env.HANKWEAVE_TRACE_BRAINTRUST || process.env.HANKWEAVE_TRACE_LANGFUSE);
}

export interface PreparedTraceUpload {
  upload(): Promise<void>;
  dispose(): Promise<void>;
}

export type PrepareTraceUpload = () => Promise<PreparedTraceUpload>;

/** Async subprocesses keep lease renewal and the shutdown watchdog responsive. */
function run(command: string, timeout: number, cwd?: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    exec(
      command,
      { timeout, maxBuffer: 10 * 1024 * 1024, env: process.env, cwd },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stdout}\n${stderr}`));
        else resolve({ stdout, stderr });
      },
    );
  });
}

/** Check configuration at startup; prepare under ownership, then upload after release. */
export async function registerTraceUpload(
  executionPath: string,
  logger?: Logger,
): Promise<PrepareTraceUpload> {
  const binary =
    process.env.HANKWEAVE_TRACE_BINARY ||
    (detectRuntime() === "bun" ? "bunx hankweave-trace" : "npx hankweave-trace");
  const log = (message: string, level: "info" | "error" = "info") => {
    if (level === "error") console.error(message);
    else console.log(message);
    logger?.log(message, level);
  };
  log("--- hankweave-trace config ---");
  try {
    const { stdout, stderr } = await run(`${binary} config`, 30_000);
    for (const line of stdout.trim().split("\n").filter(Boolean)) log(line);
    if (stderr.trim()) log(`[hankweave-trace config stderr] ${stderr.trim()}`, "error");
    if (stdout.includes("\n  - ")) {
      log(
        "[hankweave-trace] WARNING: tracing is misconfigured — upload on exit will likely fail.",
        "error",
      );
    }
  } catch (error) {
    log(`Trace configuration check failed: ${error}`, "error");
  }

  const flags = ["--force"];
  if (process.env.HANKWEAVE_TRACE_BRAINTRUST) flags.push("--braintrust");
  if (process.env.HANKWEAVE_TRACE_LANGFUSE) flags.push("--langfuse");

  return async () => {
    const snapshot = await createTraceSnapshot(executionPath);
    const quotedPath =
      process.platform === "win32"
        ? `"${snapshot.executionPath}"`
        : escapeShellArg(snapshot.executionPath);
    const command = `${binary} upload ${quotedPath} ${flags.join(" ")}`;
    let upload: Promise<void> | undefined;
    return {
      dispose: snapshot.dispose,
      upload() {
        if (upload) return upload;
        upload = (async () => {
          // Ownership has ended: output goes only to the console, never back into
          // the execution directory (which may already belong to a successor).
          console.log(`> Uploading trace: ${command}`);
          try {
            const { stdout, stderr } = await run(command, 60_000, snapshot.executionPath);
            if (stdout.trim()) console.log(stdout.trim());
            if (stderr.trim()) console.error(stderr.trim());
          } catch (error) {
            console.error(`Trace upload failed: ${error}`);
          } finally {
            await snapshot.dispose();
          }
        })();
        return upload;
      },
    };
  };
}

/** Capture only trace inputs, before journal compression and ownership release. */
export async function createTraceSnapshot(executionPath: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hankweave-trace-"));
  const snapshotPath = path.join(root, path.basename(executionPath));
  const source = new ExecutionLayout(executionPath);
  const target = new ExecutionLayout(snapshotPath);
  const cleanupOnExit = () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Best effort on force exit. */
    }
  };
  process.once("exit", cleanupOnExit);
  const dispose = async () => {
    await fs.rm(root, { recursive: true, force: true });
    process.removeListener("exit", cleanupOnExit);
  };
  try {
    await fs.mkdir(target.stateDir, { recursive: true });
    // No hardlinks or surviving symlinks: a successor must not change these bytes.
    for (const [from, to] of [
      [source.statePath, target.statePath],
      [source.metaPath, target.metaPath],
      [path.join(source.eventsDir, "events.jsonl"), path.join(target.eventsDir, "events.jsonl")],
      [source.runsDir, target.runsDir],
      // Preserve local uploader configuration when running from the snapshot.
      [
        path.join(executionPath, ".hankweave-trace.json"),
        path.join(snapshotPath, ".hankweave-trace.json"),
      ],
    ]) {
      try {
        await fs.stat(from);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || from === source.statePath) {
          throw error;
        }
        continue;
      }
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.cp(from, to, {
        recursive: true,
        dereference: true,
        mode: constants.COPYFILE_FICLONE,
      });
    }
    const state = JSON.parse(await fs.readFile(target.statePath, "utf8")) as HankweaveState;
    for (const run of state.runs) {
      // The runtime persists absolute run directories; relocate the reader's fallback.
      run.runFolder = path.join(target.runsDir, run.runId);
    }
    await fs.writeFile(target.statePath, JSON.stringify(state));

    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(await fs.readFile(target.metaPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const hank = await readSnapshotHankConfig(executionPath, meta.hankPath);
    meta.hankPath = path.join(snapshotPath, "hank.json");
    meta.executionPath ??= executionPath; // Preserve trace identity, not the temporary path.
    await fs.writeFile(meta.hankPath as string, hank);
    await fs.writeFile(target.metaPath, JSON.stringify(meta));
    return { executionPath: snapshotPath, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Match hankweave-trace's config lookup, including its empty-config fallback. */
async function readSnapshotHankConfig(executionPath: string, hankPath: unknown): Promise<string> {
  for (const candidate of [
    ...(typeof hankPath === "string" ? [hankPath] : []),
    path.join(executionPath, "hank.json"),
    path.join(executionPath, "..", "hank.json"),
    path.join(executionPath, "..", "hank", "hank.json"),
  ]) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      JSON.parse(raw);
      return raw;
    } catch {
      // The trace reader also skips missing or invalid config candidates.
    }
  }
  return "{}";
}
