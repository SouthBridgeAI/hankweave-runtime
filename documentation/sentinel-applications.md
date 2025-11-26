# Advanced Applications of the Sentinel System

## What Are Sentinels?

In the Strandweave Runner ecosystem, a **Sentinel** is a parallel, non-blocking observation agent. It is a configurable, event-driven entity that subscribes to the activity stream of the main agent's workflow. Defined entirely in your configuration files, a sentinel's purpose is to watch the main agent's actions—such as its thoughts, tool usage, and file modifications—and then perform its own analysis, summarization, or data extraction in parallel.

Key characteristics include:
- **Parallel & Non-Blocking**: Sentinels run alongside the main agent without ever interrupting or delaying its primary task.
- **Event-Driven**: They are passive listeners that only activate when specific, pre-defined events or patterns of events occur.
- **Fault-Tolerant**: An error within a sentinel will never crash the main agent's workflow, ensuring the primary task's stability.
- **Stateful or Stateless**: They can operate on single events or maintain a conversational history to build context over time.

## Relationship to the Main Agent Loop

Think of the main agent as the star player on a field, executing the core tasks of a codon. The sentinels are the expert commentators in the broadcast booth.

- **Observation, Not Interference**: The commentators (sentinels) watch every move the player (main agent) makes. They can analyze plays, provide statistics, and offer insights, but they can't run onto the field and tackle the player.
- **Separate Cognitive Load**: The player is focused solely on winning the game. The commentators handle the meta-task of interpreting and contextualizing the game for the audience. Similarly, the main agent focuses on its prompt, while sentinels handle the overhead of observation and analysis.
- **Asynchronous Flow**: The main agent's actions generate an **event stream**. Sentinels listen to this stream and react based on their configuration. This one-way flow ensures the main loop remains unburdened.

```
                  ┌───────────────────────┐
                  │   Main Agent Loop     │
                  │ (Executing a Codon)   │
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
      │ Sntl 1  │ │ Sntl 2  │ │ Sntl 3  │ │ Sntl 4  │
      │ (Notes) │ │(Security)│ │ (Eval)  │ │ (Costs) │
      └─────────┘ └─────────┘ └─────────┘ └─────────┘
```

## Applications & Use Cases

We can categorize the applications of sentinels into several key areas:

### Category 1: Knowledge & Insight Generation

These sentinels are focused on observing the agent's work to extract, summarize, and structure information.

#### 1. Citations & Provenance Tracking
- **Description**: Tracks when the main agent writes a piece of information and logs where that information originated from, whether it was from a source document, a tool output, or an LLM inference.
- **Benefits**: Creates an auditable trail for all generated content, crucial for fact-checking, academic integrity, and understanding the agent's reasoning process.
- **Example Config**:
  ```json
  {
    "id": "citation-tracker",
    "name": "Provenance and Citation Tracker",
    "trigger": { "type": "event", "on": ["file.updated"] },
    "execution": { "strategy": "debounce", "milliseconds": 5000 },
    "systemPromptText": "You are an academic librarian. Your job is to create a citation for the content being written.",
    "userPromptText": "The following file was just updated: <%= it.events[0].data.path %>. Based on the recent conversation history and the content change, please generate a citation for the source of this new information. Write it to citations.log."
  }
  ```

#### 2. Data Access Monitoring
- **Description**: Monitors all tool calls that read from the `read_only_data_source`. The sentinel can maintain a log of which files or data slices were accessed and provide a qualitative analysis of the access patterns.
- **Benefits**: Provides a clear picture of how thoroughly the agent is exploring the source data, identifying if it's focusing too narrowly, accessing data inefficiently, or if its sampling is representative.

#### 3. Automated Note Taking
- **Description**: The main agent can focus on its task while a sentinel is responsible for taking notes. It watches the event stream and periodically creates a summary of what happened, what was learned, and what the outcomes were.
- **Benefits**: Offloads a significant cognitive task from the main agent, simplifying its prompt and allowing it to dedicate its full context to problem-solving.

#### 4. Codon Summaries
- **Description**: Triggers at the end of a codon (`codon.completed`) to generate a comprehensive summary of what was accomplished. This can serve as a briefing for the next codon or for a human operator.
- **Benefits**: Creates clean, structured handoffs between complex codons and provides high-level summaries for long-running workflows.
- **Example Config**:
  ```json
  {
    "id": "codon-summary-generator",
    "name": "End-of-Codon Summarizer",
    "trigger": { "type": "event", "on": ["codon.completed"] },
    "execution": { "strategy": "immediate" },
    "userPromptText": "Codon '<%= it.events[0].data.codonId %>' has just completed. Summarize its outcome, cost ($<%= it.events[0].data.cost %>), and duration (<%= it.events[0].data.duration %>ms). What are the key takeaways for the next codon?"
  }
  ```

#### 5. Entity Extraction
- **Description**: A sentinel that scans all assistant messages and file updates for specific entities (e.g., names, dates, organizations, technical terms) and compiles them into a structured list or knowledge graph.
- **Benefits**: Automatically builds a structured database of key information from unstructured text generated during the run.

#### 6. "Rosetta Stone" Discovery
- **Description**: This advanced sentinel looks for "data events"—the discovery of key files, data points, or relationships that are critical to understanding the project. It identifies and logs these "Rosetta Stones" for future reference.
- **Benefits**: Helps build a semantic map of a complex or unfamiliar codebase/dataset, accelerating future analysis.

---
### Category 2: Quality Assurance & Improvement

These sentinels act as a peer-reviewer or a quality gate, improving the artifacts produced by the main agent.

#### 7. Tool Usage Guardian
- **Description**: This sentinel is given documentation for the project's available tools in its system prompt. It watches `tool.result` events, especially those with errors, and suggests improvements or corrections to how the main agent is using the tools.
- **Benefits**: Helps the main agent learn to use new or complex tools more effectively. It can spot common mistakes, like incorrect parameters or misinterpreting a "zero" result, and provide corrective feedback.
- **Example Config**:
  ```json
  {
    "id": "tool-usage-guardian",
    "name": "Tool Usage Guardian",
    "trigger": {
      "type": "event",
      "on": ["tool.result"],
      "conditions": [{ "path": "isError", "operator": "equals", "value": true }]
    },
    "execution": { "strategy": "immediate" },
    "systemPromptFile": "./prompts/tool-documentation.md",
    "userPromptText": "The agent tried to use the '<%= it.events[0].data.toolName %>' tool and it failed. Here is the result: <%= JSON.stringify(it.events[0].data) %>. Based on the tool documentation, what was the likely mistake and how should the agent correct its approach?"
  }
  ```

#### 8. Live Code Improver / Linter
- **Description**: Triggers on `file.updated` events for source code files. It acts as an asynchronous, AI-powered code reviewer, critiquing the code written by the main agent and suggesting improvements for clarity, performance, or style.
- **Benefits**: The main agent can focus on rapid, functional implementation, while the sentinel handles the "clean up" task of refactoring and adhering to best practices in parallel.

#### 9. Validation Script Generator
- **Description**: A powerful paired-agent pattern. When the main agent performs an action (like a data transformation or implementing a feature), a sentinel is triggered to write a validation script or a suite of unit tests to verify the correctness of that action.
- **Benefits**: Enforces a form of test-driven development automatically, increasing the reliability and robustness of the final output.

---
### Category 3: Meta-Cognition & Performance Monitoring

These sentinels analyze the agent's behavior and strategy, providing insights into its performance.

#### 10. Live Evals
- **Description**: Using a sophisticated model and prompt, this sentinel evaluates the agent's actions against a set of metrics in real-time. These can include:
    - **Task Adherence**: Is the agent following instructions and avoiding prohibited actions?
    - **Creativity**: Is the agent finding novel solutions to problems?
    - **Resilience**: How does the agent react when it gets stuck?
    - **Looping**: Is the agent trying the same failed approach repeatedly?
    - **Laziness**: Is the agent being thorough or taking shortcuts?
- **Benefits**: Provides a continuous, qualitative performance score for the agent, helping developers identify and fix behavioral issues in their prompts and configurations.

#### 11. Workflow Adherence Monitor
- **Description**: This sentinel is given the entire `codon-sequence.json` configuration. It monitors the agent's actions to ensure its current strategy aligns with the goals of the active codon.
- **Benefits**: Prevents the agent from getting sidetracked, providing alerts if its actions deviate significantly from the codon's intended purpose.

#### 12. Pacing & Time-to-Completion Estimator
- **Description**: Monitors the rate of progress (e.g., files processed per minute) and provides real-time estimates for codon completion.
- **Benefits**: Acts as an early warning system if a task is proving more complex or time-consuming than anticipated, allowing for operator intervention.

#### 13. Run Post-Mortem Generator
- **Description**: Triggers on the final `codon.completed` or a `server.idle` event. It analyzes the entire history of the run to produce a comprehensive after-action report.
- **Benefits**: Creates an executive summary of a run's successes, failures, costs, and key outcomes, invaluable for project tracking.

---
### Category 4: Safety, Security, & Resource Management

These sentinels act as a safety net, monitoring for undesirable or dangerous behavior.

#### 14. Security & Safety Monitor
- **Description**: An always-on guardian that watches for potentially dangerous commands, especially in `Bash` tool usage (e.g., `rm -rf`, `curl` with POST to unknown URLs).
- **Benefits**: Provides immediate alerts for high-risk operations, giving a human operator a chance to intervene before damage occurs.
- **Example Config**:
  ```json
  {
    "id": "security-monitor",
    "name": "Security Command Monitor",
    "trigger": {
      "type": "event",
      "on": ["assistant.action"],
      "conditions": [
        { "path": "toolName", "operator": "equals", "value": "Bash" },
        { "path": "toolInput.command", "operator": "matches", "value": "(rm -rf|mkfs|dd if=/dev/zero)" }
      ]
    },
    "execution": { "strategy": "immediate" },
    "userPromptText": "SECURITY ALERT: A potentially destructive command was just attempted. Please log this immediately and analyze the context. Command: <%= it.events[0].data.toolInput.command %>"
  }
  ```

#### 15. PII & Secret Detection
- **Description**: Scans all `file.updated` content and `tool.result` outputs for patterns that match secrets (API keys, passwords) or Personally Identifiable Information (PII).
- **Benefits**: Helps prevent the accidental exposure or hardcoding of sensitive data into the project's artifacts.

---
### Category 5: Human-in-the-Loop & User Experience

These sentinels are designed to make the agent's process more transparent and understandable to a human observer.

#### 16. Human-Friendly Progress Narrator
- **Description**: Transforms the raw, technical event stream into a high-level, easy-to-read narrative of the agent's progress, using a debounce strategy to provide periodic updates.
- **Benefits**: Makes it easy for anyone to understand what the agent is doing and why, without needing to be an expert on the Strandweave protocol.
- **Example Config**:
  ```json
  {
    "id": "narrator",
    "name": "Activity Narrator",
    "trigger": { "type": "event", "on": ["assistant.action", "tool.result"] },
    "execution": { "strategy": "debounce", "milliseconds": 10000 },
    "userPromptText": "Summarize the following agent activities in a conversational, human-readable way. Focus on what the agent is trying to accomplish:\n\n<%= JSON.stringify(it.events, null, 2) %>"
  }
  ```

#### 17. Key Event Highlighter / "TL;DR" Generator
- **Description**: Sifts through the entire event stream to identify and summarize only the most pivotal moments—critical errors, key breakthroughs, and final deliverables.
- **Benefits**: Creates a "highlight reel" of a run, saving operators significant time when reviewing progress.

#### 18. Intervention Point Suggester
- **Description**: Actively looks for patterns that indicate the agent is stuck (e.g., repeated failed tool calls) and suggests that a human operator should intervene.
- **Benefits**: Turns the operator from a passive observer into a targeted problem-solver, improving the overall efficiency of the workflow.
- **Example Config**:
  ```json
  {
    "id": "stuck-detector",
    "name": "Stuck Agent Detector",
    "trigger": {
      "type": "sequence",
      "interestFilter": { "on": ["tool.result"] },
      "pattern": [
        { "type": "tool.result", "conditions": [{ "path": "isError", "operator": "equals", "value": true }] },
        { "type": "tool.result", "conditions": [{ "path": "isError", "operator": "equals", "value": true }] },
        { "type": "tool.result", "conditions": [{ "path": "isError", "operator": "equals", "value": true }] }
      ]
    },
    "execution": { "strategy": "immediate" },
    "userPromptText": "The agent has failed the same tool 3 times in a row. It may be stuck. Analyze the errors and suggest an intervention: <%= JSON.stringify(it.events) %>"
  }
  ```

---
### Category 6: Proactive & Generative Applications

These sentinels don't just observe; they use their observations to generate new ideas and knowledge.

#### 19. Hypothesis Generator
- **Description**: Watches the agent's analysis and results to come up with new, adjacent hypotheses or avenues of exploration that the main agent might have missed.
- **Benefits**: Can introduce serendipity and creativity into the workflow, suggesting new paths that could lead to better outcomes.

#### 20. Knowledge Base "Cookbook" Generator
- **Description**: Identifies novel and successful solutions (e.g., a complex `Bash` command, a clever algorithm) and saves them to a persistent "cookbook.md" file.
- **Benefits**: Creates a self-improving system where the agent's own successful techniques are captured and can be fed back into future runs as part of the system prompt.

#### 21. Real-time Documentation Generator
- **Description**: As the main agent writes code (`file.updated`), this sentinel generates the corresponding documentation (e.g., JSDoc, docstrings) in parallel.
- **Benefits**: Ensures that documentation is never an afterthought, dramatically improving the maintainability of the code produced by the agent.