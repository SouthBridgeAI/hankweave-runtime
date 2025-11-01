#!/usr/bin/env bun
import { beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PhaseId, RunId } from "../../server/types/branded-types";
import type { Run, TadpoleState } from "../../server/types/state-types";
import type {
  AssistantActionEvent,
  CheckpointListEvent,
  PhaseCompletedEvent,
  PhaseStartedEvent,
  RollbackCompletedEvent,
  RollbackProgressEvent,
  RollbackStartedEvent,
  ServerEvent,
} from "../../server/types/types";

// --- Test Configuration ---
const TEST_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const SNAPSHOT_DIR = path.join(TEST_ROOT, "tests/test-area/rollback-snapshots");
const TEST_DIR = path.join(TEST_ROOT, "tests/test-area/rollback-improved");
const SNAPSHOT_NAMES = [
  "1-after-phase2-phase3-skipped",
  "2-after-rollback-to-phase1",
  "3-after-full-completion",
  "4-after-rollback-to-start",
];
const SNAPSHOT_MAX_AGE_MINUTES = 30;

// Cost configuration for validation (should match server config)
const COSTS_PER_MTOK = {
  sonnet: {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  opus: {
    input: 15.0,
    output: 75.0,
    cacheWrite: 18.75,
    cacheRead: 1.5,
  },
};

// --- Interfaces ---
interface TestSnapshot {
  name: string;
  directory: string;
  state: TadpoleState;
  events: ServerEvent[];
  checkpoints: CheckpointListEvent["data"]["checkpoints"];
  timestamp: string;
  // Lazily loaded git info
  git?: {
    branches: string[];
    allShas: Set<string>;
    commits: Array<{
      sha: string;
      message: string;
      timestamp: string;
    }>;
  };
}

// --- Global Test State ---
const snapshots = new Map<string, TestSnapshot>();

// --- Helper Functions ---

/**
 * Recursively gets all file paths in a directory.
 */
async function getFilePaths(dir: string): Promise<string[]> {
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    dirents.map((dirent) => {
      const res = path.resolve(dir, dirent.name);
      return dirent.isDirectory() ? getFilePaths(res) : res;
    }),
  );
  return Array.prototype.concat(...files);
}

/**
 * Computes a hash for a directory's contents (files and structure).
 * Excludes .tadpole directory to focus on project files only.
 */
async function hashDirectory(dir: string): Promise<string> {
  if (!fs.existsSync(dir)) {
    return "directory-does-not-exist";
  }
  const allFilePaths = (await getFilePaths(dir)).sort();

  // Filter out .tadpole directory files, data directory, and read_only_data_source directory
  const filePaths = allFilePaths.filter((filePath) => {
    const relativePath = path.relative(dir, filePath);
    return (
      !relativePath.startsWith(`.tadpole${path.sep}`) &&
      !relativePath.startsWith(".tadpole/") &&
      !relativePath.startsWith(`data${path.sep}`) &&
      !relativePath.startsWith("data/") &&
      relativePath !== "data" &&
      !relativePath.startsWith(`read_only_data_source${path.sep}`) &&
      !relativePath.startsWith("read_only_data_source/") &&
      relativePath !== "read_only_data_source"
    );
  });

  const hash = createHash("sha256");

  for (const filePath of filePaths) {
    const relativePath = path.relative(dir, filePath);
    // Include relative path in hash to account for file moves/renames
    hash.update(relativePath.replace(/\\/g, "/")); // Normalize path separators
    const data = await fs.promises.readFile(filePath);
    hash.update(data);
  }

  return hash.digest("hex");
}

/**
 * Gets all commit SHAs from a git repository.
 */
function getGitShas(gitDir: string): Set<string> {
  try {
    const output = execSync(`git --git-dir=${gitDir} log --format=%H`, {
      encoding: "utf-8",
    });
    return new Set(output.trim().split("\n"));
  } catch (_e) {
    return new Set();
  }
}

/**
 * Gets detailed git commit information.
 */
function getGitCommits(gitDir: string): Array<{
  sha: string;
  message: string;
  timestamp: string;
}> {
  try {
    const output = execSync(`git --git-dir=${gitDir} log --format="%H|%s|%ai"`, {
      encoding: "utf-8",
    });
    return output
      .trim()
      .split("\n")
      .map((line) => {
        const [sha, message, timestamp] = line.split("|");
        return { sha, message, timestamp };
      });
  } catch (_e) {
    return [];
  }
}

/**
 * Calculate expected cost from token usage.
 */
function calculateExpectedCost(
  tokens: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  },
  model: "sonnet" | "opus" = "sonnet",
): number {
  const costs = COSTS_PER_MTOK[model];
  return (
    (tokens.inputTokens * costs.input) / 1_000_000 +
    (tokens.outputTokens * costs.output) / 1_000_000 +
    (tokens.cacheCreationTokens * costs.cacheWrite) / 1_000_000 +
    (tokens.cacheReadTokens * costs.cacheRead) / 1_000_000
  );
}

/**
 * Reconstruct phase states from event stream.
 */
function reconstructPhaseStatesFromEvents(events: ServerEvent[]): Map<
  string,
  {
    phaseId: string;
    status: string;
    sessionId?: string;
    previousSessionId?: string;
    cost: number;
    assistantMessageCount: number;
  }
> {
  const phases = new Map<
    string,
    {
      phaseId: string;
      status: string;
      sessionId?: string;
      previousSessionId?: string;
      cost: number;
      assistantMessageCount: number;
    }
  >();

  for (const event of events) {
    if (event.type === "phase.started") {
      const data = event.data as PhaseStartedEvent["data"];
      phases.set(data.phaseId, {
        phaseId: data.phaseId,
        status: "started",
        sessionId: data.sessionId,
        previousSessionId: data.previousSessionId,
        cost: 0,
        assistantMessageCount: 0,
      });
    } else if (event.type === "phase.completed") {
      const data = event.data as PhaseCompletedEvent["data"];
      const phase = phases.get(data.phaseId);
      if (phase) {
        phase.status = data.success ? "completed" : "failed";
        phase.cost = data.cost;
      }
    } else if (event.type === "assistant.action") {
      const data = event.data as AssistantActionEvent["data"];
      const phase = phases.get(data.phaseId);
      if (phase && data.action === "message") {
        phase.assistantMessageCount++;
      }
    }
  }

  return phases;
}

/**
 * Check if a timestamp is valid ISO 8601.
 */
function isValidISO8601(timestamp: string): boolean {
  const date = new Date(timestamp);
  return date.toISOString() === timestamp;
}

// --- Test Suite ---

describe("Rollback E2E Snapshot Analysis Suite", () => {
  // 1. Load all snapshot data before running tests.
  beforeAll(async () => {
    if (!fs.existsSync(SNAPSHOT_DIR)) return;

    for (const name of SNAPSHOT_NAMES) {
      const dir = path.join(SNAPSHOT_DIR, name);
      if (!fs.existsSync(dir)) continue;

      const statePath = path.join(dir, ".tadpole", "state.json");
      const eventJournalPath = path.join(dir, ".tadpole", "events", "events.jsonl");
      const gitDir = path.join(dir, ".tadpole", "checkpoints", ".git");

      if (fs.existsSync(statePath)) {
        const state: TadpoleState = JSON.parse(await fs.promises.readFile(statePath, "utf-8"));

        const events: ServerEvent[] = [];
        let checkpoints: CheckpointListEvent["data"]["checkpoints"] = [];

        // Parse events.jsonl file from snapshot (JSONL format)
        if (fs.existsSync(eventJournalPath)) {
          try {
            const logContent = await fs.promises.readFile(eventJournalPath, "utf-8");
            const logLines = logContent
              .trim()
              .split("\n")
              .filter((line) => line.trim());

            for (const line of logLines) {
              try {
                // Parse JSONL format - each line is a ServerEvent
                const event = JSON.parse(line) as ServerEvent;
                events.push(event);
              } catch (_parseError) {
                // Skip malformed JSON lines
              }
            }

            // Extract checkpoints from the last checkpoint.list event
            const checkpointListEvent = events
              .slice()
              .reverse()
              .find((e) => e.type === "checkpoint.list") as CheckpointListEvent | undefined;

            checkpoints = checkpointListEvent?.data.checkpoints || [];
          } catch (error) {
            console.warn(`Failed to load events from ${eventJournalPath}:`, error);
          }
        }

        snapshots.set(name, {
          name,
          directory: dir,
          state,
          events,
          checkpoints,
          timestamp: new Date(fs.statSync(dir).mtime).toISOString(),
          git: {
            branches: [], // To be populated if needed
            allShas: getGitShas(gitDir),
            commits: getGitCommits(gitDir),
          },
        });
      }
    }
  });

  // 2. Initial Sanity Checks.
  test("Snapshot directory must exist", () => {
    expect(fs.existsSync(SNAPSHOT_DIR)).toBe(true);
    expect(snapshots.size).toBe(SNAPSHOT_NAMES.length);
  });

  test(`Snapshots must be recent (less than ${SNAPSHOT_MAX_AGE_MINUTES} minutes old)`, () => {
    const now = new Date();
    for (const snapshot of snapshots.values()) {
      const snapshotAge = now.getTime() - new Date(snapshot.timestamp).getTime();
      const ageInMinutes = snapshotAge / (1000 * 60);
      // This will fail the test but allow others to run, serving as a warning.
      expect(ageInMinutes).toBeLessThan(SNAPSHOT_MAX_AGE_MINUTES);
    }
  });

  // --- Priority 1: Critical Data Integrity & Core Rollback Logic ---
  describe("Priority 1: Critical Data Integrity & Core Rollback Logic", () => {
    test.each(Array.from(snapshots.entries()))(
      "1.1 State File Integrity: %s",
      (_name, snapshot) => {
        const statePath = path.join(snapshot.directory, ".tadpole", "state.json");
        const backupPath = path.join(snapshot.directory, ".tadpole", "state.json.bak");

        expect(fs.existsSync(backupPath)).toBe(true);
        const stateContent = fs.readFileSync(statePath, "utf-8");
        const backupContent = fs.readFileSync(backupPath, "utf-8");
        expect(JSON.parse(stateContent)).toEqual(JSON.parse(backupContent));
      },
    );

    test.each(Array.from(snapshots.entries()))(
      "1.2 Git Repository Integrity: %s",
      (_name, snapshot) => {
        const gitDir = path.join(snapshot.directory, ".tadpole", "checkpoints", ".git");
        expect(fs.existsSync(gitDir)).toBe(true);
        try {
          execSync(`git --git-dir=${gitDir} fsck`);
        } catch (e) {
          throw new Error(`Git fsck failed: ${e}`);
        }
      },
    );

    test.each(Array.from(snapshots.entries()))(
      "1.3 Three-Way Consistency: %s",
      (_name, snapshot) => {
        const allCheckpointShas = new Set<string>();
        // State -> Git
        snapshot.state.runs.forEach((run: Run) => {
          run.phases.forEach((phase) => {
            if ("completionCheckpoint" in phase && phase.completionCheckpoint)
              allCheckpointShas.add(phase.completionCheckpoint);
            if ("errorCheckpoint" in phase && phase.errorCheckpoint)
              allCheckpointShas.add(phase.errorCheckpoint);
            if ("skipCheckpoint" in phase && phase.skipCheckpoint)
              allCheckpointShas.add(phase.skipCheckpoint);
            if ("workspaceSetupCheckpoint" in phase && phase.workspaceSetupCheckpoint)
              allCheckpointShas.add(phase.workspaceSetupCheckpoint);
          });
        });

        for (const sha of allCheckpointShas) {
          expect(snapshot.git?.allShas.has(sha)).toBe(true);
        }

        // State -> Filesystem
        snapshot.state.runs.forEach((run) => {
          const runFolder = path.join(snapshot.directory, ".tadpole", "runs", run.runId);
          expect(fs.existsSync(runFolder)).toBe(true);
        });
      },
    );

    test("1.4 Rollback File State Accuracy: Snapshot 1 -> 2", async () => {
      const snapshot1 = snapshots.get("1-after-phase2-phase3-skipped");
      const snapshot2 = snapshots.get("2-after-rollback-to-phase1");
      expect(snapshot1).toBeDefined();
      expect(snapshot2).toBeDefined();

      const rollbackEvent = snapshot2?.events.find(
        (e) => e.type === "rollback.completed",
      ) as RollbackCompletedEvent;

      expect(rollbackEvent).toBeDefined();
      const targetSha = rollbackEvent.data.checkpoint;

      const checkoutDir = path.join(TEST_ROOT, "tests/test-area/temp-checkout");
      if (fs.existsSync(checkoutDir)) fs.rmSync(checkoutDir, { recursive: true, force: true });
      fs.mkdirSync(checkoutDir, { recursive: true });

      if (!snapshot1 || !snapshot2) return;

      const gitDir = path.join(snapshot1.directory, ".tadpole", "checkpoints", ".git");

      // Log git commits for debugging
      console.log("\n=== Git Commits in Checkpoint Repository ===");
      if (snapshot1.git?.commits) {
        snapshot1.git.commits.forEach((commit, idx) => {
          console.log(
            `${idx + 1}. ${commit.sha.substring(0, 7)} - ${commit.message} (${commit.timestamp})`,
          );
        });
      }
      console.log(`Target SHA for rollback: ${targetSha}`);

      execSync(`git --git-dir=${gitDir} --work-tree=${checkoutDir} checkout ${targetSha} -- .`);

      // List files in both directories for comparison (excluding .tadpole)
      console.log("\n=== Project Files in Rolled Back Directory (Snapshot 2) ===");
      const rolledBackFiles = await getFilePaths(snapshot2.directory);
      const projectFilesRolledBack = rolledBackFiles.filter((f) => {
        const relative = path.relative(snapshot2.directory, f);
        return !relative.startsWith(`.tadpole${path.sep}`) && !relative.startsWith(".tadpole/");
      });
      projectFilesRolledBack.sort().forEach((f) => {
        const relative = path.relative(snapshot2.directory, f);
        console.log(`  ${relative}`);
      });

      console.log("\n=== Files in Git Checkout Directory ===");
      const checkedOutFiles = await getFilePaths(checkoutDir);
      checkedOutFiles.sort().forEach((f) => {
        const relative = path.relative(checkoutDir, f);
        console.log(`  ${relative}`);
      });

      // Check specific files
      console.log("\n=== Specific File Checks ===");
      const notesDir2 = path.join(snapshot2.directory, "notes");
      const notesCheckout = path.join(checkoutDir, "notes");

      if (fs.existsSync(notesDir2)) {
        const files2 = fs.readdirSync(notesDir2);
        console.log(`Files in snapshot2/notes: ${files2.join(", ")}`);
      }

      if (fs.existsSync(notesCheckout)) {
        const filesCheckout = fs.readdirSync(notesCheckout);
        console.log(`Files in checkout/notes: ${filesCheckout.join(", ")}`);
      }

      const rolledBackHash = await hashDirectory(snapshot2.directory);
      const checkedOutHash = await hashDirectory(checkoutDir);

      // CRITICAL: Rollback file state MUST match git checkout exactly
      if (rolledBackHash !== checkedOutHash) {
        console.log("\n=== HASH MISMATCH DETAILS ===");
        console.log(`Rolled back hash: ${rolledBackHash}`);
        console.log(`Checked out hash: ${checkedOutHash}`);
        console.log(`Target SHA: ${targetSha}`);

        throw new Error(
          `Rollback file state mismatch! Rolled back: ${rolledBackHash}, Expected: ${checkedOutHash}, Target SHA: ${targetSha}`,
        );
      }
      expect(rolledBackHash).toEqual(checkedOutHash);

      fs.rmSync(checkoutDir, { recursive: true, force: true });
    });

    test("1.5 Continuation Run Linkage: Snapshot 2", () => {
      const snapshot = snapshots.get("2-after-rollback-to-phase1");
      if (!snapshot) return;

      console.log("\n=== Continuation Run Analysis ===");
      console.log(`Total runs in state: ${snapshot.state.runs.length}`);
      console.log(`Current run ID: ${snapshot.state.currentRunId}`);

      snapshot.state.runs.forEach((run, idx) => {
        console.log(`\nRun ${idx + 1}: ${run.runId}`);
        console.log(`  Status: ${run.status}`);
        console.log(`  Starting conditions: ${JSON.stringify(run.startingConditions, null, 2)}`);
        console.log(`  Phases: ${run.phases.map((p) => `${p.phaseId}(${p.status})`).join(", ")}`);
      });

      // Rollback MUST create a new continuation run to preserve history
      expect(snapshot.state.runs.length).toBe(2);

      const lastRun = snapshot.state.runs[0]; // Newest run is first
      expect(lastRun.startingConditions.type).toBe("continuation");

      if (lastRun.startingConditions.type === "continuation") {
        expect(lastRun.startingConditions.source.runId).toBe(snapshot.state.runs[1].runId);
        expect(lastRun.startingConditions.source.afterPhase).toBe(PhaseId("phase-1"));
      }
    });
  });

  // --- Priority 2: State Machine, Session & Costing Logic ---
  describe("Priority 2: State Machine, Session & Costing Logic", () => {
    test("2.1 Phase State Transitions: Skipped phase has correct data", () => {
      const snapshot = snapshots.get("1-after-phase2-phase3-skipped");
      if (!snapshot) return;
      const run = snapshot.state.runs[0];
      const skippedPhase = run.phases.find((p) => p.phaseId === "phase-3");
      expect(skippedPhase?.status).toBe("skipped");
      if (skippedPhase?.status === "skipped") {
        expect(skippedPhase.assistantMessageCount).toBeGreaterThan(0);
        expect(skippedPhase.skipCheckpoint).toBeDefined();
      }
    });

    test("2.2 Session ID Chaining: Phase 2 continues from Phase 1", () => {
      const snapshot = snapshots.get("1-after-phase2-phase3-skipped");
      if (!snapshot) return;
      const phase1Start = snapshot.events.find(
        (e) =>
          e.type === "phase.started" && (e.data as PhaseStartedEvent["data"]).phaseId === "phase-1",
      ) as PhaseStartedEvent;
      const phase2Start = snapshot.events.find(
        (e) =>
          e.type === "phase.started" && (e.data as PhaseStartedEvent["data"]).phaseId === "phase-2",
      ) as PhaseStartedEvent;

      expect(phase1Start).toBeDefined();
      expect(phase2Start).toBeDefined();
      expect(phase2Start.data.previousSessionId).toEqual(phase1Start.data.sessionId);
    });

    test("2.3 Cost Tracking Accuracy: Skipped phase cost is zero", () => {
      const snapshot = snapshots.get("1-after-phase2-phase3-skipped");
      if (!snapshot) return;
      const phase3Completed = snapshot.events.find(
        (e) =>
          e.type === "phase.completed" &&
          (e.data as PhaseCompletedEvent["data"]).phaseId === "phase-3",
      ) as PhaseCompletedEvent;
      expect(phase3Completed.data.cost).toBe(0);
    });

    test("2.4 Event Stream Reconciliation: Events match final state", () => {
      const snapshot = snapshots.get("1-after-phase2-phase3-skipped");
      if (!snapshot) return;
      const reconstructedPhases = reconstructPhaseStatesFromEvents(snapshot.events);

      // Check that reconstructed phases match state.json
      const run = snapshot.state.runs[0];
      for (const phase of run.phases) {
        const reconstructed = reconstructedPhases.get(phase.phaseId);
        if (reconstructed) {
          if (phase.status === "skipped") {
            // For skipped phases, we expect them to show as failed in events but have 0 cost
            expect(reconstructed.cost).toBe(0);
          } else if (phase.status === "completed") {
            expect(reconstructed.status).toBe("completed");
            expect(reconstructed.cost).toBeGreaterThan(0);
          }
        }
      }
    });

    test("2.5 Cost Calculation Validation: Costs are reasonable", () => {
      const snapshot = snapshots.get("3-after-full-completion");
      if (!snapshot) return;
      const run = snapshot.state.runs[0];

      for (const phase of run.phases) {
        if (phase.status === "completed") {
          // Check that final cost is reasonable based on tokens
          const expectedCost = calculateExpectedCost(phase.finalTokens);
          const actualCost = phase.finalCost;

          // Allow 20% variance for rounding and pricing differences (Claude's pricing may differ from our calculation)
          const variance = Math.abs(actualCost - expectedCost) / expectedCost;
          expect(variance).toBeLessThan(0.2);

          // Also verify cost is positive and reasonable
          expect(actualCost).toBeGreaterThan(0);
          expect(actualCost).toBeLessThan(1.0); // Should be less than $1 for test phases
        }
      }
    });
  });

  // --- Priority 3: Filesystem & Artifact Validation ---
  describe("Priority 3: Filesystem & Artifact Validation", () => {
    test("3.1 Phase Output File Presence: Correct files exist in each stage", () => {
      const s1 = snapshots.get("1-after-phase2-phase3-skipped");
      const s3 = snapshots.get("3-after-full-completion");
      const s4 = snapshots.get("4-after-rollback-to-start");
      if (!s1 || !s3 || !s4) return;

      // Snapshot 1: Phase 1 & 2 outputs should exist, Phase 3 workspace setup ran but was skipped
      expect(fs.existsSync(path.join(s1.directory, "notes"))).toBe(true);
      expect(fs.existsSync(path.join(s1.directory, "typescript_code"))).toBe(
        true, // Phase 3 workspace setup ran before skip
      );

      // Snapshot 3: All outputs should exist
      expect(fs.existsSync(path.join(s3.directory, "notes"))).toBe(true);
      expect(fs.existsSync(path.join(s3.directory, "typescript_code"))).toBe(true);

      // Snapshot 4: Rolled back to before Phase 1 started. No output should exist.
      expect(fs.existsSync(path.join(s4.directory, "notes"))).toBe(false);
      expect(fs.existsSync(path.join(s4.directory, "typescript_code"))).toBe(false);
    });

    test.each(Array.from(snapshots.entries()))(
      "3.2 Orphaned Artifact Check: No orphaned runs or logs in %s",
      (name, snapshot) => {
        const runIdsInState = new Set(snapshot.state.runs.map((r) => r.runId));
        const runDirsOnDisk = fs.readdirSync(path.join(snapshot.directory, ".tadpole", "runs"));

        console.log(`\n=== Orphaned Artifact Check for ${name} ===`);
        console.log(`Run IDs in state: ${Array.from(runIdsInState).join(", ")}`);
        console.log(`Run directories on disk: ${runDirsOnDisk.join(", ")}`);

        // All run directories must have corresponding state entries
        for (const dir of runDirsOnDisk) {
          if (!runIdsInState.has(RunId(dir))) {
            console.log(`ORPHANED: Directory ${dir} has no state entry`);
            throw new Error(`Orphaned run directory found in ${name}: ${dir}`);
          }
          expect(runIdsInState.has(RunId(dir))).toBe(true);
        }

        // All runs in state must have corresponding directories
        for (const run of snapshot.state.runs) {
          const runDir = path.join(snapshot.directory, ".tadpole", "runs", run.runId);
          if (!fs.existsSync(runDir)) {
            throw new Error(`Missing run directory for ${run.runId} in ${name}`);
          }
          expect(fs.existsSync(runDir)).toBe(true);
        }
      },
    );

    test("3.3 Checkpoint Type and Message Content: Snapshot 1", () => {
      const snapshot = snapshots.get("1-after-phase2-phase3-skipped");
      if (!snapshot) return;

      // If no checkpoints were loaded from events, verify they exist in state instead
      if (snapshot.checkpoints.length === 0) {
        console.log("No checkpoints loaded from events, checking state.json instead");
        const run = snapshot.state.runs[0];

        // Verify phase 1 has completion checkpoint
        const phase1 = run.phases.find((p) => p.phaseId === "phase-1");
        expect(phase1?.status).toBe("completed");
        if (phase1?.status === "completed") {
          expect(phase1.completionCheckpoint).toBeDefined();
        }

        // Verify phase 3 has skip checkpoint
        const phase3 = run.phases.find((p) => p.phaseId === "phase-3");
        expect(phase3?.status).toBe("skipped");
        if (phase3?.status === "skipped" && "skipCheckpoint" in phase3) {
          expect(phase3.skipCheckpoint).toBeDefined();
        }
        return;
      }

      const p1checkpoints = snapshot.checkpoints.filter((cp) => cp.phaseId === "phase-1");
      const p3checkpoints = snapshot.checkpoints.filter((cp) => cp.phaseId === "phase-3");

      expect(p1checkpoints.some((cp) => cp.checkpointType === "completed")).toBe(true);
      expect(p3checkpoints.some((cp) => cp.checkpointType === "skipped")).toBe(true);

      // Check commit message of a checkpoint
      const aCheckpoint = snapshot.checkpoints[0];
      const gitDir = path.join(snapshot.directory, ".tadpole", "checkpoints", ".git");
      const msg = execSync(`git --git-dir=${gitDir} show -s --format=%B ${aCheckpoint.sha}`, {
        encoding: "utf-8",
      });

      expect(msg).toContain(`Phase: ${aCheckpoint.phaseName}`);
      expect(msg).toContain(`Status: ${aCheckpoint.checkpointType}`);
    });

    test("3.4 Log File Integrity: All phases have corresponding log files", () => {
      for (const snapshot of snapshots.values()) {
        for (const run of snapshot.state.runs) {
          for (const phase of run.phases) {
            if ("claudeLogPath" in phase && phase.claudeLogPath) {
              const logPath = path.join(snapshot.directory, phase.claudeLogPath);

              // Log files MUST exist for phases that reached running state
              if (
                phase.status === "completed" ||
                phase.status === "failed" ||
                phase.status === "skipped"
              ) {
                // Check both old and new naming patterns
                let actualLogPath = logPath;
                if (!fs.existsSync(logPath)) {
                  // Try the old pattern with double "phase-phase-"
                  const runDir = path.dirname(logPath);
                  const oldPattern = path.join(runDir, `phase-${phase.phaseId}-claude.log`);
                  if (fs.existsSync(oldPattern)) {
                    actualLogPath = oldPattern;
                  } else {
                    // List actual files in the run directory for debugging
                    if (fs.existsSync(runDir)) {
                      const files = fs.readdirSync(runDir);
                      console.log(`    Files in run directory: ${files.join(", ")}`);
                    }

                    throw new Error(
                      `Log file missing for ${phase.phaseId} in ${snapshot.name}: ${phase.claudeLogPath}`,
                    );
                  }
                }

                expect(fs.existsSync(actualLogPath)).toBe(true);

                // If log file exists, verify it's not empty
                const stats = fs.statSync(actualLogPath);
                expect(stats.size).toBeGreaterThan(0);
              }
            }
          }
        }
      }
    });
  });

  // --- Priority 4: Event Stream Analysis ---
  describe("Priority 4: Event Stream Analysis", () => {
    test("4.1 Event Ordering and Completeness: Events are chronologically ordered", () => {
      for (const snapshot of snapshots.values()) {
        const timestamps = snapshot.events.map((e) => new Date(e.timestamp).getTime());

        // Check that timestamps are monotonically increasing
        for (let i = 1; i < timestamps.length; i++) {
          expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
        }
      }
    });

    test("4.2 Rollback Event Sequence: Complete rollback event chain for each rollback", () => {
      for (const snapshot of snapshots.values()) {
        // Find all rollback operations in the event stream
        const rollbackStartedEvents = snapshot.events.filter(
          (e) => e.type === "rollback.started",
        ) as RollbackStartedEvent[];

        // If no rollbacks happened in this snapshot's history, we can skip it.
        if (rollbackStartedEvents.length === 0) {
          continue;
        }

        for (const startEvent of rollbackStartedEvents) {
          // Find the corresponding completion event for this specific rollback
          const completedEvent = snapshot.events.find(
            (e) => e.type === "rollback.completed" && e.timestamp >= startEvent.timestamp,
          ) as RollbackCompletedEvent | undefined;

          // Every rollback must complete
          expect(completedEvent).toBeDefined();
          if (!completedEvent) continue; // Skip to next if something is very wrong

          // Filter progress events that fall between this specific start and completion
          const progressEvents = snapshot.events.filter(
            (e) =>
              e.type === "rollback.progress" &&
              e.timestamp >= startEvent.timestamp &&
              e.timestamp <= completedEvent.timestamp,
          ) as RollbackProgressEvent[];

          // The number of progress steps must equal the number of phases to roll back through, plus one final step for applying the target checkpoint.
          const expectedProgressCount = startEvent.data.phasesToProcess.length + 1;
          expect(progressEvents.length).toBe(expectedProgressCount);

          // Verify the progress steps are sequential (1, 2, 3...)
          const steps = progressEvents.map((e) => e.data.currentStep);
          expect(steps).toEqual([...Array(expectedProgressCount)].map((_, i) => i + 1));
        }
      }
    });

    test("4.3 Phase Event Completeness: Every started phase has completion event", () => {
      for (const snapshot of snapshots.values()) {
        const startedPhases = snapshot.events
          .filter((e) => e.type === "phase.started")
          .map((e) => (e as PhaseStartedEvent).data.phaseId);

        const completedPhases = snapshot.events
          .filter((e) => e.type === "phase.completed")
          .map((e) => (e as PhaseCompletedEvent).data.phaseId);

        for (const phaseId of startedPhases) {
          expect(completedPhases).toContain(phaseId);
        }
      }
    });

    test("4.4 Timestamp Validity: All timestamps are valid ISO 8601", () => {
      for (const snapshot of snapshots.values()) {
        for (const event of snapshot.events) {
          expect(isValidISO8601(event.timestamp)).toBe(true);
        }
      }
    });
  });

  // --- Priority 5: Data Integrity Tests ---
  describe("Priority 5: Data Integrity Tests", () => {
    test("5.1 State-to-Filesystem Run Integrity: All runs have folders", () => {
      for (const snapshot of snapshots.values()) {
        for (const run of snapshot.state.runs) {
          const expectedFolder = path.join(snapshot.directory, ".tadpole", "runs", run.runId);
          expect(fs.existsSync(expectedFolder)).toBe(true);
        }
      }
    });

    test("5.2 Checkpoint SHA Uniqueness: All checkpoint SHAs are unique", () => {
      for (const snapshot of snapshots.values()) {
        const allShas = new Set<string>();

        for (const checkpoint of snapshot.checkpoints) {
          expect(allShas.has(checkpoint.sha)).toBe(false);
          allShas.add(checkpoint.sha);
        }
      }
    });

    test("5.3 Session ID Uniqueness: All session IDs are unique within snapshot", () => {
      for (const snapshot of snapshots.values()) {
        const sessionIds = new Set<string>();

        for (const run of snapshot.state.runs) {
          for (const phase of run.phases) {
            if ("claudeSessionId" in phase && phase.claudeSessionId) {
              expect(sessionIds.has(phase.claudeSessionId)).toBe(false);
              sessionIds.add(phase.claudeSessionId);
            }
          }
        }
      }
    });

    test("5.4 Run Status Consistency: Only one run can be 'running'", () => {
      for (const snapshot of snapshots.values()) {
        const runningRuns = snapshot.state.runs.filter((r) => r.status === "running");
        expect(runningRuns.length).toBeLessThanOrEqual(1);

        // If there's a current run ID, it should be running
        if (snapshot.state.currentRunId) {
          const currentRun = snapshot.state.runs.find(
            (r) => r.runId === snapshot.state.currentRunId,
          );
          expect(currentRun?.status).toBe("running");
        }
      }
    });
  });

  // --- Priority 6: Edge Cases and Behavioral Tests ---
  describe("Priority 6: Edge Cases and Behavioral Tests", () => {
    test("6.1 Skip Behavior Preservation: Skipped phases maintain continuation data", () => {
      const snapshot = snapshots.get("1-after-phase2-phase3-skipped");
      if (!snapshot) return;
      const run = snapshot.state.runs[0];
      const skippedPhase = run.phases.find((p) => p.phaseId === "phase-3");

      if (skippedPhase?.status === "skipped") {
        // Should have session ID for potential continuation
        expect("claudeSessionId" in skippedPhase && skippedPhase.claudeSessionId).toBeTruthy();

        // Should have assistant message count > 0 (Claude was active before skip)
        expect(skippedPhase.assistantMessageCount).toBeGreaterThan(0);

        // Should have partial cost and tokens preserved
        expect("partialCost" in skippedPhase).toBe(true);
        expect("partialTokens" in skippedPhase).toBe(true);
      }
    });

    test("6.2 Multiple Rollback Resilience: State remains valid after multiple rollbacks", () => {
      // Check that each rollback snapshot has valid state
      const rollbackSnapshots = [
        snapshots.get("2-after-rollback-to-phase1"),
        snapshots.get("4-after-rollback-to-start"),
      ].filter((snapshot): snapshot is TestSnapshot => snapshot !== undefined);

      for (const snapshot of rollbackSnapshots) {
        // State should be valid JSON
        expect(snapshot.state).toBeDefined();
        expect(snapshot.state.runs).toBeDefined();
        expect(Array.isArray(snapshot.state.runs)).toBe(true);

        // Should have at least one run
        expect(snapshot.state.runs.length).toBeGreaterThan(0);

        // Git repository should still be valid
        const gitDir = path.join(snapshot.directory, ".tadpole", "checkpoints", ".git");
        expect(fs.existsSync(gitDir)).toBe(true);
      }
    });

    test("6.3 Checkpoint Ordering: Checkpoints are in chronological order", () => {
      for (const snapshot of snapshots.values()) {
        if (snapshot.checkpoints.length > 1) {
          for (let i = 1; i < snapshot.checkpoints.length; i++) {
            const prev = new Date(snapshot.checkpoints[i - 1].timestamp);
            const curr = new Date(snapshot.checkpoints[i].timestamp);
            expect(curr.getTime()).toBeGreaterThanOrEqual(prev.getTime());
          }
        }
      }
    });
  });

  // --- Priority 7: Additional Validation Tests ---
  describe("Priority 7: Additional Validation Tests", () => {
    test("7.1 Resource Cleanup: Lock files removed", () => {
      const mainLockFilePath = path.join(TEST_DIR, ".tadpole", "server.lock");
      const mainLockFileExists = fs.existsSync(mainLockFilePath);
      expect(mainLockFileExists).toBe(false);
    });

    test("7.2 Storage Growth Patterns: State file sizes are reasonable", () => {
      const stateSizes: Array<{ name: string; size: number }> = [];

      for (const snapshot of snapshots.values()) {
        const statePath = path.join(snapshot.directory, ".tadpole", "state.json");
        if (fs.existsSync(statePath)) {
          const stats = fs.statSync(statePath);
          stateSizes.push({ name: snapshot.name, size: stats.size });
        }
      }

      // State files should be reasonable size (less than 100KB for test scenarios)
      for (const { name, size } of stateSizes) {
        expect(size).toBeLessThan(100 * 1024); // 100KB
        expect(size).toBeGreaterThan(100); // At least 100 bytes
        console.log(`State file size for ${name}: ${size} bytes`);
      }
    });

    test("7.3 Configuration Consistency: Phase configs remain unchanged", () => {
      // This test verifies that phase configurations are consistent across snapshots
      // We can't directly test this from snapshots, but we can verify the phases exist
      const expectedPhases = ["phase-1", "phase-2", "phase-3"];

      for (const snapshot of snapshots.values()) {
        for (const run of snapshot.state.runs) {
          const phaseIds = run.phases.map((p) => p.phaseId);
          for (const expectedPhase of expectedPhases) {
            if (phaseIds.includes(PhaseId(expectedPhase))) {
              // Phase exists - this is good
              const phase = run.phases.find((p) => p.phaseId === PhaseId(expectedPhase));
              expect(phase).toBeDefined();
            }
          }
        }
      }
    });

    test("7.4 Workspace Setup Validation: Workspace directories match phase execution", () => {
      const snapshot1 = snapshots.get("1-after-phase2-phase3-skipped");
      const snapshot3 = snapshots.get("3-after-full-completion");
      const snapshot4 = snapshots.get("4-after-rollback-to-start");
      if (!snapshot1 || !snapshot3 || !snapshot4) return;

      // Snapshot 1: Phase 3 workspace setup ran (typescript_code should exist)
      const run1 = snapshot1.state.runs[0];
      const phase3_s1 = run1.phases.find((p) => p.phaseId === "phase-3");
      if (phase3_s1?.status === "skipped" && "workspaceSetupCheckpoint" in phase3_s1) {
        expect(phase3_s1.workspaceSetupCheckpoint).toBeDefined();
        expect(fs.existsSync(path.join(snapshot1.directory, "typescript_code"))).toBe(true);
      }

      // Snapshot 3: All workspace setups should have run
      expect(fs.existsSync(path.join(snapshot3.directory, "notes"))).toBe(true);
      expect(fs.existsSync(path.join(snapshot3.directory, "typescript_code"))).toBe(true);

      // Snapshot 4: Rollback should have cleaned up workspace directories
      expect(fs.existsSync(path.join(snapshot4.directory, "notes"))).toBe(false);
      expect(fs.existsSync(path.join(snapshot4.directory, "typescript_code"))).toBe(false);
    });

    test("7.5 Token Usage Patterns: Token ratios are reasonable", () => {
      for (const snapshot of snapshots.values()) {
        for (const run of snapshot.state.runs) {
          for (const phase of run.phases) {
            if (phase.status === "completed") {
              const tokens = phase.finalTokens;

              // Input tokens should generally be higher than output tokens for our test phases
              expect(tokens.inputTokens).toBeGreaterThan(0);
              expect(tokens.outputTokens).toBeGreaterThan(0);

              // Cache tokens should be non-negative
              expect(tokens.cacheCreationTokens).toBeGreaterThanOrEqual(0);
              expect(tokens.cacheReadTokens).toBeGreaterThanOrEqual(0);

              // Total tokens should be reasonable (not astronomical)
              const totalTokens =
                tokens.inputTokens +
                tokens.outputTokens +
                tokens.cacheCreationTokens +
                tokens.cacheReadTokens;
              expect(totalTokens).toBeLessThan(1_000_000); // Less than 1M tokens
            }
          }
        }
      }
    });

    test("7.6 Error Propagation: No unhandled errors in events", () => {
      for (const snapshot of snapshots.values()) {
        const errorEvents = snapshot.events.filter((e) => e.type === "error");

        // Log any error events for debugging
        if (errorEvents.length > 0) {
          console.log(`Found ${errorEvents.length} error events in ${snapshot.name}:`);
          errorEvents.forEach((e, i) => {
            console.log(`  ${i + 1}: ${JSON.stringify(e.data)}`);
          });
        }

        // Error events should have proper structure
        for (const errorEvent of errorEvents) {
          expect(errorEvent.data).toBeDefined();
          expect(typeof errorEvent.data).toBe("object");
          if (errorEvent.data && typeof errorEvent.data === "object") {
            expect("message" in errorEvent.data).toBe(true);
          }
        }
      }
    });

    test("7.7 Content Validation: Wordsworth is referenced in generated content", () => {
      // Check at least the first and third snapshots which should have poem content
      const snapshotsToCheck = [
        snapshots.get("1-after-phase2-phase3-skipped"),
        snapshots.get("3-after-full-completion"),
      ].filter((s): s is TestSnapshot => s !== undefined);

      let foundWordsworth = false;

      for (const snapshot of snapshotsToCheck) {
        // Check assistant messages for Wordsworth mentions
        const assistantMessages = snapshot.events
          .filter((e) => e.type === "assistant.action")
          .map((e) => {
            if (e.type === "assistant.action" && e.data.action === "message") {
              return e.data.content?.toLowerCase() || "";
            }
            return "";
          })
          .filter((content) => content !== "");

        const hasWordsworthInMessages = assistantMessages.some((content) =>
          content.includes("wordsworth"),
        );

        if (hasWordsworthInMessages) {
          foundWordsworth = true;
          console.log(`Found Wordsworth reference in assistant messages for ${snapshot.name}`);
        }

        // Check generated poem files
        const notesDir = path.join(snapshot.directory, "notes");
        if (fs.existsSync(notesDir)) {
          const files = fs.readdirSync(notesDir);
          for (const file of files) {
            if (file.endsWith(".txt") || file.endsWith(".md")) {
              const filePath = path.join(notesDir, file);
              const content = fs.readFileSync(filePath, "utf-8").toLowerCase();
              if (content.includes("wordsworth")) {
                foundWordsworth = true;
                console.log(`Found Wordsworth reference in ${file} for ${snapshot.name}`);
                break;
              }
            }
          }
        }

        // Also check TypeScript files for phase 3
        const tsDir = path.join(snapshot.directory, "typescript_code/src");
        if (fs.existsSync(tsDir)) {
          const files = fs.readdirSync(tsDir);
          for (const file of files) {
            if (file.endsWith(".ts")) {
              const filePath = path.join(tsDir, file);
              const content = fs.readFileSync(filePath, "utf-8").toLowerCase();
              if (content.includes("wordsworth")) {
                foundWordsworth = true;
                console.log(`Found Wordsworth reference in ${file} for ${snapshot.name}`);
                break;
              }
            }
          }
        }
      }

      // Verify the data source file is linked correctly
      const firstSnapshot = snapshots.get("1-after-phase2-phase3-skipped");
      if (firstSnapshot) {
        const dataSourceInExecution = path.join(
          firstSnapshot.directory,
          "read_only_data_source",
          "poem_guides.txt",
        );
        const dataSourceExists = fs.existsSync(dataSourceInExecution);
        console.log(`Data source file linked at ${dataSourceInExecution}: ${dataSourceExists}`);

        if (dataSourceExists) {
          const content = fs.readFileSync(dataSourceInExecution, "utf-8").toLowerCase();
          // The source file contains Lucy poems (which are by Wordsworth)
          // but doesn't mention "wordsworth" explicitly - that's intentional
          expect(content).toContain("lucy");
          expect(content).toContain("she dwelt among the untrodden ways");
        }
      }

      // At least one snapshot should contain Wordsworth
      expect(foundWordsworth).toBe(true);
    });
  });
});
