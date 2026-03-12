import { appendFile, access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import type { RawGeminiEvent } from "./protocol.js";

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeJsonDebugLine(filePath: string, event: RawGeminiEvent): Promise<void> {
  await appendFile(filePath, JSON.stringify(event) + "\n", "utf8");
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function findInvalidJsonFiles(
  filePaths: Iterable<string>,
): Promise<Array<{ filePath: string; error: string }>> {
  const invalid: Array<{ filePath: string; error: string }> = [];

  for (const filePath of filePaths) {
    if (!filePath.toLowerCase().endsWith(".json")) {
      continue;
    }

    try {
      const content = await readFile(filePath, "utf8");
      JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      invalid.push({ filePath, error: message });
    }
  }

  return invalid;
}
