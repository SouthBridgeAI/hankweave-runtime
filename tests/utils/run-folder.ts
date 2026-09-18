import * as fs from "node:fs";
import * as path from "node:path";

/** Locate the first recorded run, preserving filesystem enumeration order. */
export function findFirstRunFolder(testDir: string): string {
  const runsDir = path.join(testDir, ".hankweave/runs");
  if (!fs.existsSync(runsDir)) return "";
  const folders = fs.readdirSync(runsDir);
  return folders.length > 0 ? path.join(runsDir, folders[0]) : "";
}
