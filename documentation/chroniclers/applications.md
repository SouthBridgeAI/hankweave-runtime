# Chronicler Applications & Use Cases

This document showcases practical, advanced use cases for the Chronicler system to inspire users. We can categorize the applications of chroniclers into several key areas.

For a basic introduction to what Chroniclers are, see the [Overview](./overview.md). For details on how to configure them, refer to the [Configuration Guide](./configuration-guide.md).

---

### Category 1: Knowledge & Insight Generation

These chroniclers are focused on observing the agent's work to extract, summarize, and structure information.

#### 1. Automated Note Taking & Summarization
- **Description**: The main agent can focus on its task while a chronicler is responsible for taking notes. It watches the event stream and periodically creates a summary of what happened, what was learned, and what the outcomes were.
- **Benefits**: Offloads a significant cognitive task from the main agent, simplifying its prompt and allowing it to dedicate its full context to problem-solving.
- **Example Config**:
  ```json
  {
    "id": "phase-summary-generator",
    "name": "End-of-Phase Summarizer",
    "model": "anthropic/claude-3-5-sonnet-20241022",
    "trigger": { "type": "event", "on": ["phase.completed"] },
    "execution": { "strategy": "immediate" },
    "userPromptText": "Phase\u003c%\u003d it.events[0].data.phaseId \u003c%\u003e has just completed. Summarize its outcome, cost ($<%= it.events[0].data.cost %>), and duration (<%= it.events[0].data.duration %>ms). What are the key takeaways for the next phase?"
  }
  ```

#### 2. Structured Entity Extraction
- **Description**: A chronicler that scans all assistant messages and file updates for specific entities (e.g., names, dates, organizations, technical terms) and compiles them into a structured list or knowledge graph using **Structured Output**.
- **Benefits**: Automatically builds a validated, typed database of key information from the unstructured text generated during the run.
- **Example Config**:
  ```json
  {
    "id": "issue-tracker",
    "name": "Issue Tracker",
    "model": "anthropic/claude-3-5-sonnet-20241022",
    "trigger": { "type": "event", "on": ["file.updated"] },
    "execution": { "strategy": "immediate" },
    "userPromptText": "Scan the following file content for potential software issues like bugs, performance problems, or security vulnerabilities. Extract them into a structured format.\n\nFile: <%= it.events[0].data.path %>\n\n<%= it.events[0].data.content %>",
    "structuredOutput": {
      "output": "array",
      "schemaStr": "z.object({ issue: z.string(), file: z.string(), severity: z.enum(['low', 'medium', 'high', 'critical']) })"
    }
  }
  ```

#### 3. Data Access Monitoring
- **Description**: Monitors all tool calls that read from the `read_only_data_source`. The chronicler can maintain a log of which files or data slices were accessed and provide a qualitative analysis of the access patterns.
- **Benefits**: Provides a clear picture of how thoroughly the agent is exploring the source data, identifying if it's focusing too narrowly or accessing data inefficiently.

---
### Category 2: Quality Assurance & Improvement

These chroniclers act as a peer-reviewer or a quality gate, improving the artifacts produced by the main agent.

#### 4. Tool Usage Guardian
- **Description**: This chronicler is given documentation for the project's available tools in its system prompt. It watches `tool.result` events, especially those with errors, and suggests improvements or corrections to how the main agent is using the tools.
- **Benefits**: Helps the main agent learn to use new or complex tools more effectively.
- **Example Config**:
  ```json
  {
    "id": "tool-usage-guardian",
    "name": "Tool Usage Guardian",
    "model": "anthropic/claude-3-5-sonnet-20241022",
    "trigger": {
      "type": "event",
      "on": ["tool.result"],
      "conditions": [{ "path": "isError", "operator": "equals", "value": true }]
    },
    "execution": { "strategy": "immediate" },
    "systemPromptFile": "./prompts/tool-documentation.md",
    "userPromptText": "The agent tried to use the\u003c%= it.events[0].data.toolName \u003c%\u003e tool and it failed. Here is the result: <%= JSON.stringify(it.events[0].data) %>. Based on the tool documentation, what was the likely mistake and how should the agent correct its approach?"
  }
  ```

#### 5. Live Code Improver / Linter
- **Description**: Triggers on `file.updated` events for source code files. It acts as an asynchronous, AI-powered code reviewer, critiquing the code written by the main agent and suggesting improvements for clarity, performance, or style.
- **Benefits**: The main agent can focus on rapid, functional implementation, while the chronicler handles the "clean up" task of refactoring and adhering to best practices in parallel.

#### 6. Validation Script Generator
- **Description**: A powerful paired-agent pattern. When the main agent performs an action (like a data transformation or implementing a feature), a chronicler is triggered to write a validation script or a suite of unit tests to verify the correctness of that action.
- **Benefits**: Enforces a form of test-driven development automatically, increasing the reliability and robustness of the final output.

---
### Category 3: Meta-Cognition & Performance Monitoring

These chroniclers analyze the agent's behavior and strategy, providing insights into its performance.

#### 7. Cumulative Metrics Tracker (Conversational)
- **Description**: A **Conversational Chronicler** that maintains state across multiple triggers to track cumulative metrics. For example, it can count the total number of files changed and lines of code added throughout a phase.
- **Benefits**: Provides a running tally of key metrics, offering a high-level view of the agent's activity and progress over time.
- **Example Config**:
  ```json
  {
    "id": "metrics-tracker",
    "name": "Cumulative Metrics Tracker",
    "model": "anthropic/claude-3-5-sonnet-20241022",
    "trigger": { "type": "event", "on": ["file.updated"] },
    "execution": { "strategy": "immediate" },
    "systemPromptText": "You are a metrics tracker. On each turn, I will give you the number of lines in a file that was just updated. Your job is to update the running total of files changed and lines added. Respond with the updated totals in the requested JSON format.",
    "userPromptText": "File updated: <%= it.events[0].data.path %>. It now has <%= it.events[0].data.content.split('\n').length %> lines.",
    "conversational": {
      "trimmingStrategy": { "type": "maxTurns", "maxTurns": 20 }
    },
    "structuredOutput": {
      "output": "object",
      "schemaStr": "z.object({ totalFilesChanged: z.number().int(), totalLinesAdded: z.number().int() })"
    }
  }
  ```

#### 8. Live Evals
- **Description**: Using a sophisticated model and prompt, this chronicler evaluates the agent's actions against a set of metrics in real-time, such as task adherence, creativity, resilience, or looping behavior.
- **Benefits**: Provides a continuous, qualitative performance score for the agent, helping developers identify and fix behavioral issues in their prompts and configurations.

---
### Category 4: Safety, Security, & Resource Management

These chroniclers act as a safety net, monitoring for undesirable or dangerous behavior.

#### 9. Security & Safety Monitor
- **Description**: An always-on guardian that watches for potentially dangerous commands, especially in `Bash` tool usage (e.g., `rm -rf`, `curl` with POST to unknown URLs).
- **Benefits**: Provides immediate alerts for high-risk operations, giving a human operator a chance to intervene before damage occurs.
- **Example Config**:
  ```json
  {
    "id": "security-monitor",
    "name": "Security Command Monitor",
    "model": "anthropic/claude-3-5-sonnet-20241022",
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

#### 10. PII & Secret Detection
- **Description**: Scans all `file.updated` content and `tool.result` outputs for patterns that match secrets (API keys, passwords) or Personally Identifiable Information (PII).
- **Benefits**: Helps prevent the accidental exposure or hardcoding of sensitive data into the project's artifacts.

---
### Category 5: Human-in-the-Loop & User Experience

These chroniclers are designed to make the agent's process more transparent and understandable to a human observer.

#### 11. Human-Friendly Progress Narrator
- **Description**: Transforms the raw, technical event stream into a high-level, easy-to-read narrative of the agent's progress, using a debounce strategy to provide periodic updates.
- **Benefits**: Makes it easy for anyone to understand what the agent is doing and why, without needing to be an expert on the Tadpole protocol.
- **Example Config**:
  ```json
  {
    "id": "narrator",
    "name": "Activity Narrator",
    "model": "anthropic/claude-3-5-sonnet-20241022",
    "trigger": { "type": "event", "on": ["assistant.action", "tool.result"] },
    "execution": { "strategy": "debounce", "milliseconds": 10000 },
    "userPromptText": "Summarize the following agent activities in a conversational, human-readable way. Focus on what the agent is trying to accomplish:\n\n<%= JSON.stringify(it.events, null, 2) %>"
  }
  ```

#### 12. Intervention Point Suggester
- **Description**: Actively looks for patterns that indicate the agent is stuck (e.g., repeated failed tool calls) and suggests that a human operator should intervene.
- **Benefits**: Turns the operator from a passive observer into a targeted problem-solver, improving the overall efficiency of the workflow.
- **Example Config**:
  ```json
  {
    "id": "stuck-detector",
    "name": "Stuck Agent Detector",
    "model": "anthropic/claude-3-5-sonnet-20241022",
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
    "userPromptText": "The agent has failed a tool 3 times in a row. It may be stuck. Analyze the errors and suggest an intervention: <%= JSON.stringify(it.events) %>"
  }
  ```
