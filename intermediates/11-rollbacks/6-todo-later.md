# Additional questions

1.  Are we cleaning up the workspace folders when we rollback?
2.  Checkpoint on quit?
3.  Consider ignoring gitignores?
4.  We should add a command line thing to move forward and backward through phases
5.  When rolling forward we should do workspace setup before rolling forward git - would that work?
6.  Should we add any file written to by the agent as part of the checkpoint?
7.  We should keep track of the file tree at each point, and diff it to find out what directories not covered by the checkpoints are to be removed when rolling back.
8.  OR - should we treat typescript package setup and teardown as a special case?

## Your Original Questions

### 1. Are we checkpointing on a server crash or quit?

Looking at the `shutdown` method in `langton-server.ts` (lines 5950-6050), I can see:

**Yes, we do checkpoint on shutdown**, but with conditions:

- If shutting down normally ("all phases completed"), no exit checkpoint is created

- For other shutdown reasons (crash, SIGINT, etc.), an exit checkpoint IS created if:

  - Checkpointing is enabled
  - There's a current phase running

The code shows:

```typescript
// Create exit checkpoint if not shutting down normally (all phases completed)
if (
  reason !== "all phases completed" &&
  this.checkpointingEnabled &&
  this.currentPhase
) {
  await this.createCheckpoint({
    status: "exit",
    phaseId: this.currentPhase.phase.id,
    phaseName: this.currentPhase.phase.name,
    runId: this.currentRunId || RunId("unknown"),
    timestamp: new Date().toISOString(),
  });
}
```

### 2. When we roll back phases, are we actually deleting copied folders by workspace setup?

Looking at the `executeRollback` method, **No, we don't delete copied folders**. The rollback process:

1. Cleans up current phase state (in memory)
2. Completes the current run
3. Does a git reset to the checkpoint
4. Starts a new continuation run
5. Restores checkpoint patterns

The git reset only affects tracked files. Folders created by workspace setup (like `typescript_code` copied from a template) are NOT tracked in git, so they remain after rollback. This could lead to conflicts if you rollback and try to copy again.

### 3. Are we listening well enough for Write/Edit tool calls to add to checkpoints?

Looking at `handleFileToolCall`, **we're listening but not adding to checkpoints dynamically**. The current behavior:

- We detect Write/Edit/Read tool calls
- We send file update events to the client
- We update the file tree
- **BUT** we don't trigger a checkpoint when files are written

The checkpoint patterns are added at phase start (accumulated from all phases up to current), but files created by Claude are only checkpointed at phase completion/failure/skip.
