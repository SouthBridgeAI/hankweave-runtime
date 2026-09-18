import fs from "node:fs";
import path from "node:path";
import glob from "fast-glob";
import { type Logger, resolveFileConflict } from "../utils.js";

/** Explicit output copies use their own glob policy, independent of gitignore. */
export class WorkspaceOutput {
  constructor(
    private readonly agentRoot: string,
    private readonly logger?: Logger,
  ) {}

  /**
   * Copy output files OUT of the workspace by glob patterns, preserving the
   * directory structure under `destinationDirectory`. Deliberately does NOT
   * respect .gitignore (unlike the visible surface): an output the hank
   * names is wanted whatever the workspace rules say. Existing destinations
   * are renamed apart (utils.ts :: resolveFileConflict) unless `overwrite`.
   */
  async copyOut(
    patterns: string[],
    destinationDirectory: string,
    options?: { overwrite?: boolean },
  ): Promise<{ conflicts: Array<{ original: string; resolved: string }> }> {
    const conflicts: Array<{ original: string; resolved: string }> = [];

    this.logger?.log(
      `Copying files from ${this.agentRoot} to ${destinationDirectory} using globs ${patterns.join(
        ", ",
      )}`,
      "debug",
    );

    await fs.promises.mkdir(destinationDirectory, { recursive: true });

    // fast-glob directly: no gitignore filtering, dotfiles included,
    // directories included so a directory pattern copies recursively.
    const files = await glob(patterns, { cwd: this.agentRoot, dot: true, onlyFiles: false });

    if (files.length === 0) {
      this.logger?.log("No files matched the copy globs.", "debug");
      return { conflicts };
    }

    this.logger?.log(`Resolved files: ${files.join(", ")}`, "debug");

    for (const file of files) {
      await this.copyFileOut(file, destinationDirectory, options, conflicts);
    }

    return { conflicts };
  }
  private async copyFileOut(
    file: string,
    destinationDirectory: string,
    options: { overwrite?: boolean } | undefined,
    conflicts: Array<{ original: string; resolved: string }>,
  ): Promise<void> {
    const sourcePath = path.join(this.agentRoot, file);
    let destPath = path.join(destinationDirectory, file);

    this.logger?.log(`Copying ${sourcePath} to ${destPath}`, "debug");

    if (!fs.existsSync(sourcePath)) {
      this.logger?.log(`Source file ${sourcePath} does not exist`, "info");
      return;
    }

    if (!options?.overwrite) {
      const { resolvedPath, hadConflict } = await resolveFileConflict(destPath);
      if (hadConflict) {
        this.logger?.log(
          `Output file conflict: '${path.basename(destPath)}' already exists, saving as '${path.basename(resolvedPath)}'`,
          "info",
        );
        conflicts.push({ original: destPath, resolved: resolvedPath });
        destPath = resolvedPath;
      }
    } else if (fs.existsSync(destPath)) {
      this.logger?.log(`Overwriting output file: '${path.basename(destPath)}'`, "info");
    }

    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

    // verbatimSymlinks: preserves symlinks as symlinks rather than
    // dereferencing them — prevents EINVAL when copying node_modules/.bin/
    // which contains symlinks pointing to parent directories.
    await fs.promises.cp(sourcePath, destPath, {
      recursive: true,
      verbatimSymlinks: true,
      force: options?.overwrite ?? false,
    });
  }
}
