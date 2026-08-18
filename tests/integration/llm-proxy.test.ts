import { beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cleanupTest,
  getFreePort,
  startServer,
  type TestServerConfig,
  TestWSClient,
} from "../utils/test-helpers.js";

let configPath: string | undefined;

const waitForFileToContain = async (
  filePath: string,
  text: string,
  timeoutMs = 5000,
  intervalMs = 50,
) => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (readFileSync(filePath, "utf-8").includes(text)) {
        return;
      }
    } catch {
      // Ignore transient read errors while the log file is still being created.
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${filePath} to contain ${text}`);
};

const runTests = async (
  config: TestServerConfig,
  tests: (executionDir?: string, proxyPort?: number) => Promise<void>,
) => {
  if (!configPath) throw new Error("configPath not initialized");
  const tempDir = path.dirname(configPath);
  let serverProcess: ChildProcess | null = null;
  let client: TestWSClient | null = null;

  try {
    // Start the server using the helper function
    serverProcess = startServer(config);

    // Create a WebSocket client to test connection
    client = new TestWSClient();

    // Connect with retry - server may take a while to start on Windows
    await client.connectWithRetry(config.port);

    // Wait for server.ready event to confirm it's fully started
    const readyEvent = await client.waitForEvent("server.ready", 10000);

    console.log("✓ Server started successfully and is ready");

    // Extract proxyPort from server.ready event data
    let proxyPort: number | undefined;
    if (readyEvent.type === "server.ready") {
      proxyPort = readyEvent.data.proxyPort;
    }

    // Parse server.log to extract execution directory
    const serverLogPath = path.join(tempDir, "server.log");
    let executionDir: string | undefined;

    try {
      const match = readFileSync(serverLogPath, "utf-8").match(
        /\[STDOUT\] Created execution directory: (.+)/,
      );
      if (match) {
        executionDir = match[1].trim();
        console.log(`✓ Found execution directory: ${executionDir}`);
      }
    } catch (error) {
      console.log(`⚠ Could not parse server.log for execution directory: ${error}`);
    }

    await tests(executionDir, proxyPort);
  } finally {
    // Clean up
    await cleanupTest({
      testDir: tempDir,
      testRunDir: tempDir,
      serverProcess,
      client,
      events: client?.getEvents() || [],
      gracefulShutdown: true,
    });
  }
};

describe("LLM proxy", () => {
  beforeEach(() => {
    // Create temporary directory
    const tempDir = mkdtempSync(path.join(tmpdir(), "hankweave-test-"));
    configPath = path.join(tempDir, "codons.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          hank: [
            {
              id: "codon-1-analysis",
              name: "Codon 1: Initial Analysis",
              promptFile: "prompts/1-analyze.md",
              // These tests assert proxy wiring (health endpoint, --without-proxy)
              // and never run a codon — but the startup self-test still demands
              // credentials for every *credential-enforced* model in the config
              // AND (since the pi-catalog preflight) that the model exists in
              // pi's catalog. A real catalog model on an unenforced provider
              // passes every static check with no keys at all, which is what
              // keeps this suite honest in the keyless integration tier.
              model: "pi/deepseek/deepseek-v4-flash",
              continuationMode: "fresh",
              checkpointedFiles: ["src/**/*.ts", "analysis.md"],
            },
            {
              id: "codon-2-implementation",
              name: "Codon 2: Implementation",
              promptFile: "prompts/2-implement.md",
              model: "pi/deepseek/deepseek-v4-flash",
              continuationMode: "continue-previous",
              checkpointedFiles: ["src/**/*.ts"],
            },
          ],
        },
        null,
        2,
      ),
    );

    // Create prompts directory
    const promptsDir = path.join(tempDir, "prompts");
    mkdirSync(promptsDir);

    // Create prompt files
    writeFileSync(
      path.join(promptsDir, "1-analyze.md"),
      "Please analyze the TypeScript files in the `src/` directory. Identify areas for improvement in terms of code structure, clarity, and potential bugs. Write your findings to a new file named `analysis.md`.",
    );

    writeFileSync(
      path.join(promptsDir, "2-implement.md"),
      "Based on our previous discussion and the contents of `analysis.md`, please implement the suggested improvements directly into the source files.",
    );
  });

  test("health check responds when proxy enabled", async (done) => {
    expect(configPath).toBeDefined();
    if (!configPath) throw new Error("configPath not initialized");

    const tempDir = path.dirname(configPath);
    const port = await getFreePort();

    await runTests(
      {
        testRunDir: tempDir,
        configFile: configPath,
        port,
        testMode: "integration",
        cwd: tempDir,
        proxy: true, // Proxy is off by default, enable it for this test
        // The suite asserts proxy wiring only; without this, the server
        // autostarts codon-1 the moment it boots — which is how these tests
        // spent real Sonnet money on every CI push for months.
        noAutostart: true,
        // Point the proxy's upstream at a dead local port. The middleware
        // assertion below needs a request on the API path, and this guarantees
        // it terminates on this machine instead of reaching api.anthropic.com.
        extraArgs: ["--anthropic-base-url", "http://127.0.0.1:1"],
      },
      async (executionDir, proxyPort) => {
        expect(executionDir).toBeDefined();
        expect(proxyPort).toBeDefined();
        if (!executionDir) throw new Error("executionDir not reported by server");

        // Check that proxy is running on the reported port
        const healthResponse = await fetch(`http://localhost:${proxyPort}/health`);
        expect(healthResponse.ok).toBe(true);
        expect(await healthResponse.text()).toBe("Hankweave Proxy OK");

        // `/health` short-circuits before the middleware, so it alone proves
        // nothing about the request pipeline. Send one request down the API
        // path — the middleware logs it before attempting the (dead) upstream
        // forward, which is all this assertion needs. Historically this line
        // was satisfied by a real autostarted Sonnet codon's API traffic.
        await fetch(`http://localhost:${proxyPort}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ probe: true }),
        }).catch(() => {
          // The upstream is intentionally unreachable; delivery is irrelevant.
        });

        // Check if server log contains the logging middleware message
        const logPath = path.join(executionDir, ".hankweave/logs/server.log");
        await waitForFileToContain(logPath, "[LOGGING-MIDDLEWARE] Received request");

        done();
      },
    );
  }, 30000);

  test("does not run proxy when withoutProxy is true", async (done) => {
    expect(configPath).toBeDefined();
    if (!configPath) throw new Error("configPath not initialized");

    const tempDir = path.dirname(configPath);
    const port = await getFreePort();
    await runTests(
      {
        testRunDir: tempDir,
        configFile: configPath,
        port,
        testMode: "integration",
        cwd: tempDir,
        withoutProxy: true,
        noAutostart: true,
      },
      async (_executionDir, proxyPort) => {
        // The server.ready payload is the contract: no proxyPort means the
        // runtime never started a proxy. The old socket probe on `port + 1`
        // raced concurrent suites — the runtime prefers server-port+1 for its
        // proxy, but getFreePort never reserved that adjacent port, so any
        // parallel test could legitimately be listening there.
        expect(proxyPort).toBeUndefined();

        done();
      },
    );
  }, 30000);
});
