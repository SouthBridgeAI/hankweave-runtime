# Fixing Execution Directory Behavior

## From Step 1 Agent

This task is about cleaning up confusing and cumbersome behavior around execution directories and the validation mode in Hankweave. The most important thing here is that the current implementation has two main issues: the `--start-new` flag fails when a directory exists (even though intuitively it should just start fresh there), and the `--validate` flag creates a new directory unnecessarily when it should just perform preflight checks without any side effects. The task also mentions it's related to ENG-88, which implemented the ability to run strands in existing directories with the `--start-new` and `--force` flags. My main questions are: (1) Should `--validate` work on a hypothetical execution directory without actually creating it, or should it work in the current directory? (2) What exactly constitutes "nothing wrong with it" when deciding whether to run in an existing directory? (3) Should we prevent resuming entirely when using `--start-new`, or just make it not the default behavior? The user Hrishi Olickel added a comment "This is a comment for fun" which doesn't provide additional context but confirms the ticket is being actively worked on.

## Original Task

From Linear ticket ENG-90 (https://linear.app/southbridge/issue/ENG-90):

**Title:** Fixing execution directory behavior

**Status:** In Progress

**Priority:** 1 (High)

**Description:**
> The overall behavior around execution directories makes for a cumbersome experience:
>
> * --start-new fails if the directory exists.
> * --validate creates a new directory for some reason.
>
> Let's clean up a bit. (also related to ENG-88) - here's the behavior we want:
>
> 1. Validate doesn't make a directory or start up the server. It just runs a comprehensive preflight check to make sure that the server with all the currently enabled settings (whether that's resume, start new, etc) will work once validate flag is removed.
>
> 2. --start-new will create a dir if it doesn't exist,
>    1. if --force is on, backup .strandweave in existing dir, overwrite read_only_data_source in existing dir, otherwise fail
>    2. or run in directory if nothing wrong with it
> 3. neither will try to resume in a directory.

**Labels:** Improvement

**Related Task:** ENG-88 (Status: Done) - "Run strands in existing run directories"

From the input task file, there's also a specific note:
> "we also want to check whether simply running with an execution directory in params makes hankweave make that directory (--start-new if the dir doesn't exist). If not we want it to!"

## Expanded Understanding

Looking at the current implementation in `server/execution-setup.ts` and `server/index.ts`, Hankweave has a sophisticated execution directory management system with three safety tiers. The problem is that the behavior is inconsistent and confusing in several ways.

### Current Behavior (What's Wrong)

**Problem 1: `--start-new` fails if directory exists**

Currently, when you run `hankweave --start-new --execution /some/path`, if that path already exists, the code has complex tiered logic. The intent from the Linear ticket is that `--start-new` should mean "I want to start a fresh execution" and should handle existing directories intelligently rather than failing. Right now at line 175-197 in execution-setup.ts, when `startNew` is true and the directory exists with a `.hankweave` folder, it either backs up (with `--force`) or throws an error (without `--force`). This is good behavior! But the confusion comes from the interaction with the auto-managed directories.

**Problem 2: `--validate` creates a directory**

The validation mode is supposed to be a dry-run preflight check that verifies the configuration without actually setting up execution infrastructure. However, looking at index.ts line 259-272, the code calls `setupExecutionEnvironment()` BEFORE the validation happens. This means that even in validation mode, a full execution directory is created, data is copied/symlinked, and metadata files are written. This is wasteful and confusing for users who just want to check if their hank configuration is valid.

**Problem 3: Confusion about resuming**

The current implementation (when `--start-new` is NOT provided) automatically tries to resume existing executions by looking for directories with matching data hashes (execution-setup.ts line 318-325). The ticket says "neither will try to resume in a directory" which suggests that `--start-new` should explicitly mean "don't resume, start fresh" but the current behavior already does this somewhat.

### Related Work: ENG-88

ENG-88 was about enabling Hankweave to run in existing (non-empty) directories rather than only in clean auto-managed directories. From the YAML, Hrishi's thinking was:
1. If there's no `.strandweave` folder (note: the code uses `.hankweave` but the ticket says `.strandweave` - this might be a naming inconsistency!), just run.
2. If there is a `.strandweave` folder, require `--start-new` which will backup the old folder and start fresh, with appropriate warnings.

This was marked as "Done" and supposedly implemented in PR #71 (though the PR link returned a 404, so it might be in a private repo or the URL structure is different).

### Desired Behavior (What We Want)

**For `--validate` mode:**
- Should NOT create any directories
- Should NOT write any files
- Should NOT start the server
- Should perform comprehensive preflight checks including:
  - Parse and validate hank.json structure
  - Verify all referenced prompt files exist
  - Validate model configurations
  - Check rig setup commands are valid
  - Verify loop termination conditions
  - Check tracked file patterns
  - Simulate what WOULD happen if validation flag was removed
- Should work whether or not an execution directory exists

**For `--start-new` flag:**
- When execution directory path is provided AND doesn't exist: create it
- When execution directory path is provided AND exists:
  - If it has `.hankweave` (or `.strandweave`?):
    - With `--force`: backup existing `.hankweave`, overwrite `read_only_data_source`, start fresh
    - Without `--force`: fail with clear error message
  - If it doesn't have `.hankweave`: treat as empty directory and run (with tier 3 safety warnings)
- When no execution directory path provided (auto-managed):
  - Always create a new directory in `~/.hankweave-executions/`
  - Never resume an existing execution
- Should NEVER attempt to resume a previous execution

**For default behavior (no `--start-new`, no `--execution`):**
- Auto-detect existing execution directories by data hash
- Resume if found
- Create new if not found

**For `--execution` without `--start-new`:**
- If directory exists and has metadata: resume
- If directory exists without metadata: treat as new execution
- If directory doesn't exist: error (don't auto-create)

## Questions and Considerations

**Question 1: The .hankweave vs .strandweave naming**
The code consistently uses `.hankweave` as the hidden directory name (see execution-setup.ts line 265, 379), but the Linear ticket ENG-88 mentions `.strandweave`. The description in ENG-90 also says "backup .strandweave in existing dir" which suggests this might be old naming or there's some inconsistency. We need to clarify: is this just old documentation using the old name "strand"/"strandweave" from before the project was renamed to "Hank"/"Hankweave"? I believe this is the case - the tickets were written when thinking about the conceptual model but the actual implementation uses `.hankweave`.

**Question 2: What does "nothing wrong with it" mean?**
In point 2.2 of the desired behavior, it says "or run in directory if nothing wrong with it". What constitutes "nothing wrong"? My interpretation is:
- Directory exists
- Directory doesn't have `.hankweave` folder (meaning no previous Hankweave execution)
- User is okay with Hankweave agents having read/write access to the directory

The current tier 3 safety logic (execution-setup.ts line 199-228) handles this by showing a warning and asking for confirmation, which seems like the right approach.

**Question 3: How should validate mode determine execution path?**
Since `--validate` shouldn't create directories, but it needs to know WHERE to validate against (for resolving relative paths in the hank config), should it:
- Option A: Use the current working directory for path resolution
- Option B: Do a "dry run" of execution directory logic without actually creating anything
- Option C: Require an execution directory to be specified when using `--validate`

I believe Option B makes the most sense - simulate the full execution setup logic to determine what WOULD be created, verify all paths would work, but don't actually create anything.

**Question 4: Should the auto-create behavior apply to --execution paths?**
The input task note says: "we also want to check whether simply running with an execution directory in params makes hankweave make that directory (--start-new if the dir doesn't exist). If not we want it to!"

This is asking whether `hankweave --execution /some/new/path` should auto-create that directory if it doesn't exist. Currently, without `--start-new`, it throws an error (execution-setup.ts line 244-246). The note suggests we should auto-create with `--start-new` semantics. But this creates ambiguity: does `--execution /some/path` mean "resume here" or "start new here"?

My interpretation is that we should keep the current behavior for `--execution` alone (error if doesn't exist), but `--execution /some/path --start-new` should auto-create the directory. This makes the intent explicit.

**Question 5: Overwriting read_only_data_source**
Point 2.1 mentions "overwrite read_only_data_source in existing dir" when using `--force`. Currently, the code checks if `read_only_data_source` exists at line 343 and only creates it for new executions. With `--start-new --force`, we should:
- Remove existing `read_only_data_source` if it exists
- Create new symlink/copy to the new data source
- This handles the case where you want to re-run a hank on different data in the same execution directory

**Question 6: Data hash validation**
Currently, when resuming (execution-setup.ts line 267-275), the code verifies the data hash matches. With `--start-new`, should we skip this check since we're explicitly starting fresh? Yes, I think so. The data hash check is for safety when resuming, but `--start-new` is an explicit signal that the user wants to start over, possibly with different data.

## Initial Thoughts on Implementation

This task involves modifying primarily two files:

1. **server/index.ts** - Move validation logic before execution setup
2. **server/execution-setup.ts** - Refactor the directory creation and safety logic

### Implementation Approach

**Part 1: Fix `--validate` mode (Higher Priority)**

The validation flow should be:
1. Parse CLI args
2. Resolve config path
3. If `--validate` flag is set:
   - Perform a dry-run of execution setup to determine paths (without creating anything)
   - Load and validate hank configuration
   - Verify all referenced files
   - Print summary
   - Exit
4. Otherwise, proceed with normal execution setup

Changes needed in `server/index.ts`:
- Create a new function `dryRunExecutionSetup()` that simulates execution setup without side effects
- Move the `validateMode` check from line 327 to much earlier (before line 259)
- Pass the dry-run paths to `validateHank()` instead of real execution paths

**Part 2: Fix `--start-new` behavior (Medium Priority)**

The behavior should be clearer:
- `startNew === true` means "I want a fresh execution, not resuming"
- Combined with explicit execution path: create if doesn't exist, or use existing with safety checks
- Combined with auto-managed path: always create new directory

Changes needed in `server/execution-setup.ts`:
- Simplify the logic at line 172-241 to be clearer about the intent
- When `startNew && executionPath` and directory doesn't exist: create it (currently this works, line 234-236)
- When `startNew && executionPath` and directory exists: current logic is mostly correct, just needs clearer messaging
- When `startNew && !executionPath`: current logic is correct (line 307-316)

**Part 3: Handle read_only_data_source overwriting (Medium Priority)**

Changes needed in `server/execution-setup.ts`:
- At line 343, change the condition from `if (isNewExecution || !fs.existsSync(dataPathInExecutionDir))` to also handle the `--start-new --force` case
- Add logic to remove existing `read_only_data_source` when `startNew && forceMode && fs.existsSync(dataPathInExecutionDir)`
- This should happen before the symlink/copy logic

**Part 4: Clarify "neither will try to resume" (Lower Priority)**

This is mostly already correct. The current code with `startNew === true` will:
- In auto-managed mode: create new directory (never resume) ✓
- In explicit path mode: treat as new execution ✓

The only edge case is if someone does `--execution /existing/path/with/metadata` without `--start-new`. Currently this resumes (line 293). Should we prevent this? Reading the requirement again: "neither will try to resume in a directory" might mean that when you provide `--execution`, it should never auto-resume - you should have to explicitly opt-in to resuming. But this seems like a useful feature to keep. I think "neither" refers to the two main scenarios mentioned (validate and start-new), not all execution modes.

### Testing Considerations

We'll need to verify:
1. `--validate` doesn't create any files or directories
2. `--validate` works with hypothetical execution paths
3. `--validate` catches all the errors it should catch
4. `--start-new --execution /new/path` creates the directory
5. `--start-new --execution /existing/path` works (with appropriate tier 2/3 safety)
6. `--start-new --force --execution /path/with/.hankweave` backs up and starts fresh
7. `--start-new` in auto-managed mode always creates new directory
8. `--start-new --force` overwrites `read_only_data_source` when it exists

### Dependencies and Related Files

Files that will need changes:
- `server/index.ts` - Main entry point, validation mode logic
- `server/execution-setup.ts` - Core execution directory management
- `server/config.ts` - The `validateHank()` function might need updates if it currently assumes directories exist

Files to review for understanding:
- `server/cli-parser.ts` - Already supports all the flags we need
- `server/data-hasher.ts` - Used for finding existing execution directories
- Tests in `tests/e2e/` - Will need to verify existing tests still pass and add new ones

### Edge Cases and Safety

The three-tier safety system is well-designed:
- **Tier 1:** Hard block on using `~/.hankweave-executions/` directly ✓
- **Tier 2:** Require `--force` for directories with existing `.hankweave` ✓
- **Tier 3:** Warn and confirm for non-empty directories ✓

We should preserve this safety while making the behavior more intuitive.

### Open Questions for Implementation

1. Should we add a `--resume` flag to make resuming explicit? (Probably not needed, absence of `--start-new` implies resume is okay)
2. Should `--validate` output differ when `--start-new` is also provided? (Yes, it should note that validation is for a new execution, not a resume)
3. Do we need to update the help text in index.ts to clarify the new behavior? (Yes, definitely)
4. Should we add warnings when data hash or hank hash changes with `--start-new --force`? (The hash check warnings should probably be skipped since `--force` is explicit override)

## Summary for Next Steps

The Step 2 Agent should focus on:
1. Finding all places in the codebase where execution directory setup happens
2. Identifying where validation currently triggers side effects
3. Looking for any tests that might break with these changes
4. Understanding the full flow from CLI parsing through execution setup
5. Examining how `validateHank()` currently works and what it assumes about directory structure
