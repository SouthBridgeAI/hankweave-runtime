# Understanding the Tadpole Execution Model

This guide explains how Tadpole's execution model works, including the relationships between executions, data directories, symlinks, runs, and phases.

## Core Concepts Hierarchy

```
Data Source (Your Project)
    ↓
Execution Directory (Isolated Environment)
    ├── data/ → symlink to Data Source
    └── .tadpole/
        ├── execution-meta.json
        └── state.json
            └── Runs[]
                └── Phases[]
```

## 1. Data Source

Your original project directory containing:
- Source code
- Configuration files
- Documentation
- Any other project assets

**Key Properties:**
- **Read-only**: Never modified by Tadpole
- **Location**: Can be anywhere on your filesystem
- **Identification**: Hashed to create a unique fingerprint

### Data Hash Calculation

The data hash uniquely identifies your project:

```
H(data) = SHA256(∑(f_type : f_path : f_size : f_mtime))
```

Where:
- `f_type` ∈ {d, f, e} (directory, file, error)
- `f_path` = relative path from data root
- `f_size` = file size in bytes (files only)
- `f_mtime` = modification time (seconds since epoch)

## 2. Execution Directory

An isolated workspace where Tadpole operates:

```
~/.tadpole-executions/<timestamp>-<random>-<hash_prefix>/
```

### Execution Directory Naming

```
E_name = T_ms + "-" + R_36(5) + "-" + H_6
```

Where:
- `T_ms` = timestamp in milliseconds since epoch
- `R_36(5)` = 5-character random string (base 36)
- `H_6` = first 6 characters of data hash

**Example**: `1737123456789-abc12-d4f5e6`

## 3. Data Access via Symlinks

The data directory is accessed through:

```
<execution_dir>/data/ → <data_source_path>
```

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
    phases: PhaseExecution[],
    parent: RunId | null  // for rollback continuations
}
```

### Run ID Generation

```
RunId = T_ms + "-" + R_36(7)
```

## 5. Phases

Phases are the atomic units of work:

### Phase State Machine

```
State transitions:
preparing → starting → initializing → running → {completed, failed, skipped}
```

### Phase Execution Time

Total phase time calculation:

```
T_phase = T_setup + T_init + T_claude + T_checkpoint
```

Where:
- `T_setup` = workspace setup time
- `T_init` = Claude process initialization
- `T_claude` = Claude execution time
- `T_checkpoint` = git checkpoint creation time

## 6. Cost Calculations

### Token Cost Formula

```
C_phase = (T_in × R_in) + (T_out × R_out)
```

Where:
- `T_in` = input tokens
- `R_in` = input token rate ($/1M tokens)
- `T_out` = output tokens
- `R_out` = output token rate ($/1M tokens)

### Total Execution Cost

```
C_total = ∑(C_phase) for all phases in execution thread
```

## 7. Execution Thread

The logical sequence across multiple runs:

### Thread Construction Algorithm

```
Thread = []
current_run = latest_run

while current_run:
    for phase in reverse(current_run.phases):
        if phase.id not in Thread.ids:
            Thread.prepend(phase)

    if current_run.parent:
        current_run = find_run(current_run.parent)
        skip_phases_after(current_run.continuation_point)
    else:
        break
```

## 8. Checkpoint Storage

### Checkpoint Size Estimation

```
S_checkpoint = ∑(f_size) for all f matching tracked_patterns
```

### Storage Growth Rate

```
dS/dt = N_phases × S_avg_checkpoint × F_change
```

Where:
- `N_phases` = phases per hour
- `S_avg_checkpoint` = average checkpoint size
- `F_change` = fraction of files changed per phase

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
    → ~/.tadpole-executions/exec-1/ (approach A)
    → ~/.tadpole-executions/exec-2/ (approach B)
    → ~/.tadpole-executions/exec-3/ (approach C)
```

### 2. Execution Lifecycle
```
Create → Link Data → Run Phases → Checkpoint → Complete/Rollback
```

### 3. Rollback Creates New Run
```
Execution-1/Run-1 → Rollback → Execution-1/Run-2
                                (continues from checkpoint)
```

## Best Practices

### 1. Data Organization
- Keep data sources focused and cohesive
- Exclude large binary files from tracking
- Use `.gitignore` to control what's accessible

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
```

### Symlink Fails
Force copy mode:
```bash
bun run server --data=/path/to/project --copy
```

### Execution Space Usage
Monitor with:
```bash
du -sh ~/.tadpole-executions/*
```

Clean old executions:
```bash
bun run server --cleanup --data=/path/to/project
