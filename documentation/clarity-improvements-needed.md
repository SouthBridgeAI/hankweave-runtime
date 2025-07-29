# Documentation Clarity Improvements Needed

After reviewing the Tadpole Runner documentation, here are areas that need more explanation or clarification. This document tracks what has been addressed (✅) and what still needs work.

## ✅ Recently Addressed

### Execution Isolation
- Complete documentation of the new execution isolation feature
- Template variables updated: `<%EXECUTION_DIR%>`, `<%DATA_DIR%>`, `<%PROJECT_DIR%>` (deprecated)
- Execution directory structure and benefits explained
- Data hashing and execution discovery process documented
- Cleanup changes for execution directories

### Configuration Improvements
- Phase configuration schema now complete with all fields
- Workspace setup details clarified (sequential execution, working directory options)
- File tracking patterns better explained with examples
- Shadow git repository manual inspection commands added
- Lock file behavior and stale lock handling documented

### Protocol Updates
- WebSocket protocol updated to reflect `executionPath` and `dataPath` instead of `projectPath`
- Server ready event documentation updated
- Tool result tracking feature documented with new `tool.result` event

### Tool Execution Tracking
- New `tool.result` event type added to protocol
- Real-time tool execution results with timing and truncation
- Correlation between tool invocations and results via `toolUseId`

## 1. Technical Concepts Not Explained

### Branded Types
- Architecture mentions "branded types" (`PhaseId`, `RunId`) but doesn't explain what these are
- How do they enforce type safety beyond regular TypeScript types?

### Event-Sourcing Pattern
- State-manager uses "event-sourcing-inspired pattern" - what does this mean practically?
- How does this differ from traditional state management?

### Discriminated Unions
- PhaseExecution is mentioned as a discriminated union but the pattern isn't explained
- Why is this beneficial for the state machine?

## 2. Configuration Details Missing

### Phase Configuration Schema
- No complete reference showing ALL possible fields in a phase configuration
- Optional vs required fields not clearly marked
- No validation rules explained (e.g., max prompt size, valid characters in IDs)

### Model Options
- Only "sonnet" and "opus" mentioned - what are all available models?
- What are the trade-offs between different models?
- How to determine which model to use for which task?

### Workspace Setup Details
- What shell is used for command execution?
- What's the working directory context?
- How are errors handled during setup?
- Are commands run sequentially or in parallel?
- Is there a timeout for commands?

## 3. Behavioral Clarifications Needed

### Continuation Mode Edge Cases
- What happens if you use `continue-previous` but the previous phase failed?
- What if the previous phase was skipped?
- Can you continue from a phase in a different run?

### File Tracking and Resolution
- No examples of complex glob patterns or edge cases
- Does it respect the project's .gitignore or create its own?
- How are symlinks handled?
- What about files outside the project directory?

### Session Management
- The relationship between sessionId, phases, and runs is unclear
- How long do sessions persist?
- Can you reuse a session after server restart?

## 4. Operational Details Missing

### Cost Tracking
- How are costs calculated?
- What units are used (dollars, cents)?
- Are costs estimates or actual API charges?
- How accurate are the cost calculations?

### Error Recovery Procedures
- What to do when the server crashes mid-phase?
- How to recover from corrupted state?
- When should you use --cleanup vs manual recovery?
- How to debug when Claude times out?

### WebSocket Protocol Gaps
- No mention of reconnection behavior
- Message size limits?
- What happens if connection drops during phase execution?
- Complete list of WebSocket close codes used?

## 5. System Details Unclear

### TADPOLE Prefix
- Why this specific environment variable prefix?
- What does "tadpole" refer to?
- Is this configurable?

### Shadow Git Repository
- Exact branch naming format
- Commit message structure
- How to manually inspect/use the shadow repo
- Can you push it to a remote for backup?

### Lock File Behavior
- What if process is killed (kill -9)?
- How does heartbeat mechanism work exactly?
- Can you manually clear a stale lock?

## 6. Visual/Conceptual Gaps

### Execution Thread
- The concept is abstract and needs visual representation
- How does branching history work in practice?
- Examples of complex execution scenarios

### State Transitions
- The state machine could use a visual diagram
- What triggers each transition?
- Can phases move backwards in states?

### File System Events
- When exactly are file.updated events triggered?
- Is there debouncing for rapid changes?
- How are binary files handled?

## 7. Integration Questions

### Claude CLI Integration
- What version of Claude CLI is required?
- How are Claude CLI errors surfaced?
- Can you pass custom flags to Claude CLI?

### Git Integration
- Minimum Git version required?
- What if Git is not available?
- How does it handle Git configuration conflicts?

## 8. Performance and Limits

### System Limits
- Maximum number of phases?
- Maximum file size for tracking?
- Maximum number of tracked files?
- Memory usage considerations?

### Timing and Timeouts
- Default timeouts for different operations?
- Can these be configured?
- How long can a phase run?

## 9. Security Considerations

### File Access
- Can phases access files outside the project?
- How are sensitive files protected?
- Is there sandboxing?

### API Key Management
- Best practices for API key storage?
- Can you use multiple API keys?
- Key rotation procedures?

## 10. Advanced Use Cases

### Workflow Patterns
- Examples of complex multi-phase workflows
- Conditional phase execution?
- Parallel phase execution?
- Dynamic phase generation?

### Debugging
- How to enable verbose logging?
- Where are detailed error logs stored?
- How to replay a specific phase for debugging?
