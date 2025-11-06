The "Unknown Event" messages in your logs are a clear sign that the `BasicTUI` component hasn't been updated to handle all the new event types you've added, especially those related to the Chronicler system and the more detailed state management.

Here is a comprehensive guide and implementation plan that an AI coding agent (or a human developer) can use to update `server/basic-tui.ts` to properly handle all server events.

### **Objective**

Update the `BasicTUI` in `server/basic-tui.ts` to recognize and visually represent all new server events, eliminating "Unknown Event" log entries and providing a richer, more informative terminal interface.

### **Target File**

`server/basic-tui.ts`

### **Analysis & Strategy**

The core of the work is to expand the `switch (event.type)` statement within the `handleServerEvent` method. We need to add `case` blocks for each currently unhandled event type.

The unhandled events fall into three categories:

1.  **Chronicler Events:** These are highly valuable for observation and should be displayed prominently to show the activity of the parallel agents.
    *   `chronicler.loaded`
    *   `chronicler.unloaded`
    *   `chronicler.triggered`
    *   `chronicler.output`
    *   `chronicler.error`

2.  **State Management Events:** These are low-level internal events. Displaying them would create too much noise. They should be handled silently.
    *   `state.transition`

3.  **Connection State Events:** These are protocol-level events for client synchronization that are not relevant to the TUI's primary display. They should also be handled silently.
    *   `history.batch`
    *   `pong`

The plan is to add a `case` for each of these. Chronicler events will get new, formatted outputs, while the others will be explicitly ignored.

---

### **Implementation Plan**

#### **Step 1: Locate the `handleServerEvent` Method**

Open `server/basic-tui.ts` and navigate to the `handleServerEvent` method (around line `L186`). The `switch (event.type)` block is our target for modification.

#### **Step 2: Add Handlers for Chronicler Events**

We will add new `case` blocks for each chronicler event. These should have distinct visual styles to differentiate them from the main agent's activity. A good color choice is `magenta` or `blue` to distinguish them from the main agent's `cyan` and `yellow`.

**1. `chronicler.loaded`**

*   **Representation:** Display a prominent box to announce that a chronicler has been successfully loaded for the current phase.
*   **Action:** Add the following `case` block inside the `switch` statement.

```typescript
// Add this case block for chronicler.loaded
case "chronicler.loaded": {
  console.log(`\n${timestamp} ${COLORS.magenta}${COLORS.bold}Chronicler Loaded${COLORS.reset}`);
  this.drawBox(
    `Chronicler: ${event.data.chroniclerId}`,
    [
      `Phase: ${COLORS.dim}${event.data.phaseId}${COLORS.reset}`,
      `Model: ${COLORS.dim}${event.data.model}${COLORS.reset}`,
      `Trigger: ${COLORS.cyan}${event.data.triggerType}${COLORS.reset}`,
      `Strategy: ${COLORS.cyan}${event.data.executionStrategy}${COLORS.reset}`,
      `Source: ${COLORS.dim}${event.data.source}${event.data.sourcePath ? ` (${path.basename(event.data.sourcePath)})` : ""}${COLORS.reset}`,
    ],
    COLORS.magenta,
  );
  break;
}
```

**2. `chronicler.unloaded`**

*   **Representation:** A simple log line indicating the chronicler has been unloaded, with a reason.
*   **Action:** Add the following `case` block.

```typescript
// Add this case block for chronicler.unloaded
case "chronicler.unloaded": {
  const reasonColor =
    event.data.reason === "fatal-error" || event.data.reason === "consecutive-failures"
      ? COLORS.red
      : COLORS.dim;
  console.log(
    `\n${timestamp} ${reasonColor}Chronicler Unloaded${COLORS.reset}: ${COLORS.bold}${event.data.chroniclerId}${COLORS.reset}`,
  );
  console.log(`  ${SYMBOLS.arrow} Reason: ${event.data.reason}`);
  console.log(`  ${SYMBOLS.arrow} Final Cost: ${COLORS.yellow}$${event.data.finalCost.toFixed(6)}${COLORS.reset}`);
  console.log(`  ${SYMBOLS.arrow} LLM Calls: ${event.data.llmCallCount}`);
  break;
}
```

**3. `chronicler.triggered`**

*   **Representation:** A minimal, single-line message. This event can be frequent, so we want to avoid cluttering the log.
*   **Action:** Add the following `case` block.

```typescript
// Add this case block for chronicler.triggered
case "chronicler.triggered": {
  console.log(
    `\n${timestamp} ${COLORS.dim}${COLORS.italic}Chronicler Triggered: ${event.data.chroniclerId} (#${event.data.triggerNumber}, ${event.data.eventCount} events)${COLORS.reset}`,
  );
  break;
}
```

**4. `chronicler.output`**

*   **Representation:** A prominent box, similar to an assistant message, to display the chronicler's generated output. It should handle both text and structured (JSON) content.
*   **Action:** Add the following `case` block.

```typescript
// Add this case block for chronicler.output
case "chronicler.output": {
  const outputContent =
    event.data.outputType === "structured"
      ? JSON.stringify(event.data.content, null, 2).split("\n")
      : [event.data.content as string];

  this.drawBox(
    `Chronicler Output: ${event.data.chroniclerId}`,
    [
      ...outputContent,
      `${COLORS.dim}${"─".repeat(20)}${COLORS.reset}`,
      `Cost: ${COLORS.yellow}$${event.data.cost.toFixed(6)}${COLORS.reset}`,
      `Tokens: ${COLORS.dim}(in: ${event.data.tokens.input}, out: ${event.data.tokens.output})${COLORS.reset}`,
    ],
    COLORS.green, // Use green to indicate a result
  );
  break;
}
```

**5. `chronicler.error`**

*   **Representation:** A critical error box, using the same style as existing `error` events for consistency.
*   **Action:** Add the following `case` block.

```typescript
// Add this case block for chronicler.error
case "chronicler.error": {
  console.log(`\n${timestamp} ${COLORS.red}${COLORS.bold}Chronicler Error${COLORS.reset}`);
  this.drawBox(
    `Chronicler Error: ${event.data.chroniclerId}`,
    [
      `Type: ${COLORS.yellow}${event.data.errorType}${COLORS.reset}`,
      `Message: ${event.data.message}`,
      `Retriable: ${event.data.retriable ? "yes" : "no"}`,
      `Consecutive Failures: ${event.data.consecutiveFailureCount}`,
    ],
    COLORS.red,
  );
  break;
}
```

#### **Step 3: Add Handlers for Other Unhandled Events (Silent)**

These events are important for the server's internal logic but are not useful for the TUI user. We will add cases for them with a comment and a `break` to prevent them from falling into the `default` "Unknown Event" block.

*   **Action:** Add the following `case` blocks inside the `switch` statement.

```typescript
// Add these case blocks for silent handling
case "state.transition":
  // Internal state event, too noisy for TUI.
  break;

case "history.batch":
  // Protocol-level event for client sync, not relevant for TUI display.
  break;

case "pong":
  // Response to a ping, not user-facing.
  break;
```

#### **Step 4: Final Review**

After adding all the new `case` blocks, the `switch` statement in `handleServerEvent` should now cover every possible event type defined in `server/schemas/event-schemas.ts`. The `default` case for "Unknown Event" should no longer be triggered during normal operation.