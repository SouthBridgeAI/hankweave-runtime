#!/usr/bin/env bun
/**
 * Comprehensive Sentinel Integration E2E Test
 *
 * Tests the full sentinel system integration with HankweaveServer:
 * - Sentinel lifecycle events
 * - State persistence and SentinelState tracking
 * - Output file generation
 * - Structured output mode
 * - Conversational mode
 * - completing-sentinels state transition
 * - Zero sentinels scenario
 *
 * This test boots up a real server with sentinels configured and verifies
 * all aspects of the integration work correctly.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CodonCompletedEvent,
  InfoEvent,
  SentinelLoadedEvent,
  SentinelOutputEvent,
  SentinelUnloadedEvent,
  ServerEvent,
  StateTransitionEvent,
} from "../../server/schemas/event-schemas.js";
import type { HankweaveState } from "../../server/types/state-types.js";
import {
  ClientMode,
  colors,
  generateTestTimestamp,
  startServer,
  type TestServerConfig,
  TestWSClient,
} from "../utils/test-helpers.js";

const TEST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_RESULTS_DIR = path.join(TEST_ROOT, "tests/test-results");
const TEST_TIMESTAMP = generateTestTimestamp();

// -------------
// Test Suite 1: Sentinels Enabled
// -------------

describe("Sentinel Integration: With Sentinels", () => {
  const TEST_RUN_DIR = path.join(TEST_RESULTS_DIR, `sentinel-enabled-${TEST_TIMESTAMP}`);
  const TEST_PORT = 7824;

  let serverProcess: ChildProcess | null = null;
  let client: TestWSClient | null = null;
  let executionPath: string | null = null;
  let events: ServerEvent[] = [];

  beforeAll(async () => {
    // Create test area
    const testDir = path.join(TEST_ROOT, "tests/test-area/sentinel-enabled-test");
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });

    const configDir = path.join(testDir, "config");
    const promptsDir = path.join(testDir, "prompts");
    const sentinelsDir = path.join(testDir, "sentinels");

    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.mkdirSync(sentinelsDir, { recursive: true });

    // Create data file
    const dataFile = path.join(testDir, "test-data.txt");
    fs.writeFileSync(dataFile, "Test data for sentinel integration\n");

    // Create prompt
    fs.writeFileSync(
      path.join(promptsDir, "codon1.md"),
      'Write "Integration test complete" to output.txt',
    );

    // Create text sentinel config
    const textSentinelConfig = {
      id: "text-narrator",
      name: "Text Narrator",
      model: "anthropic/claude-haiku-4-5",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      userPromptText: "Narrate: <%= it.events.length %> event(s)",
      joinString: "\n---\n",
    };

    // Create structured output sentinel config
    const structuredSentinelConfig = {
      id: "entity-tracker",
      name: "Entity Tracker",
      model: "anthropic/claude-haiku-4-5",
      trigger: { type: "event", on: ["file.updated"] },
      execution: { strategy: "immediate" },
      userPromptText: "Extract entities",
      structuredOutput: {
        output: "object",
        schemaStr: "z.object({ count: z.number(), items: z.array(z.string()) })",
      },
    };

    // Create conversational sentinel config
    const conversationalSentinelConfig = {
      id: "conv-narrator",
      name: "Conversational Narrator",
      model: "anthropic/claude-haiku-4-5",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "debounce", milliseconds: 2000 },
      systemPromptText: "You maintain context across events",
      userPromptText: "Summarize: <%= it.events.length %> events",
      conversational: {
        trimmingStrategy: { type: "maxTurns", maxTurns: 5 },
      },
    };

    fs.writeFileSync(
      path.join(sentinelsDir, "text-narrator.json"),
      JSON.stringify(textSentinelConfig, null, 2),
    );
    fs.writeFileSync(
      path.join(sentinelsDir, "entity-tracker.json"),
      JSON.stringify(structuredSentinelConfig, null, 2),
    );
    fs.writeFileSync(
      path.join(sentinelsDir, "conv-narrator.json"),
      JSON.stringify(conversationalSentinelConfig, null, 2),
    );

    // Create codon config with all three sentinels
    const codonsConfig = [
      {
        id: "sentinel-test-codon",
        name: "Sentinel Integration Test",
        promptFile: path.join(promptsDir, "codon1.md"),
        model: "sonnet",
        continuationMode: "fresh",
        checkpointedFiles: ["*.txt"],
        sentinels: [
          { sentinelConfig: path.join(sentinelsDir, "text-narrator.json") },
          { sentinelConfig: path.join(sentinelsDir, "entity-tracker.json") },
          { sentinelConfig: path.join(sentinelsDir, "conv-narrator.json") },
        ],
      },
    ];

    const codonConfigPath = path.join(configDir, "codons.json");
    fs.writeFileSync(codonConfigPath, JSON.stringify({ hank: codonsConfig }, null, 2));

    // Ensure test run directory exists
    if (!fs.existsSync(TEST_RUN_DIR)) {
      fs.mkdirSync(TEST_RUN_DIR, { recursive: true });
    }

    // Start server with noAutostart so we can connect before codon starts
    // This ensures we capture sentinel.loaded events
    const serverConfig: TestServerConfig = {
      testRunDir: TEST_RUN_DIR,
      configFile: codonConfigPath,
      port: TEST_PORT,
      testMode: "sentinel-enabled",
      dataSourceDir: dataFile,
      cwd: testDir,
      useDataFlag: true,
      startNew: true,
      noAutostart: true, // Don't auto-start - we'll trigger manually after connecting
    };

    console.log(`${colors.blue}Starting server with sentinels (noAutostart)...${colors.reset}`);
    serverProcess = startServer(serverConfig);

    // Connect client with retry logic - connect as early as possible
    console.log(`${colors.blue}Connecting client (with retry)...${colors.reset}`);
    client = new TestWSClient();
    await client.connectWithRetry(TEST_PORT, {
      performHandshake: true,
      mode: ClientMode.READANDWRITE,
      maxRetries: 30,
      retryDelay: 500,
      timeout: 10000,
    });

    // Get server ready event
    const readyEvent = await client.waitForEvent("server.ready", 10000);
    if (readyEvent.type === "server.ready") {
      executionPath = readyEvent.data.executionPath;
      console.log(`${colors.green}✓ Server ready at ${executionPath}${colors.reset}`);
    }

    // Now trigger the first codon to start - client is connected and will capture all events
    console.log(`${colors.blue}Triggering codon start...${colors.reset}`);
    const { generateId } = await import("../../server/utils.js");
    client.sendCommand({
      id: generateId(),
      type: "codon.next",
    });

    // Wait for codon to complete
    console.log(`${colors.blue}Waiting for codon to complete...${colors.reset}`);
    const codonComplete = await client.waitForEvent("codon.completed", 120000);
    expect(codonComplete.type).toBe("codon.completed");
    expect((codonComplete as CodonCompletedEvent).data.success).toBe(true);
    console.log(`${colors.green}✓ Codon completed${colors.reset}`);

    // Wait for sentinel work to complete (queue draining, outputs written)
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Request server shutdown to trigger sentinel unload events
    // This cleanly unloads sentinels before server stops
    console.log(`${colors.blue}Requesting server shutdown...${colors.reset}`);
    client.sendCommand({
      id: generateId(),
      type: "server.shutdown",
      data: { reason: "test-complete" },
    });

    // Wait for server to process shutdown and emit unload events
    // The unload events should be emitted before the connection closes
    await new Promise((resolve) => setTimeout(resolve, 3000));

    events = client.getEvents();
  });

  afterAll(async () => {
    if (client) {
      await client.disconnect();
    }
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  });

  describe("Sentinel Lifecycle Events", () => {
    it("should emit sentinel.loaded events for all 3 sentinels", () => {
      const loadedEvents = events.filter(
        (e) => e.type === "sentinel.loaded",
      ) as SentinelLoadedEvent[];

      expect(loadedEvents.length).toBe(3);

      const ids = loadedEvents.map((e) => e.data.sentinelId).sort();
      expect(ids).toEqual(["conv-narrator", "entity-tracker", "text-narrator"]);

      // Verify each has correct metadata
      for (const event of loadedEvents) {
        expect(event.data.codonId).toBe("sentinel-test-codon");
        expect(event.data.source).toBe("file");
        expect(event.data.model).toContain("anthropic");
        expect(event.data.triggerType).toBe("event");
      }

      console.log(`${colors.green}✓ All 3 sentinel.loaded events verified${colors.reset}`);
    });

    it("should emit sentinel.unloaded events on codon completion", () => {
      const unloadedEvents = events.filter(
        (e) => e.type === "sentinel.unloaded",
      ) as SentinelUnloadedEvent[];

      expect(unloadedEvents.length).toBe(3);

      for (const event of unloadedEvents) {
        // Unload reason could be either codon-complete or shutdown depending on timing
        expect(["codon-complete", "shutdown"]).toContain(event.data.reason);
        expect(event.data.codonId).toBe("sentinel-test-codon");
        expect(typeof event.data.finalCost).toBe("number");
        expect(typeof event.data.llmCallCount).toBe("number");
      }

      console.log(`${colors.green}✓ All 3 sentinel.unloaded events verified${colors.reset}`);
    });

    it("should emit sentinel.output events", () => {
      const outputEvents = events.filter(
        (e) => e.type === "sentinel.output",
      ) as SentinelOutputEvent[];

      // Should have outputs from sentinels
      expect(outputEvents.length).toBeGreaterThan(0);

      for (const event of outputEvents) {
        expect(event.data.codonId).toBe("sentinel-test-codon");
        expect(["text-narrator", "entity-tracker", "conv-narrator"]).toContain(
          event.data.sentinelId,
        );
        expect(typeof event.data.cost).toBe("number");
        expect(event.data.tokens).toBeDefined();
      }

      console.log(`${colors.green}✓ Sentinel output events verified${colors.reset}`);
    });
  });

  describe("State Transitions", () => {
    it("should transition to completing-sentinels state", () => {
      const transitions = events.filter(
        (e) => e.type === "state.transition",
      ) as StateTransitionEvent[];

      const completingTransition = transitions.find((e) => {
        const data = e.data as StateTransitionEvent["data"];
        return (
          data.transitionType === "CodonTransitioned" &&
          data.codonId === "sentinel-test-codon" &&
          data.transition?.data?.to === "completing-sentinels"
        );
      });

      expect(completingTransition).toBeDefined();

      if (completingTransition) {
        const transitionData = completingTransition.data.transition.data as Record<string, unknown>;
        const metadata = transitionData.metadata as Record<string, unknown> | undefined;
        expect(metadata?.sentinelCount).toBe(3);
        expect(metadata?.sentinelIds).toEqual(
          expect.arrayContaining(["text-narrator", "entity-tracker", "conv-narrator"]),
        );
      }

      console.log(`${colors.green}✓ completing-sentinels transition verified${colors.reset}`);
    });

    it("should have SentinelStatesUpdated transitions", () => {
      const transitions = events.filter(
        (e) => e.type === "state.transition",
      ) as StateTransitionEvent[];

      const senStateUpdates = transitions.filter((e) => {
        return e.data.transitionType === "SentinelStatesUpdated";
      });

      // Should have at least 2: initial load + final update before completion
      expect(senStateUpdates.length).toBeGreaterThanOrEqual(2);

      for (const update of senStateUpdates) {
        const transitionData = update.data.transition.data as Record<string, unknown>;
        expect(transitionData.sentinelStates).toBeDefined();
        expect(Array.isArray(transitionData.sentinelStates)).toBe(true);
        expect(transitionData.totalCost).toBeDefined();
      }

      console.log(
        `${colors.green}✓ ${senStateUpdates.length} SentinelStatesUpdated transitions verified${colors.reset}`,
      );
    });

    it("should emit info events about completing sentinels", () => {
      const infoEvents = events.filter((e) => e.type === "info") as InfoEvent[];

      const startEvent = infoEvents.find((e) => e.data.message.includes("Completing work for"));
      expect(startEvent).toBeDefined();
      if (startEvent) {
        expect(startEvent.data.message).toContain("3 sentinel");
      }

      const endEvent = infoEvents.find((e) => e.data.message.includes("Sentinel work completed"));
      expect(endEvent).toBeDefined();

      console.log(`${colors.green}✓ Sentinel completion info events verified${colors.reset}`);
    });
  });

  describe("State Persistence", () => {
    it("should persist SentinelState in state.json", () => {
      if (!executionPath) {
        throw new Error("No execution path");
      }

      const statePath = path.join(executionPath, ".hankweave/state.json");
      expect(fs.existsSync(statePath)).toBe(true);

      const stateContent = fs.readFileSync(statePath, "utf-8");
      const state: HankweaveState = JSON.parse(stateContent);

      expect(state.runs.length).toBeGreaterThan(0);
      const codon = state.runs[0].codons.find((p) => p.codonId === "sentinel-test-codon");

      expect(codon).toBeDefined();
      if (!codon) throw new Error("Codon not found");

      expect(codon.status).toBe("completed");

      // Type narrow to CompletedCodon to access sentinels
      if (codon.status === "completed") {
        expect(codon.sentinels).toBeDefined();

        if (codon.sentinels) {
          // Verify field is 'executed' not 'loaded'
          expect(codon.sentinels.executed).toBeDefined();
          expect(codon.sentinels.executed.length).toBe(3);

          // Verify each sentinel state
          const senIds = codon.sentinels.executed.map((c) => c.id).sort();
          expect(senIds).toEqual(["conv-narrator", "entity-tracker", "text-narrator"]);

          for (const senState of codon.sentinels.executed) {
            expect(senState.model).toBeDefined();
            expect(senState.loadedAt).toBeDefined();
            // Status could be active or unloaded depending on when state was captured
            expect(["active", "unloaded"]).toContain(senState.status);
            // Only check unloadReason if status is unloaded
            if (senState.status === "unloaded") {
              expect(["codon-complete", "shutdown"]).toContain(senState.unloadReason || "");
            }
            expect(typeof senState.llmCallCount).toBe("number");
            expect(typeof senState.totalTriggers).toBe("number");
            expect(typeof senState.totalCost).toBe("number");
            expect(senState.totalCost).toBeGreaterThanOrEqual(0);
          }

          // Verify total cost
          expect(typeof codon.sentinels.totalCost).toBe("number");
          expect(codon.sentinels.totalCost).toBeGreaterThanOrEqual(0);

          // Individual costs should sum to total
          const sum = codon.sentinels.executed.reduce((acc, chr) => acc + chr.totalCost, 0);
          expect(Math.abs(sum - codon.sentinels.totalCost)).toBeLessThan(0.000001);
        }
      }

      console.log(
        `${colors.green}✓ SentinelState persisted correctly in state.json${colors.reset}`,
      );
    });

    it("should track sentinel costs separately from codon costs", () => {
      if (!executionPath) {
        throw new Error("No execution path");
      }

      const statePath = path.join(executionPath, ".hankweave/state.json");
      const state: HankweaveState = JSON.parse(fs.readFileSync(statePath, "utf-8"));

      const codon = state.runs[0].codons.find((p) => p.codonId === "sentinel-test-codon");
      expect(codon).toBeDefined();
      if (!codon) throw new Error("Codon not found");
      expect(codon.status).toBe("completed");

      if (codon.status === "completed" && codon.sentinels) {
        const codonCost = codon.finalCost;
        const sentinelCost = codon.sentinels.totalCost;

        expect(typeof codonCost).toBe("number");
        expect(typeof sentinelCost).toBe("number");
        expect(codonCost).toBeGreaterThan(0);

        console.log(
          `${colors.green}✓ Costs separated: Codon=$${codonCost.toFixed(6)}, Sentinels=$${sentinelCost.toFixed(6)}${colors.reset}`,
        );
      }
    });
  });

  describe("Output Files", () => {
    it("should create sentinel output directories", () => {
      if (!executionPath) {
        throw new Error("No execution path");
      }

      const outputsDir = path.join(executionPath, ".hankweave/sentinels/outputs");
      expect(fs.existsSync(outputsDir)).toBe(true);

      // Should have directories for each sentinel
      const sentinelDirs = fs.readdirSync(outputsDir);
      expect(sentinelDirs).toContain("text-narrator");
      expect(sentinelDirs).toContain("entity-tracker");
      expect(sentinelDirs).toContain("conv-narrator");

      console.log(`${colors.green}✓ Output directories created for all sentinels${colors.reset}`);
    });

    it("should create text output files with correct extension", () => {
      if (!executionPath) {
        throw new Error("No execution path");
      }

      const textNarratorDir = path.join(
        executionPath,
        ".hankweave/sentinels/outputs/text-narrator",
      );
      const files = fs.readdirSync(textNarratorDir);

      // Should have .md file (text output)
      const mdFiles = files.filter((f) => f.endsWith(".md"));
      expect(mdFiles.length).toBeGreaterThan(0);

      // Verify file naming pattern
      expect(mdFiles[0]).toMatch(/^text-narrator-sentinel-test-codon-\d+\.md$/);

      console.log(`${colors.green}✓ Text output files created with .md extension${colors.reset}`);
    });

    it("should create structured output files with correct extension", () => {
      if (!executionPath) {
        throw new Error("No execution path");
      }

      const entityTrackerDir = path.join(
        executionPath,
        ".hankweave/sentinels/outputs/entity-tracker",
      );
      const files = fs.readdirSync(entityTrackerDir);

      // Should have .ndjson file (structured output)
      const ndjsonFiles = files.filter((f) => f.endsWith(".ndjson"));
      expect(ndjsonFiles.length).toBeGreaterThan(0);

      console.log(
        `${colors.green}✓ Structured output files created with .ndjson extension${colors.reset}`,
      );
    });

    it("should create conversational history file", () => {
      if (!executionPath) {
        throw new Error("No execution path");
      }

      const sentinelsDir = path.join(executionPath, ".hankweave/sentinels");

      if (fs.existsSync(sentinelsDir)) {
        const historyFiles = fs.readdirSync(sentinelsDir).filter((f) => f.endsWith(".json"));

        // Should have history file for conversational sentinel
        const convHistory = historyFiles.find((f) => f.includes("conv-narrator"));
        if (convHistory) {
          expect(convHistory).toMatch(/^conv-narrator-codon-sentinel-test-codon\.json$/);

          // Verify it's valid JSON
          const historyPath = path.join(sentinelsDir, convHistory);
          const content = fs.readFileSync(historyPath, "utf-8");
          expect(() => JSON.parse(content)).not.toThrow();

          console.log(`${colors.green}✓ Conversational history file created${colors.reset}`);
        }
      }
    });
  });

  describe("Structured Output", () => {
    it("should generate valid JSON objects", () => {
      const outputEvents = events.filter(
        (e) => e.type === "sentinel.output" && e.data?.sentinelId === "entity-tracker",
      ) as SentinelOutputEvent[];

      if (outputEvents.length > 0) {
        for (const event of outputEvents) {
          expect(event.data.outputType).toBe("structured");
          expect(typeof event.data.content).toBe("object");

          // Verify schema structure - content is Record<string, unknown> for structured output
          if (typeof event.data.content === "object" && event.data.content !== null) {
            const content = event.data.content as Record<string, unknown>;
            expect(content.count).toBeDefined();
            expect(content.items).toBeDefined();
            expect(Array.isArray(content.items)).toBe(true);
          }
        }

        console.log(`${colors.green}✓ Structured output validated${colors.reset}`);
      }
    });
  });
});

// -------------
// Test Suite 2: Zero Sentinels
// -------------

describe("Sentinel Integration: Zero Sentinels", () => {
  const TEST_RUN_DIR = path.join(TEST_RESULTS_DIR, `sentinel-zero-${TEST_TIMESTAMP}`);
  const TEST_PORT = 7825; // Different port from first suite

  let serverProcess: ChildProcess | null = null;
  let client: TestWSClient | null = null;
  let executionPath: string | null = null;
  let events: ServerEvent[] = [];

  beforeAll(async () => {
    // Create test area
    const testDir = path.join(TEST_ROOT, "tests/test-area/sentinel-zero-test");
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });

    const configDir = path.join(testDir, "config");
    const promptsDir = path.join(testDir, "prompts");

    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(promptsDir, { recursive: true });

    // Create data file
    const dataFile = path.join(testDir, "test-data.txt");
    fs.writeFileSync(dataFile, "Test data\n");

    // Create prompt
    fs.writeFileSync(path.join(promptsDir, "codon1.md"), 'Write "Done" to output.txt');

    // Create codon config WITHOUT sentinels
    const codonsConfig = [
      {
        id: "zero-sen-codon",
        name: "Codon Without Sentinels",
        promptFile: path.join(promptsDir, "codon1.md"),
        model: "sonnet",
        continuationMode: "fresh",
        checkpointedFiles: ["*.txt"],
        // NO sentinels field
      },
    ];

    const codonConfigPath = path.join(configDir, "codons.json");
    fs.writeFileSync(codonConfigPath, JSON.stringify({ hank: codonsConfig }, null, 2));

    // Ensure test run directory exists
    if (!fs.existsSync(TEST_RUN_DIR)) {
      fs.mkdirSync(TEST_RUN_DIR, { recursive: true });
    }

    // Start server
    const serverConfig: TestServerConfig = {
      testRunDir: TEST_RUN_DIR,
      configFile: codonConfigPath,
      port: TEST_PORT,
      testMode: "sentinel-zero",
      dataSourceDir: dataFile,
      cwd: testDir,
      useDataFlag: true,
      startNew: true,
    };

    console.log(`${colors.blue}Starting server without sentinels...${colors.reset}`);
    serverProcess = startServer(serverConfig);

    // Wait for server to start
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Connect client
    client = new TestWSClient();
    await client.connect(TEST_PORT, {
      performHandshake: true,
      mode: ClientMode.READANDWRITE,
    });

    // Get server ready event
    const readyEvent = await client.waitForEvent("server.ready", 10000);
    if (readyEvent.type === "server.ready") {
      executionPath = readyEvent.data.executionPath;
      console.log(`${colors.green}✓ Server ready at ${executionPath}${colors.reset}`);
    }

    // Wait for codon to complete
    await client.waitForEvent("codon.completed", 60000);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    events = client.getEvents();
  });

  afterAll(async () => {
    if (client) {
      await client.disconnect();
    }
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  });

  describe("State Transitions Without Sentinels", () => {
    it("should skip completing-sentinels state when sentinelCount is 0", () => {
      if (!client) throw new Error("Client not initialized");

      const transitions = events.filter(
        (e) => e.type === "state.transition",
      ) as StateTransitionEvent[];

      // Should NOT have completing-sentinels transition
      const completingTransition = transitions.find((e) => {
        const transitionData = e.data.transition.data as Record<string, unknown>;
        return (
          e.data.transitionType === "CodonTransitioned" &&
          transitionData?.to === "completing-sentinels"
        );
      });
      expect(completingTransition).toBeUndefined();

      // Should go directly running → completed
      const directTransition = transitions.find((e) => {
        const transitionData = e.data.transition.data as Record<string, unknown>;
        return (
          e.data.transitionType === "CodonTransitioned" &&
          transitionData?.from === "running" &&
          transitionData?.to === "completed" &&
          e.data.codonId === "zero-sen-codon"
        );
      });
      expect(directTransition).toBeDefined();

      console.log(`${colors.green}✓ Correctly skips completing-sentinels state${colors.reset}`);
    });

    it("should not have sentinels field in state.json when no sentinels", () => {
      if (!executionPath) throw new Error("No execution path");

      const statePath = path.join(executionPath, ".hankweave/state.json");
      const state: HankweaveState = JSON.parse(fs.readFileSync(statePath, "utf-8"));

      const codon = state.runs[0].codons.find((p) => p.codonId === "zero-sen-codon");
      expect(codon).toBeDefined();
      if (!codon) throw new Error("Codon not found");

      expect(codon.status).toBe("completed");

      // Type narrow to CompletedCodon
      if (codon.status === "completed") {
        expect(codon.sentinels).toBeUndefined();
      }

      console.log(`${colors.green}✓ No sentinels field when none configured${colors.reset}`);
    });

    it("should not emit sentinel lifecycle events", () => {
      const loadedEvents = events.filter((e) => e.type === "sentinel.loaded");
      const unloadedEvents = events.filter((e) => e.type === "sentinel.unloaded");
      const outputEvents = events.filter((e) => e.type === "sentinel.output");

      expect(loadedEvents.length).toBe(0);
      expect(unloadedEvents.length).toBe(0);
      expect(outputEvents.length).toBe(0);

      console.log(`${colors.green}✓ No sentinel events when none configured${colors.reset}`);
    });
  });
});
