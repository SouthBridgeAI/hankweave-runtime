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

// Helper types and interfaces
interface ClientSetupResult {
  client: WebSocket;
  clientId: string;
}

type ClientMode = "readonly" | "readandwrite";

// Helper function to create and setup a client
async function setupClient(
  serverUrl: string,
  options: {
    performHandshake?: boolean;
    mode?: ClientMode;
    timeout?: number;
  } = {}
): Promise<ClientSetupResult> {
  const { performHandshake = true, mode = "readandwrite", timeout = 5000 } = options;

  // Connect client
  const client = new WebSocket(serverUrl);

  const connected = await new Promise<boolean>((resolve) => {
    client.onopen = () => resolve(true);
    client.onerror = () => resolve(false);
    setTimeout(() => resolve(false), timeout);
  });

  if (!connected) {
    throw new Error("Failed to connect client to server");
  }

  if (!performHandshake) {
    return { client, clientId: "unknown" };
  }

  // Perform handshake
  const handshakePromise = new Promise<any>((resolve, reject) => {
    client.onmessage = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.type === "handshake.response") {
        resolve(data);
      }
    };
    client.onerror = () => reject(new Error("WebSocket error during handshake"));
    setTimeout(() => reject(new Error("Handshake timeout")), timeout);
  });

  client.send(
    JSON.stringify({
      type: "handshake",
      data: { mode },
    })
  );

  const handshakeResponse = await handshakePromise;

  if (!handshakeResponse.data.clientId) {
    throw new Error("Handshake response missing clientId");
  }

  return {
    client,
    clientId: handshakeResponse.data.clientId,
  };
}

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
    // Try to connect to the server without handshake
    const { client } = await setupClient(serverUrl, { performHandshake: false });

    expect(client.readyState).toBe(WebSocket.OPEN);

    // Clean up
    client.close();
  });

  it("supports multiple connections", async () => {
    // Connect multiple clients without handshake
    const { client: client1 } = await setupClient(serverUrl, { performHandshake: false });
    const { client: client2 } = await setupClient(serverUrl, { performHandshake: false });
    const { client: client3 } = await setupClient(serverUrl, { performHandshake: false });

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
    // Connect clients with different modes
    const { client: client1, clientId: clientId1 } = await setupClient(serverUrl, { mode: "readandwrite" });
    const { client: client2, clientId: clientId2 } = await setupClient(serverUrl, { mode: "readandwrite" });
    const { client: client3, clientId: clientId3 } = await setupClient(serverUrl, { mode: "readonly" });

    // Verify client IDs are defined
    expect(clientId1).toBeDefined();
    expect(clientId2).toBeDefined();
    expect(clientId3).toBeDefined();

    // All clients should stay connected after handshake
    expect(client1.readyState).toBe(WebSocket.OPEN);
    expect(client2.readyState).toBe(WebSocket.OPEN);
    expect(client3.readyState).toBe(WebSocket.OPEN);

    // Clean up
    client1.close();
    client2.close();
    client3.close();
  });

  it("responds to ping command from single client", async () => {
    // Connect and handshake client
    const { client } = await setupClient(serverUrl, { mode: "readandwrite" });

    // Set up pong response listener
    const pongPromise = new Promise<any>((resolve) => {
      client.onmessage = (event: MessageEvent) => {
        const data = JSON.parse(event.data);
        if (data.type === "pong") {
          resolve(data);
        }
      };
    });

    // Send ping command
    client.send(
      JSON.stringify({
        id: "test-ping-1",
        type: "ping",
      })
    );

    // Wait for pong response
    const pongResponse = await pongPromise;
    expect(pongResponse.type).toBe("pong");
    expect(pongResponse.data.message).toBe("pong");
    expect(pongResponse.data.timestamp).toBeDefined();
    expect(pongResponse.data.clientId).toBeUndefined(); // Regular ping doesn't include clientId

    // Clean up
    client.close();
  });

  it("responds to ping.broadcast command to all clients", async () => {
    // Connect and handshake clients
    const { client: client1, clientId: client1Id } = await setupClient(serverUrl, { mode: "readandwrite" });
    const { client: client2 } = await setupClient(serverUrl, { mode: "readonly" });

    // Set up pong response listeners
    const pongPromises = [
      new Promise<any>((resolve) => {
        client1.onmessage = (event: MessageEvent) => {
          const data = JSON.parse(event.data);
          if (data.type === "pong") {
            resolve({ client: "client1", data });
          }
        };
      }),
      new Promise<any>((resolve) => {
        client2.onmessage = (event: MessageEvent) => {
          const data = JSON.parse(event.data);
          if (data.type === "pong") {
            resolve({ client: "client2", data });
          }
        };
      }),
    ];

    // Send ping.broadcast command from client1
    client1.send(
      JSON.stringify({
        id: "test-ping-broadcast-1",
        type: "ping.broadcast",
      })
    );

    // Wait for both pong responses
    const pongResponses = await Promise.all(pongPromises);

    // Both clients should receive pong responses
    expect(pongResponses).toHaveLength(2);

    for (const response of pongResponses) {
      expect(response.data.type).toBe("pong");
      expect(response.data.data.message).toBe("pong");
      expect(response.data.data.timestamp).toBeDefined();
      expect(response.data.data.clientId).toBe(client1Id); // Should include sender's client ID
    }

    // Clean up
    client1.close();
    client2.close();
  });

  it("handles ping commands with multiple clients correctly", async () => {
    // Connect and handshake three clients
    const clientSetups = await Promise.all([
      setupClient(serverUrl, { mode: "readandwrite" }),
      setupClient(serverUrl, { mode: "readandwrite" }),
      setupClient(serverUrl, { mode: "readandwrite" }),
    ]);

    const clients = clientSetups.map(setup => setup.client);
    const clientIds = clientSetups.map(setup => setup.clientId);

    // Test 1: Regular ping from client 0 - only client 0 should receive response
    const pingPromise = new Promise<any[]>((resolve) => {
      let responseCount = 0;
      const responses: any[] = [];

      clients.forEach((client, index) => {
        client.onmessage = (event: MessageEvent) => {
          const data = JSON.parse(event.data);
          if (data.type === "pong") {
            responses.push({ clientIndex: index, data });
            responseCount++;

            // For regular ping, only sender should get response
            if (responseCount >= 1) {
              resolve(responses);
            }
          }
        };
      });

      // Set timeout to ensure we're not waiting forever
      setTimeout(() => resolve(responses), 1000);
    });

    clients[0].send(
      JSON.stringify({
        id: "test-ping-multiple-1",
        type: "ping",
      })
    );

    const pingResponses = await pingPromise;

    // Only one response should be received (by the sender)
    expect(pingResponses).toHaveLength(1);
    expect(pingResponses[0].clientIndex).toBe(0); // Should be client 0
    expect(pingResponses[0].data.data.clientId).toBeUndefined(); // Regular ping doesn't include clientId

    // Test 2: Broadcast ping from client 1 - all clients should receive response
    const broadcastPromise = new Promise<any[]>((resolve) => {
      let responseCount = 0;
      const responses: any[] = [];

      clients.forEach((client, index) => {
        client.onmessage = (event: MessageEvent) => {
          const data = JSON.parse(event.data);
          if (data.type === "pong") {
            responses.push({ clientIndex: index, data });
            responseCount++;

            // For broadcast, all clients should get response
            if (responseCount >= 3) {
              resolve(responses);
            }
          }
        };
      });

      // Set timeout to ensure we're not waiting forever
      setTimeout(() => resolve(responses), 1000);
    });

    clients[1].send(
      JSON.stringify({
        id: "test-ping-broadcast-multiple-1",
        type: "ping.broadcast",
      })
    );

    const broadcastResponses = await broadcastPromise;

    // All three clients should receive responses
    expect(broadcastResponses).toHaveLength(3);

    // All responses should include the sender's client ID (client 1)
    for (const response of broadcastResponses) {
      expect(response.data.data.clientId).toBe(clientIds[1]); // Should be client 1's ID
      expect(response.data.data.message).toBe("pong");
    }

    // Clean up
    clients.forEach(client => client.close());
  });
});
