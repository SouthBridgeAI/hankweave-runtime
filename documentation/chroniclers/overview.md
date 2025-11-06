# Chroniclers: An Overview

In the Tadpole Runner ecosystem, a **Chronicler** is a parallel, non-blocking observation agent. It is a configurable, event-driven entity that subscribes to the activity stream of the main agent's workflow. Defined entirely in your configuration files, a chronicler's purpose is to watch the main agent's actions—such as its thoughts, tool usage, and file modifications—and then perform its own analysis, summarization, or data extraction in parallel.

## Key Benefits

- **Parallel & Non-Blocking**: Chroniclers run alongside the main agent without ever interrupting or delaying its primary task.
- **Event-Driven**: They are passive listeners that only activate when specific, pre-defined events or patterns of events occur.
- **Fault-Tolerant**: An error within a chronicler will never crash the main agent's workflow, ensuring the primary task's stability.
- **Stateful or Stateless**: They can operate on single events or maintain a conversational history to build context over time.
- **Structured Data Extraction**: Transform the unstructured stream of events into validated, typed JSON objects using Zod schemas.
- **Offloading Cognitive Load**: The main agent can focus on its core task, while chroniclers handle the meta-tasks of observation, analysis, and summarization.

## Relationship to the Main Agent Loop

Think of the main agent as the star player on a field, executing the core tasks of a phase. The chroniclers are the expert commentators in the broadcast booth.

- **Observation, Not Interference**: The commentators (chroniclers) watch every move the player (main agent) makes. They can analyze plays, provide statistics, and offer insights, but they can't run onto the field and tackle the player.
- **Separate Cognitive Load**: The player is focused solely on winning the game. The commentators handle the meta-task of interpreting and contextualizing the game for the audience. Similarly, the main agent focuses on its prompt, while chroniclers handle the overhead of observation and analysis.
- **Asynchronous Flow**: The main agent's actions generate an **event stream**. Chroniclers listen to this stream and react based on their configuration. This one-way flow ensures the main loop remains unburdened.

```
                  ┌───────────────────────┐
                  │   Main Agent Loop     │
                  │ (Executing a Phase)   │
                  └──────────┬────────────┘
                             │
                             │ Emits Event Stream
                             │ (assistant.action, tool.result, file.updated, etc.)
                             ▼
                  ┌───────────────────────┐
                  │ Event Processing Bus  │
                  └──────────┬────────────┘
           ┌───────────┬─────┴─────┬───────────┐
           ▼           ▼           ▼           ▼
      ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐
      │ Chron 1 │ │ Chron 2 │ │ Chron 3 │ │ Chron 4 │
      │ (Notes) │ │(Security) │ │ (Eval)  │ │ (Costs) │
      └─────────┘ └─────────┘ └─────────┘ └─────────┘
```

## What's Next?

- **[Configuration Guide](./configuration-guide.md)**: Learn how to write Chronicler configurations from scratch.
- **[Applications & Use Cases](./applications.md)**: Explore practical, advanced examples of what you can build with Chroniclers.
