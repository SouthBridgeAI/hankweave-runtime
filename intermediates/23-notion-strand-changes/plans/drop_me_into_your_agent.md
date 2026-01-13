# Implementation Guide: Strandweave CLI/UX Improvements

**IMPORTANT**: You are about to implement a set of 7 related CLI and user experience improvements to Strandweave. This guide is designed to maximize the quality of implementation by front-loading all decisions that require user input, ensuring the user is consulted properly before any code is written.

**Philosophy**: Think of yourself as a technical consultant reviewing an architecture plan with a client. Your job is to understand the requirements deeply, walk the user through all decisions like a doctor explaining treatment options, and only start coding once you have explicit approval for each choice.

---

## Table of Contents

1. [How to Use This Guide](#how-to-use-this-guide)
2. [Overview and Context](#overview-and-context)
3. [CRITICAL: Pre-Implementation User Consultation](#critical-pre-implementation-user-consultation)
4. [Implementation Order and Dependencies](#implementation-order-and-dependencies)
5. [Conventions and Guidelines](#conventions-and-guidelines)
6. [Progress Tracking](#progress-tracking)
7. [Testing Strategy and Boundaries](#testing-strategy-and-boundaries)
8. [Cross-Task Implications](#cross-task-implications)
9. [Task-Specific Details](#task-specific-details)

---

## How to Use This Guide

### Step 1: Read This Guide Thoroughly
Read this entire document to understand the scope, the decisions, and the implementation order. Do not skim.

### Step 2: Read All Plan Files
Load and read each of the 7 final-standalone plan files. They contain deep analysis and specific implementation details that this guide summarizes but does not replace.

### Step 3: Conduct User Consultation
Before writing ANY code, present ALL decision points to the user in an organized fashion. Explain each decision, the reasoning, and get explicit confirmation. As the user responds, update the plan files with their feedback.

### Step 4: Create Progress Notes File
Create `implementation_progress_notes.md` in this directory to track problems, bugs, and judgement calls as you work.

### Step 5: Implement Sequentially
Follow the implementation order exactly. For each task:
1. Use TodoWrite to create granular TODOs
2. Load the specific plan file
3. Implement methodically
4. Test before moving to next task
5. Update progress notes

---

## Overview and Context

### What is Strandweave?

Strandweave is an orchestration runtime for antibrittle agentic workflows. It breaks LLM coding tasks into atomic units called "Codons" executed in isolation, providing time-travel (rollbacks), observability (sentinels), and rigorous execution boundaries.

**Key concepts you must understand:**
- **Codon**: Atomic unit of work with a specific prompt, file boundary, and model. Think of it as a "phase" of a larger task.
- **Strand**: Sequence of codons defined in `strand.json`. This is the "DNA" of a workflow.
- **Execution Directory**: Isolated workspace in `~/.strandweave-executions/` where agents work. Your original data is never modified directly.
- **Shadow Git**: Checkpoint system that saves state after each codon completes. Enables rollback to previous states.
- **Sentinel**: Parallel observer that watches the event stream (for documentation, security, etc.)

### Codebase Structure

```
server/                   # Main runtime code (TypeScript, runs on Bun)
  index.ts               # Main entry point, CLI parsing (many tasks modify this)
  config.ts              # Strand configuration schema and loading
  execution-setup.ts     # Execution environment creation (Tasks 4 & 5 modify this)
  strandweave-runtime.ts # Main orchestration logic
  codon-runner.ts        # Individual codon execution
  checkpoint-git.ts      # Shadow Git system
  types/types.ts         # TypeScript type definitions
  schemas/               # Zod schemas

tests/
  unit/                  # Unit tests
  integration/           # Integration tests
  e2e/                   # End-to-end tests

intermediates/23-notion-strand-changes/plans/  # THIS DIRECTORY
  00-index.md                                   # Master index (READ FIRST)
  final-standalone-1-repository-link-strand.md # Task 7
  final-standalone-2-command-line-improvements.md # Task 2
  final-standalone-3-simple-input-text-data.md # Task 3
  final-standalone-4-rename-trackedfiles.md    # Task 1
  final-standalone-5-config-warnings-resume.md # Task 4
  final-standalone-6-existing-run-directories.md # Task 5
  final-standalone-7-frontmatter-prompts.md    # Task 6
  supporting-docs/                             # Original research and analysis
```

### Conventions from CLAUDE.md (MUST FOLLOW)

1. **Ignore** `tests/test-area` and `tests/test-results` when using grep
2. **Ignore** `intermediates/` unless explicitly instructed
3. **Don't commit** without asking the user first
4. **Always read files first** before proposing changes. Your first assumptions are often wrong.
5. **Use `bun lint:fix` and `bun tc`** to check your results
6. **DO NOT RUN `bun test`** - ask the user to run tests (they're expensive)
7. **Don't loosen types** - understand what's happening before opening up types
8. **Beware the optional type pattern** - it lets problems through

---

## CRITICAL: Pre-Implementation User Consultation

**THIS SECTION IS NOT OPTIONAL**. Before writing any code, you must walk through ALL decision points with the user.

### Why This Matters

These 7 tasks involve architectural decisions that affect user workflows. Making the wrong choice means rework later. Spending 15-20 minutes upfront to confirm decisions will save hours of back-and-forth during implementation.

### Process for User Consultation

1. **Read all 7 plan files completely**
2. **Prepare a comprehensive message** covering ALL decisions
3. **Present decisions grouped by task**
4. **For each decision**:
   - Explain the context (what is being decided and why it matters)
   - State the current recommendation
   - Explain the rationale and alternatives considered
   - Ask if they want to change it
5. **As the user responds**, update the relevant plan files with their feedback
6. **Get explicit "proceed" approval** before starting implementation

### The Complete Decision Checklist

Below is the EXHAUSTIVE list of all decision points. Present these to the user in an organized, easy-to-read format.

---

#### Task 1: ENG-92 - Rename trackedFiles to checkpointedFiles
**Plan file**: `final-standalone-4-rename-trackedfiles.md`

**Decision 1.1: Deprecation Timeline**

*Context*: The old field name `trackedFiles` needs to be deprecated. Users have existing strand.json files using the old name that should continue to work during a transition period.

*Current recommendation*: Three-phase deprecation:
- Phase 1 (current release): Accept both names, emit deprecation warning when old name used
- Phase 2 (next release): Louder/more prominent warning
- Phase 3 (later): Remove old name (breaking change)

*Rationale*: This gives users time to update their configurations while being reminded to do so. Breaking existing workflows immediately would be disruptive.

*Question for user*: Is this timeline appropriate, or should we support both names indefinitely (never breaking existing configs)?

---

#### Task 2: ENG-106 - Command Line Behavior Improvements
**Plan file**: `final-standalone-2-command-line-improvements.md`

**Decision 2.1: Backward Compatibility Strategy**

*Context*: Currently CLI arguments use equals syntax (`--config=value`). We want to add space-separated syntax (`--config value`) and positional arguments (`strandweave strand.json /data`). The question is whether to eventually remove the old syntax.

*Current recommendation*: Support all three formats PERMANENTLY with no deprecation period:
```bash
strandweave strand.json /data              # Positional (new)
strandweave --config strand.json           # Space-separated (new)
strandweave --config=strand.json           # Equals (old, still works)
```

*Rationale*: This is easy to implement and means existing scripts never break. Documentation can show "preferred" style while noting alternatives work.

*Question for user*: Is there any reason to eventually deprecate the equals syntax, or is permanent support the right approach?

---

**Decision 2.2: TUI as Default Behavior**

*Context*: Currently the Terminal UI (TUI) is opt-in via `--basic` flag. Users often forget to add it and get confused by the non-interactive mode.

*Current recommendation*: Make TUI the default. Add `--headless` flag to disable it for CI/CD.

*Behavior change*:
- Before: Server starts headless unless `--basic` provided
- After: Server starts in TUI mode unless `--headless` provided

*Rationale*: TUI provides better UX for interactive use, which is the common case. The TUI is non-blocking, so it shouldn't break scripts.

*Question for user*: Are there CI/CD scenarios where defaulting to TUI would cause problems? Even though the TUI is non-blocking, this is a behavior change that might surprise some automation.

---

**Decision 2.3: Relative Path Investigation (ENG-21)**

*Context*: There's a separate ticket (ENG-21) about relative paths not working. However, the Step 2 Agent analyzed the code and found that it appears to already handle relative paths correctly. The code saves the original working directory before any `process.chdir()` calls and uses that saved value for path resolution.

*Current recommendation*: Write comprehensive tests for relative paths FIRST. If tests pass, close ENG-21 as "already works" and update documentation. If tests fail, fix the specific edge case.

*Rationale*: Don't change working code. Test first to confirm the current behavior.

*Question for user*: Is there a specific reproduction case where relative paths fail? Or can we proceed with testing and close ENG-21 if tests pass?

---

#### Task 3: ENG-93 - Simple Input Text as Data
**Plan file**: `final-standalone-3-simple-input-text-data.md`

**Decision 3.1: stdin Convention**

*Context*: We want to allow piping text input to Strandweave (e.g., `echo "text" | strandweave strand.json -`). The question is what marker to use for stdin.

*Current recommendation*: Use `-` to represent stdin, following the universal Unix convention established by Ken Thompson.

*Examples*:
```bash
echo "Analyze this text" | strandweave strand.json -
echo "Analyze this text" | strandweave --data=-
cat spec.md | strandweave strand.json -
```

*Rationale*: This is the standard Unix convention used by almost all CLI tools. Users already expect `-` to mean stdin.

*Question for user*: Confirm this convention is acceptable?

---

**Decision 3.2: Inline Text Flag Name**

*Context*: For quick experiments, users might want to provide text directly without piping. We need a flag name.

*Current recommendation*: `--data-text="text"` for providing inline text.

*Example*:
```bash
strandweave strand.json --data-text="Design a REST API for a todo app"
```

*Rationale*: `--data-text` clearly indicates this is text being used as data, distinguishing it from `--data` which is a path.

*Question for user*: Is this flag name intuitive? Any preference for alternatives like `--text`, `--input`, or `--data-inline`?

---

#### Tasks 4 & 5: ENG-91 & ENG-88 - Execution Safety
**Plan files**: `final-standalone-5-config-warnings-resume.md` and `final-standalone-6-existing-run-directories.md`

These two tasks are implemented together because they both modify `execution-setup.ts` and share related concerns about execution safety.

**Decision 4.1: Three-Tier Safety System Strictness**

*Context*: Currently Strandweave refuses to run in non-empty directories. This is too restrictive for practical workflows where users want to run in their project directories. We need to add flexibility while maintaining safety.

*Current recommendation*: Three-tier safety system:

| Tier | Condition | Behavior |
|------|-----------|----------|
| 1 | Path inside `~/.strandweave-executions/` | **Hard error** - Always blocked. This is reserved for auto-managed executions. |
| 2 | Directory contains `.strandweave/` | **Hard error** unless `--force` flag provided. With `--force`, creates timestamped backup and proceeds. |
| 3 | Non-empty directory without Strandweave | **Warning + confirmation prompt**. User must confirm (or use `-y` to skip). |

*Rationale*:
- Tier 1 protects the managed execution space from corruption
- Tier 2 prevents accidental overwrite of previous execution state but allows explicit override
- Tier 3 enables legitimate workflow (running in project dir) while ensuring user awareness

*Question for user*: Is this strictness appropriate? Some users might prefer Tier 2 to be a warning+prompt (like Tier 3) instead of a hard error requiring `--force`. Would you like the default behavior to be more permissive?

---

**Decision 4.2: Security Warning Prominence**

*Context*: When running in an existing directory, Strandweave agents will have access to read and modify files in that directory. Users need to understand this risk.

*Current recommendation*: Display a prominent warning showing:
- File and directory count in the target
- Explicit statement: "Strandweave agents will have access to READ and MODIFY files in this directory"
- Reminder to use version control
- Confirmation prompt

*Example warning*:
```
⚠️  WARNING: Running in existing non-empty directory: /home/user/my-project

  This directory contains 147 files and 23 directories.
  Strandweave agents will have access to READ and MODIFY files in this directory.

  IMPORTANT: Always use version control. Test strands on non-critical directories first.

Continue? [y/N]
```

*Question for user*: Is this warning sufficient? Should it be more explicit about potential risks? Should we add documentation links to the warning?

---

**Decision 4.3: Config Change Sensitivity (Whitespace)**

*Context*: When resuming an execution, we need to detect if the strand.json has changed. We do this by storing a SHA-256 hash of the file content.

*Current recommendation*: Hash the raw file content. This means whitespace changes (reformatting JSON, changing indentation) WILL trigger a warning.

*Rationale*: Any change to the config file should be noted. Users who reformat their JSON have technically modified the file.

*Alternative*: Normalize JSON before hashing (parse, sort keys, re-stringify). This would ignore formatting changes but adds complexity and could miss some edge cases.

*Question for user*: Is whitespace sensitivity the right behavior? Or should we normalize to ignore formatting-only changes?

---

#### Task 6: ENG-87 - Frontmatter on Prompts
**Plan file**: `final-standalone-7-frontmatter-prompts.md`

**Decision 6.1: Strict Schema Validation**

*Context*: We're adding YAML frontmatter support to prompt files. When parsing frontmatter, we need to decide what to do with unknown fields.

*Current recommendation*: Strict validation - reject unknown fields with a helpful error message.

*Example error*:
```
Error: Invalid frontmatter in prompts/analyze.md
Unknown field "modle". Did you mean "model"?
Allowed fields: model, continuationMode, name, description, tags, version, author
```

*Rationale*: Rejecting unknown fields catches typos immediately. If someone types `modle: opus` instead of `model: opus`, they'll know right away instead of silently having their setting ignored.

*Alternative*: Allow custom fields using an `x-` prefix (similar to HTTP headers). For example, `x-internal-version: 2024-Q4` would be allowed but ignored.

*Question for user*: Is strict validation too restrictive? Should we support custom fields with an `x-` prefix for user-specific metadata?

---

**Decision 6.2: Precedence Order for Configuration**

*Context*: The same configuration (like model selection) can now be specified in multiple places: CLI flags, prompt frontmatter, codon config in strand.json, strand-level recommendations, and defaults. We need a clear precedence order.

*Current recommendation*: Most specific wins:
```
CLI flags > Prompt frontmatter > Codon config > Strand recommendations > Defaults
```

*Example*:
- Strand.json has `"model": "sonnet"` at codon level
- Prompt file has `model: opus` in frontmatter
- User runs with `--model=haiku`
- **Result**: Uses `haiku` (CLI wins)

*Rationale*: CLI is the most explicit and immediate override. Frontmatter is more specific than codon config because it's "closer" to the actual prompt. Strand recommendations are the broadest.

*Alternative view*: Some users might expect codon config in strand.json to override prompt frontmatter since strand.json is the "orchestrating" document that controls execution.

*Question for user*: Is this precedence intuitive? Or should codon config override frontmatter (making strand.json authoritative)?

---

**Decision 6.3: Metadata Display in TUI**

*Context*: Prompt files can now include metadata like name, version, and author. The question is whether to display this in the TUI when a codon starts.

*Current recommendation*: Store metadata in execution state (for debugging and audit trail) but don't display it during normal execution.

*Alternative*: Show metadata in TUI when codon starts, e.g.:
```
Starting codon: analyze
  Prompt: "TypeScript Analyzer v1.2.0" by Jane Smith
  Model: opus
```

*Question for user*: Should the TUI show prompt metadata (name, version, author) when a codon starts? This could help users understand which version of a prompt is being used.

---

#### Task 7: ENG-105 - Repository Link Strand
**Plan file**: `final-standalone-1-repository-link-strand.md`

This is the most complex task. It enables running strands directly from Git repository URLs.

**Decision 7.1: Cache TTL for Branch References**

*Context*: When a user runs a strand from a branch (like `@main`), we need to decide how long to cache it before checking for updates.

*Current recommendation*: 1 hour default TTL for branch references.

| Reference Type | Cache Behavior |
|---------------|----------------|
| Commit SHA | Cache forever (immutable) |
| Tags | Cache until explicit `--update-cache` |
| Branches | Check for updates after TTL (default: 1 hour) |
| No version | Always fetch latest on default branch |

*Rationale*: 1 hour balances freshness with avoiding excessive network requests. Commit SHAs never change so can be cached forever. Tags are assumed stable but can be force-updated.

*Question for user*: Is 1 hour appropriate for branch caching? Should this be configurable via an environment variable like `STRANDWEAVE_CACHE_TTL`?

---

**Decision 7.2: Security Prompt Model for Remote Strands**

*Context*: Remote strands can contain rig setup commands that execute on the user's system. This is a security risk. We need to warn users and get confirmation.

*Current recommendation*: Three scenarios:
1. **First run**: Always prompt with strand summary (unless `--yes` flag)
2. **Cached run (unchanged)**: Skip prompt if strand.json content matches what was previously approved
3. **Updated run**: Prompt again if strand.json content differs from previous execution

*Example first-run prompt*:
```
Downloading strand from: https://github.com/user/repo@main

Strand configuration summary:
  - Name: "Code Analyzer"
  - Codons: 3
  - Models: sonnet
  - Rig setup operations: 2
    1. Copy: ../templates/config.json -> config/analyzer.json
    2. Command: npm install

This strand will execute commands on your system.
Review the strand configuration at: ~/.strandweave-cache/strands/github.com/user/repo/main/strand.json

Do you want to continue? [y/N]
```

*Question for user*: Is this security model sufficient? Should there also be a whitelist file (e.g., `~/.strandweave/trusted-repos.json`) in addition to the `STRANDWEAVE_TRUST_REPOS` environment variable?

---

**Decision 7.3: Trust Environment Variable Format**

*Context*: Power users in CI/CD environments want to skip security prompts for known-good repositories. We need a way to whitelist them.

*Current recommendation*: Environment variable `STRANDWEAVE_TRUST_REPOS` as a comma-separated list.

*Example*:
```bash
export STRANDWEAVE_TRUST_REPOS="github.com/myorg/strands,github.com/trusted/repo"
```

*Question for user*: Should this support glob patterns (e.g., `github.com/my-org/*` to trust all repos in an org) or only exact matches?

---

### How to Present This to the User

**Template for your consultation message:**

```
I've read through all 7 implementation plans for the Strandweave CLI/UX improvements. Before I start coding, I need to walk you through the key decision points to make sure we implement exactly what you want.

This is similar to how a doctor would explain treatment options - I'll present each decision, explain the reasoning, state the current recommendation, and ask for your confirmation or changes.

There are [X] decisions across 7 tasks. Let's go through them:

---

## Task 1: Rename trackedFiles (ENG-92)

### Decision 1.1: Deprecation Timeline
[Full explanation as above]

Your response: (approve / modify / question)

---

## Task 2: CLI Improvements (ENG-106)

### Decision 2.1: Backward Compatibility
[Full explanation]

### Decision 2.2: TUI as Default
[Full explanation]

[Continue for all decisions...]

---

After you've confirmed these decisions, I will:
1. Update the plan files with your feedback
2. Create granular TODOs for the first task
3. Begin implementation in the recommended order

You can respond with:
- "Approve all" if all recommendations look good
- Specific changes you want for particular decisions
- Questions about any decision you'd like clarified
```

---

## Implementation Order and Dependencies

Implement in this exact order. The order is based on dependencies, risk, and logical grouping.

### Phase 1: Independent Quick Win

**Task 1 - ENG-92: Rename trackedFiles to checkpointedFiles**
- **Why first**: Completely independent, no runtime risk, improves clarity for all subsequent work
- **Plan**: `final-standalone-4-rename-trackedfiles.md`
- **Key files**: `server/config.ts`, `server/strandweave-runtime.ts`, `server/types/types.ts`
- **When to test**: After completing all code changes, before moving to Task 2

### Phase 2: CLI Foundation

**Task 2 - ENG-106: Command Line Behavior Improvements**
- **Why second**: Foundational work that Tasks 3, 5, and 7 build on
- **Plan**: `final-standalone-2-command-line-improvements.md`
- **Key insight**: Test relative paths BEFORE implementing changes (ENG-21 may already work)
- **Key files**: `server/index.ts`, `server/config.ts`
- **When to test**: After implementing all CLI changes, before Task 3

**Task 3 - ENG-93: Simple Input Text as Data**
- **Why after Task 2**: Uses the same argument parsing patterns introduced in Task 2
- **Plan**: `final-standalone-3-simple-input-text-data.md`
- **New capability**: `--data=-` for stdin, `--data-text="text"` for inline
- **Key files**: `server/index.ts`, `server/execution-setup.ts`
- **When to test**: After implementation, before Phase 3

### Phase 3: Execution Safety

**Tasks 4 & 5 - ENG-91 & ENG-88: Config Warnings + Existing Directories**
- **Why together**: BOTH modify `execution-setup.ts` heavily and share related concerns
- **Plans**: `final-standalone-5-config-warnings-resume.md` AND `final-standalone-6-existing-run-directories.md`
- **CRITICAL**: Read BOTH plans before starting. Map out all changes to `execution-setup.ts` first.
- **Key files**: `server/execution-setup.ts`, `server/index.ts`
- **When to test**: After implementing both features together, before Phase 4

### Phase 4: New Capabilities

**Task 6 - ENG-87: Frontmatter on Prompts**
- **Why here**: Adds a new npm dependency (`gray-matter`)
- **Plan**: `final-standalone-7-frontmatter-prompts.md`
- **First step**: Run `bun add gray-matter` before writing any code
- **New file**: `server/prompt-frontmatter.ts`
- **When to test**: After implementation, before Task 7

**Task 7 - ENG-105: Running Strands from Repository URLs**
- **Why last**: Most complex task, builds on CLI patterns from Phase 2
- **Plan**: `final-standalone-1-repository-link-strand.md`
- **New file**: `server/strand-downloader.ts`
- **When to test**: After implementation (this is the final task)

---

## Conventions and Guidelines

### Code Style

1. **TypeScript strict mode**: All code must type-check with `bun tc`
2. **Zod for validation**: Use Zod schemas for all config validation (follow existing patterns in `config.ts`)
3. **Error messages**: Include actionable recovery steps. Tell users what they can do to fix the problem.
4. **Logging**: Use existing logger patterns from `strandweave-runtime.ts`

### File Naming

- **New modules**: kebab-case (e.g., `strand-downloader.ts`, `prompt-frontmatter.ts`)
- **Test files**: Mirror source structure with `.test.ts` suffix
- **Types**: Define in `server/types/types.ts` or co-locate if module-specific

### Git Workflow

**CRITICAL**: Do not commit without asking the user first.

When user asks for commit:
1. Run `git status` to see all changes
2. Run `git diff` to show what changed
3. Run `git log` to see recent commit message style
4. Draft a descriptive commit message
5. Include Co-Authored-By line
6. Run `git status` after commit to verify success

### Reading Before Editing

**ALWAYS read files before proposing changes**. Your first assumptions are often wrong. The plans contain deep analysis, but the codebase may have evolved. Verify current state before modifying.

---

## Progress Tracking

### TODO Management

**Use the TodoWrite tool proactively and GRANULARLY throughout implementation.**

**When to create TODOs:**
- At the start of each task (break down the plan into concrete steps)
- When you discover subtasks during implementation
- When tests fail and you need to track fixes

**TODO granularity:**
- Each step in the implementation plan = 1 TODO
- Each file to modify = 1 TODO
- Each test suite to write = 1 TODO
- Each bug discovered = 1 TODO

**Example TODO structure for Task 2 (CLI Improvements):**
```
1. [in_progress] Read server/index.ts and understand current parsing
2. [pending] Add getArgValue() helper function
3. [pending] Update CLI validation patterns to accept space-separated
4. [pending] Add extractPositionals() function
5. [pending] Update precedence logic (flags > positionals > defaults)
6. [pending] Make TUI default, add --headless flag
7. [pending] Change proxy default to off in config.ts
8. [pending] Update help text with new syntax
9. [pending] Write unit tests for getArgValue
10. [pending] Write unit tests for extractPositionals
11. [pending] Write unit tests for precedence rules
12. [pending] Test relative paths (ENG-21 investigation)
13. [pending] Update README with new syntax examples
14. [pending] Run bun lint:fix and bun tc
15. [pending] Ask user to run tests
```

**Mark TODOs complete IMMEDIATELY** after finishing each step. Do not batch completions.

### Implementation Progress Notes

**CREATE AND MAINTAIN `implementation_progress_notes.md` in this directory.**

This file is CRITICAL for tracking problems, bugs, and judgement calls. It also provides an audit trail.

**Structure:**
```markdown
# Implementation Progress Notes

## Task 1: ENG-92 - Rename trackedFiles

### Date: [DATE]

**Completed:**
- [List of completed items]

**Problems encountered:**
- [Problem]: [Description]
- [Solution]: [How you fixed it]

**Judgement calls:**
- [Decision you made]: [Rationale]

**User feedback:**
- [Any feedback from user discussions]

**Next steps:**
- [What's next]

---

## Task 2: ENG-106 - CLI Improvements

[Continue as you work...]
```

**Update this file:**
- After completing each logical chunk of work
- When you make judgement calls
- When you encounter problems
- When you discover cross-task implications
- When the user provides feedback

---

## Testing Strategy and Boundaries

### Per-Task Testing

**After implementing each task, but BEFORE moving to the next task:**

1. **Run lint and type check (you do this):**
   ```bash
   bun lint:fix
   bun tc
   ```

2. **Ask user to run tests (they do this):**
   - Specify which test files to run
   - Wait for confirmation that tests pass

3. **Do not proceed to next task until tests pass**

### Testing Boundaries by Task

| Task | Unit Tests To Write | Integration Tests To Write | When to Ask User to Run |
|------|--------------------|-----------------------------|-------------------------|
| 1 (rename trackedFiles) | Schema migration logic | Old name still works, new name works | After all code changes |
| 2 (CLI improvements) | getArgValue, extractPositionals, precedence | All three formats work, relative paths | After all parsing changes |
| 3 (input text) | Input type detection, temp file naming | Temp file creation, content preservation | After implementation |
| 4 & 5 (execution safety) | Tier detection, hash computation, codon comparison | Backup creation, warning prompts, resume blocking | After BOTH implemented together |
| 6 (frontmatter) | Frontmatter parsing, schema validation, multi-file | Precedence chain works correctly | After implementation |
| 7 (repository URLs) | URL parsing, cache path generation | Cache behavior (TTL, immutability), security prompts | After implementation |

### E2E Tests

For each task that adds user-facing behavior, add tests to the existing `tests/e2e/happy-path-e2e.test.ts` suite. This avoids the overhead of creating separate E2E test files.

### Manual Testing

Some features require manual testing because they involve user prompts or terminal interaction. Document manual test steps in your progress notes and ask the user to verify.

**Features requiring manual testing:**
- TUI mode (Task 2)
- Security prompts for non-empty directories (Task 5)
- Config change warning prompts (Task 4)
- Security prompts for remote strands (Task 7)

---

## Cross-Task Implications

### Files Modified by Multiple Tasks

Understanding which files are modified by which tasks helps avoid merge conflicts and understand dependencies.

| File | Tasks Modifying It | Strategy |
|------|-------------------|----------|
| `server/index.ts` | 2, 3, 4, 5, 7 | Implement in order. Read entire file before each modification. |
| `server/execution-setup.ts` | 4, 5 | Implement Tasks 4 & 5 TOGETHER. Map out all changes first. |
| `server/config.ts` | 1, 2 | Task 1 modifies schema, Task 2 modifies defaults. Low conflict risk. |
| `server/types/types.ts` | 1, 4, 6 | Additive changes. Low conflict risk. |
| `README.md` | All tasks | Make small, targeted updates after each task. |

### Shared Patterns to Keep Consistent

**User confirmation prompts** (used by Tasks 4, 5, 7):
- Use consistent phrasing: `Continue? [y/N]`
- Respect `-y` flag to skip prompts
- Respect environment variables (e.g., `STRANDWEAVE_IGNORE_CONFIG_CHANGES`)
- Use `readline` module consistently

**Error message formatting** (all tasks):
- Explain what went wrong
- Provide actionable recovery steps
- Reference specific flags or commands that can help

**Help text updates** (Tasks 2, 3, 7):
- Organize consistently (arguments first, then options)
- Include examples for major features
- Keep alphabetical order for flag listings

### Dependency Chain

```
Task 1 (rename trackedFiles)
    ↓
Task 2 (CLI improvements) ← Establishes parsing patterns
    ↓
Task 3 (input text) ← Uses Task 2 patterns
    ↓
Tasks 4 & 5 (execution safety) ← Must implement together
    ↓
Task 6 (frontmatter) ← Independent but uses conventions
    ↓
Task 7 (repository URLs) ← Most complex, uses all patterns
```

---

## Task-Specific Details

For each task, load the specific plan file when starting. The plan files contain implementation details, code snippets, and testing strategies that this guide summarizes.

### Task 1: ENG-92 - Rename trackedFiles

**Load when starting**: `final-standalone-4-rename-trackedfiles.md`

**Summary**: Rename the `trackedFiles` field to `checkpointedFiles` with automatic migration for backward compatibility.

**Key implementation points:**
- Add `checkpointedFiles` as the primary field in Zod schema
- Add Zod transform to migrate `trackedFiles` → `checkpointedFiles`
- Add refinement to error if BOTH names provided
- Emit deprecation warning when old name used
- Update all runtime code to use new name
- Update TypeScript types
- Update tests and README

**Critical files:**
- `server/config.ts` (schema definition and validation)
- `server/strandweave-runtime.ts` (runtime usage)
- `server/types/types.ts` (TypeScript interface)

**Testing focus:**
- Schema migration works correctly
- Old name still works (backward compat)
- Both names simultaneously throws error
- Deprecation warning appears

---

### Task 2: ENG-106 - Command Line Improvements

**Load when starting**: `final-standalone-2-command-line-improvements.md`

**Summary**: Modernize CLI to support space-separated flags, positional arguments, TUI by default, and proxy off by default.

**Key implementation points:**
- Add `getArgValue()` helper to handle both `--flag=value` and `--flag value`
- Add `extractPositionals()` to get non-flag arguments
- Implement precedence: flags > positionals > defaults
- Change basicMode logic: TUI default, `--headless` to disable
- Change proxy default to true in DEFAULT_CONFIG
- Update validation patterns to accept new formats
- Update help text

**Relative paths investigation (ENG-21):**
1. FIRST: Write tests for relative paths
2. If tests pass: Close ENG-21 as "already works", update docs
3. If tests fail: Fix the specific edge case

**Critical files:**
- `server/index.ts` (all CLI parsing logic)
- `server/config.ts` (proxy default change)

**Testing focus:**
- All three argument formats work (positional, space, equals)
- Precedence is correct
- TUI is default, --headless works
- Backward compatibility preserved

---

### Task 3: ENG-93 - Simple Input Text as Data

**Load when starting**: `final-standalone-3-simple-input-text-data.md`

**Summary**: Allow users to provide text input via stdin (`-`) or inline (`--data-text`).

**Key implementation points:**
- Add `readStdin()` async function
- Create temp files in `os.tmpdir()` with unique names
- Detect stdin marker (`-`) and inline text (`--data-text`)
- Store input source metadata in execution state
- Update help text and validation patterns

**Key insight from plan**: "File support ALREADY EXISTS in the code. What's missing is creating files from stdin or inline text." This means you only need to create the temp file, then existing logic handles it.

**Critical files:**
- `server/index.ts` (input detection and temp file creation)
- `server/execution-setup.ts` (metadata storage)

**Testing focus:**
- stdin detection works
- Inline text detection works
- Precedence is correct (--data-text > --data > positional)
- Temp files created with correct content
- Metadata recorded correctly

---

### Tasks 4 & 5: ENG-91 & ENG-88 - Execution Safety

**Load when starting**: BOTH `final-standalone-5-config-warnings-resume.md` AND `final-standalone-6-existing-run-directories.md`

**CRITICAL**: Read both plans before starting. Both heavily modify `execution-setup.ts`.

**Summary (ENG-91)**: Add strand config change detection on resume. Store SHA-256 hash of strand.json in execution metadata, compare on resume, warn or block.

**Summary (ENG-88)**: Allow running in existing non-empty directories with three-tier safety system.

**Key implementation points:**
- Add Tier 1 check (block managed execution directory)
- Add Tier 2 check (block existing .strandweave unless --force)
- Add Tier 3 warning (non-empty directory)
- Add `--force` flag support
- Add config hash storage and comparison
- Add codon ID tracking for incompatible change detection
- Add user confirmation prompts

**Coordination strategy:**
1. Read both plans together
2. Map out ALL changes to `execution-setup.ts`
3. Implement in single coherent flow
4. Test both features together

**Critical files:**
- `server/execution-setup.ts` (BOTH tasks modify this heavily)
- `server/index.ts` (config check after setup, --force flag)
- `server/types/types.ts` (new interfaces)

**Testing focus:**
- Tier 1, 2, 3 detection correct
- Backup creation works
- Warning prompts appear correctly
- Hash computation is deterministic
- Incompatible changes blocked
- Compatible changes warn and allow

---

### Task 6: ENG-87 - Frontmatter on Prompts

**Load when starting**: `final-standalone-7-frontmatter-prompts.md`

**Summary**: Add YAML frontmatter support to prompt markdown files for metadata and configuration overrides.

**FIRST STEP**: Run `bun add gray-matter` before writing any code.

**Key implementation points:**
- Create `server/prompt-frontmatter.ts` module
- Define strict Zod schema for frontmatter fields
- Implement `loadPromptWithFrontmatter()` function
- Implement `loadPromptFiles()` for multiple prompt files (first wins)
- Integrate with codon loading
- Implement precedence chain: CLI > Frontmatter > Codon > Strand > Defaults
- Store metadata in execution state

**Critical files:**
- `server/prompt-frontmatter.ts` (NEW file)
- `server/codon-runner.ts` or equivalent (integration)
- `server/types/types.ts` (new interface)

**Testing focus:**
- Frontmatter parsing works
- Unknown fields rejected with helpful error
- Multiple files: first with frontmatter wins
- Precedence chain correct
- Metadata stored in execution state

---

### Task 7: ENG-105 - Running Strands from Repository URLs

**Load when starting**: `final-standalone-1-repository-link-strand.md`

**Summary**: Enable running strands directly from Git repository URLs with caching, versioning, and security prompts.

**This is the most complex task.** Take your time. Read the plan carefully.

**Key implementation points:**
- Create `server/strand-downloader.ts` module
- Implement URL detection (`isStrandUrl`)
- Implement URL parsing with version extraction (`@ref` suffix)
- Implement cache structure (`~/.strandweave-cache/strands/`)
- Implement cache behavior by reference type (SHA forever, tags until update, branches with TTL)
- Implement security prompt showing strand summary
- Implement trust tracking (hash comparison for subsequent runs)
- Add flags: `--update-cache`, `--offline`, `--yes`, `--list-cache`, `--clean-cache`

**Critical files:**
- `server/strand-downloader.ts` (NEW file)
- `server/index.ts` (URL detection and resolution)

**Testing focus:**
- URL detection correct (HTTPS, HTTP, SSH formats)
- URL parsing handles edge cases (@ in path, etc.)
- Cache paths are consistent and unique
- TTL logic correct for different reference types
- Security prompts appear at right times
- Invalid strands cleaned from cache
- Offline mode works

---

## Final Checklist Before Starting

Before you begin coding, confirm:

- [ ] I have read this entire guide
- [ ] I have read all 7 final-standalone plan files
- [ ] I have read the 00-index.md master overview
- [ ] I have presented ALL decision points to the user
- [ ] I have documented the user's responses in the plan files
- [ ] I have created `implementation_progress_notes.md`
- [ ] I understand the implementation order and dependencies
- [ ] I understand which files are modified by which tasks
- [ ] I have received explicit approval to start coding

---

## Getting Started

Once user consultation is complete:

1. **Create TODOs for Task 1** using TodoWrite
2. **Load** `final-standalone-4-rename-trackedfiles.md`
3. **Read** `server/config.ts` to understand current schema
4. **Implement** methodically, one step at a time
5. **Update** progress notes as you go
6. **Test** with `bun lint:fix` and `bun tc`
7. **Ask user** to run relevant tests
8. **Get approval** before moving to Task 2

**Remember:**
- Front-load questions - get all user input upfront
- Update plan files with decisions
- Track every step with TODOs
- Document problems and judgement calls in progress notes
- Don't commit without asking
- Read files before editing
- Trust the plans - they contain deep analysis

Good luck! The plans are comprehensive and well-researched. Follow them closely, communicate frequently with the user, and you'll deliver high-quality implementations.
