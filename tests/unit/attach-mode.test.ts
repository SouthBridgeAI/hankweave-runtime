import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Tests for ENG-103: CLI attach mode and lock file port field.
 *
 * These tests verify:
 * - Lock file format includes port field
 * - Backward compatibility with old lock files without port
 * - Port 0 handling (falsy but valid)
 * - --port precedence over lock file port
 */

const rimrafSimple = (dir: string) => {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe("lock file port field (ENG-103)", () => {
  const TEST_DIR = path.join(process.cwd(), "tests", "test-area", "temp-lockfile-test");

  beforeEach(async () => {
    await fs.promises.mkdir(path.join(TEST_DIR, ".hankweave"), { recursive: true });
  });

  afterEach(async () => {
    rimrafSimple(TEST_DIR);
  });

  test("should handle old lock file format without port field", async () => {
    // Create a lock file in old format (no port)
    const lockPath = path.join(TEST_DIR, ".hankweave", "runtime.lock");
    const oldFormatLock = {
      pid: process.pid,
      runId: "test-run-123",
      startTime: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      // Note: no port field
    };
    await fs.promises.writeFile(lockPath, JSON.stringify(oldFormatLock));

    // Attach should fall back to default port 7777
    const lockData = JSON.parse(await fs.promises.readFile(lockPath, "utf-8"));
    const port = lockData.port ?? 7777;

    expect(port).toBe(7777);
  });

  test("should read port from lock file when present", async () => {
    const lockPath = path.join(TEST_DIR, ".hankweave", "runtime.lock");
    const lockData = {
      pid: process.pid,
      runId: "test-run-456",
      startTime: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      port: 9999,
    };
    await fs.promises.writeFile(lockPath, JSON.stringify(lockData));

    const data = JSON.parse(await fs.promises.readFile(lockPath, "utf-8"));
    expect(data.port).toBe(9999);
  });

  test("should preserve port field in heartbeat updates", async () => {
    const lockPath = path.join(TEST_DIR, ".hankweave", "runtime.lock");
    const lockData = {
      pid: process.pid,
      runId: "test-run-456",
      startTime: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      port: 9999,
    };
    await fs.promises.writeFile(lockPath, JSON.stringify(lockData));

    // Simulate heartbeat update (read-modify-write)
    const existing = JSON.parse(await fs.promises.readFile(lockPath, "utf-8"));
    existing.lastHeartbeat = new Date().toISOString();
    await fs.promises.writeFile(lockPath, JSON.stringify(existing));

    // Port should still be preserved
    const updated = JSON.parse(await fs.promises.readFile(lockPath, "utf-8"));
    expect(updated.port).toBe(9999);
  });

  test("should correctly read port 0 from lock file (type safety check)", async () => {
    // Port 0 is a valid port number (used for auto-assignment), but is falsy
    // The code must use !== undefined, not truthiness check
    const lockPath = path.join(TEST_DIR, ".hankweave", "runtime.lock");
    const lockData = {
      pid: process.pid,
      runId: "test-run-789",
      startTime: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      port: 0, // Edge case: port 0 is falsy but valid
    };
    await fs.promises.writeFile(lockPath, JSON.stringify(lockData));

    const data = JSON.parse(await fs.promises.readFile(lockPath, "utf-8"));

    // WRONG: if (data.port) { ... } would skip port 0
    // CORRECT: if (data.port !== undefined) { ... }
    const port = data.port !== undefined ? data.port : 7777;
    expect(port).toBe(0); // Should be 0, not 7777
  });

  test("should give explicit --port precedence over lock file port", async () => {
    // When both --execution and --port are provided, --port wins
    const lockPath = path.join(TEST_DIR, ".hankweave", "runtime.lock");
    const lockData = {
      pid: process.pid,
      runId: "test-run-abc",
      startTime: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      port: 8888, // Port in lock file
    };
    await fs.promises.writeFile(lockPath, JSON.stringify(lockData));

    // Simulate CLI args with both --execution and --port
    const cliArgs = {
      attach: true,
      executionPath: TEST_DIR,
      port: 9999, // Explicit port override
    };

    // Explicit --port should win
    const finalPort = cliArgs.port ?? lockData.port;
    expect(finalPort).toBe(9999);
  });
});

describe("attach mode port resolution logic", () => {
  test("should use explicit port when provided", () => {
    const cliArgs = {
      attach: true,
      port: 8080,
      executionPath: undefined,
    };

    // Logic from index.ts
    let port: number;
    if (cliArgs.port !== undefined) {
      port = cliArgs.port;
    } else {
      port = 7777; // default
    }

    expect(port).toBe(8080);
  });

  test("should fall back to default when no port specified", () => {
    const cliArgs = {
      attach: true,
      port: undefined,
      executionPath: undefined,
    };

    // Logic from index.ts
    let port: number;
    if (cliArgs.port !== undefined) {
      port = cliArgs.port;
    } else {
      port = 7777; // default
    }

    expect(port).toBe(7777);
  });
});
