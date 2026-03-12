import fs from "node:fs";
import path from "node:path";

export class DebugRecorder {
  private readonly rawJsonlPath?: string;
  private readonly rawLogPath?: string;
  private readonly verbose: boolean;

  constructor(options: {
    debugDir?: string;
    sessionId?: string;
    verbose: boolean;
  }) {
    this.verbose = options.verbose;
    if (!options.debugDir || !options.sessionId) {
      return;
    }

    fs.mkdirSync(options.debugDir, { recursive: true });
    this.rawJsonlPath = path.join(options.debugDir, `session-${options.sessionId}.raw.jsonl`);
    this.rawLogPath = path.join(options.debugDir, `session-${options.sessionId}.raw.log`);
    fs.writeFileSync(this.rawJsonlPath, "", "utf8");
    fs.writeFileSync(this.rawLogPath, "", "utf8");
  }

  event(event: unknown): void {
    if (!this.rawJsonlPath) {
      return;
    }

    try {
      fs.appendFileSync(this.rawJsonlPath, `${JSON.stringify(event)}\n`, "utf8");
    } catch {
      // Best-effort debug logging only.
    }
  }

  log(...parts: unknown[]): void {
    const line = parts.map((part) => formatForLog(part)).join(" ");
    if (this.verbose) {
      console.error(`[pi-shim] ${line}`);
    }

    if (!this.rawLogPath) {
      return;
    }

    try {
      fs.appendFileSync(this.rawLogPath, `[pi-shim] ${line}\n`, "utf8");
    } catch {
      // Best-effort debug logging only.
    }
  }
}

function formatForLog(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
