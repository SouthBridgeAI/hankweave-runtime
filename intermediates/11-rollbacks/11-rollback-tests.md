---

### Tests That Are Irrelevant or Hard to Test with Snapshots

These are tests from your plan that are difficult or impossible to verify using only the static file snapshots and logs produced by your E2E test. They typically require inspecting the live state of the server process or are non-deterministic.

1.  **Tests Requiring Live Process State:**
    *   `10.1 Resource Cleanup`: You cannot verify that log file handles are closed or that there are no lingering Claude processes from a static snapshot of the filesystem. You *can* verify that the `.langton/server.lock` file is removed, which is a good proxy for a clean shutdown.
    *   `12.2 Crash Recovery Validation`: Your current E2E test likely performs a *clean shutdown*. Therefore, the snapshots won't represent a crashed state. You can't test crash recovery (e.g., from a stale lock file) unless you specifically create an E2E test that kills the server process (`kill -9`) to simulate a crash and then restarts it.

2.  **Tests Requiring Semantic AI Understanding:**
    *   `5.2 Continuation Mode Behavior`: Specifically the part about *"check Claude's responses reference previous context"*. While you can verify that the correct `previousSessionId` was passed (a crucial check!), you cannot programmatically verify that Claude's *semantic* output correctly used that context. This would require an LLM to evaluate another LLM's output, which is complex and unreliable for automated testing.
    *   `13.1 Cross-Run Determinism`: Claude's output is non-deterministic. You cannot expect similar prompts to produce identical token usage or file content. You can check if they are within a reasonable *range*, but this can lead to flaky tests. It's better to focus on the correctness of the orchestration logic rather than the AI's specific output.

3.  **Tests Requiring Multi-Platform Execution:**
    *   `Additional Validation Checks > Platform Compatibility`: The snapshots will be generated on a single platform. You cannot use them to verify cross-platform compatibility (e.g., path separator issues on Windows vs. Linux). This requires running the E2E test itself on different platforms.

---

### New Test Suggestions to Add

Your plan is very comprehensive, but here are a few new tests focusing on **cross-validating the integrity between different parts of the snapshot**. These strengthen the "Three-Way Consistency" idea from your plan.

1.  **State-to-Filesystem Run Integrity:**

    - **Test:** For every run object in `state.json`, verify its corresponding `runFolder` exists in `.langton/runs/`.
    - **Inverse Test:** For every directory in `.langton/runs/`, verify a corresponding run object exists in `state.json`. This checks for orphaned run artifacts.

2.  **State-to-Git Checkpoint Integrity:**

    - **Test:** For every `checkpointSha` recorded anywhere in `state.json` (e.g., `completionCheckpoint`, `errorCheckpoint`), verify that a Git commit with that exact SHA exists in the shadow Git repository (`.langton/checkpoints/.git`). This is a critical data integrity check.

3.  **Event Stream to Final State Reconciliation:**

    - **Test:** "Replay" the WebSocket event log from a snapshot. Track `phase.started` and `phase.completed` events. The final state of all phases derived from the event log should match the final state of those phases in `state.json`. For example, a phase with `start` and `complete` events should have a `status: "completed"` in the state file.
    - **Why:** This ensures the event stream is a reliable and complete audit trail of what happened, and that the server's state machine logic is consistent with the events it emits.

4.  **Cost and Token Sanity Check:**

    - **Test:** For each completed phase, perform a rough sanity check on the cost. Based on the `finalTokens` in `state.json`, calculate an expected cost using the prices in the server config. The `finalCost` in the state should be reasonably close (e.g., within 5%).
    - **Why:** This catches potential bugs in either the log parsing or the cost calculation logic, ensuring that the reported costs are plausible.

5.  **Rollback Filesystem Verification Against Git:**
    - **Test:** After a rollback (e.g., in Snapshot 2 and 4), don't just check if certain directories exist or not. Check out the target checkpoint's commit from the shadow git repo into a temporary directory and perform a full directory diff against the main project directory in the snapshot. They should be identical.
    - **Why:** This provides a much stronger guarantee that the rollback was perfectly executed and the file state is exactly what it should be, not just "close enough."

---

### Refined & Prioritized Test Plan

Here is a revised version of your plan, incorporating the feedback above. It's structured for implementation, removing untestable items and adding the new suggestions with a clear "Methodology" for each.

#### **Priority 1: Critical Data Integrity & Core Rollback Logic**

These tests ensure the system's foundation is solid and that rollbacks are accurate.

| Test Name                             | Snapshots                       | Methodology                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1.1. State File Integrity**         | All                             | 1. Parse `state.json` and `state.json.bak` in each snapshot; ensure they are valid JSON. 2. Verify `state.json` and `state.json.bak` are identical.                                                                                                                                |
| **1.2. Git Repository Integrity**     | All                             | 1. In each snapshot, run `git fsck` inside the `.langton/checkpoints` directory. It should pass without errors. 2. Verify each run in `state.json` has a corresponding branch in the git repo.                                                                                     |
| **1.3. Three-Way Consistency**        | All                             | 1. **(State -> Git)** For every checkpoint SHA in `state.json`, verify the commit exists in the git repo. 2. **(State -> FS)** For every run in `state.json`, verify its `runFolder` exists.                                                                                       |
| **1.4. Rollback File State Accuracy** | Compare Snapshots 1->2 and 3->4 | 1. Get the target rollback commit SHA from the `rollback.completed` event. 2. Check out that commit from the shadow git repo into a temp dir. 3. Perform a recursive file hash comparison between the snapshot's project dir and the checked-out temp dir. They must be identical. |
| **1.5. Continuation Run Linkage**     | Snapshot 2, 4                   | 1. In `state.json`, find the newest run. 2. Verify its `startingConditions.type` is `"continuation"`. 3. Verify `source.runId` points to the previous run and `source.checkpointSha` is correct.                                                                                   |

#### **Priority 2: State Machine, Session & Costing Logic**

These tests verify the application's business logic and state transitions.

| Test Name                            | Snapshots                              | Methodology                                                                                                                                                                                                |
| ------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **2.1. Phase State Transitions**     | All                                    | 1. In `state.json`, ensure all terminal phases (`completed`, `failed`, `skipped`) have `endTime` and final cost/token fields. 2. For `skipped` Phase 3 in Snapshot 1, check `assistantMessageCount > 0`.   |
| **2.2. Session ID Chaining**         | Snapshot 1, 3                          | 1. From the event log, find the `phase.started` event for Phase 1 and get its `sessionId`. 2. Find the `phase.started` event for Phase 2 and verify its `previousSessionId` matches Phase 1's `sessionId`. |
| **2.3. Cost Tracking Accuracy**      | All                                    | 1. For Phase 3 in Snapshot 1, verify its cost is `$0.00`. 2. For each completed phase, calculate the expected cost from its `finalTokens` and verify it's close to the stored `finalCost`.                 |
| **2.4. Event Stream Reconciliation** | All                                    | 1. Parse the event log. 2. Reconstruct the sequence of phase statuses for each run. 3. Compare the reconstructed state with the final `state.json`. They should match perfectly.                           |
| **2.5. Rollback Event Sequence**     | Events between Snapshots 1->2 and 3->4 | 1. Find the `rollback.started` event. 2. Verify it is followed by `rollback.progress`, `rollback.workspaceCleanup`, `rollback.phaseCheckpoint` events, and finally `rollback.completed`.                   |

#### **Priority 3: Filesystem & Artifact Validation**

These tests ensure that the side effects (files created by Claude) are managed correctly.

| Test Name                                    | Snapshots                           | Methodology                                                                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **3.1. Phase Output File Presence**          | Snapshot 1, 3, 4                    | 1. In Snapshot 1, verify `notes/` exists and `typescript_code/` does not. 2. In Snapshot 3, verify both directories exist. 3. In Snapshot 4, verify file state matches expectations for a "clean" start.                                         |
| **3.2. Orphaned Artifact Check**             | All                                 | 1. For every directory in `.langton/runs/`, verify there is a matching run in `state.json`. 2. For every log file in a run folder, verify the phase exists in that run's state.                                                                  |
| **3.3. Checkpoint Type and Message Content** | Checkpoint lists from all snapshots | 1. Verify `workspace-setup` checkpoints only exist for phases with `workspaceSetup`. 2. Verify `skipped` checkpoint exists for Phase 3 in Snapshot 1. 3. Parse commit messages to verify they contain correct metadata (runId, phaseId, status). |

# Comprehensive Rollback E2E Test Catalog

## Overview

This document catalogs all tests that should be extracted from the rollback e2e test snapshots. Each test includes what to look for, which snapshots to examine, and why it matters.

### Snapshot Reference

- **Snapshot 1**: After Phase 2 complete, Phase 3 skipped
- **Snapshot 2**: After rollback to Phase 1
- **Snapshot 3**: After full completion from rollback
- **Snapshot 4**: After rollback to very start

---

## 1. State Consistency Tests

### 1.1 Run State Integrity

**What to test:**

- Continuation runs properly reference their parent run
- Starting conditions match what actually happened
- Run status transitions are valid (running → completed/failed)
- No orphaned runs (currentRunId points to existing run)
- Run folders exist in `.langton/runs/` for each run in state

**Snapshots to examine:** All snapshots

**What to look for:**

- In Snapshot 2 & 4: New runs should have `type: "continuation"` with correct source references
- Run folders should match run IDs in state.json
- No run should have status "running" except the current one

**Why it matters:** Ensures the run lifecycle is properly tracked and no data is orphaned

### 1.2 Phase Execution State Consistency

**What to test:**

- Status transitions follow valid paths (preparing → starting → initializing → running → terminal)
- Terminal states have required fields (endTime, costs, exitCode, etc)
- Session IDs are unique across all phases
- Continuation phases have previousSessionId when expected
- Assistant message counts are preserved through skips

**Snapshots to examine:** All snapshots

**What to look for:**

- In Snapshot 1: Phase 3 should be "skipped" with assistantMessageCount > 0
- In Snapshot 2-3: New phases should have unique session IDs
- All completed phases should have finalCost, finalTokens, completionCheckpoint

**Why it matters:** Phase state machine integrity is critical for recovery and continuation

---

## 2. Cost Tracking Tests

### 2.1 Cost Accumulation Accuracy

**What to test:**

- Phase costs for re-executed phases (compare same phase across runs)
- Skipped phases have exactly $0.00 cost
- Total cost calculations match sum of individual phase costs
- Costs from rolled-back phases don't affect new run totals
- Partial costs are preserved in failed/skipped phases

**Snapshots to examine:** Compare Snapshot 1 vs 3, check all snapshots for totals

**What to look for:**

- Phase 2 costs in Snapshot 1 vs Snapshot 3 (should be similar but not identical)
- Phase 3 in Snapshot 1 should have $0 cost (skipped)
- Total costs should increase monotonically across snapshots

**Why it matters:** Cost tracking accuracy is essential for billing and resource management

### 2.2 Token Usage Tracking

**What to test:**

- Token counts are reasonable (not 0, not astronomical)
- Input/output token ratios make sense for the operations
- Cache tokens are tracked when applicable
- Token accumulation matches cost calculations

**Snapshots to examine:** All snapshots with completed phases

**What to look for:**

- Each completed phase should have all four token types tracked
- Input tokens should generally be higher than output tokens
- Cache tokens should appear when continuationMode is used

**Why it matters:** Token tracking helps optimize prompts and monitor API usage

---

## 3. File System State Tests

### 3.1 Workspace Setup Rollback

**What to test:**

- Copied directories are properly removed after rollback
- Generated files match checkpoint state
- No orphaned files from rolled-back phases
- Workspace directories match phase execution history

**Snapshots to examine:** Compare Snapshot 1 → 2 and Snapshot 3 → 4

**What to look for:**

- Snapshot 4: Check if `notes/` and `typescript_code/` directories are removed/present based on rollback target
- No leftover files from phases that were rolled back
- Workspace setup directories should only exist for executed phases

**Why it matters:** Ensures rollback actually cleans up file system changes

### 3.2 Phase Output Files

**What to test:**

- Output files match execution history
- File contents are consistent with phase completion
- No partial files from interrupted phases

**Snapshots to examine:** All snapshots

**What to look for:**

- Snapshot 1: `notes/` exists (phase 1-2), no `typescript_code/`
- Snapshot 3: Both `notes/` and `typescript_code/` exist
- Snapshot 4: Depends on rollback target (workspace-setup vs completed)

**Why it matters:** Verifies that Claude's file operations are properly tracked and rolled back

---

## 4. Checkpoint Integrity Tests

### 4.1 Checkpoint Creation and Ordering

**What to test:**

- Timestamps are monotonically increasing
- Each phase has expected checkpoint types
- Checkpoint SHAs are unique across all checkpoints
- Branch names match run IDs
- Checkpoint messages contain correct metadata

**Snapshots to examine:** All snapshots - check checkpoint lists

**What to look for:**

- Each phase should have appropriate checkpoints (workspace-setup, completed/skipped/error)
- No duplicate SHAs across checkpoints
- Timestamps should be in chronological order

**Why it matters:** Checkpoint integrity is critical for reliable rollback

### 4.2 Checkpoint Type Validation

**What to test:**

- workspace-setup checkpoints exist only for phases with workspaceSetup config
- completed checkpoints for successful phases
- skipped checkpoints for skipped phases
- error checkpoints for failed phases

**Snapshots to examine:** Snapshot 1 (has skipped phase)

**What to look for:**

- Phase 3 in Snapshot 1 should have a "skipped" checkpoint
- All phases with workspaceSetup should have workspace-setup checkpoints
- No missing checkpoints for terminal states

**Why it matters:** Ensures all rollback targets are properly captured

---

## 5. Session Continuity Tests

### 5.1 Session ID Chain Validation

**What to test:**

- Phase 2 previousSessionId matches Phase 1 sessionId
- After rollback, new sessions are created
- Skipped phases preserve session for potential continuation
- Session IDs are valid UUIDs

**Snapshots to examine:** All snapshots, trace session IDs through events

**What to look for:**

- In events: phase.started events should show proper session chaining
- After rollback (Snapshot 2): New session IDs should be generated
- Skipped phase (Snapshot 1): Should still have valid sessionId

**Why it matters:** Session continuity enables Claude to maintain context across phases

### 5.2 Continuation Mode Behavior

**What to test:**

- Phases with continuationMode "continue-previous" have valid previousSessionId
- Continuation actually works (check Claude's responses reference previous context)
- Failed continuation attempts are handled gracefully

**Snapshots to examine:** All snapshots with phase 2 executions

**What to look for:**

- Phase 2 should always have previousSessionId set
- Events should show Claude referencing previous phase context
- No phase should continue without a valid previous session

**Why it matters:** Continuation mode is key to complex multi-phase workflows

---

## 6. Rollback Behavior Tests

### 6.1 Continuation Run Creation

**What to test:**

- New run created with type: "continuation"
- Source run/phase/checkpoint are correctly set
- afterPhase is null for workspace-setup rollbacks
- Rollback reason is recorded

**Snapshots to examine:** Snapshot 2 and 4

**What to look for:**

- State should show new run with proper startingConditions
- Source references should point to valid runs/phases
- Git branch should be created for new run

**Why it matters:** Proper run linkage enables rollback history tracking

### 6.2 Rollback Targeting Accuracy

**What to test:**

- Correct checkpoint selected based on phase + type
- SHA partial matching works correctly
- Latest checkpoint used when multiple exist for a phase
- Rollback to "start" finds earliest checkpoint

**Snapshots to examine:** Snapshot 4 (rollback to start)

**What to look for:**

- Verify the checkpoint SHA used matches the intended target
- Check that file state matches the checkpoint
- Ensure no newer checkpoints were incorrectly selected

**Why it matters:** Accurate targeting is essential for predictable rollback

---

## 7. Event Stream Analysis

### 7.1 Event Ordering and Completeness

**What to test:**

- Events are chronologically ordered by timestamp
- No missing events (e.g., phase.started before phase.completed)
- Idle events occur when expected
- Error events correlate with phase failures

**Snapshots to examine:** All snapshots - analyze full event arrays

**What to look for:**

- Every phase should have started → completed/skipped events
- Idle events after each phase completion
- No gaps in event sequence

**Why it matters:** Complete event streams enable debugging and auditing

### 7.2 Rollback Event Sequence

**What to test:**

- rollback.started has correct source/target metadata
- rollback.progress events show all affected phases
- rollback.phaseCheckpoint for each phase rolled through
- rollback.workspaceCleanup events for workspace directories
- rollback.completed with correct continuation info

**Snapshots to examine:** Events between Snapshot 1→2 and 3→4

**What to look for:**

- Complete rollback event sequence
- Progress events should count correctly
- Workspace cleanup should list removed directories

**Why it matters:** Rollback visibility helps users understand what's happening

---

## 8. Edge Case Tests

### 8.1 Skip Behavior Preservation

**What to test:**

- Skipped phase has assistantMessageCount > 0
- Session can theoretically be continued
- Partial costs were captured
- Skip checkpoint was created

**Snapshots to examine:** Snapshot 1

**What to look for:**

- Phase 3 should have all continuation-enabling data
- Events should show Claude was active before skip
- Checkpoint should exist for the skip

**Why it matters:** Skipped phases should be resumable if designed that way

### 8.2 Multiple Rollback Resilience

**What to test:**

- Multiple rollbacks don't corrupt state
- Each rollback properly isolates its effects
- No accumulation of orphaned data
- Git repository remains consistent

**Snapshots to examine:** All snapshots sequentially

**What to look for:**

- State remains valid after each rollback
- No duplicate or orphaned runs
- Git branches properly organized

**Why it matters:** System should handle any number of rollbacks gracefully

---

## 9. Data Integrity Tests

### 9.1 Git Repository Validation

**What to test:**

- Git branches exist for each run
- Working directory matches checkpoint after rollback
- No uncommitted changes after operations
- Git repository is not corrupted

**Snapshots to examine:** All snapshots

**What to look for:**

- `.langton/checkpoints/.git` exists and is valid
- Can run `git log` and see all checkpoints
- Working tree matches expected state

**Why it matters:** Git corruption would break entire checkpoint system

### 9.2 State File Integrity

**What to test:**

- state.json can be parsed without errors
- state.json.bak exists and matches state.json
- No corruption from concurrent operations
- State validates against schema

**Snapshots to examine:** All snapshots

**What to look for:**

- Both state.json and state.json.bak should exist
- Files should be valid JSON
- All required fields present

**Why it matters:** State corruption would require manual recovery

---

## 10. Performance and Resource Tests

### 10.1 Resource Cleanup

**What to test:**

- Log files closed properly (no handles left open)
- No lingering Claude processes
- Temporary files cleaned up
- Lock files removed appropriately

**Snapshots to examine:** All snapshots

**What to look for:**

- No `.langton/server.lock` file (server was shut down)
- No temp files in project directory
- Process list shouldn't show orphaned Claude processes

**Why it matters:** Resource leaks accumulate over time

### 10.2 Storage Growth Patterns

**What to test:**

- state.json size growth is linear
- Checkpoint repository size is reasonable
- Log file sizes are proportional to phase duration
- No exponential growth patterns

**Snapshots to examine:** Compare sizes across all snapshots

**What to look for:**

- Calculate size differences between snapshots
- Check `.langton/checkpoints/.git` size
- Ensure growth matches operation count

**Why it matters:** Uncontrolled growth would limit long-running projects

---

## 11. Real Integration Tests

### 11.1 Three-Way Consistency

**What to test:**

- State says files exist → files actually exist on disk
- Git tracked files → match actual filesystem
- Checkpoint SHAs in state → exist in git repository
- No orphaned data in any system

**Snapshots to examine:** All snapshots

**What to look for:**

- Cross-reference state.json, git log, and filesystem
- Every reference should be valid
- No dangling pointers

**Why it matters:** Inconsistency between systems breaks assumptions

### 11.2 Claude Log Integration

**What to test:**

- Log files exist at paths specified in state
- Logs contain expected message types
- Costs in logs match state costs
- No log truncation or corruption

**Snapshots to examine:** All snapshots

**What to look for:**

- Check `.langton/runs/*/phase-*.log` files
- Parse logs and verify costs match state
- Ensure init/assistant/result messages present

**Why it matters:** Logs are source of truth for costs and tokens

---

## 12. Recovery Scenario Tests

### 12.1 Partial Operation Recovery

**What to test:**

- State remains consistent if operations fail partway
- Partial checkpoints don't corrupt repository
- Failed workspace setup is properly recorded

**Snapshots to examine:** Look for any failed phases

**What to look for:**

- Failed phases should have partial costs
- State should be valid even with failures
- No half-written files

**Why it matters:** Real-world operations fail frequently

### 12.2 Crash Recovery Validation

**What to test:**

- Lock files properly indicate crashed state
- State backup would enable recovery
- Partial state writes don't corrupt data

**Snapshots to examine:** Final state of each snapshot

**What to look for:**

- state.json.bak should be valid
- No evidence of corruption
- Clean shutdown markers

**Why it matters:** Crashes shouldn't require starting over

---

## 13. Behavioral Consistency Tests

### 13.1 Cross-Run Determinism

**What to test:**

- Similar prompts produce similar token usage
- Workspace setup creates consistent file structures
- Checkpoint creation is predictable

**Snapshots to examine:** Compare Phase 2 across Snapshot 1 and 3

**What to look for:**

- Token usage should be in similar ranges
- File structures should match
- Operations should be reproducible

**Why it matters:** Predictable behavior enables testing

### 13.2 Feature Integration

**What to test:**

- File watching captures all changes
- Cost tracking includes all token types
- Checkpointing captures complete state

**Snapshots to examine:** All snapshots

**What to look for:**

- No missing file updates in events
- All four token types tracked
- Checkpoints restore complete state

**Why it matters:** Features must work together seamlessly

---

## Additional Validation Checks

### Configuration Consistency

- Phase configurations remain unchanged across snapshots
- Model selection (sonnet/opus) properly recorded
- Workspace setup operations match configuration

### Timestamp Integrity

- All timestamps are valid ISO 8601
- Timestamps increase monotonically
- No future timestamps

### WebSocket Event Completeness

- Can reconstruct execution from events alone
- Events contain sufficient detail for debugging
- No missing critical events

### Error Propagation

- Errors in subprocess appear in events
- Filesystem errors cause appropriate failures
- Git errors are handled gracefully

### Platform Compatibility

- Paths use correct separators
- File operations work cross-platform
- No hardcoded assumptions

---

## Testing Priority

1. **Critical**: State consistency, checkpoint integrity, rollback accuracy
2. **High**: Cost tracking, session continuity, file system state
3. **Medium**: Event completeness, performance, resource cleanup
4. **Low**: Cross-run determinism, edge cases

## Success Criteria

- All critical tests pass
- No data corruption scenarios
- Rollback always produces expected state
- Resource usage is bounded
- System remains debuggable
