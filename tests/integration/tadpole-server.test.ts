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

    // Connect second client
    const client2 = new WebSocket(serverUrl);

    const client2Connected = await new Promise<boolean>((resolve) => {
      client2.onopen = () => resolve(true);
      client2.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 5000);
    });

    expect(client2Connected).toBe(true);
    expect(client2.readyState).toBe(WebSocket.OPEN);

    // Connect third client
    const client3 = new WebSocket(serverUrl);

    const client3Connected = await new Promise<boolean>((resolve) => {
      client3.onopen = () => resolve(true);
      client3.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 5000);
    });

    expect(client3Connected).toBe(true);
    expect(client3.readyState).toBe(WebSocket.OPEN);

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

  it("responds to ping command from single client", async () => {
    // Connect and handshake client
    const client = new WebSocket(serverUrl);
    await new Promise<void>((resolve) => {
      client.onopen = () => resolve();
    });

    // Perform handshake
    const handshakePromise = new Promise<any>((resolve) => {
      client.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "handshake.response") {
          resolve(data);
        }
      };
    });

    client.send(
      JSON.stringify({
        type: "handshake",
        data: { mode: "readandwrite" },
      })
    );

    const handshakeResponse = await handshakePromise;
    const clientId = handshakeResponse.data.clientId;

    // Set up pong response listener
    const pongPromise = new Promise<any>((resolve) => {
      client.onmessage = (event) => {
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
    // Connect and handshake first client
    const client1 = new WebSocket(serverUrl);
    await new Promise<void>((resolve) => {
      client1.onopen = () => resolve();
    });

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
    const client1Id = handshakeResponse1.data.clientId;

    // Connect and handshake second client
    const client2 = new WebSocket(serverUrl);
    await new Promise<void>((resolve) => {
      client2.onopen = () => resolve();
    });

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
        data: { mode: "readonly" },
      })
    );

    const handshakeResponse2 = await handshake2Promise;
    const client2Id = handshakeResponse2.data.clientId;

    // Set up pong response listeners
    const pongPromises = [
      new Promise<any>((resolve) => {
        client1.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "pong") {
            resolve({ client: "client1", data });
          }
        };
      }),
      new Promise<any>((resolve) => {
        client2.onmessage = (event) => {
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
    const clients: WebSocket[] = [];
    const clientIds: string[] = [];

    for (let i = 0; i < 3; i++) {
      const client = new WebSocket(serverUrl);
      await new Promise<void>((resolve) => {
        client.onopen = () => resolve();
      });

      const handshakePromise = new Promise<any>((resolve) => {
        client.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === "handshake.response") {
            resolve(data);
          }
        };
      });

      client.send(
        JSON.stringify({
          type: "handshake",
          data: { mode: "readandwrite" },
        })
      );

      const handshakeResponse = await handshakePromise;
      clients.push(client);
      clientIds.push(handshakeResponse.data.clientId);
    }

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
