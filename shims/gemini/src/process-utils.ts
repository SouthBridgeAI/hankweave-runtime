import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function trackChildExit(child: ChildProcessWithoutNullStreams): Promise<number> {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }

  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null) => {
      cleanup();
      resolve(code ?? child.exitCode ?? 1);
    };
    const cleanup = () => {
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    };

    child.once("error", onError);
    child.once("close", onClose);
  });
}

export async function which(command: string): Promise<string | null> {
  const isWindows = process.platform === "win32";
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve) => {
    const proc = spawn(isWindows ? "where" : "which", [command], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: isWindows,
    });
    let output = "";
    proc.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null);
      } else {
        resolve(null);
      }
    });
  });
}

export async function loadGeminiSettingsAuthType(): Promise<string | null> {
  try {
    const settingsPath = path.join(os.homedir(), ".gemini", "settings.json");
    const content = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, any>;
    return content?.security?.auth?.selectedType ?? null;
  } catch {
    return null;
  }
}
