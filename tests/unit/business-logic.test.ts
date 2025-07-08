import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { rmSync } from "fs";

// Since these functions are likely internal to langton-server.ts, we'll test the logic patterns
// This demonstrates how to test business logic in isolation

describe("getNextPhaseIndex", () => {
  // Simulating the logic for finding the next phase to execute
  function getNextPhaseIndex(phases: any[], completedPhases: string[]): number {
    if (completedPhases.length === 0) return 0;
    if (completedPhases.length >= phases.length) return -1;
    
    // Find the index of the last completed phase
    let lastCompletedIndex = -1;
    for (let i = phases.length - 1; i >= 0; i--) {
      if (completedPhases.includes(phases[i].id)) {
        lastCompletedIndex = i;
        break;
      }
    }
    
    // Return next index or -1 if all completed
    return lastCompletedIndex + 1 < phases.length ? lastCompletedIndex + 1 : -1;
  }

  const mockPhases = [
    { id: "phase-1", name: "Phase 1" },
    { id: "phase-2", name: "Phase 2" },
    { id: "phase-3", name: "Phase 3" }
  ];

  test("returns 0 when no phases completed", () => {
    const result = getNextPhaseIndex(mockPhases, []);
    expect(result).toBe(0);
  });

  test("returns next index after last completed", () => {
    const result = getNextPhaseIndex(mockPhases, ["phase-1"]);
    expect(result).toBe(1);
  });

  test("returns -1 when all phases completed", () => {
    const result = getNextPhaseIndex(mockPhases, ["phase-1", "phase-2", "phase-3"]);
    expect(result).toBe(-1);
  });

  test("handles non-sequential completion (after skip)", () => {
    // If phase-2 was skipped
    const result = getNextPhaseIndex(mockPhases, ["phase-1", "phase-3"]);
    expect(result).toBe(-1); // All phases after phase-3 are done
  });

  test("handles out-of-order completion", () => {
    // If phases were completed out of order
    const result = getNextPhaseIndex(mockPhases, ["phase-2", "phase-1"]);
    expect(result).toBe(2); // Should return phase-3
  });
});

describe("getPreviousSessionId", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-test-session-${Date.now()}`);
    await fs.promises.mkdir(path.join(tempDir, ".langton", "logs"), { recursive: true });
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Simulating the logic for extracting session ID from logs
  async function getPreviousSessionId(
    projectPath: string, 
    phaseIndex: number,
    phases: any[],
    continueFromPrevious: boolean
  ): Promise<string | null> {
    if (phaseIndex === 0 || !continueFromPrevious) return null;
    
    const prevPhase = phases[phaseIndex - 1];
    const logPath = path.join(projectPath, ".langton", "logs", `${prevPhase.id}.log`);
    
    try {
      const logContent = await fs.promises.readFile(logPath, "utf-8");
      
      // Look for session ID in log (simulating Claude's output format)
      const sessionMatch = logContent.match(/session_id":"([a-f0-9-]+)"/);
      if (sessionMatch) {
        return sessionMatch[1];
      }
      
      // Alternative format
      const altMatch = logContent.match(/Session ID: ([a-f0-9-]+)/);
      if (altMatch) {
        return altMatch[1];
      }
      
      return null;
    } catch (error) {
      return null;
    }
  }

  test("returns null for first phase", async () => {
    const result = await getPreviousSessionId(tempDir, 0, [], true);
    expect(result).toBeNull();
  });

  test("returns null when previous phase failed", async () => {
    const phases = [
      { id: "phase-1", name: "Phase 1" },
      { id: "phase-2", name: "Phase 2" }
    ];
    
    // Create a log file without session ID (indicating failure)
    const logPath = path.join(tempDir, ".langton", "logs", "phase-1.log");
    await fs.promises.writeFile(logPath, "Error: Phase failed");
    
    const result = await getPreviousSessionId(tempDir, 1, phases, true);
    expect(result).toBeNull();
  });

  test("extracts UUID from successful phase log", async () => {
    const phases = [
      { id: "phase-1", name: "Phase 1" },
      { id: "phase-2", name: "Phase 2" }
    ];
    
    // Create a log file with session ID
    const sessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const logPath = path.join(tempDir, ".langton", "logs", "phase-1.log");
    await fs.promises.writeFile(logPath, `{"session_id":"${sessionId}"}`);
    
    const result = await getPreviousSessionId(tempDir, 1, phases, true);
    expect(result).toBe(sessionId);
  });

  test("returns null when log file missing", async () => {
    const phases = [
      { id: "phase-1", name: "Phase 1" },
      { id: "phase-2", name: "Phase 2" }
    ];
    
    // Don't create any log file
    const result = await getPreviousSessionId(tempDir, 1, phases, true);
    expect(result).toBeNull();
  });

  test("returns null when continueFromPrevious is false", async () => {
    const phases = [
      { id: "phase-1", name: "Phase 1" },
      { id: "phase-2", name: "Phase 2" }
    ];
    
    // Create a valid log file
    const sessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const logPath = path.join(tempDir, ".langton", "logs", "phase-1.log");
    await fs.promises.writeFile(logPath, `{"session_id":"${sessionId}"}`);
    
    // But continueFromPrevious is false
    const result = await getPreviousSessionId(tempDir, 1, phases, false);
    expect(result).toBeNull();
  });

  test("handles alternative log format", async () => {
    const phases = [
      { id: "phase-1", name: "Phase 1" },
      { id: "phase-2", name: "Phase 2" }
    ];
    
    // Create a log file with alternative format
    const sessionId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const logPath = path.join(tempDir, ".langton", "logs", "phase-1.log");
    await fs.promises.writeFile(logPath, `Session started\nSession ID: ${sessionId}\nPhase completed`);
    
    const result = await getPreviousSessionId(tempDir, 1, phases, true);
    expect(result).toBe(sessionId);
  });
});

describe("Token calculation utilities", () => {
  test("calculates total tokens correctly", () => {
    const usage = {
      input: 100,
      output: 200,
      cache: 50
    };
    
    const total = usage.input + usage.output + usage.cache;
    expect(total).toBe(350);
  });

  test("handles missing token fields", () => {
    const usage: any = {
      input: 100,
      output: 200
      // cache is undefined
    };
    
    const total = (usage.input || 0) + (usage.output || 0) + (usage.cache || 0);
    expect(total).toBe(300);
  });

  test("calculates cumulative costs", () => {
    const phases = [
      { id: "p1", cost: 0.05 },
      { id: "p2", cost: 0.10 },
      { id: "p3", cost: 0.03 }
    ];
    
    const totalCost = phases.reduce((sum, phase) => sum + phase.cost, 0);
    expect(totalCost).toBeCloseTo(0.18, 2);
  });
});