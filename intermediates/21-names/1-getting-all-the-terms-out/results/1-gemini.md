### Core Execution Concepts

1.  **The Executable Plan**
    This is the user-authored configuration file (e.g., `phases.json`) that declaratively defines the entire multi-step task. It serves as the master blueprint or "program" that the system reads to understand the sequence of operations, their prompts, and their dependencies.

2.  **A Single Unit of Work (currently "Phase")**
    This is the fundamental, atomic building block of the Executable Plan, representing one discrete task for the AI to accomplish. Each unit is defined by its own prompt, model configuration, and environment, and it represents a single, logical step in the overall workflow.

3.  **The Primary AI Worker**
    This refers to the main, active agentic process that executes a single Unit of Work. It is the entity that receives the prompt, thinks, uses tools, modifies files, and carries the conversational context forward to complete its assigned task.

4.  **A Single Server Session (currently "Run")**
    This represents one complete lifecycle of the orchestration server, from the moment it starts until it shuts down. Each session has a unique identity, contains the execution history of one or more Units of Work, and forms an isolated branch in the versioning system.

5.  **The Logical Workflow History (currently "Execution Thread")**
    This is the reconstructed, coherent sequence of successfully completed tasks, even when they span across multiple Server Sessions due to rollbacks. It represents the project's "true" evolutionary path and is used to intelligently determine what the next logical Unit of Work should be.

### Observation & Meta-Processing

6.  **The Parallel Observer Agent (currently "Chronicler")**
    This is a non-blocking, event-driven agent that watches the Primary AI Worker's activity stream to perform its own parallel tasks. Its purpose is observation, analysis, summarization, or evaluation, and it never interferes with or delays the main workflow.

7.  **The LLM Request Interceptor (currently "LLM Proxy")**
    This is a middleware layer that sits between the AI Worker and the external LLM API. It transparently inspects, logs, and can modify all incoming requests and outgoing responses, enabling features like cost tracking, safety guardrails, and caching.

### Environment & State Concepts

8.  **The Isolated Workspace (currently "Execution Directory")**
    This is the sandboxed directory where all operations take place, keeping the user's original project pristine. It contains the linked source data, all generated files, logs, checkpoints, and state, ensuring that every run is contained and reproducible.

9.  **The Source Material (currently "Data Source" / "Data Folder")**
    This is the user's original project directory or single file that serves as the initial input for the entire process. The system treats this material as read-only, accessing it via a symlink or copy within the Isolated Workspace to guarantee data integrity.

10. **The State Snapshot (currently "Checkpoint")**
    This is a point-in-time snapshot of all tracked files within the Isolated Workspace, captured and managed by the internal "shadow" git repository. These snapshots are the atomic units that enable the system's powerful rollback and versioning capabilities.

### Supporting Concepts

11. **The Central Orchestrator (currently "Tadpole Server")**
    This is the core engine that reads the Executable Plan and manages the entire process. It is responsible for spinning up AI Workers, managing state, handling file I/O, creating Snapshots, and communicating with the user via its control interface.

12. **The Control Interface (currently "WebSocket Protocol" / "TUI")**
    This defines the API and mechanism through which a human user or programmatic client interacts with the Central Orchestrator. It's the channel for sending commands (like `start`, `skip`, `rollback`) and receiving the real-time stream of events from the system.

13. **The Preparatory Step (currently "Workspace Setup")**
    This is an automated sequence of operations, like copying files or running shell commands (`npm install`), that executes *before* a Unit of Work begins. Its function is to prepare the Isolated Workspace so the AI Worker has the necessary environment and dependencies to succeed.

14. **The Generated Artifacts (currently "Output files")**
    These are the final, tangible files and data produced as the result of the entire workflow. They represent the successful culmination of the AI's work, such as new source code, documentation, or a data analysis report, all residing within the Isolated Workspace.