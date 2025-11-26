### The Verdict: Refactor, Don't Rewrite.

**Do not rewrite from scratch.** The existing documentation is excellent. It accurately describes the complex behaviors (shadow git, execution threads, atomic writes) which haven't changed—only their names have. Rewriting risks losing the high-fidelity technical details that are already there.

However, a simple "Find & Replace" will be dangerous because the *metaphor* has shifted.
*   **Old Metaphor:** Biological Lifecycle (Tadpole $\to$ Frog, Phases of life).
*   **New Metaphor:** Genetic Sequencing / Textile Construction (Strands, Weaving, Codons as building blocks, Rigs as machinery).

We need to edit the docs to align with the new "Strand" metaphor while preserving the technical accuracy.

---

# Documentation Refactoring Spec

Here is the precise plan to update the documentation to match the codebase you just refactored.

## 1. File System Operations (Renaming)

Rename the files to match the new terminology. This effectively breaks all internal links, so fixing links is a priority step later.

| Current Filename | **New Filename** |
| :--- | :--- |
| `tadpole-folder-structure.md` | **`strandweave-folder-structure.md`** |
| `phase-system.md` | **`codon-system.md`** |
| `phase-configuration-guide.md` | **`codon-configuration-guide.md`** |
| `server-protocol.md` | **`server-protocol.md`** (Keep name, heavily edit content) |
| `execution-model-guide.md` | *(Keep name)* |
| `architecture.md` | *(Keep name)* |
| `event-journal.md` | *(Keep name)* |
| `chroniclers/` (Directory) | **`sentinels/`** |

## 2. The Glossary (Search & Replace Rules)

Apply these semantic changes across all markdown files.

| Old Term | New Term | Context/Nuance |
| :--- | :--- | :--- |
| **Tadpole** | **Strandweave** | The product name. |
| **Phase** | **Codon** | The execution unit. Be careful of English usage like "In this phase of development..." $\to$ "In this stage..." |
| **Workspace Setup** | **Rig Setup** | The preparation steps (`copy`, `command`). |
| **Workspace** | **Rig** | When referring to the configuration. Use **"Execution Directory"** when referring to the folder on disk. |
| **Chronicler** | **Sentinel** | The parallel agents. |
| **Tadprogram** | **Strand** | The full JSON configuration / input package. |
| **`phases.json`** | **`codon-sequence.json`** | The default config file name. |
| **`.tadpole`** | **`.strandweave`** | The hidden state directory. |
| **`tadpole-results`** | **`strandweave-results`** | The output directory. |

## 3. Critical Content Updates (File by File)

### A. `README.md`
*   **Branding:** Update title to **Strandweave Runtime**.
*   **Intro:** Shift the narrative from "lifecycle management" to "Sequencing AI workflows."
*   **Quick Start Code Blocks:**
    *   Update the JSON example: Change `workspaceSetup` to `rigSetup`.
    *   Update CLI commands: `bun run server --config=codon-sequence.json`.
*   **Links:** Update links to point to the new `codon-*.md` files.

### B. `codon-configuration-guide.md` (was `phase-configuration-guide.md`)
*   **JSON Examples:** This is the most critical file. Every JSON block needs to be updated.
    *   Key: `phases` $\to$ `codons` (if applicable in root object, usually it's an array).
    *   Key: `workspaceSetup` $\to$ `rigSetup`.
    *   Key: `chroniclers` $\to$ `sentinels`.
    *   Key: `chroniclerConfig` $\to$ `sentinelConfig`.
*   **Env Vars:** Update example from `TADPOLE_API_KEY` to `STRANDWEAVE_API_KEY`.

### C. `codon-system.md` (was `phase-system.md`)
*   **Concept Definition:** Rewrite the definition of a "Phase".
    *   *Old:* "A Phase is a period of time..."
    *   *New:* "A **Codon** is a discrete, executable unit of work within a Strand. Like a genetic codon defines a specific instruction, a Strandweave Codon defines a specific prompt and environment configuration."
*   **State Machine:** Update the diagrams. `phase.started` becomes `codon.started`.
*   **Thread:** Rename "Execution Thread" logic to refer to "Stitching Codons".

### D. `strandweave-folder-structure.md` (was `tadpole...`)
*   **Directory Tree:** Update the ASCII tree structure.
    *   `.tadpole/` $\to$ `.strandweave/`
    *   `chroniclers/` $\to$ `sentinels/`
*   **Lock File:** Mention `.strandweave/server.lock`.
*   **Checkpoints:** Update commit message format example: `checkpoint(rig-setup): codon-1`.

### E. `server-protocol.md`
*   **Events:** Rename all event types.
    *   `phase.started` $\to$ `codon.started`
    *   `phase.completed` $\to$ `codon.completed`
    *   `chronicler.*` $\to$ `sentinel.*`
*   **Commands:** Rename all commands.
    *   `phase.start` $\to$ `codon.start` (payload `phaseId` $\to$ `codonId`).
    *   `rollback.toPhase` $\to$ `rollback.toCodon`.

### F. Sentinel Documentation (`documentation/sentinels/*`)
*   **Terminology:** Replace all instances of Chronicler with Sentinel.
*   **Metaphor:** Change "The Chronicler records history" to "The Sentinel stands watch and observes."
*   **Config:** Update all JSON examples to use `sentinelConfig` and `sentinels` array.

## 4. ASCII Art & Diagram Repair

The documentation contains text-based diagrams. Since "Strandweave" is 11 chars and "Tadpole" is 7, these boxes will break.

**Agent Instruction:**
> "Locate all ASCII diagrams in `.md` files. Re-align the borders of boxes to fit the new, longer terms 'Strandweave' and 'Sentinel'."

**Example Repair:**
```text
OLD:
┌─────────────┐
│   Tadpole   │
└─────────────┘

NEW:
┌─────────────────┐
│   Strandweave   │
└─────────────────┘
```

## 5. Verification Checklist

1.  **grep `Tadpole`:** Should only appear if referring to the history of the project (if desired), otherwise 0 results.
2.  **grep `Phase`:** Should only appear in generic English sentences ("...in this phase of the project..."). It should **NOT** appear in code blocks or event names.
3.  **grep `workspaceSetup`:** Should be 0 results.
4.  **grep `chronicler`:** Should be 0 results.
5.  **Link Check:** Ensure `[link](./phase-system.md)` is updated to `[link](./codon-system.md)`.