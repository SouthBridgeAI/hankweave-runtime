Let me reorganize everything based on the personas and what they need to understand:

## For Workflow Authors (currently "Creators")

### Core Authoring Concepts
**Workflow/Program** - The complete package they're creating: configuration, prompts, and setup instructions that define a reusable AI automation.

**Phase Definition** - The atomic unit they design: a single focused task with its prompt, model choice, and configuration.

**Prompt Composition** - How they write instructions: inline text, prompt files, system prompt additions, and how multiple files concatenate.

**Template Variables** - The placeholders (`<%EXECUTION_DIR%>`, `<%DATA_DIR%>`) they use to make prompts work across different environments.

**Model Selection** - Choosing between Sonnet (fast/cheap) or Opus (powerful/expensive) and understanding the tradeoffs.

**Continuation Modes** - Whether a phase starts fresh or inherits the conversation from the previous phase ("continue-previous").

### Environment Control
**Workspace Setup** - Pre-phase automation they configure: copying templates, running shell commands, preparing dependencies.

**Working Directory Options** - Where setup commands run: "project" (root), "lastCopied" (from previous copy operation).

**Tracked Files** - The glob patterns that determine what files get monitored, versioned, and included in rollbacks.

**Environment Variables** - How to pass configuration/secrets: phase-specific env objects and TADPOLE_ prefixed system variables.

### Advanced Authoring
**Chronicler Design** - Creating parallel observers: trigger patterns, execution strategies (immediate/debounce/count/timeWindow), and prompt templates.

**Chronicler Triggers** - Event matching rules: simple events, sequences, conditions, and wildcard patterns.

**Tool Availability** - What Claude can do: Read files, Write files, run Bash commands, with constraints and best practices.

**Phase Dependencies** - How phases relate: which can continue from others, what happens to context, branching logic.

**Validation Rules** - What makes a valid configuration: required fields, file existence, logical consistency.

## For Workflow Users (currently "Operators")

### Basic Operation
**Running a Workflow** - Starting the server with a workflow and data source, understanding execution isolation.

**Phase** - The visible steps that execute: seeing their names, progress, and status.

**Phase Status** - Where things are: preparing, starting, running, completed, failed, or skipped.

**Data Source** - The file or folder they point Tadpole at, which remains untouched during execution.

**Execution Directory** - Where work actually happens: an isolated sandbox separate from their original data.

### Control & Monitoring
**Commands** - How to control execution: next, skip, redo, force-stop, rollback.

**Progress Indicators** - Real-time feedback: token usage, costs, file changes, assistant messages.

**Cost Tracking** - Running tallies of API spend per phase and total.

**File Updates** - Seeing what's being created or modified in real-time.

**Basic TUI** - The terminal interface with hotkeys for local control (or whatever client they're using).

### Recovery & Experimentation
**Rollback** - Jumping back to a previous state to try a different approach or recover from errors.

**Checkpoint** - The automatic save points created at key moments they can rollback to.

**Run** - A complete execution session that groups phases together and maintains history.

**Restart vs Resume** - Starting fresh in a new execution vs continuing where they left off.

**Skip vs Force-Stop** - Gracefully moving past a phase vs emergency termination.

## Concepts Both Need (Different Depths)

### Shared Understanding
**Phase** - Authors design them as configuration; users see them execute as steps.

**Execution Environment** - Authors write paths relative to it; users see it as where outputs appear.

**Tracked Files** - Authors specify patterns; users see which files are being monitored.

**Costs** - Authors optimize prompts/models for cost; users monitor spending.

**Errors** - Authors handle error cases; users need to understand failure reasons.

### Different Perspectives
**Chroniclers**:
- Authors: Design trigger patterns and prompts
- Users: See summaries and insights appear

**Workspace Setup**:
- Authors: Configure copy/command operations
- Users: Wait for "preparing" to complete

**Continuation**:
- Authors: Architect multi-phase conversations
- Users: Understand why context carries forward

**Model Choice**:
- Authors: Select based on task complexity
- Users: See speed/cost differences

## Terms Needing Resolution

These need canonical names both groups will use:
1. **Workflow vs Program vs Tadprogram** - Pick one
2. **Creator vs Author vs Developer** - Who makes these?
3. **User vs Operator vs Runner** - Who executes these?
4. **Phase vs Step vs Task** - The atomic unit
5. **Execution Directory vs Workspace vs Sandbox** - Where work happens
6. **Basic TUI vs Terminal Interface vs Console** - The built-in client
7. **Force-Stop vs Abort vs Kill** - Emergency termination
8. **Data Source vs Input vs Project** - What you point at
9. **Outputs vs Artifacts vs Results** - What gets produced
10. **Chronicler vs Observer vs Monitor** - The parallel agents

The key insight: Authors need to understand the **how** and **why** of every feature, while users need to understand **what** is happening and **how to control it**. The naming should reflect this difference in mental models.