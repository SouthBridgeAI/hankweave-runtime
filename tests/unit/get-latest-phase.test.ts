import { afterEach, beforeEach, describe, expect, test, mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { StateManager } from "../../server/state-manager.js";
import { PhaseId, RunId, SessionId } from "../../server/branded-types.js";
import type {
  LangtonState,
  PhaseExecution,
  Run,
} from "../../server/state-types.js";
import { Logger } from "../../server/utils.js";
import type { CheckpointGit } from "../../server/checkpoint-git.js";

// Create mock functions
const mockIsInitialized = mock(() => false);
const mockGetAllCheckpointShas = mock(async () => new Set<string>());

// Mock CheckpointGit
const mockCheckpointGit = {
  isInitialized: mockIsInitialized,
  getAllCheckpointShas: mockGetAllCheckpointShas,
} as unknown as CheckpointGit;

describe("StateManager - getLatestPhase", () => {
  let tempDir: string;
  let stateManager: StateManager;
  let logger: Logger;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(process.cwd(), "test-state-"));
    logger = new Logger(path.join(tempDir, "test.log"));
    stateManager = new StateManager(tempDir, logger);

    // Set the mock checkpoint git
    stateManager.setCheckpointGit(mockCheckpointGit);

    // Reset mocks
    mockIsInitialized.mockRestore();
    mockGetAllCheckpointShas.mockRestore();
    mockIsInitialized.mockImplementation(() => false);
    mockGetAllCheckpointShas.mockImplementation(async () => new Set<string>());
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a test state with runs and phases
   */
  function createTestState(runs: Run[]): LangtonState {
    return {
      runs,
      currentRunId: runs.find((r) => r.status === "running")?.runId || null,
    };
  }

  /**
   * Helper to create a completed phase
   */
  function createCompletedPhase(
    phaseId: string,
    endTime: string,
    checkpoint: string
  ): PhaseExecution {
    return {
      phaseId: PhaseId(phaseId),
      startTime: "2024-01-01T00:00:00Z",
      status: "completed",
      endTime,
      claudeSessionId: SessionId("session-123"),
      claudeLogPath: "log.jsonl",
      exitCode: 0,
      finalCost: 0.1,
      finalTokens: {
        inputTokens: 100,
        outputTokens: 200,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      resultMessageReceived: true,
      completionCheckpoint: checkpoint,
    };
  }

  /**
   * Helper to create a failed phase
   */
  function createFailedPhase(
    phaseId: string,
    endTime: string,
    checkpoint?: string
  ): PhaseExecution {
    return {
      phaseId: PhaseId(phaseId),
      startTime: "2024-01-01T00:00:00Z",
      status: "failed",
      endTime,
      failedDuring: "running",
      exitCode: 1,
      failureReason: {
        type: "unknown",
        retriable: true,
        message: "Test failure",
      },
      partialCost: 0.05,
      partialTokens: {
        inputTokens: 50,
        outputTokens: 100,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      errorCheckpoint: checkpoint,
    };
  }

  /**
   * Helper to create a running phase
   */
  function createRunningPhase(phaseId: string): PhaseExecution {
    return {
      phaseId: PhaseId(phaseId),
      startTime: "2024-01-01T00:00:00Z",
      status: "running",
      claudePid: 12345,
      claudeSessionId: SessionId("session-456"),
      claudeLogPath: "log.jsonl",
      currentCost: 0.02,
      currentTokens: {
        inputTokens: 20,
        outputTokens: 40,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      assistantMessageCount: 5,
    };
  }

  test("returns null when no phases exist", async () => {
    const state = createTestState([]);
    await fs.promises.writeFile(
      path.join(tempDir, "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const result = await stateManager.getLatestPhase();
    expect(result).toBeNull();
  });

  test("returns running phase when one exists", async () => {
    const runningPhase = createRunningPhase("phase-2");
    const state = createTestState([
      {
        runId: RunId("run-1"),
        runFolder: "/test/run-1",
        gitBranch: "run-1",
        startingConditions: { type: "fresh" },
        phases: [
          createCompletedPhase("phase-1", "2024-01-01T01:00:00Z", "sha-1"),
          runningPhase,
        ],
        status: "running",
        startTime: "2024-01-01T00:00:00Z",
        serverPid: 12345,
      },
    ]);

    await fs.promises.writeFile(
      path.join(tempDir, "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const result = await stateManager.getLatestPhase();
    expect(result).not.toBeNull();
    expect(result!.phase.phaseId).toBe(PhaseId("phase-2"));
    expect(result!.status).toBe("running");
    expect(result!.runId).toBe(RunId("run-1"));
    expect(result!.nextPhaseId).toBeNull(); // Running phase, can't start next
    expect(result!.continueInCurrentRun).toBe(true);
  });

  test("returns latest terminal phase by timestamp when no git available", async () => {
    // Mock git as not initialized
    mockIsInitialized.mockImplementation(() => false);

    const state = createTestState([
      {
        runId: RunId("run-1"),
        runFolder: "/test/run-1",
        gitBranch: "run-1",
        startingConditions: { type: "fresh" },
        phases: [
          createCompletedPhase("phase-1", "2024-01-01T01:00:00Z", "sha-1"),
          createCompletedPhase("phase-2", "2024-01-01T02:00:00Z", "sha-2"),
        ],
        status: "completed",
        startTime: "2024-01-01T00:00:00Z",
        endTime: "2024-01-01T02:30:00Z",
        serverPid: 12345,
      },
      {
        runId: RunId("run-2"),
        runFolder: "/test/run-2",
        gitBranch: "run-2",
        startingConditions: { type: "fresh" },
        phases: [
          createCompletedPhase("phase-1", "2024-01-01T03:00:00Z", "sha-3"), // Latest
        ],
        status: "completed",
        startTime: "2024-01-01T02:45:00Z",
        endTime: "2024-01-01T03:30:00Z",
        serverPid: 12346,
      },
    ]);

    await fs.promises.writeFile(
      path.join(tempDir, "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const result = await stateManager.getLatestPhase();
    expect(result).not.toBeNull();
    expect(result!.phase.phaseId).toBe(PhaseId("phase-1"));
    expect(result!.status).toBe("completed");
    expect(result!.runId).toBe(RunId("run-2"));
    // Note: Without phase configs, we can't determine next phase
  });

  test("returns latest phase with valid checkpoint when git is available", async () => {
    // Mock git as initialized with specific checkpoints
    mockIsInitialized.mockImplementation(() => true);
    mockGetAllCheckpointShas.mockImplementation(
      async () => new Set(["sha-1", "sha-3"]) // sha-2 is missing (rolled back)
    );

    const state = createTestState([
      {
        runId: RunId("run-1"),
        runFolder: "/test/run-1",
        gitBranch: "run-1",
        startingConditions: { type: "fresh" },
        phases: [
          createCompletedPhase("phase-1", "2024-01-01T01:00:00Z", "sha-1"),
          createCompletedPhase("phase-2", "2024-01-01T02:00:00Z", "sha-2"), // Rolled back
          createCompletedPhase("phase-3", "2024-01-01T03:00:00Z", "sha-3"), // Latest valid
        ],
        status: "completed",
        startTime: "2024-01-01T00:00:00Z",
        endTime: "2024-01-01T03:30:00Z",
        serverPid: 12345,
      },
    ]);

    await fs.promises.writeFile(
      path.join(tempDir, "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const result = await stateManager.getLatestPhase();
    expect(result).not.toBeNull();
    expect(result!.phase.phaseId).toBe(PhaseId("phase-3"));
    expect(result!.status).toBe("completed");
    // Note: Without phase configs, we can't determine next phase
  });

  test("handles phases with multiple checkpoint types", async () => {
    mockIsInitialized.mockImplementation(() => true);
    mockGetAllCheckpointShas.mockImplementation(
      async () => new Set(["sha-workspace", "sha-error"])
    );

    const phase: PhaseExecution = {
      phaseId: PhaseId("phase-1"),
      startTime: "2024-01-01T00:00:00Z",
      status: "failed",
      endTime: "2024-01-01T01:00:00Z",
      failedDuring: "running",
      exitCode: 1,
      failureReason: {
        type: "unknown",
        retriable: true,
        message: "Test",
      },
      partialCost: 0,
      partialTokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      workspaceSetupCheckpoint: "sha-workspace",
      errorCheckpoint: "sha-error",
    };

    const state = createTestState([
      {
        runId: RunId("run-1"),
        runFolder: "/test/run-1",
        gitBranch: "run-1",
        startingConditions: { type: "fresh" },
        phases: [phase],
        status: "failed",
        startTime: "2024-01-01T00:00:00Z",
        endTime: "2024-01-01T01:00:00Z",
        serverPid: 12345,
      },
    ]);

    await fs.promises.writeFile(
      path.join(tempDir, "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const result = await stateManager.getLatestPhase();
    expect(result).not.toBeNull();
    expect(result!.phase.phaseId).toBe(PhaseId("phase-1"));
    expect(result!.runId).toBe(RunId("run-1"));
    expect(result!.status).toBe("failed");
    // Note: Without phase configs, we can't determine next phase
  });

  test("returns null when no phases have valid checkpoints", async () => {
    mockIsInitialized.mockImplementation(() => true);
    mockGetAllCheckpointShas.mockImplementation(
      async () => new Set() // Empty - all checkpoints have been rolled back
    );

    const state = createTestState([
      {
        runId: RunId("run-1"),
        runFolder: "/test/run-1",
        gitBranch: "run-1",
        startingConditions: { type: "fresh" },
        phases: [
          createCompletedPhase("phase-1", "2024-01-01T01:00:00Z", "sha-1"),
          createCompletedPhase("phase-2", "2024-01-01T02:00:00Z", "sha-2"),
        ],
        status: "completed",
        startTime: "2024-01-01T00:00:00Z",
        endTime: "2024-01-01T02:30:00Z",
        serverPid: 12345,
      },
    ]);

    await fs.promises.writeFile(
      path.join(tempDir, "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const result = await stateManager.getLatestPhase();
    expect(result).toBeNull();
  });

  test("handles git errors gracefully", async () => {
    mockIsInitialized.mockImplementation(() => true);
    mockGetAllCheckpointShas.mockImplementation(async () => {
      throw new Error("Git error");
    });

    const state = createTestState([
      {
        runId: RunId("run-1"),
        runFolder: "/test/run-1",
        gitBranch: "run-1",
        startingConditions: { type: "fresh" },
        phases: [
          createCompletedPhase("phase-1", "2024-01-01T01:00:00Z", "sha-1"),
        ],
        status: "completed",
        startTime: "2024-01-01T00:00:00Z",
        endTime: "2024-01-01T01:30:00Z",
        serverPid: 12345,
      },
    ]);

    await fs.promises.writeFile(
      path.join(tempDir, "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    // Should fall back to timestamp-based selection
    const result = await stateManager.getLatestPhase();
    expect(result).not.toBeNull();
    expect(result!.phase.phaseId).toBe(PhaseId("phase-1"));
    // Note: Without phase configs, we can't determine next phase
  });

  test("sorts phases by timestamp correctly", async () => {
    mockIsInitialized.mockImplementation(() => false);

    const state = createTestState([
      {
        runId: RunId("run-1"),
        runFolder: "/test/run-1",
        gitBranch: "run-1",
        startingConditions: { type: "fresh" },
        phases: [
          createCompletedPhase("phase-1", "2024-01-01T03:00:00Z", "sha-3"), // Latest
          createCompletedPhase("phase-2", "2024-01-01T01:00:00Z", "sha-1"), // Oldest
        ],
        status: "completed",
        startTime: "2024-01-01T00:00:00Z",
        endTime: "2024-01-01T03:30:00Z",
        serverPid: 12345,
      },
      {
        runId: RunId("run-2"),
        runFolder: "/test/run-2",
        gitBranch: "run-2",
        startingConditions: { type: "fresh" },
        phases: [
          createCompletedPhase("phase-1", "2024-01-01T02:00:00Z", "sha-2"), // Middle
        ],
        status: "completed",
        startTime: "2024-01-01T01:45:00Z",
        endTime: "2024-01-01T02:30:00Z",
        serverPid: 12346,
      },
    ]);

    await fs.promises.writeFile(
      path.join(tempDir, "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const result = await stateManager.getLatestPhase();
    expect(result).not.toBeNull();
    expect(result!.phase.phaseId).toBe(PhaseId("phase-1"));
    expect(result!.runId).toBe(RunId("run-1"));
    expect((result!.phase as any).endTime).toBe("2024-01-01T03:00:00Z");
  });

  test("handles tiebreaker for same timestamp", async () => {
    mockIsInitialized.mockImplementation(() => false);

    const sameTime = "2024-01-01T01:00:00Z";
    const state = createTestState([
      {
        runId: RunId("run-1"),
        runFolder: "/test/run-1",
        gitBranch: "run-1",
        startingConditions: { type: "fresh" },
        phases: [
          createCompletedPhase("phase-a", sameTime, "sha-1"),
          createCompletedPhase("phase-b", sameTime, "sha-2"), // Should win (later alphabetically)
        ],
        status: "completed",
        startTime: "2024-01-01T00:00:00Z",
        endTime: "2024-01-01T01:30:00Z",
        serverPid: 12345,
      },
    ]);

    await fs.promises.writeFile(
      path.join(tempDir, "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const result = await stateManager.getLatestPhase();
    expect(result).not.toBeNull();
    expect(result!.phase.phaseId).toBe(PhaseId("phase-b"));
  });

  test("prioritizes running phase over any terminal phase", async () => {
    mockIsInitialized.mockImplementation(() => true);
    mockGetAllCheckpointShas.mockImplementation(
      async () => new Set(["sha-1", "sha-2"])
    );

    const state = createTestState([
      {
        runId: RunId("run-1"),
        runFolder: "/test/run-1",
        gitBranch: "run-1",
        startingConditions: { type: "fresh" },
        phases: [
          createCompletedPhase("phase-1", "2024-01-01T10:00:00Z", "sha-1"), // Much later
        ],
        status: "completed",
        startTime: "2024-01-01T09:00:00Z",
        endTime: "2024-01-01T10:30:00Z",
        serverPid: 12345,
      },
      {
        runId: RunId("run-2"),
        runFolder: "/test/run-2",
        gitBranch: "run-2",
        startingConditions: { type: "fresh" },
        phases: [
          createCompletedPhase("phase-1", "2024-01-01T01:00:00Z", "sha-2"),
          createRunningPhase("phase-2"), // Should be returned despite earlier time
        ],
        status: "running",
        startTime: "2024-01-01T00:30:00Z",
        serverPid: 12346,
      },
    ]);

    await fs.promises.writeFile(
      path.join(tempDir, "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const result = await stateManager.getLatestPhase();
    expect(result).not.toBeNull();
    expect(result!.phase.phaseId).toBe(PhaseId("phase-2"));
    expect(result!.status).toBe("running");
    expect(result!.runId).toBe(RunId("run-2"));
    expect(result!.nextPhaseId).toBeNull(); // Running phase, can't start next
    expect(result!.continueInCurrentRun).toBe(true);
  });

  test("handles skipped phases with checkpoints", async () => {
    mockIsInitialized.mockImplementation(() => true);
    mockGetAllCheckpointShas.mockImplementation(
      async () => new Set(["sha-skip"])
    );

    const skippedPhase: PhaseExecution = {
      phaseId: PhaseId("phase-1"),
      startTime: "2024-01-01T00:00:00Z",
      status: "skipped",
      endTime: "2024-01-01T00:30:00Z",
      skippedDuring: "running",
      partialCost: 0,
      partialTokens: {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
      skipCheckpoint: "sha-skip",
    };

    const state = createTestState([
      {
        runId: RunId("run-1"),
        runFolder: "/test/run-1",
        gitBranch: "run-1",
        startingConditions: { type: "fresh" },
        phases: [skippedPhase],
        status: "completed",
        startTime: "2024-01-01T00:00:00Z",
        endTime: "2024-01-01T00:30:00Z",
        serverPid: 12345,
      },
    ]);

    await fs.promises.writeFile(
      path.join(tempDir, "state.json"),
      JSON.stringify(state)
    );
    await stateManager.initialize();

    const result = await stateManager.getLatestPhase();
    expect(result).not.toBeNull();
    expect(result!.phase.phaseId).toBe(PhaseId("phase-1"));
    expect(result!.runId).toBe(RunId("run-1"));
    expect(result!.status).toBe("skipped");
    // Note: Without phase configs, we can't determine next phase
  });
});
