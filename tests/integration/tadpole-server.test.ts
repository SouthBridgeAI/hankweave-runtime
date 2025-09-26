import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TadpoleServer } from "../../server/tadpole-server.js";

// Create a minimal config
const serverPort = 8889;
const serverUrl = `ws://localhost:${serverPort}`;

describe("TadpoleServer - Single Client Behavior", () => {
  let server: TadpoleServer;
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for the test
    tempDir = path.join(os.tmpdir(), `tadpole-test-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Create necessary subdirectories
    const logsDir = path.join(tempDir, ".tadpole", "logs");
    const dataDir = path.join(tempDir, "data");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    server = new TadpoleServer({
      port: serverPort,
      cwd: tempDir,
      executionPath: tempDir,
      dataPathInExecutionDir: dataDir,
      readOnlySourceDataPath: dataDir,
      dataHash: "test-hash",
      isNewExecution: true,
      isResuming: false,
      linkType: "symlink",
      phases: [],
      socketLogFile: path.join(logsDir, "socket.jsonl"),
      serverLogFile: path.join(logsDir, "server.log"),
    });
    await server.start();
  });

  afterEach(async () => {
    if (server) {
      await server.shutdown("test cleanup");
    }
    // Clean up temp directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("server is running on expected port", async () => {
    // Try to connect to the server
    const client = new WebSocket(serverUrl);

    const connected = await new Promise<boolean>((resolve) => {
      client.onopen = () => resolve(true);
      client.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 5000);
    });

    expect(connected).toBe(true);
    expect(client.readyState).toBe(WebSocket.OPEN);

    // Clean up
    client.close();
  });
});
