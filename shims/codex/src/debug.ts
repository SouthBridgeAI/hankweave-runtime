import fs from "node:fs";
import path from "node:path";

export interface DebugInitPayload {
  sessionId: string;
  cwd: string;
  model: string;
}

export class DebugRecorder {
  private readonly debugDir?: string;
  private rawJsonlPath?: string;
  private rawLogPath?: string;

  constructor(debugDir?: string) {
    this.debugDir = debugDir;
  }

  setSession(sessionId: string, init: Omit<DebugInitPayload, "sessionId">): void {
    if (!this.debugDir) {
      return;
    }

    fs.mkdirSync(this.debugDir, { recursive: true });
    this.rawJsonlPath = path.join(this.debugDir, `session-${sessionId}.raw.jsonl`);
    this.rawLogPath = path.join(this.debugDir, `session-${sessionId}.raw.log`);

    this.touch(this.rawJsonlPath);
    this.touch(this.rawLogPath);
    this.logJson({
      type: "init",
      session_id: sessionId,
      cwd: init.cwd,
      model: init.model,
      timestamp: new Date().toISOString(),
    });
  }

  logSdkEvent(event: unknown): void {
    this.logJson(event);
  }

  logResult(status: "success" | "error", extra: Record<string, unknown> = {}): void {
    this.logJson({
      type: "result",
      status,
      timestamp: new Date().toISOString(),
      ...extra,
    });
  }

  logLine(line: string): void {
    if (!this.rawLogPath) {
      return;
    }

    fs.appendFileSync(this.rawLogPath, line.endsWith("\n") ? line : `${line}\n`, "utf8");
  }

  static logStartupError(debugDir: string | undefined, line: string): void {
    if (!debugDir) {
      return;
    }

    fs.mkdirSync(debugDir, { recursive: true });
    const rawLogPath = path.join(debugDir, "session-unknown.raw.log");
    fs.appendFileSync(rawLogPath, line.endsWith("\n") ? line : `${line}\n`, "utf8");
  }

  private logJson(value: unknown): void {
    if (!this.rawJsonlPath) {
      return;
    }

    fs.appendFileSync(this.rawJsonlPath, `${JSON.stringify(value)}\n`, "utf8");
  }

  private touch(filePath: string): void {
    fs.closeSync(fs.openSync(filePath, "a"));
  }
}
