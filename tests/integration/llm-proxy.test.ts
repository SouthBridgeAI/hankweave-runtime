import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  startServer,
  cleanupTest,
  TestWSClient,
  TestServerConfig,
  getFreePort,
} from "../utils/test-helpers.js";
import type { ChildProcess } from "node:child_process";

let configPath: string | undefined;

const runTests = async (
  config: TestServerConfig,
  tests: (executionDir?: string) => Promise<void>
) => {
  const tempDir = path.dirname(configPath!);
  let serverProcess: ChildProcess | null = null;
  let client: TestWSClient | null = null;

  try {
    // Start the server using the helper function
    serverProcess = startServer(config);

    // Create a WebSocket client to test connection
    client = new TestWSClient();

    // Give server a moment to start
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Try to connect - this will throw if server isn't running
    await client.connect(config.port);

    // Wait for server.ready event to confirm it's fully started
    await client.waitForEvent("server.ready", 10000);

    console.log("✓ Server started successfully and is ready");

    // Parse server.log to extract execution directory
    const serverLogPath = path.join(tempDir, "server.log");
    let executionDir: string | undefined;

    try {
      const match = readFileSync(serverLogPath, "utf-8").match(
        /\[STDOUT\] Created execution directory: (.+)/
      );
      if (match) {
        executionDir = match[1].trim();
        console.log(`✓ Found execution directory: ${executionDir}`);
      }
    } catch (error) {
      console.log(
        `⚠ Could not parse server.log for execution directory: ${error}`
      );
    }

    await tests(executionDir);
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
              model: "sonnet",
              continuationMode: "fresh",
              checkpointedFiles: ["src/**/*.ts", "analysis.md"],
            },
            {
              id: "codon-2-implementation",
              name: "Codon 2: Implementation",
              promptFile: "prompts/2-implement.md",
              model: "sonnet",
              continuationMode: "continue-previous",
              checkpointedFiles: ["src/**/*.ts"],
            },
          ],
        },
        null,
        2
      )
    );

    // Create prompts directory
    const promptsDir = path.join(tempDir, "prompts");
    mkdirSync(promptsDir);

    // Create prompt files
    writeFileSync(
      path.join(promptsDir, "1-analyze.md"),
      "Please analyze the TypeScript files in the `src/` directory. Identify areas for improvement in terms of code structure, clarity, and potential bugs. Write your findings to a new file named `analysis.md`."
    );

    writeFileSync(
      path.join(promptsDir, "2-implement.md"),
      "Based on our previous discussion and the contents of `analysis.md`, please implement the suggested improvements directly into the source files."
    );
  });

  test("runs on server port + 1 when enabled", async (done) => {
    expect(configPath).toBeDefined();

    const tempDir = path.dirname(configPath!);
    const port = await getFreePort();

    await runTests(
      {
        testRunDir: tempDir,
        configFile: configPath!,
        port,
        testMode: "integration",
        cwd: tempDir,
        proxy: true, // Proxy is off by default, enable it for this test
      },
      async (executionDir) => {
        expect(executionDir).toBeDefined();

        // Check that proxy is running on (server port + 1)
        const healthResponse = await fetch(
          `http://localhost:${port + 1}/health`
        );
        expect(healthResponse.ok).toBe(true);
        expect(await healthResponse.text()).toBe("Hankweave Proxy OK");

        // sleep a bit to make sure we run smth
        await new Promise((resolve) => setTimeout(resolve, 15000));

        // Check if server log contains the logging middleware message
        const logPath = path.join(
          executionDir!,
          ".hankweave/logs/server.log"
        );
        expect(readFileSync(logPath, "utf-8")).toContain(
          "[LOGGING-MIDDLEWARE] Received request"
        );

        done();
      }
    );
  }, 30000);

  test("does not run proxy when withoutProxy is true", async (done) => {
    expect(configPath).toBeDefined();

    const tempDir = path.dirname(configPath!);
    const port = await getFreePort();
    await runTests(
      {
        testRunDir: tempDir,
        configFile: configPath!,
        port,
        testMode: "integration",
        cwd: tempDir,
        withoutProxy: true,
      },
      async () => {
        // Check that proxy is NOT running on (server port + 1)
        try {
          await fetch(`http://localhost:${port + 1}/health`);
          // If we get here, the proxy is running when it shouldn't be
          expect.unreachable(
            "Proxy should not be running when withoutProxy is true"
          );
        } catch (error) {
          // This is expected - the proxy should not be running
          expect(error).toBeDefined();

          done();
        }
      }
    );
  }, 30000);
});
