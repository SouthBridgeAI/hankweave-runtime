We are reaching the final stretch of the twisted road to full looping phases support - dealing with "context exceeded" events.

Loops need to support "contextExceeded" termination condition. Furthermore, standalone phases will need a way to handle these gracefully very soon in the future. We will be focusing on loops for now, however.

## Current implementation

Our system currently detects "context exceeded" event inside server/tadpole-server.ts and logs it 

```ts
if (isContextExceeded(msg as ClaudeLogMessage)) {
    this.logger.log(
    `[TADPOLE-SERVER] Context exceeded error detected for phase ${phaseId}`,
    "error",
    );
    // Additional handling will be added in future work
}
```

Our goal now is to come up with a plan on how to implement a useful way to handle this event. Here are a few important ideas to consider:

- we want to notify state manager about "context exceeded" event and let it handle it accordingly based on the current state of the application:
  - while inside the loop that has "context exceeded" as its "terminateOn" condition, it should consider the loop as completed successfully and proceed with a fresh session to work on next phase
  - otherwise "context exceeded" must trigger an error
- we want to consider introducing and emitting additional event to notify clients
- let's make sure we have a way to start a fresh session using Claude process manager that we will use to run subsequent phases with
- we want a cheap and fast unit/integration tests for the state manager to test "context exceeded" events
- we will also need a more thorough and expensive e2e tests to test functionality end to end (these will go into tests/long-running)