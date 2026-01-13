# ENG-91: Config warnings when resuming on a previous execution directory

## From Step 3 Agent

Hash-based change detection is well-established in configuration management. Research shows [network devices use SHA-256 hashes for config change detection](https://arubanetworking.hpe.com/techdocs/AOS-CX/10.14/HTML/fundamentals_8400/Content/Chp_Cfg_FW_mgt/Chk_cmds/sho-run-cfg-hash.htm), and [comparing current hash with cached versions is standard practice](https://offlinetools.org/tools/file-hash-compare). The Step 2 recommendation to store both hash and metadata (codon count, IDs) is smart - it enables informative warnings about what changed. SHA-256 is the right choice (industry standard, fast, collision-resistant for this use case). Consider making the warning even more detailed: show which codons were added/removed/reordered, not just that the config changed. This helps users make informed decisions about whether to proceed.

## From Step 2 Agent

Currently only data hash is verified on resume (execution-setup.ts line 107), not strand config. Recommend storing strand.json hash + metadata (codon count, IDs) in execution-meta.json on first run, then comparing on resume. If hash differs, show loud warning with details of what changed, and prompt user to confirm (unless `-y` flag provided). Low complexity (~150 lines, half day). Implementation: (1) extend execution-meta.json with strandConfig field containing hash and metadata, (2) add comparison logic in server/index.ts after line 248, (3) display warning and prompt user. Also consider STRANDWEAVE_IGNORE_CONFIG_CHANGES env var for automation.

## From Step 1 Agent

This task investigates a bug where resuming a Strandweave execution produces spurious warnings about copy targets being overwritten, followed by an execution thread failure and rollback. The error message suggests the validation system is checking for file conflicts even when resuming an existing run where those files naturally already exist from the previous execution. The question "Is this expected?" in the issue description indicates uncertainty about whether this is intentional behavior or a bug. The Step 1 Agent believes this is clearly a bug - resume operations should skip validation checks that only make sense for fresh starts, as the execution directory state is expected to match the checkpoint being resumed from.

---

## Linear Task Information

**Identifier:** ENG-91
**Title:** Config warnings when resuming on a previous execution directory
**Status:** In Progress
**Priority:** Medium
**Labels:** Bug
**Created:** 2025-12-18 by Hrishi Olickel
**Assignee:** None (unassigned)

### Original Description

Hrishi wrote: "If the server was shut down and then resumed, we get this message:

```
⚠️  Configuration warnings:
  - Codon 1 (build-pre-loop): Copy target \"eval-suite\" already exists and will be overwritten

[2025-12-18T10:18:07.538Z] [ERROR] Execution thread failed, rolling back...
```

Is this expected?"

### Comments

No comments on this issue.

### Related Issues

No related issues linked.

---

## Step 1 Agent Analysis

### Understanding the Problem

When a Strandweave run is resumed (after being stopped or crashed), the system is showing a configuration warning about copy targets that "already exist and will be overwritten." This warning is followed by an execution failure and rollback.

The Step 1 Agent interprets this as follows: The warning system is designed to catch potential problems before execution starts. One of these checks is looking at `outputFiles` copy targets and warning if they already exist in the destination (presumably the `strandweave-results/` directory).

This check makes perfect sense for a fresh run:
```json
{
  "outputFiles": [
    {"copy": ["eval-suite"]}
  ]
}
```

If `strandweave-results/eval-suite` already exists from a previous run, warning the user makes sense - "Hey, we're about to overwrite your previous results!"

However, when resuming an execution, this check is inappropriate because:
1. The execution directory already exists (that's what we're resuming)
2. Files in `strandweave-results/` are likely from the run we're resuming
3. We expect to overwrite them as the run continues
4. This is not an error condition

### The Real Question: Is This Expected?

Hrishi asks "Is this expected?" The Step 1 Agent's answer is: No, this is clearly a bug. The validation/warning system should differentiate between:

- **Fresh start** - Warn about potential overwrites
- **Resume** - Don't warn about files that are expected to exist from the previous execution

### Why Does It Cause Execution Failure?

The error message shows:
```
[ERROR] Execution thread failed, rolling back...
```

This suggests the warning is somehow being treated as a fatal error when resuming, or there's a subsequent problem triggered by the warning state. The Step 1 Agent hypothesizes several possibilities:

**Hypothesis 1: Warnings treated as errors in resume mode**
The validation system might have stricter failure conditions when resuming, causing warnings to escalate to errors.

**Hypothesis 2: Side effect of validation**
The validation check might be doing something destructive (like trying to create directories or modify state) that conflicts with the existing execution state.

**Hypothesis 3: Unrelated failure**
The warning and the failure might be coincidental - the actual failure could be something else entirely, and the warning just happens to be logged first.

The Step 2 agent will need to investigate the actual code to determine which hypothesis is correct.

### Expected Behavior

When resuming an execution, the system should:

1. **Skip fresh-run validation checks** - Checks like "output directory already exists" are irrelevant when resuming
2. **Perform resume-specific validation** - Instead, check things like:
   - Does the execution directory have valid checkpoint state?
   - Is the strand.json being used compatible with the checkpointed state?
   - Are we resuming from a clean checkpoint or was the previous run interrupted mid-codon?
3. **Continue from checkpoint** - Load the state and continue execution without treating existing files as errors

### Understanding the Context: outputFiles

From the README, `outputFiles` is a codon-level configuration that specifies which files to copy from the execution directory to the `strandweave-results/` directory:

```json
{
  "outputFiles": [
    {"copy": ["analysis.md"]}
  ]
}
```

The warning mentions "Codon 1 (build-pre-loop): Copy target \"eval-suite\" already exists." This tells us:
- This is from the first codon in the strand
- That codon is named "build-pre-loop"
- It's trying to copy something called "eval-suite" (probably a directory)
- The target location already has "eval-suite" from a previous run

### When Is Overwriting a Real Problem?

The Step 1 Agent thinks the overwrite warning IS valuable in certain scenarios:

**Scenario 1: Fresh run with existing results**
```bash
# User runs a strand
strandweave ./strand.json ./data

# Files are written to strandweave-results/

# User runs again with --start-new
strandweave --start-new ./strand.json ./data
```

In this case, warning that we're about to overwrite previous results is helpful.

**Scenario 2: Different data, same output location**
```bash
strandweave ./strand.json ./data1  # outputs to ./strandweave-results/
strandweave ./strand.json ./data2  # also outputs to ./strandweave-results/
```

Warning about overwriting results from data1 when running on data2 is valuable.

### Solution Approach

The Step 1 Agent proposes this solution:

1. **Differentiate run modes** - The validation system needs to know if this is:
   - A fresh run (--start-new or default)
   - A resume (implicit resume when execution directory exists)

2. **Conditional validation** - Apply different validation rules:
   - **Fresh run:** Check for output conflicts, warn user
   - **Resume:** Skip output conflict checks, focus on checkpoint validity

3. **Resume-specific checks** - Add validation that's only relevant for resumes:
   - Execution directory has valid `.strandweave/` state
   - Checkpoint history is not corrupted
   - Strand config hasn't changed in incompatible ways (?)

4. **Clear error messages** - If validation fails, explain WHY in the context of resuming:
   - Not: "Copy target already exists" (confusing when resuming)
   - Instead: "Cannot resume: checkpoint state is corrupted" or similar

### Question: Should Strand Config Changes Block Resume?

An interesting edge case: What if the user modifies strand.json between stopping and resuming? For example:

1. Start run with codon that outputs to `eval-suite`
2. Stop the run mid-execution
3. Edit strand.json to change the output location
4. Resume

Should this be allowed? The Step 1 Agent thinks:
- **Probably not** - The checkpoint state assumes a specific strand configuration
- **But maybe** - If the change is to a codon that hasn't executed yet, it might be safe
- **Definitely document** - Whatever the behavior, it should be clearly documented

This is something the Step 2 agent should consider when investigating the code.

### Testing Strategy

Tests should cover:
1. Resume with existing output files (should not warn)
2. Fresh run with existing output files (should warn)
3. Resume after modifying strand.json (define expected behavior)
4. Resume with corrupted checkpoint state (should fail with clear error)
5. Resume with missing output files (should not cause errors)

### Relationship to ENG-90

ENG-90 is about "Fixing execution directory behavior" and has "Urgent" priority. It's related but distinct:
- **ENG-90** focuses on how --start-new and --validate behave
- **ENG-91** focuses on warnings/errors when resuming

However, both touch on the broader issue of execution directory lifecycle management. The Step 1 Agent suspects the fixes for these might need to be coordinated.

### Relationship to ENG-88

ENG-88 is about "Run strands in existing run directories" and describes behavior for handling .strandweave folders. This is closely related to ENG-91:
- **ENG-88** defines policy: when to backup, when to fail, when to continue
- **ENG-91** is a specific bug in the resume case

ENG-88's proposed behavior is:
```
1. If there's no .strandweave folder, just go ahead and run.
2. If there is, require `start-new`, which will backup the old .strandweave folder and start fresh.
```

If this policy is implemented, it might naturally fix ENG-91 by clarifying when resume happens vs when fresh start happens.

### Implementation Scope

The Step 1 Agent believes fixing this bug requires:

1. **Investigation** - Find where the "Copy target already exists" warning is generated
2. **Context detection** - Determine if we're resuming or starting fresh
3. **Conditional validation** - Skip inappropriate checks when resuming
4. **Testing** - Add tests that resume executions and verify no spurious warnings
5. **Documentation** - Clarify resume behavior in README

### Open Questions for Step 2

The Step 2 agent should investigate:

- Where is the "Copy target already exists" warning generated? (Probably in `server/config-validation/` or `server/execution-setup.ts`)
- How does the system currently detect if it's resuming vs starting fresh?
- What causes the "Execution thread failed" error after the warning?
- Are there other validation checks that should be skipped during resume?
- How do ENG-88 and ENG-90's changes affect this bug?
- Can we reproduce this bug with a minimal test case?
