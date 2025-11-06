#!/usr/bin/env bun
/**
 * Comprehensive Chronicler Integration E2E Test
 *
 * Tests the full chronicler system integration with TadpoleServer:
 * - Chronicler lifecycle events
 * - State persistence and ChroniclerState tracking
 * - Output file generation
 * - Structured output mode
 * - Conversational mode
 * - completing-chroniclers state transition
 * - Zero chroniclers scenario
 *
 * This test boots up a real server with chroniclers configured and verifies
 * all aspects of the integration work correctly.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ChroniclerLoadedEvent,
  ChroniclerOutputEvent,
  ChroniclerUnloadedEvent,
  InfoEvent,
  PhaseCompletedEvent,
  ServerEvent,
  StateTransitionEvent,
} from "../../server/schemas/event-schemas.js";
import type { TadpoleState } from "../../server/types/state-types.js";
import {
  ClientMode,
  colors,
  generateTestTimestamp,
  type ServerConfig,
  startServer,
  TestWSClient,
} from "../utils/test-helpers.js";

const TEST_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const TEST_RESULTS_DIR = path.join(TEST_ROOT, "tests/test-results");
const TEST_TIMESTAMP = generateTestTimestamp();

// ============================================================================
// Test Suite 1: Chroniclers Enabled
// ============================================================================

describe("Chronicler Integration: With Chroniclers", () => {
  const TEST_RUN_DIR = path.join(TEST_RESULTS_DIR, `chronicler-enabled-${TEST_TIMESTAMP}`);
  const TEST_PORT = 7824;

  let serverProcess: ChildProcess | null = null;
  let client: TestWSClient | null = null;
  let executionPath: string | null = null;
  let events: ServerEvent[] = [];

  beforeAll(async () => {
    // Create test area
    const testDir = path.join(TEST_ROOT, "tests/test-area/chronicler-enabled-test");
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testDir, { recursive: true });

    const configDir = path.join(testDir, "config");
    const promptsDir = path.join(testDir, "prompts");
    const chroniclersDir = path.join(testDir, "chroniclers");

    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.mkdirSync(chroniclersDir, { recursive: true });

    // Create data file
    const dataFile = path.join(testDir, "test-data.txt");
    fs.writeFileSync(dataFile, "Test data for chronicler integration\n");

    // Create prompt
    fs.writeFileSync(
      path.join(promptsDir, "phase1.md"),
      'Write "Integration test complete" to output.txt',
    );

    // Create text chronicler config
    const textChroniclerConfig = {
      id: "text-narrator",
      name: "Text Narrator",
      model: "anthropic/claude-haiku-4-5",
      trigger: { type: "event", on: ["assistant.action"] },
      execution: { strategy: "immediate" },
      userPromptText: "Narrate: <%= it.events.length %> event(s)",
      joinString: "\n---\n",
    };

    // Create structured output chronicler config
    const structuredChroniclerConfig = {
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

    // Create conversational chronicler config
    const conversationalChroniclerConfig = {
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
      path.join(chroniclersDir, "text-narrator.json"),
      JSON.stringify(textChroniclerConfig, null, 2),
    );
    fs.writeFileSync(
      path.join(chroniclersDir, "entity-tracker.json"),
      JSON.stringify(structuredChroniclerConfig, null, 2),
    );
    fs.writeFileSync(
      path.join(chroniclersDir, "conv-narrator.json"),
      JSON.stringify(conversationalChroniclerConfig, null, 2),
    );

    // Create phase config with all three chroniclers
    const phasesConfig = [
      {
        id: "chronicler-test-phase",
        name: "Chronicler Integration Test",
        promptFile: path.join(promptsDir, "phase1.md"),
        model: "sonnet",
        continuationMode: "fresh",
        trackedFiles: ["*.txt"],
        chroniclers: [
          { chroniclerConfig: path.join(chroniclersDir, "text-narrator.json") },
          { chroniclerConfig: path.join(chroniclersDir, "entity-tracker.json") },
          { chroniclerConfig: path.join(chroniclersDir, "conv-narrator.json") },
        ],
      },
    ];

    const phaseConfigPath = path.join(configDir, "phases.json");
    fs.writeFileSync(phaseConfigPath, JSON.stringify(phasesConfig, null, 2));

    // Ensure test run directory exists
    if (!fs.existsSync(TEST_RUN_DIR)) {
      fs.mkdirSync(TEST_RUN_DIR, { recursive: true });
    }

    // Start server
    const serverConfig: ServerConfig = {
      testRunDir: TEST_RUN_DIR,
      phasesConfig: phaseConfigPath,
      port: TEST_PORT,
      testMode: "chronicler-enabled",
      dataSourceDir: dataFile,
      cwd: testDir,
      useDataFlag: true,
      startNew: true,
    };

    console.log(`${colors.blue}Starting server with chroniclers...${colors.reset}`);
    serverProcess = startServer(serverConfig);

    // Wait for server to start
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Connect client
    console.log(`${colors.blue}Connecting client...${colors.reset}`);
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

    // Wait for phase to complete
    console.log(`${colors.blue}Waiting for phase to complete...${colors.reset}`);
    const phaseComplete = await client.waitForEvent("phase.completed", 120000);
    expect(phaseComplete.type).toBe("phase.completed");
    expect((phaseComplete as PhaseCompletedEvent).data.success).toBe(true);
    console.log(`${colors.green}✓ Phase completed${colors.reset}`);

    // Wait for chronicler work to complete and state to be persisted
    // Need to wait for:
    // 1. Chronicler queues to drain
    // 2. Unload events to fire
    // 3. State to be written to disk
    await new Promise((resolve) => setTimeout(resolve, 5000));

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

  describe("Chronicler Lifecycle Events", () => {
    it("should emit chronicler.loaded events for all 3 chroniclers", () => {
      const loadedEvents = events.filter(
        (e) => e.type === "chronicler.loaded",
      ) as ChroniclerLoadedEvent[];

      expect(loadedEvents.length).toBe(3);

      const ids = loadedEvents.map((e) => e.data.chroniclerId).sort();
      expect(ids).toEqual(["conv-narrator", "entity-tracker", "text-narrator"]);

      // Verify each has correct metadata
      for (const event of loadedEvents) {
        expect(event.data.phaseId).toBe("chronicler-test-phase");
        expect(event.data.source).toBe("file");
        expect(event.data.model).toContain("anthropic");
        expect(event.data.triggerType).toBe("event");
      }

      console.log(`${colors.green}✓ All 3 chronicler.loaded events verified${colors.reset}`);
    });

    it("should emit chronicler.unloaded events on phase completion", () => {
      const unloadedEvents = events.filter(
        (e) => e.type === "chronicler.unloaded",
      ) as ChroniclerUnloadedEvent[];

      expect(unloadedEvents.length).toBe(3);

      for (const event of unloadedEvents) {
        // Unload reason could be either phase-complete or shutdown depending on timing
        expect(["phase-complete", "shutdown"]).toContain(event.data.reason);
        expect(event.data.phaseId).toBe("chronicler-test-phase");
        expect(typeof event.data.finalCost).toBe("number");
        expect(typeof event.data.llmCallCount).toBe("number");
      }

      console.log(`${colors.green}✓ All 3 chronicler.unloaded events verified${colors.reset}`);
    });

    it("should emit chronicler.output events", () => {
      const outputEvents = events.filter(
        (e) => e.type === "chronicler.output",
      ) as ChroniclerOutputEvent[];

      // Should have outputs from chroniclers
      expect(outputEvents.length).toBeGreaterThan(0);

      for (const event of outputEvents) {
        expect(event.data.phaseId).toBe("chronicler-test-phase");
        expect(["text-narrator", "entity-tracker", "conv-narrator"]).toContain(
          event.data.chroniclerId,
        );
        expect(typeof event.data.cost).toBe("number");
        expect(event.data.tokens).toBeDefined();
      }

      console.log(`${colors.green}✓ Chronicler output events verified${colors.reset}`);
    });
  });

  describe("State Transitions", () => {
    it("should transition to completing-chroniclers state", () => {
      const transitions = events.filter(
        (e) => e.type === "state.transition",
      ) as StateTransitionEvent[];

      const completingTransition = transitions.find((e) => {
        const data = e.data as StateTransitionEvent["data"];
        return (
          data.transitionType === "PhaseTransitioned" &&
          data.phaseId === "chronicler-test-phase" &&
          data.transition?.data?.to === "completing-chroniclers"
        );
      });

      expect(completingTransition).toBeDefined();

      if (completingTransition) {
        const transitionData = completingTransition.data.transition.data as Record<string, unknown>;
        const metadata = transitionData.metadata as Record<string, unknown> | undefined;
        expect(metadata?.chroniclerCount).toBe(3);
        expect(metadata?.chroniclerIds).toEqual(
          expect.arrayContaining(["text-narrator", "entity-tracker", "conv-narrator"]),
        );
      }

      console.log(`${colors.green}✓ completing-chroniclers transition verified${colors.reset}`);
    });

    it("should have ChroniclerStatesUpdated transitions", () => {
      const transitions = events.filter(
        (e) => e.type === "state.transition",
      ) as StateTransitionEvent[];

      const chrStateUpdates = transitions.filter((e) => {
        return e.data.transitionType === "ChroniclerStatesUpdated";
      });

      // Should have at least 2: initial load + final update before completion
      expect(chrStateUpdates.length).toBeGreaterThanOrEqual(2);

      for (const update of chrStateUpdates) {
        const transitionData = update.data.transition.data as Record<string, unknown>;
        expect(transitionData.chroniclerStates).toBeDefined();
        expect(Array.isArray(transitionData.chroniclerStates)).toBe(true);
        expect(transitionData.totalCost).toBeDefined();
      }

      console.log(
        `${colors.green}✓ ${chrStateUpdates.length} ChroniclerStatesUpdated transitions verified${colors.reset}`,
      );
    });

    it("should emit info events about completing chroniclers", () => {
      const infoEvents = events.filter((e) => e.type === "info") as InfoEvent[];

      const startEvent = infoEvents.find((e) => e.data.message.includes("Completing work for"));
      expect(startEvent).toBeDefined();
      if (startEvent) {
        expect(startEvent.data.message).toContain("3 chronicler");
      }

      const endEvent = infoEvents.find((e) => e.data.message.includes("Chronicler work completed"));
      expect(endEvent).toBeDefined();

      console.log(`${colors.green}✓ Chronicler completion info events verified${colors.reset}`);
    });
  });

  describe("State Persistence", () => {
    it("should persist ChroniclerState in state.json", () => {
      if (!executionPath) {
        throw new Error("No execution path");
      }

      const statePath = path.join(executionPath, ".tadpole/state.json");
      expect(fs.existsSync(statePath)).toBe(true);

      const stateContent = fs.readFileSync(statePath, "utf-8");
      const state: TadpoleState = JSON.parse(stateContent);

      expect(state.runs.length).toBeGreaterThan(0);
      const phase = state.runs[0].phases.find((p) => p.phaseId === "chronicler-test-phase");

      expect(phase).toBeDefined();
      if (!phase) throw new Error("Phase not found");

      expect(phase.status).toBe("completed");

      // Type narrow to CompletedPhase to access chroniclers
      if (phase.status === "completed") {
        expect(phase.chroniclers).toBeDefined();

        if (phase.chroniclers) {
          // Verify field is 'executed' not 'loaded'
          expect(phase.chroniclers.executed).toBeDefined();
          expect(phase.chroniclers.executed.length).toBe(3);

          // Verify each chronicler state
          const chrIds = phase.chroniclers.executed.map((c) => c.id).sort();
          expect(chrIds).toEqual(["conv-narrator", "entity-tracker", "text-narrator"]);

          for (const chrState of phase.chroniclers.executed) {
            expect(chrState.model).toBeDefined();
            expect(chrState.loadedAt).toBeDefined();
            // Status could be active or unloaded depending on when state was captured
            expect(["active", "unloaded"]).toContain(chrState.status);
            // Only check unloadReason if status is unloaded
            if (chrState.status === "unloaded") {
              expect(["phase-complete", "shutdown"]).toContain(chrState.unloadReason || "");
            }
            expect(typeof chrState.llmCallCount).toBe("number");
            expect(typeof chrState.totalTriggers).toBe("number");
            expect(typeof chrState.totalCost).toBe("number");
            expect(chrState.totalCost).toBeGreaterThanOrEqual(0);
          }

          // Verify total cost
          expect(typeof phase.chroniclers.totalCost).toBe("number");
          expect(phase.chroniclers.totalCost).toBeGreaterThanOrEqual(0);

          // Individual costs should sum to total
          const sum = phase.chroniclers.executed.reduce((acc, chr) => acc + chr.totalCost, 0);
          expect(Math.abs(sum - phase.chroniclers.totalCost)).toBeLessThan(0.000001);
        }
      }

      console.log(
        `${colors.green}✓ ChroniclerState persisted correctly in state.json${colors.reset}`,
      );
    });

    it("should track chronicler costs separately from phase costs", () => {
      if (!executionPath) {
        throw new Error("No execution path");
      }

      const statePath = path.join(executionPath, ".tadpole/state.json");
      const state: TadpoleState = JSON.parse(fs.readFileSync(statePath, "utf-8"));

      const phase = state.runs[0].phases.find((p) => p.phaseId === "chronicler-test-phase");
      expect(phase).toBeDefined();
      if (!phase) throw new Error("Phase not found");
      expect(phase.status).toBe("completed");

      if (phase.status === "completed" && phase.chroniclers) {
        const phaseCost = phase.finalCost;
        const chroniclerCost = phase.chroniclers.totalCost;

        expect(typeof phaseCost).toBe("number");
        expect(typeof chroniclerCost).toBe("number");
        expect(phaseCost).toBeGreaterThan(0);

        console.log(
          `${colors.green}✓ Costs separated: Phase=$${phaseCost.toFixed(6)}, Chroniclers=$${chroniclerCost.toFixed(6)}${colors.reset}`,
        );
      }
    });
  });

  describe("Output Files", () => {
    it("should create chronicler output directories", () => {
      if (!executionPath) {
        throw new Error("No execution path");
      }

      const outputsDir = path.join(executionPath, ".tadpole/chroniclers/outputs");
      expect(fs.existsSync(outputsDir)).toBe(true);

      // Should have directories for each chronicler
      const chroniclerDirs = fs.readdirSync(outputsDir);
      expect(chroniclerDirs).toContain("text-narrator");
      expect(chroniclerDirs).toContain("entity-tracker");
      expect(chroniclerDirs).toContain("conv-narrator");

      console.log(`${colors.green}✓ Output directories created for all chroniclers${colors.reset}`);
    });

    it("should create text output files with correct extension", () => {
      if (!executionPath) {
        throw new Error("No execution path");
      }

      const textNarratorDir = path.join(
        executionPath,
        ".tadpole/chroniclers/outputs/text-narrator",
      );
      const files = fs.readdirSync(textNarratorDir);

      // Should have .md file (text output)
      const mdFiles = files.filter((f) => f.endsWith(".md"));
      expect(mdFiles.length).toBeGreaterThan(0);

      // Verify file naming pattern
      expect(mdFiles[0]).toMatch(/^text-narrator-chronicler-test-phase-\d+\.md$/);

      console.log(`${colors.green}✓ Text output files created with .md extension${colors.reset}`);
    });

    it("should create structured output files with correct extension", () => {
      if (!executionPath) {
        throw new Error("No execution path");
      }

      const entityTrackerDir = path.join(
        executionPath,
        ".tadpole/chroniclers/outputs/entity-tracker",
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

      const chroniclersDir = path.join(executionPath, ".tadpole/chroniclers");

      if (fs.existsSync(chroniclersDir)) {
        const historyFiles = fs.readdirSync(chroniclersDir).filter((f) => f.endsWith(".json"));

        // Should have history file for conversational chronicler
        const convHistory = historyFiles.find((f) => f.includes("conv-narrator"));
        if (convHistory) {
          expect(convHistory).toMatch(/^conv-narrator-phase-chronicler-test-phase\.json$/);

          // Verify it's valid JSON
          const historyPath = path.join(chroniclersDir, convHistory);
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
        (e) => e.type === "chronicler.output" && e.data?.chroniclerId === "entity-tracker",
      ) as ChroniclerOutputEvent[];

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

// ============================================================================
// Test Suite 2: Zero Chroniclers
// ============================================================================

describe("Chronicler Integration: Zero Chroniclers", () => {
  const TEST_RUN_DIR = path.join(TEST_RESULTS_DIR, `chronicler-zero-${TEST_TIMESTAMP}`);
  const TEST_PORT = 7825; // Different port from first suite

  let serverProcess: ChildProcess | null = null;
  let client: TestWSClient | null = null;
  let executionPath: string | null = null;
  let events: ServerEvent[] = [];

  beforeAll(async () => {
    // Create test area
    const testDir = path.join(TEST_ROOT, "tests/test-area/chronicler-zero-test");
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
    fs.writeFileSync(path.join(promptsDir, "phase1.md"), 'Write "Done" to output.txt');

    // Create phase config WITHOUT chroniclers
    const phasesConfig = [
      {
        id: "zero-chr-phase",
        name: "Phase Without Chroniclers",
        promptFile: path.join(promptsDir, "phase1.md"),
        model: "sonnet",
        continuationMode: "fresh",
        trackedFiles: ["*.txt"],
        // NO chroniclers field
      },
    ];

    const phaseConfigPath = path.join(configDir, "phases.json");
    fs.writeFileSync(phaseConfigPath, JSON.stringify(phasesConfig, null, 2));

    // Ensure test run directory exists
    if (!fs.existsSync(TEST_RUN_DIR)) {
      fs.mkdirSync(TEST_RUN_DIR, { recursive: true });
    }

    // Start server
    const serverConfig: ServerConfig = {
      testRunDir: TEST_RUN_DIR,
      phasesConfig: phaseConfigPath,
      port: TEST_PORT,
      testMode: "chronicler-zero",
      dataSourceDir: dataFile,
      cwd: testDir,
      useDataFlag: true,
      startNew: true,
    };

    console.log(`${colors.blue}Starting server without chroniclers...${colors.reset}`);
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

    // Wait for phase to complete
    await client.waitForEvent("phase.completed", 60000);
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

  describe("State Transitions Without Chroniclers", () => {
    it("should skip completing-chroniclers state when chroniclerCount is 0", () => {
      if (!client) throw new Error("Client not initialized");

      const transitions = events.filter(
        (e) => e.type === "state.transition",
      ) as StateTransitionEvent[];

      // Should NOT have completing-chroniclers transition
      const completingTransition = transitions.find((e) => {
        const transitionData = e.data.transition.data as Record<string, unknown>;
        return (
          e.data.transitionType === "PhaseTransitioned" &&
          transitionData?.to === "completing-chroniclers"
        );
      });
      expect(completingTransition).toBeUndefined();

      // Should go directly running → completed
      const directTransition = transitions.find((e) => {
        const transitionData = e.data.transition.data as Record<string, unknown>;
        return (
          e.data.transitionType === "PhaseTransitioned" &&
          transitionData?.from === "running" &&
          transitionData?.to === "completed" &&
          e.data.phaseId === "zero-chr-phase"
        );
      });
      expect(directTransition).toBeDefined();

      console.log(`${colors.green}✓ Correctly skips completing-chroniclers state${colors.reset}`);
    });

    it("should not have chroniclers field in state.json when no chroniclers", () => {
      if (!executionPath) throw new Error("No execution path");

      const statePath = path.join(executionPath, ".tadpole/state.json");
      const state: TadpoleState = JSON.parse(fs.readFileSync(statePath, "utf-8"));

      const phase = state.runs[0].phases.find((p) => p.phaseId === "zero-chr-phase");
      expect(phase).toBeDefined();
      if (!phase) throw new Error("Phase not found");

      expect(phase.status).toBe("completed");

      // Type narrow to CompletedPhase
      if (phase.status === "completed") {
        expect(phase.chroniclers).toBeUndefined();
      }

      console.log(`${colors.green}✓ No chroniclers field when none configured${colors.reset}`);
    });

    it("should not emit chronicler lifecycle events", () => {
      const loadedEvents = events.filter((e) => e.type === "chronicler.loaded");
      const unloadedEvents = events.filter((e) => e.type === "chronicler.unloaded");
      const outputEvents = events.filter((e) => e.type === "chronicler.output");

      expect(loadedEvents.length).toBe(0);
      expect(unloadedEvents.length).toBe(0);
      expect(outputEvents.length).toBe(0);

      console.log(`${colors.green}✓ No chronicler events when none configured${colors.reset}`);
    });
  });
});
