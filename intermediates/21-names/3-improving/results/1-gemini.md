Of course. This is a crucial distinction. The language you use for someone *building* the automation should be precise and technical, while the language for someone *running* it should be intuitive and action-oriented.

Let's rename the personas first to make this clearer:
*   **The Author:** The developer who designs and writes the workflow configuration. They think in terms of architecture, logic, and implementation.
*   **The Operator:** The user who executes, monitors, and interacts with the running workflow. They think in terms of control, progress, and results.

Here is a full list of the system's components, operations, and concepts, broken down by the persona who needs to understand them most.

---

### For the Author (The one who builds the automation)

An Author's primary concern is correctly defining a robust, repeatable process. They need to understand the building blocks of the system and how to assemble them.

#### Core Primitives (The "Nouns" an Author Creates)

1.  **The Workflow**
    *   **Current Term(s):** `Tadprogram`, `Workflow`, `phases.json` file.
    *   **Why it Matters:** This is the top-level artifact the Author produces. They need a single, canonical name for the entire set of instructions they are creating.

2.  **The Step**
    *   **Current Term(s):** `Phase`.
    *   **Why it Matters:** This is the fundamental unit of the Workflow. The Author's main job is to break a large problem down into a sequence of well-defined, modular Steps.

3.  **The Prompt**
    *   **Current Term(s):** `promptFile`, `promptText`, `appendSystemPrompt`.
    *   **Why it Matters:** This is the core instruction set for a Step. The Author needs to know how prompts are assembled from files and text, and how to inject dynamic information using templates.

4.  **The Setup Block**
    *   **Current Term(s):** `workspaceSetup`.
    *   **Why it Matters:** This is the mechanism for preparing the environment. The Author uses this to declare dependencies, scaffold files, or run build scripts, ensuring each Step starts in a predictable state.

5.  **The State Definition**
    *   **Current Term(s):** `trackedFiles`.
    *   **Why it Matters:** This is a critical declaration. The Author uses this to explicitly define which files constitute the "state" of their workflow, controlling what gets versioned for rollbacks and what file changes are monitored.

#### Key Configurations (The "Adjectives" an Author Sets)

1.  **Continuity Mode**
    *   **Current Term(s):** `continuationMode` (`fresh` vs. `continue-previous`).
    *   **Why it Matters:** This is a primary architectural choice. The Author decides whether a Step needs the conversational history of the previous one, which dictates how they structure multi-turn logic.

2.  **Actor Profile**
    *   **Current Term(s):** `model` (`sonnet` vs. `opus`).
    *   **Why it Matters:** The Author selects the right "brain" for the job. This involves a trade-off between speed, cost, and reasoning capability that directly impacts the Step's performance and budget.

3.  **Environment Variables**
    *   **Current Term(s):** `env` block, `TADPOLE_` prefix.
    *   **Why it Matters:** This is the sanctioned way to inject secrets and configuration into the workflow. The Author needs to understand the prefixing rule and the override priority.

#### Important Concepts (The "Grammar" an Author Must Understand)

1.  **Isolation & The Workspace**
    *   **Current Term(s):** `Execution Directory`, `Execution Isolation`.
    *   **Why it Matters:** The Author *must* understand that their workflow runs in a sandboxed copy of the data. They need to know the difference between the read-only source (`<%DATA_DIR%>`) and the writable workspace (`<%EXECUTION_DIR%>`) to write correct prompts and setup commands.

2.  **The Actor Model (Primary vs. Observer)**
    *   **Current Term(s):** `Primary Agentic Loop` vs. `Chroniclers`.
    *   **Why it Matters:** The Author designs the main workflow for the Primary Actor, but can also configure Parallel Observers (Chroniclers) for tasks like logging, evaluation, or alerting. Understanding this separation allows them to offload cognitive load from the main prompt.

3.  **Modularity & Reusability**
    *   **Current Term(s):** N/A.
    *   **Why it Matters:** This is a "best practice" concept. Authors should be encouraged to create small, single-responsibility Steps that can be reused, reordered, or debugged independently, leading to more robust Workflows.

---

### For the Operator (The one who runs the automation)

An Operator's primary concern is managing the execution of a Workflow. They need to understand its status, how to control its flow, and where to find the results.

#### Core Primitives (The "Nouns" an Operator Sees)

1.  **The Session**
    *   **Current Term(s):** `Run`.
    *   **Why it Matters:** When an Operator starts the server, they are initiating a Session. All activity, logs, and artifacts are scoped to this Session, providing a clear container for a single execution attempt.

2.  **The Timeline**
    *   **Current Term(s):** `Execution Thread`.
    *   **Why it Matters:** The Operator doesn't see individual, disconnected Sessions; they see a single, coherent Timeline of what has happened. This logical history shows them the true progress, even after a revert.

3.  **The Active Step**
    *   **Current Term(s):** `currentPhase`.
    *   **Why it Matters:** This is the focus of the Operator's attention. They need to know which Step is currently running, what it's doing, and how long it's been running.

4.  **The Snapshot**
    *   **Current Term(s):** `Checkpoint`.
    *   **Why it Matters:** This is a "save point" in the Timeline. Operators view a list of Snapshots to understand the history of changes and to select a point to revert to.

5.  **The Artifacts**
    *   **Current Term(s):** `Output files`, `generated-docs`.
    *   **Why it Matters:** This is the tangible result of the Workflow. The Operator needs to know where in the Workspace to find the final, valuable output.

#### Key Operations (The "Verbs" an Operator Uses)

1.  **Start / Resume Session**
    *   **Current Term(s):** `bun run server`.
    *   **Why it Matters:** This is the command that kicks everything off, either starting a fresh Session or resuming the most recent one.

2.  **Advance / Next Step**
    *   **Current Term(s):** `phase.next`.
    *   **Why it Matters:** This is the primary way an Operator moves the workflow forward, telling the system to proceed to the next Step on the Timeline.

3.  **Skip Step**
    *   **Current Term(s):** `phase.skip`.
    *   **Why it Matters:** This gives the Operator a graceful way to bypass a Step that is unnecessary or problematic, without halting the entire Session.

4.  **Stop Step**
    *   **Current Term(s):** `phase.forceStop`.
    *   **Why it Matters:** This is the "emergency brake." It allows the Operator to immediately terminate a misbehaving Step.

5.  **Revert to Snapshot**
    *   **Current Term(s):** `rollback.toCheckpoint`.
    *   **Why it Matters:** This is the system's most powerful interactive feature. It lets the Operator undo mistakes, explore alternative paths, and recover from errors by turning back the clock to a known-good Snapshot.

6.  **Retry Step**
    *   **Current Term(s):** `phase.redo`.
    *   **Why it Matters:** A simple way to re-run the last Step, useful for iterating on a prompt or recovering from a transient error without a full revert.

#### Important Concepts (The "Dashboard" an Operator Watches)

1.  **Observability (The Event Stream)**
    *   **Current Term(s):** `assistant.action`, `tool.result`, `file.updated`.
    *   **Why it Matters:** The Operator isn't flying blind. They have a real-time view into the Active Step's "thoughts" and actions, allowing them to monitor progress, spot issues, and build confidence in the system.

2.  **Statefulness**
    *   **Current Term(s):** N/A, implied by rollbacks.
    *   **Why it Matters:** The Operator must understand that the system remembers everything. This explains why they can stop and resume, and why reverting is possible—the system's state is durable and versioned.

3.  **Cost & Performance**
    *   **Current Term(s):** `token.usage`, `totalCost`.
    *   **Why it Matters:** The Operator has a live dashboard of resource consumption. This helps them understand the financial cost of the Session and identify inefficient Steps.