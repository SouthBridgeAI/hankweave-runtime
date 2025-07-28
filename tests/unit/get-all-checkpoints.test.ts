import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { CheckpointGit } from "../../server/checkpoint-git.js";
import { StateManager } from "../../server/state-manager.js";
import { Logger } from "../../server/utils.js";

// Create mock functions
const mockIsInitialized = mock(() => false);
const mockGetAllCheckpoints = mock(
  async () =>
    [] as Array<{
      sha: string;
      message: string;
      timestamp: string;
      branch: string;
    }>,
);

// Mock CheckpointGit
const mockCheckpointGit = {
  isInitialized: mockIsInitialized,
  getAllCheckpoints: mockGetAllCheckpoints,
} as unknown as CheckpointGit;

describe("StateManager - getAllCheckpoints", () => {
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
    mockGetAllCheckpoints.mockRestore();
    mockIsInitialized.mockImplementation(() => false);
    mockGetAllCheckpoints.mockImplementation(async () => []);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns null when git is not initialized", async () => {
    mockIsInitialized.mockImplementation(() => false);

    const result = await stateManager.getAllCheckpoints();
    expect(result).toBeNull();
  });

  test("returns ordered checkpoints when git is available", async () => {
    mockIsInitialized.mockImplementation(() => true);

    const mockCheckpointData = [
      {
        sha: "abc123",
        message: "completed:phase-3 [run:2024-01-01-abc] Phase 3: Final",
        timestamp: "2024-01-01T03:00:00Z",
        branch: "run-2024-01-01-abc",
      },
      {
        sha: "def456",
        message: "workspace-setup:phase-2 [run:2024-01-01-abc] Phase 2: Middle",
        timestamp: "2024-01-01T02:00:00Z",
        branch: "run-2024-01-01-abc",
      },
      {
        sha: "ghi789",
        message: "completed:phase-1 [run:2024-01-01-abc] Phase 1: Start",
        timestamp: "2024-01-01T01:00:00Z",
        branch: "run-2024-01-01-abc",
      },
    ];

    mockGetAllCheckpoints.mockImplementation(async () => mockCheckpointData);

    const result = await stateManager.getAllCheckpoints();

    expect(result).not.toBeNull();
    expect(result).toHaveLength(3);

    // Should be ordered by timestamp (newest first)
    expect(result?.[0].sha).toBe("abc123");
    expect(result?.[1].sha).toBe("def456");
    expect(result?.[2].sha).toBe("ghi789");

    // Should have all properties
    expect(result?.[0]).toHaveProperty("message");
    expect(result?.[0]).toHaveProperty("timestamp");
    expect(result?.[0]).toHaveProperty("branch");
  });

  test("handles git errors gracefully", async () => {
    mockIsInitialized.mockImplementation(() => true);
    mockGetAllCheckpoints.mockImplementation(async () => {
      throw new Error("Git error");
    });

    const result = await stateManager.getAllCheckpoints();
    expect(result).toBeNull();
  });

  test("returns empty array when no checkpoints exist", async () => {
    mockIsInitialized.mockImplementation(() => true);
    mockGetAllCheckpoints.mockImplementation(async () => []);

    const result = await stateManager.getAllCheckpoints();
    expect(result).not.toBeNull();
    expect(result).toHaveLength(0);
  });
});
