## Things to keep in mind

1. Use p-limit or something like it for concurrency management so too many calls aren't made at once to the llm (skip for now, implement later and leave some abstraction around).

Strategies

Let's break down all the situations for controlling when a Chronicler runs into three distinct concepts: Activation Scope, Event Triggers, and Execution Strategy.
1. Activation Scope: When is the Chronicler "listening"?

This defines the overall lifecycle of a Chronicler instance.

    scope: "phase" (Default):

        In English: "This Chronicler should only be active during the specific phase where it is defined."

        Behavior: It starts listening for events when its parent phase begins (phase.started) and is completely destroyed when the phase ends (phase.completed, phase.failed, etc.). Its memory/history is reset for each new execution of the phase.

        Use Case: This is the most common scenario. A Chronicler that summarizes code generation should only run during the code generation phase.

    scope: "run":

        In English: "This Chronicler should be active for the entire duration of the current Tadpole server run, across all phases."

        Behavior: It starts listening when the first phase begins and continues listening until the server shuts down. It sees events from all phases and can maintain its state (e.g., chat history) across them.

        Use Case: A high-level Chronicler that tracks total cost across all phases or generates a complete, end-to-end narrative of the entire run.

2. Event Triggers: What specific event "pulls the trigger"?

Once a Chronicler is active, this defines the exact conditions that cause it to collect data and prepare an LLM call.

    Triggering on Event Type:

        In English: "Run whenever you see one of these specific event types."

        Example: Trigger on: ["assistant.action", "tool.result"]. This Chronicler is interested whenever the agent thinks, speaks, or a tool finishes.

    Triggering with Data Conditions:

        In English: "Run only if the event is the right type and its data contains specific values." This is for fine-grained control.

        Example 1 (Specific Tool): Trigger on tool.result but only if the toolName is Bash. This lets you create a Chronicler that specifically evaluates the safety of shell commands.

        Example 2 (File Paths): Trigger on file.updated but only if the path contains .ts. This lets you create a TypeScript-specific code quality Chronicler.

        Example 3 (Error Severity): Trigger on error but only if the severity is FATAL.

3. Execution Strategy: How do we handle triggers before calling the LLM?

This defines the timing and batching of LLM calls after one or more trigger conditions have been met.

    strategy: "immediate" (Default):

        In English: "As soon as a single event matches the trigger, run the LLM call immediately."

        Behavior: One matching event results in one LLM call.

        Use Case: A Chronicler that translates every agent message into Japanese in real-time. You want the translation for each message as it appears.

    strategy: "debounce":

        In English: "After an event matches the trigger, wait for a short period of inactivity (e.g., 2 seconds). If more matching events arrive during that period, reset the timer. When the timer finally finishes, bundle up all the events that arrived during that burst of activity and run a single LLM call on the whole batch."

        Behavior: Collects a burst of related events into a single context.

        Use Case: Creating a "What is the agent trying to do now?" summary. You don't want a new summary for every single tool call, but rather one summary after the agent finishes a quick sequence of actions.

    strategy: "count":

        In English: "Wait until you have collected a specific number of matching events (e.g., 5 events), then bundle them up and run a single LLM call."

        Behavior: Processes events in fixed-size batches.

        Use Case: A data extraction Chronicler. You might want to wait until you have 10 file access events to send them to an LLM for structured logging, making the API call more efficient.

    strategy: "timeWindow":

        In English: "Every N seconds (e.g., every 30 seconds), collect all the matching events that occurred during that time window and run a single LLM call on them. If no events occurred, do nothing."

        Behavior: Creates periodic, time-based summaries.

        Use Case: A Chronicler that provides a "30-second progress report" during a long-running phase, perfect for monitoring and high-level status updates.


3. How do we actually take these triggered events or files and pass them into the AI call's context?