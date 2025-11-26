Take a look at the previous discussions.

First, take a good look at files in tadpole/intermediates/17-names/3-improving
Based on these files, review the content in the Naming Menu section of the template below for accuracy for concepts.
If anything is too simplified or inaccurate, make the fixes. 

Then, take a good look at files in tadpole/intermediates/17-names/4-folding-ideas.
Based on the ideas, try the prose iterations, bearing in mind the goal is to flag (1) really good names for each components (2) see if they flow well toegether.

<Template>

1.  **A "Naming Menu":** I'll provide a concise list of the key concepts and 2-3 specific, concrete name candidates for each.
2.  **Prose Iterations:** I'll write two distinct versions of the narrative glossary, each using a different *combination* of those names, so we can see how they feel together.

---

### 1. The Naming Menu

Here are the key concepts with a few focused naming candidates.

| Concept | Current Name | Candidate 1 | Candidate 2 | Candidate 3 |
| :--- | :--- | :--- | :--- | :--- |
| The executable "script" | `Tadprogram` | **`Tadprogram`** (Keep) | **`FlightPlan`** | **`Greenprint`** |
| The sequential step | `phase` | **`Phase`** (Keep) | **`Stage`** | **`Leg`** |
| The definition file | `phases.json` | **`tadprogram.json`** | **`flightplan.json`** | **`greenprint.json`** |
| The isolated env | `workspace` | **`Workspace`** (Keep) | **`Pond`** | **`StagingArea`** |
| The observer agents | `chroniclers` | **`Chroniclers`** (Keep) | **`Sentinels`** | **`Auditors`** |
| The single agent loop | `primary actor` | **`Actor`** (Simplify) | **`TheHelm`** | **`Worker`** |
| The revertible save point | `snapshot` | **`Snapshot`** (Keep) | **`Lilypad`** | **`Savepoint`** |
| The full execution | `session` | **`Session`** (Keep) | **`Swim`** | **`Mission`** |
| The final output files | `artifacts` | **`Artifacts`** (Keep) | **`Results`** | *(N/A - Keep)* |

---

### 2. Prose Iterations

Here are two distinct versions, pulling from the menu above.

#### Iteration A: The "Pond" Theme (On-Brand & Organic)

This version leans into the `Tadpole` brand, using the "pond" and "metamorphosis" ideas. It's more playful and thematic.

* `Tadprogram` -> **`Greenprint`**
* `phase` -> **`Stage`**
* `workspace` -> **`Pond`**
* `chroniclers` -> **`Sentinels`**
* `primary actor` -> **`Actor`**
* `snapshot` -> **`Lilypad`**
* `session` -> **`Swim`**

> **📖 The System Defined (Pond Theme)**
>
> The entire system is powered by `` `Tadpole` ``, the core **engine** that executes complex agentic tasks. User-facing applications, like `` `Annalie` ``, are the **interfaces** built on top of `` `Tadpole` ``.
>
> `` `Annalie` `` works by finding or creating a `` `Greenprint` ``—the executable "plan" for the agent. The `` `Tadpole` `` engine is what runs that `` `Greenprint` ``.
>
> An **`Author`** writes a `` `Greenprint` `` by defining a series of `` `Stages` `` in a `` `greenprint.json` `` file. To write portable instructions, the **`Author`** must understand the `` `Pond` ``, which is the isolated, sandboxed environment where the `` `Greenprint` `` will run. Finally, an **`Author`** can configure `` `Sentinels` ``, which are parallel "observer" agents that monitor the main `` `Actor` ``.
>
> An **`Operator`** is the user who runs and interacts with a `` `Greenprint` ``.
>
> An **`Operator`** starts a `` `Swim` `` to begin an execution. During a `` `Swim` ``, they monitor the `` `Active Stage` ``. The system's most powerful feature is **`Return to Lilypad`** (or `Revert to Lilypad`), which lets the **`Operator`** return the `` `Pond` `` to a previous `` `Lilypad` `` (a "save point") to retry or recover. When the `` `Swim` `` is complete, the **`Operator`** retrieves the `` `Artifacts` `` from the `` `Pond` ``.

#### Iteration B: The "Voyage" Theme (Reliable & Long-Horizon)

This version leans into the "long-horizon," "shippable," and "reliable" concepts. It feels more technical and precise, like an engineering tool.

* `Tadprogram` -> **`FlightPlan`**
* `phase` -> **`Leg`**
* `workspace` -> **`StagingArea`**
* `chroniclers` -> **`Auditors`**
* `primary actor` -> **`TheHelm`**
* `snapshot` -> **`Savepoint`**
* `session` -> **`Mission`**

> **📖 The System Defined (Voyage Theme)**
>
> The entire system is powered by `` `Tadpole` ``, the core **engine** that executes complex, long-horizon agentic tasks. User-facing applications, like `` `Annalie` ``, are the **interfaces** built on top of `` `Tadpole` ``.
>
> `` `Annalie` `` works by finding or creating a `` `FlightPlan` ``—the executable "charter" for the agent. The `` `Tadpole` `` engine is what runs that `` `FlightPlan` ``.
>
> An **`Author`** writes a `` `FlightPlan` `` by defining a series of `` `Legs` `` in a `` `flightplan.json` `` file. To write portable instructions, the **`Author`** must understand the `` `StagingArea` ``, which is the isolated, sandboxed environment where the `` `FlightPlan` `` will run. Finally, an **`Author`** can configure `` `Auditors` ``, which are parallel "observer" agents that monitor `` `TheHelm` `` (the single agent loop).
>
> An **`Operator`** is the user who runs and interacts with a `` `FlightPlan` ``.
>
> An **`Operator`** starts a `` `Mission` `` to begin an execution. During a `` `Mission` ``, they monitor the `` `Active Leg` ``. The system's most powerful feature is **`Revert to Savepoint`**, which lets the **`Operator`** return the `` `StagingArea` `` to a previous `` `Savepoint` `` to retry or recover. When the `` `Mission` `` is complete, the **`Operator`** retrieves the `` `Artifacts` `` from the `` `StagingArea` ``.

---

How do these two versions feel? Do you prefer the more thematic "Pond" (A) or the more technical "Voyage" (B)? Or are there specific names (like `Lilypad` or `FlightPlan`) that stand out as kernels we should build around?

<Template/>