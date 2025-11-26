# Understanding the Strandweave Execution Model

This guide explains how Strandweave's execution model works, including the relationships between executions, data directories, symlinks, runs, and codons.

## Core Concepts Hierarchy

```
Data Source (Your Project or File)
    ↓
Execution Directory (Isolated Environment)
    ├── read_only_data_source/ → symlink to Data Source or containing linked file
    └── .strandweave/
        ├── execution-meta.json
        └── state.json
            └── Runs[]
                └── Codons[]
```

## 1. Data Source

Your original project directory or single file containing:
- Source code
- Configuration files
- Documentation
- Any other project assets
- Or a single file (e.g., requirements document, data file)

**Key Properties:**
- **Read-only**: Never modified by Strandweave
- **Location**: Can be anywhere on your filesystem
- **Type**: Can be either a directory or a single file
- **Identification**: Hashed to create a unique fingerprint

### Data Hash Calculation

The data hash uniquely identifies your project or file:

For directories:
```
H(data) = SHA256(∑(f_type : f_path : f_size : f_mtime))
```

For files:
```
H(file) = SHA256("file:" + basename + ":" + size + ":" + mtime + content)
```

Where:
- `f_type` ∈ {d, f, e} (directory, file, error)
- `f_path` = relative path from data root
- `f_size` = file size in bytes
- `f_mtime` = modification time (seconds since epoch)

## 2. Execution Directory

An isolated execution environment where Strandweave operates:

```
~/.strandweave-executions/<timestamp>-<random>-<hash_prefix>/
```

### Execution Directory Naming

```
E_name = T_ms + "-" + R_36(4) + "-" + H_6
```

Where:
- `T_ms` = timestamp in milliseconds since epoch
- `R_36(4)` = 4-character random string (base 36)
- `H_6` = first 6 characters of data hash

**Example**: `1737123456789-abc1-d4f5e6`

## 3. Data Access via Symlinks

The data is accessed through:

```
<execution_dir>/read_only_data_source/ → <data_source_path>
```

### File vs Directory Handling

When the data source is a **directory**:
```
read_only_data_source/ → /path/to/project/
```

When the data source is a **file**:
```
read_only_data_source/
    └── filename.txt → /path/to/filename.txt
```

The file is placed inside the `read_only_data_source` directory to maintain a consistent interface for Claude.

### Symlink vs Copy Decision

```
access_method = {
    symlink,  if OS supports && permissions allow
    copy,     otherwise
}
```

**Performance Impact:**
- Symlink: O(1) setup time, no additional disk space
- Copy: O(n) setup time where n = total data size

## 4. Runs

A run represents a single server lifecycle:

### Run Properties

```
Run = {
    id: RunId,
    startTime: ISO_timestamp,
    endTime: ISO_timestamp | null,
    status: "active" | "completed" | "crashed",
    codons: CodonExecution[],
    parent: RunId | null  // for rollback continuations
}
```

### Run ID Generation

```
RunId = T_ms + "-" + R_36(5)
```

## 5. Codons

Codons are the atomic units of work:

### Codon State Machine

```
State transitions:
preparing → starting → initializing → running → {completed, failed, skipped}
```

## 6. Loops and Execution Planning

Loops allow codons to repeat multiple times. The execution planner handles loop expansion at runtime.

For detailed loop configuration options, see [Loops in the Codon Configuration Guide](./codon-configuration-guide.md#loops).

### Execution Plan

The execution plan is a flattened list of all codons to execute, including expanded loop iterations:

```
ExecutionPlan = [
    { codon: Codon, codonId: CodonId, loopContext?: LoopContext }
]
```

### Lazy Loop Expansion

Loops are expanded lazily—only one iteration at a time:

```
Initial:     [setup, work#0, finalize]
After work#0: [setup, work#0, work#1, finalize]
After work#1: [setup, work#0, work#1, work#2, finalize]
...
```

This approach:
- Keeps the plan manageable for long-running loops
- Allows termination conditions to be evaluated after each iteration
- Supports context-exceeded loops that run until Claude's context is full

### Loop Context Tracking

Each codon in a loop carries context about its position:

```
LoopContext = {
    loopId: CodonId,       // ID of the parent loop
    iteration: number,      // 0-indexed iteration number
    codonIndexInLoop: number // Position within loop's codon array
}
```

### Codon ID Generation for Loops

Loop codons receive iteration-suffixed IDs:

```
CodonId = OriginalId + "#" + Iteration
```

Examples: `write-code#0`, `write-code#1`, `review#0`, `review#1`

### Context Exceeded Handling

When Claude's context window is exhausted, the behavior depends on the loop's termination condition:

| Termination Type | Context Exceeded Behavior |
|-----------------|--------------------------|
| `iterationLimit` | Codon **fails** (error condition) |
| `contextExceeded` | Codon **completes** (expected termination) |

For `contextExceeded` loops:
1. The current codon is marked as completed
2. Remaining codons in the current iteration are removed from the plan
3. Execution continues to the next item after the loop

See [Validation Rules for contextExceeded Loops](./codon-configuration-guide.md#validation-rules-for-contextexceeded-loops) for configuration constraints.

## 7. Cost Calculations

### Token Cost Formula

```
C_codon = (T_in × R_in) + (T_out × R_out)
```

Where:
- `T_in` = input tokens
- `R_in` = input token rate ($/1M tokens)
- `T_out` = output tokens
- `R_out` = output token rate ($/1M tokens)

### Total Execution Cost

```
C_total = ∑(C_codon) for all codons in execution thread
```

## 8. Execution Thread

The logical sequence across multiple runs:

### Thread Construction Algorithm

```
Thread = []
current_run = latest_run

while current_run:
    for codon in reverse(current_run.codons):
        if codon.id not in Thread.ids:
            Thread.prepend(codon)

    if current_run.parent:
        current_run = find_run(current_run.parent)
        skip_codons_after(current_run.continuation_point)
    else:
        break
```

## 9. Performance Metrics

### Execution Efficiency

```
E = T_useful / (T_useful + T_overhead)
```

Where:
- `T_useful` = time Claude spends on task
- `T_overhead` = setup + checkpoint + state management time

### Rollback Efficiency

```
R_eff = 1 - (T_rollback / T_redo)
```

Where:
- `T_rollback` = time to rollback and continue
- `T_redo` = time to redo from scratch

## 10. Execution Discovery

Finding executions for a data source:

```
find_executions(data_path):
    H = hash(data_path)
    return all E where E.meta.dataHash == H
    sorted by E.meta.lastUsed descending
```

## Common Patterns

### 1. Single Data, Multiple Executions
```
/my-project/ (data)
    → ~/.strandweave-executions/exec-1/ (approach A)
    → ~/.strandweave-executions/exec-2/ (approach B)
    → ~/.strandweave-executions/exec-3/ (approach C)
```

### 2. File as Data Source
```
/path/to/requirements.txt (file)
    → ~/.strandweave-executions/exec-1/read_only_data_source/requirements.txt
```

### 3. Execution Lifecycle
```
Create → Link Data → Run Codons → Checkpoint → Complete/Rollback
```

### 4. Rollback Creates New Run
```
Execution-1/Run-1 → Rollback → Execution-1/Run-2
                                (continues from checkpoint)
```

## Best Practices

### 1. Data Organization
- Keep data sources focused and cohesive
- Exclude large binary files from tracking
- Use `.gitignore` to control what's accessible
- Single files work well for specifications, configurations, or data files

### 2. Execution Management
- Use `--start-new` for independent experiments
- Clean up old executions periodically
- Monitor execution directory disk usage

### 3. Performance Optimization
- Minimize tracked file patterns
- Use symlinks when possible (default)
- Checkpoint only necessary files

## Troubleshooting

### Cannot Find Execution
Check data hash hasn't changed:
```bash
# Data modifications change the hash
touch data/new-file.txt  # Changes hash!
echo "new line" >> file.txt  # Changes hash for files!
```

### Symlink Fails
Force copy mode:
```bash
bun run server --data=/path/to/project --copy
```

### Execution Space Usage
Monitor with:
```bash
du -sh ~/.strandweave-executions/*
```

Clean old executions:
```bash
bun run server --cleanup --data=/path/to/project
```

## Template Variables in Prompts

When writing prompts, you can use these template variables:

- `<%EXECUTION_DIR%>` - The execution directory path
- `<%DATA_DIR%>` - Always resolves to `<execution-dir>/read_only_data_source`

Example:
```markdown
Please read the requirements from <%DATA_DIR%> and create a project plan in <%EXECUTION_DIR%>/plan.md
```

This works consistently whether your data source is a file or directory.

## Output Files and Results Directory

Strandweave can automatically copy files from the execution directory back to your project through the **strandweave-results** mechanism.

### Results Directory Location

Output files are copied to:
```
<your_project_root>/strandweave-results/
```

This directory is automatically created and contains accumulated output from successful codons.

### Output File Flow

```
Codon Execution → beforeCopy commands → copy patterns → strandweave-results/
```

1. **Codon executes** in the isolated execution directory
2. **beforeCopy commands** run to prepare files (optional)  
3. **Copy patterns** match files to copy
4. **Files are copied** to `strandweave-results/` where you run the command from
5. **Results accumulate** across multiple codons

### Results vs Execution Directory

| Location | Purpose | Persistence |
|----------|---------|-------------|
| `~/.strandweave-executions/<id>/` | Isolated execution environment | Temporary |
| `<project>/strandweave-results/` | User-accessible output | Persistent |

The strandweave-results directory provides a clean interface to access codon outputs without navigating temporary execution directories.

**Note on Sentinel Outputs**: The `outputFiles` mechanism described above is for the main agent's codon outputs. Outputs from parallel Sentinel agents are handled separately. They can be configured via the `settings.outputPaths` in the codon's `sentinels` array, or they will be auto-generated inside the `.strandweave/sentinels/outputs/` directory. See the Sentinel configuration guides for more details.
