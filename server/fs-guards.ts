import fs from "node:fs";

/**
 * Filesystem guards shared by every code path that reads a user-authored
 * file path (hank.json, hankweave.json, prompt/schema/sentinel refs, …).
 *
 * Lives in its own module so config.ts, hank-refs.ts, execution setup, and
 * runtime loaders can all use the same check without import cycles.
 */

/** What checkRegularFile found wrong with a path. */
export interface RegularFileProblem {
  kind: "missing" | "irregular" | "unreadable";
  /** Message fragment phrased to follow the file name (`promptFile "x" does not exist`). */
  phrase: string;
}

/**
 * Guard for paths that must be readable regular files. Returns null when the
 * path is one, otherwise the problem kind plus a message fragment phrased to
 * follow the file name (`promptFile "x" does not exist`).
 *
 * The regular-file check must run before any read: readFileSync on a FIFO
 * blocks forever, and on a directory throws a confusing EISDIR. Pass
 * { read: false } when the caller does its own read right after (the trial
 * read here would just double it).
 */
export function checkRegularFile(
  filePath: string,
  options?: { read?: boolean },
): RegularFileProblem | null {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    return { kind: "missing", phrase: "does not exist" };
  }
  if (!stats.isFile()) {
    return { kind: "irregular", phrase: "is not a regular file" };
  }
  if (options?.read !== false) {
    try {
      fs.readFileSync(filePath, "utf-8");
    } catch (error) {
      return {
        kind: "unreadable",
        phrase: `is not readable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return null;
}
