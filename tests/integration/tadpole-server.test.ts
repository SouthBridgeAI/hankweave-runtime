import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { TadpoleServer } from "../../server/tadpole-server.js";
import { generateTestTimestamp } from "../utils/test-helpers.js";

// Test configuration similar to e2e tests
const TEST_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../.."
);
const EXECUTION_DIR = path.join(
  TEST_ROOT,
  "tests/test-area/tadpole-server-integration"
);
const DATA_SOURCE_FILE = path.join(TEST_ROOT, "tests/config/poem_guides.txt");
const TEST_RESULTS_DIR = path.join(TEST_ROOT, "tests/test-results");
const PHASES_CONFIG = path.join(
  TEST_ROOT,
  "tests/config/test-phases.config.json"
);

// Create a minimal config
const serverPort = 8889;
const serverUrl = `ws://localhost:${serverPort}`;

// Generate timestamp for this test run
const TEST_TIMESTAMP = generateTestTimestamp();
const TEST_RUN_DIR = path.join(
  TEST_RESULTS_DIR,
  `server-integration-${TEST_TIMESTAMP}`
);

describe("TadpoleServer", () => {
  let server: TadpoleServer;

  beforeEach(async () => {
    // Clean up and create directories (similar to e2e test setup)
    if (fs.existsSync(EXECUTION_DIR)) {
      fs.rmSync(EXECUTION_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(EXECUTION_DIR, { recursive: true });

    // Create test results directory for this run
    fs.mkdirSync(TEST_RUN_DIR, { recursive: true });

    // Create necessary subdirectories
    const tadpoleDir = path.join(EXECUTION_DIR, ".tadpole");
    const logsDir = path.join(tadpoleDir, "logs");
    const checkpointsDir = path.join(tadpoleDir, "checkpoints");
    const dataDir = path.join(EXECUTION_DIR, "read_only_data_source");
    fs.mkdirSync(logsDir, { recursive: true });
    fs.mkdirSync(checkpointsDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });

    // Copy data source file if it exists
    if (fs.existsSync(DATA_SOURCE_FILE)) {
      fs.copyFileSync(DATA_SOURCE_FILE, path.join(dataDir, "poem_guides.txt"));
    }

    // Create state file with correct structure to avoid validation errors
    const stateFile = path.join(tadpoleDir, "state.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ runs: [], currentRunId: null })
    );

    // Load phase configs if they exist
    let phases = [];
    if (fs.existsSync(PHASES_CONFIG)) {
      try {
        phases = JSON.parse(fs.readFileSync(PHASES_CONFIG, "utf-8"));
      } catch (e) {
        console.warn("Could not load phase configs:", e);
      }
    }

    server = new TadpoleServer({
      autostart: false,
      port: serverPort,
      cwd: EXECUTION_DIR,
      executionPath: EXECUTION_DIR,
      dataPathInExecutionDir: dataDir,
      readOnlySourceDataPath: dataDir,
      dataHash: "test-hash-" + TEST_TIMESTAMP,
      isNewExecution: true,
      isResuming: false,
      linkType: "symlink",
      phases: phases,
      socketLogFile: path.join(logsDir, "socket.jsonl"),
      serverLogFile: path.join(logsDir, "server.log"),
    });
    await server.start();

    // Wait a bit for server to fully initialize
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  afterEach(async () => {
    if (server) {
      // Pass exitProcess: false to prevent the server from calling process.exit()
      // This allows the test runner to continue running subsequent tests
      await server.shutdown("test cleanup", false);
      // Wait a bit for server to fully shut down
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // Note: We keep the test results for debugging, but clean up execution directory
    // The test-area directory will be cleaned up on next run
  });

  it("runs on expected port", async () => {
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

  it("supports multiple connections", async () => {
    // Connect first client
    const client1 = new WebSocket(serverUrl);

    const client1Connected = await new Promise<boolean>((resolve) => {
      client1.onopen = () => resolve(true);
      client1.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 5000);
    });

    expect(client1Connected).toBe(true);
    expect(client1.readyState).toBe(WebSocket.OPEN);

    // Try to connect second client
    const client2 = new WebSocket(serverUrl);

    const client2Result = await new Promise<string>((resolve) => {
      client2.onopen = () => {
        // Give it a moment to see if it stays connected
        setTimeout(() => {
          if (client2.readyState === WebSocket.OPEN) {
            resolve("connected");
          } else {
            resolve("closed-after-open");
          }
        }, 100);
      };
      client2.onclose = () => resolve("rejected");
      client2.onerror = () => resolve("error");
      setTimeout(() => resolve("timeout"), 2000);
    });

    // Check if second client connects
    console.log("Client 2 result:", client2Result);
    console.log("Client 2 readyState:", client2.readyState);

    // Try to connect third client
    const client3 = new WebSocket(serverUrl);

    const client3Result = await new Promise<string>((resolve) => {
      client3.onopen = () => {
        // Give it a moment to see if it stays connected
        setTimeout(() => {
          if (client3.readyState === WebSocket.OPEN) {
            resolve("connected");
          } else {
            resolve("closed-after-open");
          }
        }, 100);
      };
      client3.onclose = () => resolve("rejected");
      client3.onerror = () => resolve("error");
      setTimeout(() => resolve("timeout"), 2000);
    });

    // Check results
    console.log("Client 3 result:", client3Result);
    console.log("Client 3 readyState:", client3.readyState);

    // Now we accept multiple connections, all should be open
    expect(client2Result).toBe("connected");
    expect(client3Result).toBe("connected");

    // All clients should stay connected
    expect(client1.readyState).toBe(WebSocket.OPEN);
    expect(client2.readyState).toBe(WebSocket.OPEN);
    expect(client3.readyState).toBe(WebSocket.OPEN);

    // Clean up
    client1.close();
    client2.close();
    client3.close();
  });

  it("supports handshake protocol with different modes", async () => {
    // Connect first client requesting read-write access
    const client1 = new WebSocket(serverUrl);
    await new Promise<void>((resolve) => {
      client1.onopen = () => resolve();
    });

    // Perform handshake for client 1 (read-write)
    const handshake1Promise = new Promise<any>((resolve) => {
      client1.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "handshake.response") {
          resolve(data);
        }
      };
    });

    client1.send(
      JSON.stringify({
        type: "handshake",
        data: { mode: "readandwrite" },
      })
    );

    const handshakeResponse1 = await handshake1Promise;
    expect(handshakeResponse1.data.mode).toBe("readandwrite");
    expect(handshakeResponse1.data.clientId).toBeDefined();

    // Connect second client requesting read-write access (should also get readandwrite)
    const client2 = new WebSocket(serverUrl);
    await new Promise<void>((resolve) => {
      client2.onopen = () => resolve();
    });

    // Perform handshake for client 2 (should also get write access)
    const handshake2Promise = new Promise<any>((resolve) => {
      client2.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "handshake.response") {
          resolve(data);
        }
      };
    });

    client2.send(
      JSON.stringify({
        type: "handshake",
        data: { mode: "readandwrite" },
      })
    );

    const handshakeResponse2 = await handshake2Promise;
    expect(handshakeResponse2.data.mode).toBe("readandwrite"); // Multiple clients can have write access
    expect(handshakeResponse2.data.clientId).toBeDefined();

    // Connect third client requesting readonly access
    const client3 = new WebSocket(serverUrl);
    await new Promise<void>((resolve) => {
      client3.onopen = () => resolve();
    });

    // Perform handshake for client 3 (readonly)
    const handshake3Promise = new Promise<any>((resolve) => {
      client3.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "handshake.response") {
          resolve(data);
        }
      };
    });

    client3.send(
      JSON.stringify({
        type: "handshake",
        data: { mode: "readonly" },
      })
    );

    const handshakeResponse3 = await handshake3Promise;
    expect(handshakeResponse3.data.mode).toBe("readonly");
    expect(handshakeResponse3.data.clientId).toBeDefined();

    // All clients should stay connected after handshake
    expect(client1.readyState).toBe(WebSocket.OPEN);
    expect(client2.readyState).toBe(WebSocket.OPEN);
    expect(client3.readyState).toBe(WebSocket.OPEN);

    // Clean up
    client1.close();
    client2.close();
    client3.close();
  });
});
