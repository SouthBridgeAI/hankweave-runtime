import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Session data stored for resumption
 */
export interface SessionData {
  /** Shim session ID (UUID v4) */
  sessionId: string;
  /** Underlying agent's native session/thread ID */
  agentSessionId: string;
  /** Timestamp of session creation */
  timestamp: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for session management
 */
export interface SessionManagerOptions {
  /**
   * Debug directory for session storage.
   * If provided, sessions are stored in <debugDir>/sessions/
   * If not provided, sessions are stored in ~/.shim/sessions/
   */
  debugDir?: string;
}

/**
 * Manages session persistence and lookup for shims.
 *
 * Behavior:
 * - If debugDir is provided: store in <debugDir>/sessions/
 * - If debugDir is NOT provided: store in ~/.shim/sessions/ (home directory)
 *
 * This ensures:
 * 1. Session resumption works without requiring --debug-dir
 * 2. No files pollute the working directory
 * 3. Session storage is in a standard, predictable location
 */
export class SessionManager {
  private sessionsDir: string;

  constructor(options: SessionManagerOptions = {}) {
    if (options.debugDir) {
      // Store in debug directory if provided
      this.sessionsDir = path.join(options.debugDir, "sessions");
    } else {
      // Store in home directory by default
      const home = process.env.HOME || process.env.USERPROFILE || "";
      if (!home) {
        throw new Error("Cannot determine home directory for session storage");
      }
      this.sessionsDir = path.join(home, ".shim", "sessions");
    }

    // Ensure sessions directory exists
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  /**
   * Generate a new UUID v4 session ID
   */
  generateSessionId(): string {
    return randomUUID();
  }

  /**
   * Save session data
   */
  saveSession(data: SessionData): void {
    const sessionPath = path.join(this.sessionsDir, `${data.sessionId}.json`);
    fs.writeFileSync(sessionPath, JSON.stringify(data, null, 2), "utf8");
  }

  /**
   * Load session data by session ID
   * @throws Error if session not found
   */
  loadSession(sessionId: string): SessionData {
    const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);

    try {
      const content = fs.readFileSync(sessionPath, "utf8");
      return JSON.parse(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Session not found: ${sessionId}`);
      }
      throw error;
    }
  }

  /**
   * Check if session exists
   */
  sessionExists(sessionId: string): boolean {
    const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);
    return fs.existsSync(sessionPath);
  }

  /**
   * Delete session data
   */
  deleteSession(sessionId: string): void {
    const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);
    try {
      fs.unlinkSync(sessionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      // Ignore if file doesn't exist
    }
  }

  /**
   * List all session IDs
   */
  listSessions(): string[] {
    try {
      const files = fs.readdirSync(this.sessionsDir);
      return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  /**
   * Get the sessions directory path
   */
  getSessionsDir(): string {
    return this.sessionsDir;
  }
}
