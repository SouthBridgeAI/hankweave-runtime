import { spawnSync } from "node:child_process";
import type { Logger } from "./utils.js";
import { detectRuntime } from "./utils.js";

export function isTraceEnabled(): boolean {
  return !!(process.env.HANKWEAVE_TRACE_BRAINTRUST || process.env.HANKWEAVE_TRACE_LANGFUSE);
}

function defaultTraceBinary(): string {
  return detectRuntime() === "bun" ? "bunx hankweave-trace" : "npx hankweave-trace";
}

/**
 * Registers a post-run trace upload.
 * Runs a config check immediately so any misconfiguration is surfaced at startup.
 * Returns an `uploadTrace` function that the caller should invoke on shutdown so
 * that the upload runs before process.exit() rather than in an exit handler.
 *
 */
export function registerTraceUpload(executionPath: string, logger?: Logger): () => void {
  const binary = process.env.HANKWEAVE_TRACE_BINARY || defaultTraceBinary();

  // Run config check at startup so the user sees provider status immediately
  const configResult = spawnSync(`${binary} config`, [], {
    shell: true,
    encoding: "utf-8",
    env: process.env,
    timeout: 30_000,
  });

  const configOut = (configResult.stdout ?? "").trim();
  const configErr = (configResult.stderr ?? "").trim();

  const header = "--- hankweave-trace config ---";
  console.log(header);
  logger?.log(header);

  for (const line of configOut.split("\n")) {
    console.log(line);
    logger?.log(line);
  }

  if (configErr) {
    const msg = `[hankweave-trace config stderr] ${configErr}`;
    console.error(msg);
    logger?.log(msg, "error");
  }

  // Detect misconfiguration: issues section contains at least one "  - " item
  const hasIssues = configOut.includes("\n  - ");
  if (hasIssues) {
    const warn =
      "[hankweave-trace] WARNING: tracing is misconfigured — upload on exit will likely fail.";
    console.error(warn);
    logger?.log(warn, "error");
  }

  const flags: string[] = ["--force"];
  if (process.env.HANKWEAVE_TRACE_BRAINTRUST) flags.push("--braintrust");
  if (process.env.HANKWEAVE_TRACE_LANGFUSE) flags.push("--langfuse");

  // Shell-quote the execution path to handle spaces
  const quotedPath = `"${executionPath.replace(/"/g, '\\"')}"`;
  const cmd = `${binary} upload ${quotedPath} ${flags.join(" ")}`.trim();

  let uploadDone = false;
  return () => {
    if (uploadDone) return;
    uploadDone = true;

    const uploadHeader = `> Uploading trace: ${cmd}`;
    console.log(uploadHeader);
    logger?.log(uploadHeader);

    const result = spawnSync(cmd, [], {
      shell: true,
      encoding: "utf-8",
      env: process.env,
      timeout: 60_000,
    });

    const out = (result.stdout ?? "").trim();
    const err = (result.stderr ?? "").trim();

    for (const line of out.split("\n").filter(Boolean)) {
      console.log(line);
      logger?.log(line);
    }
    if (err) {
      console.error(err);
      logger?.log(err, "error");
    }
  };
}
