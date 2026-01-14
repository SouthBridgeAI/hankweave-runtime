# ENG-88: Run hanks in existing run directories

## From Step 3 Agent

The three-tier safety system proposed in Step 2 is well-designed and follows security best practices. The key insight is distinguishing between "this is obviously dangerous" (Tier 1: inside .hankweave-executions), "this needs explicit confirmation" (Tier 2: existing Hankweave state), and "user might know what they're doing" (Tier 3: non-empty directory). This mirrors how other tools handle potentially destructive operations - Git won't let you init in a repo but warns about untracked files, Docker warns about overwriting containers, etc. The documentation requirements are critical: users MUST understand they're giving an AI agent filesystem access in their project directory. Consider adding a first-time setup warning that creates a `.hankweave-agreed-to-risks` marker file, so users explicitly acknowledge the risks the first time they run in a project directory.

## From Step 2 Agent

Current restriction (execution-setup.ts lines 63-69) prevents running in non-empty directories with `--start-new`. This is too restrictive - users want to run in project directories. Recommend implementing three-tier safety: (1) Hard error for ~/.hankweave-executions/, (2) Hard error if .hankweave/ already exists, (3) Warning + prompt for other non-empty directories. Implementation: remove restriction but add safety checks (~200 lines, 4-5 hours). Critical: add loud warnings so users understand agents have filesystem access. This enables key workflow: `cd ~/my-project && hankweave --execution=. --start-new`. Document prominently in README with security warnings.

## From Step 1 Agent

This task addresses a valuable workflow improvement: allowing users to run hanks in directories that already contain work or data, rather than forcing fresh execution directories every time. The current limitation is that Hankweave seems to either fail or behave unexpectedly when trying to run in a non-empty directory. The proposed solution is pragmatic: if no `.hankweave` folder exists (meaning this directory hasn't been used for a Hankweave run), proceed normally; if one does exist (indicating a previous run), require `--start-new` with a backup mechanism to preserve the old checkpoint state. This change would enable useful patterns like iterating on a hank against the same working directory or re-running failed hanks without manual cleanup.

---

## Linear Task Information

**Identifier:** ENG-88
**Title:** Run hanks in existing run directories
**Status:** In Progress
**Priority:** Medium
**Labels:** Improvement
**Created:** 2025-12-18 by Hrishi Olickel
**Assignee:** None (unassigned)

### Original Description

Hrishi wrote: "This in some ways is figuring out how to run hanks in non-empty run directories - which is a really really useful feature. My thinking is:

1. If there's no .hankweave folder, just go ahead and run.
2. If there is, require `start-new`, which will backup the old .hankweave folder and start fresh. And warn users this is what will happen."

### Comments

No comments on this issue.

### Related Issues

This task is mentioned in ENG-90 (Fixing execution directory behavior) as a related issue.

---

## Step 1 Agent Analysis

### Understanding the Current Limitation

The Step 1 Agent infers from the task description that Hankweave currently has rigid behavior around execution directories. Based on the README and this issue, it seems that:

1. Hankweave creates a unique execution directory like `~/.hankweave-executions/timestamp-id/`
2. This directory is expected to be clean/empty when starting
3. If you try to run in a directory that already has content, something goes wrong (either fails or behaves unexpectedly)
4. The `.hankweave/` subdirectory contains checkpoint state, logs, events, etc.

The limitation being addressed is: "What if I want to run a hank in a directory that already exists?"

### Use Cases for This Feature

The Step 1 Agent imagines several valuable scenarios:

**Use Case 1: Iterative Development**
```bash
# Run a hank that generates code
hankweave ./code-generator.json ./my-project

# Oops, the hank didn't quite work right
# Edit the hank.json, try again in the same directory
hankweave --start-new ./code-generator.json ./my-project
```

Without this feature, you'd have to manually clean up the directory or use a new directory each time.

**Use Case 2: Working Directory Pattern**
```bash
# User has a working directory they want to use
mkdir ~/my-analysis-workspace
cd ~/my-analysis-workspace

# Run hank here, using the current directory as both execution and output
hankweave ../analyze-hank.json .
```

The user wants to work in a specific location, not in some hidden `~/.hankweave-executions/` directory.

**Use Case 3: Rerunning After Failures**
```bash
# A run crashes midway
hankweave ./hank.json ./data  # creates execution dir with partial results

# Fix the issue, try again
hankweave --start-new ./hank.json ./data  # reuse the same directory
```

**Use Case 4: Pre-populated Environment**
```bash
# User has a directory with some pre-existing setup
mkdir my-env
cd my-env
# ... create some files, set up environment ...

# Now run a hank that builds on this existing content
hankweave ../hank.json .
```

### The Proposed Behavior

Hrishi's proposal is simple and pragmatic:

**Rule 1: No .hankweave folder → Just run**
If the target directory exists but doesn't have a `.hankweave/` folder, treat it as a fresh directory and proceed normally. The presence of other files/folders is OK.

**Rule 2: Has .hankweave folder → Require --start-new**
If the target directory has a `.hankweave/` folder, this indicates a previous Hankweave run. The user must explicitly use `--start-new` to continue.

**Rule 3: --start-new behavior → Backup and warn**
When `--start-new` is used in a directory with existing `.hankweave/`, backup the old `.hankweave/` folder (perhaps to `.hankweave.backup-{timestamp}/`) and start fresh. Warn the user this is happening.

### The Step 1 Agent's Interpretation and Questions

**Question 1: What exactly is being backed up?**
The proposal says "backup the old .hankweave folder." The Step 1 Agent interprets this as:
```bash
# Before --start-new
my-dir/.hankweave/  (old checkpoint state)

# After --start-new
my-dir/.hankweave.backup-2025-12-18-101807/  (archived old state)
my-dir/.hankweave/  (new fresh state)
```

This preserves the history in case the user wants to inspect it later.

**Question 2: What about the other files in the directory?**
The proposal only mentions the `.hankweave/` folder. What happens to other files and folders in the execution directory?

The Step 1 Agent believes:
- **Other files are preserved** - They're not part of the checkpoint state, so starting new doesn't delete them
- **read_only_data_source/ symlink** - This would be recreated to point to the new data location (if data changed)
- **Generated files** - Files created by the previous run would still be there unless explicitly cleaned up

This could be good (preserves work) or bad (stale files interfere with new run). The behavior should be clearly documented.

**Question 3: How does this interact with --force?**
ENG-90 mentions `--force` as a flag that enables more aggressive behavior. The proposed policy there is:
```
if --force is on, backup .hankweave in existing dir,
overwrite read_only_data_source in existing dir,
otherwise fail
```

So `--force` might be the flag that enables the backup behavior? Or is backup always part of `--start-new`? The relationship needs to be clarified.

The Step 1 Agent's best guess at the intended behavior:
- `--start-new` alone: Require directory to be empty (or have no `.hankweave/`)
- `--start-new --force`: Allow using directory with existing `.hankweave/`, backup old state

But this conflicts a bit with ENG-88's description which says just `--start-new` should backup. More investigation needed.

**Question 4: What about non-empty directories without .hankweave?**
Rule 1 says "If there's no .hankweave folder, just go ahead and run." But what if the directory has thousands of files? Should there be any safety checks or warnings?

The Step 1 Agent thinks:
- **Probably no limit** - If the user explicitly specifies that directory, trust their judgment
- **Maybe warn if VERY large** - Like >10,000 files or >1GB
- **Document the behavior** - Make it clear that Hankweave will work in any directory

### Integration with Current Execution Model

The README explains that Hankweave currently:
1. Creates a unique directory in `~/.hankweave-executions/`
2. Mounts data as `read_only_data_source/` symlink
3. Agent works in that isolated directory
4. Results are copied to `hankweave-results/` in user's working directory

This feature request seems to be about allowing users to **specify** the execution directory instead of having it auto-generated. Something like:

```bash
# Current (inferred)
hankweave --config ./hank.json --data ./my-data
# Creates: ~/.hankweave-executions/auto-generated-id/

# Proposed (maybe?)
hankweave --config ./hank.json --data ./my-data --exec-dir ./my-custom-exec-dir
```

Or perhaps the execution directory IS the data directory in some cases? This is unclear from the issue description.

Actually, re-reading the issue, the Step 1 Agent now thinks this might be about a different scenario: What if the auto-generated execution directory from a previous run already exists and you want to reuse it? Like:

```bash
# First run
hankweave ./hank.json ./data
# Creates: ~/.hankweave-executions/123-abc/

# Server crashes

# Try to resume or rerun
hankweave ./hank.json ./data
# Tries to use the same ~/.hankweave-executions/123-abc/ but that has existing state
```

The Step 2 agent will need to look at the actual code to clarify which scenario is being addressed.

### Relationship to ENG-90

ENG-90 is "Fixing execution directory behavior" and is marked as related. Looking at ENG-90's description, it specifies:

```
1. Validate doesn't make a directory or start up the server.
2. --start-new will create a dir if it doesn't exist,
   a. if --force is on, backup .hankweave in existing dir,
      overwrite read_only_data_source in existing dir, otherwise fail
   b. or run in directory if nothing wrong with it
3. neither will try to resume in a directory.
```

This is very detailed and overlaps significantly with ENG-88. The Step 1 Agent thinks:
- **ENG-88** is the higher-level feature request
- **ENG-90** is the detailed specification of how to implement it (plus fixing other directory issues)

They should probably be implemented together.

### Relationship to ENG-91

ENG-91 is about spurious warnings when resuming. If ENG-88/ENG-90's behavior is implemented correctly (proper handling of existing directories), it might naturally fix ENG-91's bug.

### Warning Users

Hrishi emphasizes "And warn users this is what will happen." This is good UX. When the system is about to backup old state, it should clearly communicate:

```
⚠️  Directory contains previous Hankweave run
Backing up old checkpoint state to: .hankweave.backup-2025-12-18-101807/
Starting fresh run...
```

The warning should be shown BEFORE any destructive actions.

### Safety Considerations

Backing up by renaming `.hankweave/` to `.hankweave.backup-*/` is relatively safe because:
1. It doesn't delete data, just moves it
2. The original state can be recovered by renaming back
3. Multiple backups can coexist (if timestamped)

However, there's a risk of accumulating many backup folders over time. Should there be:
- A cleanup command? `hankweave --clean-backups`
- A limit on number of backups? Keep only last N
- Documentation about manually cleaning up?

### Testing Strategy

Tests should cover:
1. Run in empty directory (should work)
2. Run in directory with other files but no `.hankweave` (should work)
3. Run in directory with existing `.hankweave` without `--start-new` (should fail with helpful error)
4. Run with `--start-new` in directory with existing `.hankweave` (should backup and proceed)
5. Verify backup folder contains old checkpoint state
6. Multiple sequential runs in same directory (should create multiple backups)
7. Resume behavior (should not create backups)

### Implementation Scope

The Step 1 Agent believes implementing this requires:

1. **Directory state detection** - Check if directory exists, if it has `.hankweave/`
2. **Backup mechanism** - Rename `.hankweave/` to `.hankweave.backup-{timestamp}/`
3. **Warning system** - Display clear messages about what's happening
4. **Error handling** - Fail with helpful message if preconditions not met
5. **Documentation** - Explain the behavior in README
6. **Tests** - Comprehensive coverage as outlined above

### Open Questions for Step 2

The Step 2 agent should investigate:

- How does Hankweave currently choose/create execution directories? (Look in `server/execution-setup.ts` or `server/index.ts`)
- Can users already specify custom execution directories, or is it always auto-generated?
- What's the current behavior if an execution directory already exists?
- How do resume operations work? Is there already code to detect previous runs?
- Where should the backup logic be implemented?
- How does this interact with the `--validate` flag (per ENG-90)?
