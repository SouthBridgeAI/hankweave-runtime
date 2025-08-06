import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startServer, cleanupTest, TestWSClient } from "../utils/test-helpers.js";
import type { ChildProcess } from "node:child_process";

let configPath: string | undefined;

describe("Server Integration", () => {
  beforeAll(() => {
    // Create temporary directory
    const tempDir = mkdtempSync(path.join(tmpdir(), "tadpole-test-"));
    configPath = path.join(tempDir, "phases.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        [
          {
            id: "phase-1-analysis",
            name: "Phase 1: Initial Analysis",
            promptFile: "prompts/1-analyze.md",
            model: "sonnet",
            continuationMode: "fresh",
            trackedFiles: ["src/**/*.ts", "analysis.md"],
          },
          {
            id: "phase-2-implementation",
            name: "Phase 2: Implementation",
            promptFile: "prompts/2-implement.md",
            model: "sonnet",
            continuationMode: "continue-previous",
            trackedFiles: ["src/**/*.ts"],
          },
        ],
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

  test("server runs ok", async () => {
    expect(configPath).toBeDefined();
    
    const tempDir = path.dirname(configPath!);
    let serverProcess: ChildProcess | null = null;
    let client: TestWSClient | null = null;
    
    try {
      // Start the server using the helper function
      serverProcess = startServer({
        testRunDir: tempDir,
        phasesConfig: configPath!,
        port: 7777,
        testMode: "integration",
        cwd: tempDir,
      });
      
      // Create a WebSocket client to test connection
      client = new TestWSClient();
      
      // Give server a moment to start
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Try to connect - this will throw if server isn't running
      await client.connect(7777);
      
      // Wait for server.ready event to confirm it's fully started
      await client.waitForEvent("server.ready", 10000);
      
      console.log("✓ Server started successfully and is ready");
      
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
  }, 30000);
});
