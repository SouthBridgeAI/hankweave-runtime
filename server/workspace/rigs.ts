import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { RigShellCommand, ShellCommand } from "../config.js";
import type { HankDir, IgnoredEntry } from "../hank-dir.js";
import { CommandError } from "../types/error-types.js";
import { type Logger, toError } from "../utils.js";
import { lstatIfPresent, workspaceMutationPath } from "./paths.js";

export type RigSetupFailureType = "command_failed" | "timeout" | "other";

export interface RigOperationFailure {
  error: Error;
  exitCode?: number;
  failureType: RigSetupFailureType;
}

/** Describe a rig failure without deciding whether execution should continue. */
export function normalizeRigOperationFailure(
  cause: unknown,
  operationType: "copy" | "command",
): RigOperationFailure {
  const error = toError(cause);
  const commandError = error instanceof CommandError ? error : undefined;
  const errorText = error.message.toLowerCase();
  const stderrText =
    typeof commandError?.stderr === "string" ? commandError.stderr.toLowerCase() : "";

  const isTimeout = [errorText, stderrText].some(
    (text) => text.includes("timed out") || text.includes("timeout") || text.includes("etimedout"),
  );
  const failureType: RigSetupFailureType = isTimeout
    ? "timeout"
    : commandError || operationType === "command"
      ? "command_failed"
      : "other";

  return { error, exitCode: commandError?.exitCode, failureType };
}

/** Rig mutations and command working-directory selection. */
export class WorkspaceRigs {
  constructor(
    private readonly agentRoot: string,
    private readonly logger?: Logger,
  ) {}

  /**
   * The directory a rig or output command runs in: the last rig copy's
   * target when the command asks for `lastCopied` and one exists, otherwise
   * the agent root.
   */
  workingDirFor(spec: "lastCopied" | "agentRoot" | undefined, lastCopiedPath?: string): string {
    if (spec === "lastCopied" && lastCopiedPath) return lastCopiedPath;
    return this.agentRoot;
  }

  /**
   * The copy half of plantCopy: `from` is the hank's resolved copy
   * source, `to` the absolute target inside the workspace. The target's
   * parent must exist and the target must not; the source must exist. With
   * a HankDir the copy
   * honors the hank's copy-tree ignore rules (directory sources only —
   * a file source is an explicit ref, copied verbatim); programmatic
   * runtimes without a hank directory get a plain recursive copy. Returns
   * the entries the rules excluded (none for a plain copy).
   */
  private async copyFromHank(
    hank: HankDir | null,
    from: string,
    to: string,
  ): Promise<IgnoredEntry[]> {
    const sourceStats = await fs.promises.stat(from).catch(() => null);
    if (!sourceStats) {
      throw new Error(`Source path does not exist: ${from}`);
    }
    const targetParent = path.dirname(to);
    const parentStats = await fs.promises.stat(targetParent).catch(() => null);
    if (!parentStats || !parentStats.isDirectory()) {
      throw new Error(`Target parent directory does not exist: ${targetParent}`);
    }
    const targetStats = await fs.promises.stat(to).catch(() => null);
    if (targetStats) {
      throw new Error(`Target path already exists: ${to}`);
    }
    // Source and parent checks await filesystem work; validate the target's
    // ancestry again before copying, including a newly planted final link.
    workspaceMutationPath(this.agentRoot, path.relative(this.agentRoot, to));
    if (lstatIfPresent(to)) throw new Error(`Target path already exists: ${to}`);
    if (hank === null) {
      await fs.promises.cp(from, to, { recursive: true });
      return [];
    }
    return await hank.copyTo(from, to);
  }

  /**
   * A rig `copy` step end to end: resolve the target under the agent root,
   * clear anything already there, then plant the copy. Removal and copy are
   * two operations, so the caller may abort between them (a shutdown
   * landing during the awaited removal must not be followed by a fresh copy
   * into what may now be a successor-owned workspace): `shouldAbort` is
   * consulted after the removal, and an abort returns `aborted: true` with
   * nothing copied. `ignored` lists what the hank's ignore rules dropped
   * from the copy, for the caller to report.
   */
  async plantCopy(
    hank: HankDir | null,
    from: string,
    toRel: string,
    options: { shouldAbort?: () => boolean } = {},
  ): Promise<{ target: string; aborted: boolean; ignored: IgnoredEntry[] }> {
    const target = workspaceMutationPath(this.agentRoot, toRel);
    this.logger?.log(`Copying ${from} to ${target}`);
    if (lstatIfPresent(target)) {
      this.logger?.log(
        `Warning: Target path already exists: ${target}. Removing it before copying.`,
      );
      await fs.promises.rm(target, { recursive: true });
      this.logger?.log(`Removed existing path: ${target}`);
    }
    if (options.shouldAbort?.()) {
      this.logger?.log(`Rig copy aborted between removal and copy for ${target}`);
      return { target, aborted: true, ignored: [] };
    }
    workspaceMutationPath(this.agentRoot, toRel);
    const ignored = await this.copyFromHank(hank, from, target);
    this.logger?.log(`Copied ${from} to ${target}`);
    return { target, aborted: false, ignored };
  }

  async runCommand(
    shellCommand: ShellCommand | RigShellCommand | string,
    lastCopiedPath?: string,
    env?: Record<string, string>,
    onOutput?: (stream: "stdout" | "stderr", line: string) => void,
  ): Promise<void> {
    const cmd: ShellCommand | RigShellCommand =
      typeof shellCommand === "string"
        ? {
            type: "command",
            command: {
              run: shellCommand,
            },
          }
        : shellCommand;
    // The last rig copy's target when asked for, else the agent root.
    const workingDir = this.workingDirFor(
      cmd.command.workingDirectory === "lastCopied" ? "lastCopied" : "agentRoot",
      lastCopiedPath,
    );

    // Diagnostic logging: log working directory and its contents
    this.logger?.log(`[DEBUG] Running command: ${cmd.command.run}`, "info");
    this.logger?.log(`[DEBUG] Working directory: ${workingDir}`, "info");
    try {
      const dirContents = await fs.promises.readdir(workingDir);
      this.logger?.log(`[DEBUG] Directory contents: ${dirContents.join(", ")}`, "info");
    } catch (e) {
      this.logger?.log(`[DEBUG] Could not read directory contents: ${toError(e).message}`, "error");
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(cmd.command.run, {
        shell: true,
        cwd: workingDir,
        env: env ? { ...process.env, ...env } : undefined,
      });

      // Capture stdout and stderr for diagnostic purposes
      let stdout = "";
      let stderr = "";

      // Throttle rig.output events: max 1 per second per stream
      let lastStdoutEmit = 0;
      let lastStderrEmit = 0;
      let pendingStdoutLine: string | null = null;
      let pendingStderrLine: string | null = null;

      const emitRigOutput = (stream: "stdout" | "stderr", line: string) => {
        if (!onOutput || !line.trim()) return;
        onOutput(stream, line.trim().slice(0, 500));
      };

      proc.stdout?.on("data", (data) => {
        const chunk = data.toString();
        stdout += chunk;
        this.logger?.log(`[DEBUG] Command stdout: ${chunk.trim()}`, "info");

        if (onOutput) {
          const lastLine = chunk.trim().split("\n").pop() ?? "";
          const now = Date.now();
          if (now - lastStdoutEmit >= 1000) {
            emitRigOutput("stdout", lastLine);
            lastStdoutEmit = now;
            pendingStdoutLine = null;
          } else {
            pendingStdoutLine = lastLine;
          }
        }
      });

      proc.stderr?.on("data", (data) => {
        const chunk = data.toString();
        stderr += chunk;
        this.logger?.log(`[DEBUG] Command stderr: ${chunk.trim()}`, "error");

        if (onOutput) {
          const lastLine = chunk.trim().split("\n").pop() ?? "";
          const now = Date.now();
          if (now - lastStderrEmit >= 1000) {
            emitRigOutput("stderr", lastLine);
            lastStderrEmit = now;
            pendingStderrLine = null;
          } else {
            pendingStderrLine = lastLine;
          }
        }
      });

      // Flush pending lines every second
      const flushInterval = onOutput
        ? setInterval(() => {
            if (pendingStdoutLine) {
              emitRigOutput("stdout", pendingStdoutLine);
              lastStdoutEmit = Date.now();
              pendingStdoutLine = null;
            }
            if (pendingStderrLine) {
              emitRigOutput("stderr", pendingStderrLine);
              lastStderrEmit = Date.now();
              pendingStderrLine = null;
            }
          }, 1000)
        : null;

      proc.on("exit", (code) => {
        if (flushInterval) clearInterval(flushInterval);
        if (code === 0) {
          this.logger?.log(`[DEBUG] Command completed successfully`, "info");
          resolve();
        } else {
          // Handle null exit code (killed by signal)
          const exitCode = code ?? -1;
          this.logger?.log(`[DEBUG] Command failed with exit code ${exitCode}`, "error");
          this.logger?.log(`[DEBUG] Full stdout: ${stdout}`, "info");
          this.logger?.log(`[DEBUG] Full stderr: ${stderr}`, "error");

          // Create CommandError with exit code and output
          const error = new CommandError(
            `Command failed with exit code ${exitCode}`,
            exitCode,
            stdout,
            stderr,
          );
          reject(error);
        }
      });

      proc.on("error", (err) => {
        if (flushInterval) clearInterval(flushInterval);
        this.logger?.log(`[DEBUG] Command error: ${err.message}`, "error");
        reject(err);
      });
    });
  }

  /** Remove a rig-created path from the workspace. True when it existed. */
  async removePath(rel: string): Promise<boolean> {
    const full = workspaceMutationPath(this.agentRoot, rel);
    if (!lstatIfPresent(full)) return false;
    await fs.promises.rm(full, { recursive: true, force: true });
    return true;
  }
}
