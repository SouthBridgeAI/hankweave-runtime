# Langton Server Test Plan

## Test Strategy

We'll use Bun's built-in test runner with actual Claude API calls to ensure end-to-end functionality. Tests will run in the `test-area` directory with cleanup between tests.

## Test Categories

### 1. Server Lifecycle Tests

**Test: Server Startup and Shutdown**
- Start server with valid config
- Verify lock file creation
- Verify WebSocket server is listening
- Test graceful shutdown
- Verify lock file removal

**Test: Multiple Server Prevention**
- Start first server
- Attempt to start second server
- Verify second server fails with lock file error

**Test: State Recovery**
- Run a phase to completion
- Shutdown server
- Restart server
- Verify previous state is loaded correctly
- Verify costs and completed phases match

### 2. WebSocket Connection Tests

**Test: Single Client Connection**
- Connect first client
- Verify server.ready event received
- Verify state.snapshot event received
- Attempt second client connection
- Verify second client is rejected

**Test: Event Streaming**
- Connect client
- Start a phase
- Collect all events during execution
- Verify event types and order
- Verify event data integrity

**Test: Command Handling**
- Send valid commands (phase.start, phase.next, etc.)
- Send invalid commands
- Verify appropriate responses
- Test command validation

### 3. Phase Execution Tests

**Test: Basic Phase Execution**
- Start phase with promptText
- Monitor Claude process spawn
- Verify phase.started event
- Wait for completion
- Verify phase.completed event
- Check token usage and costs

**Test: Pre-Start Commands**
- Phase with mkdir pre-start command
- Verify directory creation
- Verify command runs before Claude
- Test pre-start failure handling

**Test: Phase Continuation**
- Run first phase to completion
- Run second phase with continueFromPrevious
- Verify session ID is passed correctly
- Verify context is maintained

**Test: File Watching**
- Start phase with watch pattern
- Create/modify/delete files
- Verify file.updated events
- Verify filetree.updated events
- Check file content in events

### 4. Error Handling Tests

**Test: Invalid Phase ID**
- Send phase.start with non-existent ID
- Verify error event (non-fatal)
- Verify server continues running

**Test: Missing Prompt**
- Create phase without promptFile or promptText
- Verify validation error
- Server should not start

**Test: Claude Process Failure**
- Mock Claude process failure
- Verify error handling
- Verify server shutdown (fatal error)

**Test: Concurrent Phase Prevention**
- Start a phase
- Attempt to start another phase
- Verify error (phase already running)

### 5. Phase Flow Tests

**Test: Sequential Phase Execution**
- Configure 3 phases
- Use phase.next commands
- Verify phases run in order
- Verify completion tracking

**Test: Phase Skip**
- Start a long-running phase
- Send phase.skip command
- Verify phase terminates
- Verify can start next phase

**Test: Phase Redo**
- Complete a phase
- Send phase.redo command
- Verify same phase runs again
- Verify new session ID

### 6. Cost Tracking Tests

**Test: Token Usage Calculation**
- Run phases with known prompts
- Verify token counts from events
- Verify cost calculations
- Check total cost accumulation

**Test: Cost Persistence**
- Run phases with costs
- Restart server
- Verify costs are restored

### 7. Integration Tests

**Test: Full Workflow**
- Clean test area
- Start server with 3-phase config
- Connect client
- Run all phases sequentially
- Verify file outputs
- Check final state
- Graceful shutdown

**Test: Interrupted Workflow Recovery**
- Start multi-phase workflow
- Kill server mid-phase
- Restart server
- Verify incomplete phase detection
- Continue from interruption

### 8. Performance Tests

**Test: File Watching Performance**
- Watch large directory patterns
- Create many files rapidly
- Verify all events are captured
- Check for event throttling

**Test: Log Parsing Performance**
- Generate large Claude responses
- Monitor parsing lag
- Verify no events are dropped

## Test Implementation Approach

### Test Utilities Needed

1. **WebSocket Client Wrapper**
   - Connect/disconnect
   - Send commands
   - Collect events
   - Wait for specific events

2. **Server Process Manager**
   - Start/stop server
   - Monitor stdout/stderr
   - Handle process lifecycle

3. **Test Helpers**
   - Clean test directory
   - Create test files
   - Generate test configs
   - Assert event sequences

4. **Mock Helpers**
   - Mock file system operations
   - Intercept Claude process spawn
   - Simulate process failures

### Test Structure

```typescript
import { test, expect, beforeEach, afterEach } from "bun:test";

beforeEach(async () => {
  // Clean test area
  // Reset any global state
});

afterEach(async () => {
  // Shutdown server if running
  // Clean up processes
  // Remove test files
});

test("phase execution with file watching", async () => {
  // 1. Start server
  // 2. Connect client
  // 3. Start phase
  // 4. Create test files
  // 5. Verify events
  // 6. Wait for completion
  // 7. Check outputs
});
```

### Test Data

Use the provided `test-phases.config.json` with:
- Simple prompts that complete quickly
- File watching patterns
- Pre-start commands
- Phase continuation

### Success Criteria

- All tests pass consistently
- No resource leaks (processes, files, sockets)
- Graceful handling of all error cases
- Accurate cost tracking
- Reliable state persistence
- Clean test isolation

### Performance Targets

- Server startup: < 1 second
- WebSocket connection: < 100ms
- Event delivery: < 50ms latency
- Phase switching: < 500ms
- Graceful shutdown: < 2 seconds