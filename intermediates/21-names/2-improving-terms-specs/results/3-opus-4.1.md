Looking at the comprehensive work from the other agents, they've captured the core architecture well. Let me add some critical concepts they've touched on but haven't fully separated out, plus a few missing pieces:

## Additional Core Concepts to Name

**Phase Lifecycle State Machine** - The granular 7-state progression (preparing → starting → initializing → running → completed/failed/skipped) that provides precise visibility into exactly where a phase is. This is distinct from the phase itself and deserves its own terminology as it's central to debugging and monitoring.

**Event Stream & Event Types** - The typed, real-time flow of structured events (assistant.action, tool.result, file.updated, token.usage, etc.) that forms the observable output of the system. This is the "telemetry" that everything else consumes.

**Template Variable System** - The interpolation mechanism (`<%EXECUTION_DIR%>`, `<%DATA_DIR%>`) that makes prompts portable across different execution environments. This needs a clear name as it's a key abstraction for reusability.

**Validation System** - The pre-flight checker that analyzes configurations for correctness before execution begins. This is the "linter" or "verifier" that prevents runtime failures.

**Recovery Subsystem** - The collection of mechanisms for crash detection, state corruption recovery, and orphaned resource cleanup. This is the "resilience layer" that makes the system production-ready.

**Tool Catalog** - The specific set of capabilities Claude can invoke (Read, Write, Bash, etc.) with their schemas and constraints. This is distinct from the "Tool Execution System" which tracks their usage.

**Glob Pattern Language** - The file matching syntax borrowed from shell globbing that determines what gets tracked and versioned. Users need to understand this as its own mini-language.

**Atomic Persistence Pattern** - The specific write-temp/backup/rename dance that ensures state is never corrupted. This is a critical implementation pattern that might need a user-facing name for trust-building.

## Modifications to Existing Concepts

**Resolve "Tadprogram" vs "Workflow"** - These are competing names for the same concept. Pick one and standardize. "Workflow" is more enterprise-friendly, "Tadprogram" is more distinctive and playful.

**"Core Agentic Loop" needs refinement** - This feels like an implementation detail. Consider "Phase Execution Engine" or "Agent Runtime" to be more specific about what it is.

**Chronicler Execution Strategies deserve separation** - The trigger system (when to fire) is distinct from execution strategies (how to batch: immediate/debounce/count/timeWindow). These are two different configuration dimensions.

**Model Selection should be "Model Profile"** - Not just which model (Sonnet/Opus) but the entire configuration including temperature, max tokens, etc.

**"Inspect and Modify Loops" needs structure** - This meta-programming concept needs broken down into: Detection (identifying opportunities), Proposal (suggesting changes), Gating (approval mechanism), and Application (making the change).

## Conceptual Groupings That Need Alignment

The documentation reveals some tension between different mental models:

1. **Docker-like model**: Execution environments, isolated workspaces, data mounts
2. **Git-like model**: Commits, branches, rollbacks, history
3. **Programming language model**: Programs, execution, runtime, compilation/validation
4. **Workflow engine model**: Phases, steps, orchestration, DAGs

We should pick a primary metaphor and align the terminology accordingly. The current mix might be confusing.

## Critical Missing Concept

**Execution Identity & Lineage** - How executions relate to their data sources and to each other. The hash-based identification system that links an execution back to its original data needs a clear conceptual name, as does the parent-child relationship between runs after rollbacks.