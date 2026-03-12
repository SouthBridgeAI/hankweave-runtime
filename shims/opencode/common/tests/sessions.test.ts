import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionManager, type SessionData } from "../src/sessions.js";

describe("SessionManager", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    // Create a temporary directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-test-"));
    // Save original HOME
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    // Restore HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("constructor", () => {
    test("creates sessions directory in debugDir when provided", () => {
      const manager = new SessionManager({ debugDir: tempDir });
      const sessionsDir = path.join(tempDir, "sessions");
      expect(fs.existsSync(sessionsDir)).toBe(true);
      expect(manager.getSessionsDir()).toBe(sessionsDir);
    });

    test("creates sessions directory in home when debugDir not provided", () => {
      // Set temporary HOME
      process.env.HOME = tempDir;
      const manager = new SessionManager();
      const sessionsDir = path.join(tempDir, ".shim", "sessions");
      expect(fs.existsSync(sessionsDir)).toBe(true);
      expect(manager.getSessionsDir()).toBe(sessionsDir);
    });

    test("throws error when HOME not set and debugDir not provided", () => {
      delete process.env.HOME;
      delete process.env.USERPROFILE;
      expect(() => new SessionManager()).toThrow(
        "Cannot determine home directory for session storage"
      );
    });
  });

  describe("generateSessionId", () => {
    test("generates valid UUID v4", () => {
      const manager = new SessionManager({ debugDir: tempDir });
      const sessionId = manager.generateSessionId();

      // UUID v4 format: xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx
      const uuidV4Regex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(sessionId).toMatch(uuidV4Regex);
    });

    test("generates unique IDs", () => {
      const manager = new SessionManager({ debugDir: tempDir });
      const id1 = manager.generateSessionId();
      const id2 = manager.generateSessionId();
      expect(id1).not.toBe(id2);
    });
  });

  describe("saveSession and loadSession", () => {
    test("saves and loads session data", () => {
      const manager = new SessionManager({ debugDir: tempDir });
      const sessionData: SessionData = {
        sessionId: manager.generateSessionId(),
        agentSessionId: "agent-123",
        timestamp: new Date().toISOString(),
        metadata: { foo: "bar" },
      };

      manager.saveSession(sessionData);
      const loaded = manager.loadSession(sessionData.sessionId);

      expect(loaded).toEqual(sessionData);
    });

    test("throws error when loading non-existent session", () => {
      const manager = new SessionManager({ debugDir: tempDir });
      expect(() => manager.loadSession("non-existent-id")).toThrow(
        "Session not found: non-existent-id"
      );
    });

    test("creates JSON file with proper formatting", () => {
      const manager = new SessionManager({ debugDir: tempDir });
      const sessionData: SessionData = {
        sessionId: "test-session-id",
        agentSessionId: "agent-456",
        timestamp: "2024-01-01T00:00:00.000Z",
      };

      manager.saveSession(sessionData);

      const filePath = path.join(tempDir, "sessions", "test-session-id.json");
      const content = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(content);

      expect(parsed).toEqual(sessionData);
      // Check it's formatted (has newlines)
      expect(content).toContain("\n");
    });
  });

  describe("sessionExists", () => {
    test("returns true for existing session", () => {
      const manager = new SessionManager({ debugDir: tempDir });
      const sessionData: SessionData = {
        sessionId: "existing-session",
        agentSessionId: "agent-789",
        timestamp: new Date().toISOString(),
      };

      manager.saveSession(sessionData);
      expect(manager.sessionExists("existing-session")).toBe(true);
    });

    test("returns false for non-existent session", () => {
      const manager = new SessionManager({ debugDir: tempDir });
      expect(manager.sessionExists("non-existent")).toBe(false);
    });
  });

  describe("deleteSession", () => {
    test("deletes existing session", () => {
      const manager = new SessionManager({ debugDir: tempDir });
      const sessionData: SessionData = {
        sessionId: "delete-me",
        agentSessionId: "agent-999",
        timestamp: new Date().toISOString(),
      };

      manager.saveSession(sessionData);
      expect(manager.sessionExists("delete-me")).toBe(true);

      manager.deleteSession("delete-me");
      expect(manager.sessionExists("delete-me")).toBe(false);
    });

    test("does not throw when deleting non-existent session", () => {
      const manager = new SessionManager({ debugDir: tempDir });
      expect(() => manager.deleteSession("non-existent")).not.toThrow();
    });
  });

  describe("listSessions", () => {
    test("returns empty array when no sessions exist", () => {
      const manager = new SessionManager({ debugDir: tempDir });
      expect(manager.listSessions()).toEqual([]);
    });

    test("lists all session IDs", () => {
      const manager = new SessionManager({ debugDir: tempDir });

      const sessions = [
        { sessionId: "session-1", agentSessionId: "a1", timestamp: "2024-01-01T00:00:00.000Z" },
        { sessionId: "session-2", agentSessionId: "a2", timestamp: "2024-01-02T00:00:00.000Z" },
        { sessionId: "session-3", agentSessionId: "a3", timestamp: "2024-01-03T00:00:00.000Z" },
      ];

      sessions.forEach(s => manager.saveSession(s));

      const listed = manager.listSessions();
      expect(listed).toHaveLength(3);
      expect(listed).toContain("session-1");
      expect(listed).toContain("session-2");
      expect(listed).toContain("session-3");
    });

    test("ignores non-JSON files", () => {
      const manager = new SessionManager({ debugDir: tempDir });
      const sessionData: SessionData = {
        sessionId: "valid-session",
        agentSessionId: "agent-123",
        timestamp: new Date().toISOString(),
      };

      manager.saveSession(sessionData);

      // Create a non-JSON file
      fs.writeFileSync(path.join(tempDir, "sessions", "ignore-me.txt"), "not json");

      const listed = manager.listSessions();
      expect(listed).toEqual(["valid-session"]);
    });
  });

  describe("multiple managers with different configs", () => {
    test("managers with different debugDirs use separate storage", () => {
      const dir1 = path.join(tempDir, "dir1");
      const dir2 = path.join(tempDir, "dir2");
      fs.mkdirSync(dir1, { recursive: true });
      fs.mkdirSync(dir2, { recursive: true });

      const manager1 = new SessionManager({ debugDir: dir1 });
      const manager2 = new SessionManager({ debugDir: dir2 });

      const session1: SessionData = {
        sessionId: "session-1",
        agentSessionId: "agent-1",
        timestamp: new Date().toISOString(),
      };

      const session2: SessionData = {
        sessionId: "session-2",
        agentSessionId: "agent-2",
        timestamp: new Date().toISOString(),
      };

      manager1.saveSession(session1);
      manager2.saveSession(session2);

      expect(manager1.sessionExists("session-1")).toBe(true);
      expect(manager1.sessionExists("session-2")).toBe(false);
      expect(manager2.sessionExists("session-1")).toBe(false);
      expect(manager2.sessionExists("session-2")).toBe(true);

      // Clean up
      fs.rmSync(dir1, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    });

    test("manager without debugDir uses home directory", () => {
      process.env.HOME = tempDir;
      const manager = new SessionManager();

      const sessionData: SessionData = {
        sessionId: "home-session",
        agentSessionId: "agent-home",
        timestamp: new Date().toISOString(),
      };

      manager.saveSession(sessionData);

      const expectedPath = path.join(tempDir, ".shim", "sessions", "home-session.json");
      expect(fs.existsSync(expectedPath)).toBe(true);
    });
  });
});
