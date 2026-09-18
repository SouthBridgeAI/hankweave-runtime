import fs from "node:fs";
import path from "node:path";
import { ExecutionLayout } from "../execution-layout.js";
import { containsGitComponent } from "../git-support.js";

/** Mutation paths are stricter than query paths: a root is never a target.
 * Ignore rules do not apply here; ignored rig files still need cleanup. */
export function workspaceMutationPath(root: string, candidate: string): string {
  const absolute = containedPath(root, candidate);
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  if (ExecutionLayout.isMandatoryExcluded(relative) || containsGitComponent(relative)) {
    throw new Error(`Protected workspace path: ${candidate}`);
  }
  return absolute;
}

/** Validate both lexical containment and existing ancestors. The final node
 * may be a symlink when removing/replacing that node; callers must lstat it
 * before reading or copying through it. Recheck after awaited preparation. */
export function containedPath(root: string, candidate: string): string {
  if (!candidate || path.isAbsolute(candidate) || path.win32.isAbsolute(candidate)) {
    throw new Error(`Expected a relative path inside ${root}: ${candidate}`);
  }
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes or replaces its root: ${candidate}`);
  }
  let current = path.resolve(root);
  for (const component of ["", ...relative.split(path.sep).slice(0, -1)]) {
    current = path.join(current, component);
    const stats = lstatIfPresent(current);
    if (!stats) break;
    if (!stats.isDirectory()) throw new Error(`Path ancestor is not a real directory: ${current}`);
  }
  return absolute;
}

export function lstatIfPresent(absolute: string): fs.Stats | null {
  try {
    return fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
