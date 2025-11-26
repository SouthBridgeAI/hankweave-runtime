# Research of other systems

## 1. **Workflow Orchestration Systems**

### Temporal (Go/TypeScript)

Temporal handles resumability through **event sourcing** - every state change is an event:

```typescript
// Temporal's approach
workflow.execute({
  workflowId: "order-123",
  // If this workflow crashes and restarts, it replays events
});

// They separate:
class WorkflowDefinition {
  // Like your PhaseConfig
  activities: Activity[];
}

class WorkflowExecution {
  // Like your Run
  events: Event[]; // Append-only log
  state: WorkflowState; // Reconstructed from events
}
```

**Their loop pattern:**

```typescript
// Temporal workflows use actual programming loops
export async function myWorkflow() {
  for (let i = 0; i < 3; i++) {
    await activities.processItem(i);
    // If crash here, on restart they replay events
    // and skip already-completed iterations
  }
}
```

**Key insight:** They don't flatten loops at all - they replay the actual code execution. But they can do this because they control the runtime environment.

**Relevant to Tadpole:** You can't replay Claude's execution, so flattening makes sense. But their event sourcing approach validates that storing `loopContext` per phase is correct.

---

### Airflow (Python)

Airflow DAGs are **static at parse time** - very similar to what Philip is doing:

```python
# Airflow DAG definition
with DAG('my_dag') as dag:
    start = DummyOperator(task_id='start')

    # Dynamic task generation (like loop flattening)
    tasks = []
    for i in range(3):
        task = PythonOperator(
            task_id=f'process_{i}',  # Like "review#1", "review#2"
            python_callable=process_fn
        )
        tasks.append(task)

    start >> tasks  # Dependencies
```

**At runtime, Airflow sees a flat list of tasks** with IDs like `process_0`, `process_1`, `process_2`.

**Their approach to resume:**

```python
# TaskInstance table in database
task_instance = TaskInstance(
    task_id='process_2',
    dag_id='my_dag',
    execution_date='2025-01-01',
    state='running',
    # ... metadata
)
```

When scheduler restarts:

1. Read all `TaskInstance` records
2. Find incomplete tasks
3. Match against DAG definition
4. Continue from where it left off

**Key insight:** **Flatten at DAG parse time, persist per-task state, rebuild execution plan from persisted state.** This is exactly Philip's approach!

**Relevant lesson:** Airflow has a **separate DagBag class** that handles parsing and flattening. Not embedded in the main scheduler. This validates the `ExecutionPlanner` extraction I suggested.

---

### AWS Step Functions

Step Functions use **state machine JSON** (similar to your `phases.json`):

```json
{
  "StartAt": "ConfigureCount",
  "States": {
    "ConfigureCount": {
      "Type": "Pass",
      "Result": 3,
      "ResultPath": "$.count",
      "Next": "Loop"
    },
    "Loop": {
      "Type": "Map",
      "ItemsPath": "$.items",
      "Iterator": {
        "StartAt": "ProcessItem",
        "States": {
          "ProcessItem": { "Type": "Task", "End": true }
        }
      },
      "End": true
    }
  }
}
```

**Their Map state** (loop) automatically:

- Spawns parallel or sequential iterations
- Tracks which iterations completed
- Resumes incomplete iterations on failure

**Implementation detail:** They **generate internal execution IDs** for each iteration and store them:

```
execution-123
├── Loop.1 (iteration 1)
├── Loop.2 (iteration 2)
└── Loop.3 (iteration 3, failed)
```

**Key insight:** Using generated IDs like `review#1`, `review#2` for iterations is standard practice in production workflow systems.

---

## 2. **Build Systems**

### Bazel (Google's build system)

Bazel has a **two-phase model** that's very instructive:

```python
# BUILD file (like phases.json)
[genrule(
    name = f"generate_{i}",
    srcs = [f"input_{i}.txt"],
    outs = [f"output_{i}.txt"],
) for i in range(100)]  # Loop generates 100 rules
```

**Phase 1: Loading/Analysis**

- Parse BUILD files
- Expand all loops/macros
- Build complete action graph (flat)
- This is done once and cached

**Phase 2: Execution**

- Execute actions from graph
- Track completion state
- Resume interrupted builds

**Their caching approach:**

```
~/.cache/bazel/
├── action-cache.db      # Which actions completed
├── analysis-cache/      # Parsed/expanded graphs
└── execution-state/     # Current build state
```

**Key insight:** **Separate parse/plan phase from execution phase.** The flattened execution plan can be cached/persisted separately from the original config.

**Relevant to Tadpole:** You could persist the flattened `executionPlan` to avoid re-flattening on every resume. But probably overkill for v1.

---

## 3. **Game Engines & State Persistence**

### Unity (C#)

Unity has excellent **scene serialization** that handles nested hierarchies:

```csharp
// Scene hierarchy (like your loop structure)
GameObject parent = new GameObject("Loop");
for (int i = 0; i < 3; i++) {
    GameObject child = new GameObject($"Iteration_{i}");
    child.transform.parent = parent.transform;
    child.AddComponent<PhaseComponent>();
}
```

**On save:**

```yaml
# scene.unity
GameObject:
  - name: Loop
    instanceID: 100
  - name: Iteration_0
    instanceID: 101
    parentInstanceID: 100
  - name: Iteration_1
    instanceID: 102
    parentInstanceID: 100
```

**Key insight:** They store **both the hierarchy info (parentInstanceID) AND unique instance IDs**. This is like storing both the `loopContext` and the generated `phaseId`.

**On load:**

1. Read flat list of GameObjects
2. Reconstruct hierarchy using parent IDs
3. Each object knows where it came from

**Relevant to Tadpole:** Your `loopContext` serves the same purpose as `parentInstanceID` - it lets you reconstruct where this phase came from.

---

## 4. **Language Runtimes (Loop Implementation)**

### Python Bytecode

How does Python actually execute loops?

```python
for i in range(3):
    process(i)
```

**Compiles to (simplified):**

```
0: SETUP_LOOP
2: LOAD_GLOBAL (range)
4: CALL_FUNCTION (3)
6: GET_ITER
8: FOR_ITER -> 20
10: STORE_FAST (i)
12: LOAD_GLOBAL (process)
14: LOAD_FAST (i)
16: CALL_FUNCTION
18: JUMP_ABSOLUTE 8
20: POP_BLOCK
```

**The bytecode is flat** - loops are just jump instructions. The interpreter doesn't have a special "loop mode."

**Key insight:** Even though Python has loop syntax, at runtime it's **flattened to a linear instruction stream with jumps**. Philip's flattening is analogous.

---

### Go Goroutine Scheduling

Go's goroutine scheduler handles resumption:

```go
// If a goroutine blocks (I/O, channel receive)
func worker(id int) {
    for i := 0; i < 10; i++ {
        result := <-channel  // Goroutine pauses here
        process(result)
        // Runtime saves: goroutine ID, stack, local vars (i, id)
    }
}
```

**Runtime state per goroutine:**

```go
type g struct {
    goid   int64      // Goroutine ID
    stack  stack      // Stack memory
    sched  gobuf      // Scheduling context
    // Includes saved registers, PC (program counter)
}
```

**Key insight:** To resume, you need to save **both identity (goid) and position (PC, local vars)**. Your `loopContext` is the equivalent - it saves which loop and which iteration.

---

## 5. **What Other Projects Do Wrong (Anti-patterns)**

### Jenkins Pipeline (Groovy-based)

Jenkins initially had **non-resumable pipelines**:

```groovy
// Old Jenkins - could NOT resume
for (int i = 0; i < 3; i++) {
    stage("Build ${i}") {
        sh "build.sh"
    }
}
```

Problem: They executed actual Groovy code. If pipeline crashed, **they couldn't resume because loop state was in the Groovy VM, not persisted**.

**Their fix (Pipeline Durability):**

```groovy
// Modern Jenkins - generates stages ahead of time
def stages = (0..2).collectEntries { i ->
    ["Build ${i}": { sh "build.sh" }]
}

parallel stages  // Explicitly flattened
```

**Key lesson:** **Dynamic/runtime loops are hard to resume. Static/flattened loops are easy.**

---

### GitHub Actions (initial design flaw)

GitHub Actions originally **couldn't resume individual steps**:

```yaml
# If this workflow crashes at step 3...
steps:
  - run: step1
  - run: step2
  - run: step3 # CRASH
  - run: step4
```

You had to **re-run the entire workflow**. They later added step-level resume but it required significant rework.

**Key lesson:** **Granular resumability needs to be designed in from the start.** Philip's `loopContext` per phase does this correctly.

---

## 6. **Architecture Patterns from Similar Systems**

### Separation of Concerns (Common Pattern)

Most mature systems separate:

```
┌─────────────────────────────────────────────────┐
│  Definition Layer (static, declarative)        │
│  - Airflow: DAG files                          │
│  - Bazel: BUILD files                          │
│  - Tadpole: phases.json                        │
└──────────────────┬──────────────────────────────┘
                   │ Parse & Expand
                   ↓
┌─────────────────────────────────────────────────┐
│  Planning Layer (expanded, flattened)          │
│  - Airflow: DagBag + TaskInstances             │
│  - Bazel: Action graph                         │
│  - Tadpole: ExecutionPlanner → executionPlan  │
└──────────────────┬──────────────────────────────┘
                   │ Execute
                   ↓
┌─────────────────────────────────────────────────┐
│  Execution Layer (runtime, stateful)           │
│  - Airflow: LocalTaskJob, scheduler           │
│  - Bazel: Skyframe executor                    │
│  - Tadpole: TadpoleServer, ClaudeProcessMgr   │
└──────────────────┬──────────────────────────────┘
                   │ Persist
                   ↓
┌─────────────────────────────────────────────────┐
│  Persistence Layer (state, history)            │
│  - Airflow: PostgreSQL                         │
│  - Bazel: analysis-cache.db                    │
│  - Tadpole: state.json + event journal        │
└─────────────────────────────────────────────────┘
```

**Philip's plan maps well to this:**

- Definition: `phases.json` (with Loop objects)
- Planning: `ExecutionPlanner` → `executionPlan` (flattened)
- Execution: `TadpoleServer`
- Persistence: `state.json` (with `loopContext`)

**The missing piece:** Philip puts planning logic IN execution layer (`TadpoleServer`). Industry practice suggests extracting it.

---

### File Organization (from mature projects)

**Airflow structure:**

```
airflow/
├── models/
│   ├── dag.py              # DAG definition
│   ├── dagbag.py           # DAG loading & parsing
│   └── taskinstance.py     # Runtime state
├── executors/
│   └── local_executor.py   # Execution engine
└── schedulers/
    └── scheduler.py        # Orchestration
```

**Bazel structure:**

```
bazel/
├── packages/               # BUILD file parsing
├── skyframe/              # Action graph building
└── exec/                  # Action execution
```

**Recommendation for Tadpole:**

```
server/
├── config.ts              # Parse phases.json
├── execution-planner.ts   # NEW: Flatten loops → executionPlan
├── execution-thread.ts    # Analyze history → next phase
├── state-manager.ts       # Persist state
└── tadpole-server.ts      # Orchestrate everything
```

---

## 7. **Specific Recommendations Based on Industry Patterns**

### ✅ Things Philip's Plan Gets Right (validated by industry)

1. **Flatten loops at planning time** (Airflow, Bazel)
2. **Generate unique IDs per iteration** (Step Functions, Jenkins)
3. **Store loop context per execution** (Unity, game engines)
4. **Separate config from runtime state** (universal)

### ⚠️ Things to Consider Adding (gaps compared to mature systems)

1. **Explicit planning phase**

   - Industry: Parse → Plan → Execute (three phases)
   - Philip: Parse → Execute (planning embedded in execute)
   - **Recommendation:** Extract `ExecutionPlanner` module

2. **Plan caching**

   - Industry: Bazel caches expanded action graph
   - Tadpole: Re-expands on every startup
   - **Recommendation:** v1 skip, v2 consider if startup slow

3. **Resume logic in startup path**

   - Industry: All systems check for incomplete work on startup
   - Philip's plan: Only handles rollback, not resume
   - **Recommendation:** Add resume path to `server.start()`

4. **Validation of flattened plan**
   - Industry: Most validate the expanded plan before execution
   - Philip's plan: Validates config, but not expanded plan
   - **Recommendation:** Add validation after flattening

### 📋 Pattern: Two-Phase Initialization (from Temporal, Airflow)

```typescript
// What mature systems do:
async start(): Promise<void> {
  // Phase 1: Load & Parse
  await this.stateManager.initialize();

  // Phase 2: Plan Execution
  const state = this.stateManager.getState();
  if (state.currentRunId) {
    // Resume path
    this.executionPlan = await this.planner.rebuildFromState(state);
  } else {
    // Fresh start path
    this.executionPlan = this.planner.buildInitialPlan();
  }

  // Phase 3: Execute
  await this.executeNextPhase();
}
```

---

## Summary: What We Learn from Industry

1. **Flattening loops is correct** - Python bytecode, Airflow, Bazel all do it
2. **Separate planning from execution** - Universal pattern in mature systems
3. **Generate unique IDs** - AWS Step Functions, Jenkins, Unity all do this
4. **Store context per execution** - Required for resumability (Temporal, game engines)
5. **Resume must be explicit** - Can't rely on rollback; need dedicated resume path
6. **Extract to separate module** - All 3,000+ line files eventually get split

**Philip's architecture is sound** - it follows industry best practices. The main improvements I'd suggest:

1. Extract `ExecutionPlanner` to own file (~250 lines)
2. Add explicit resume path in `server.start()`
3. Validate expanded plan before execution

The flattening approach is particularly well-validated - it's what happens under the hood in programming languages, build systems, and workflow engines.
