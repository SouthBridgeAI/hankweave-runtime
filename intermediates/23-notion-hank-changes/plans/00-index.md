# Hankweave CLI/UX Improvements - Implementation Index

This document serves as the master plan for a batch of CLI and user experience improvements to Hankweave. Read this document first, then follow the links to individual implementation plans.

## Context

**Hankweave** is an orchestration runtime for antibrittle agentic workflows. It breaks LLM coding tasks into atomic units called "Codons" executed in isolation, providing time-travel (rollbacks), observability (sentinels), and rigorous execution boundaries.

The codebase is primarily in the `server/` directory, written in TypeScript and running on Bun. The main entry point is `server/index.ts`, with key modules including:
- `execution-setup.ts` - Execution environment creation and validation
- `config.ts` - Hank configuration schema and loading
- `codon-runner.ts` - Individual codon execution
- `hankweave-runtime.ts` - Main runtime orchestration
- `checkpoint-git.ts` - Shadow Git system for rollbacks

## Tasks Overview

This batch contains seven related improvements to Hankweave's command-line interface and developer experience:

| # | Ticket | Title | Priority | Complexity | Dependencies |
|---|--------|-------|----------|------------|--------------|
| 1 | ENG-92 | [Rename trackedFiles to checkpointedFiles](final-standalone-4-rename-trackedfiles.md) | Medium | Low | None |
| 2 | ENG-106 | [Command Line Behavior Improvements](final-standalone-2-command-line-improvements.md) | High | Medium | None |
| 3 | ENG-93 | [Simple Input Text as Data](final-standalone-3-simple-input-text-data.md) | High | Low | ENG-106 (patterns) |
| 4 | ENG-91 | [Config Warnings on Resume](final-standalone-5-config-warnings-resume.md) | Medium | Low | None |
| 5 | ENG-88 | [Run in Existing Directories](final-standalone-6-existing-run-directories.md) | Medium | Low-Medium | Overlaps ENG-91 |
| 6 | ENG-87 | [Frontmatter on Prompts](final-standalone-7-frontmatter-prompts.md) | Medium | Low-Medium | None (new dep) |
| 7 | ENG-105 | [Repository Link Hank](final-standalone-1-repository-link-hank.md) | Medium | Medium | ENG-106 (patterns) |

## Recommended Implementation Order

The tasks should be implemented in the following order, based on dependencies, risk, and logical grouping:

### Phase 1: Independent Quick Wins

**1. ENG-92: Rename trackedFiles to checkpointedFiles**
- [`final-standalone-4-rename-trackedfiles.md`](final-standalone-4-rename-trackedfiles.md)
- Complexity: Low (~4-6 hours)
- Why first: Completely independent, no runtime risk, improves clarity
- Files: `server/config.ts`, `server/hankweave-runtime.ts`, `server/types/types.ts`

### Phase 2: CLI Foundation

**2. ENG-106: Command Line Behavior Quality of Life Improvements**
- [`final-standalone-2-command-line-improvements.md`](final-standalone-2-command-line-improvements.md)
- Complexity: Medium (~1-2 days)
- Why second: Foundational work that other tasks build on
- Includes: Space-separated flags, positional arguments, TUI default, proxy off by default
- Key insight: ENG-21 (relative paths) may already work - the plan recommends testing before changing

**3. ENG-93: Run Hanks with Simple Input Text as Data**
- [`final-standalone-3-simple-input-text-data.md`](final-standalone-3-simple-input-text-data.md)
- Complexity: Low (~75 lines of new code)
- Why after ENG-106: Uses the same parsing patterns introduced in CLI improvements
- Adds: `--data=-` for stdin, `--data-text="text"` for inline input

### Phase 3: Execution Safety

**4 & 5. ENG-91 + ENG-88: Config Warnings and Existing Directories**
- [`final-standalone-5-config-warnings-resume.md`](final-standalone-5-config-warnings-resume.md)
- [`final-standalone-6-existing-run-directories.md`](final-standalone-6-existing-run-directories.md)
- Complexity: Low-Medium combined (~1 day)
- Why together: Both modify `execution-setup.ts` and share related concerns
- ENG-91 adds hash-based config change detection on resume
- ENG-88 implements three-tier safety for running in existing directories

### Phase 4: New Capabilities

**6. ENG-87: Frontmatter on Prompts**
- [`final-standalone-7-frontmatter-prompts.md`](final-standalone-7-frontmatter-prompts.md)
- Complexity: Low-Medium (~1 day)
- Why here: Adds a new dependency (`gray-matter`)
- Enables: YAML metadata in prompt files, model overrides at prompt level

**7. ENG-105: Running Hanks from Repository URLs**
- [`final-standalone-1-repository-link-hank.md`](final-standalone-1-repository-link-hank.md)
- Complexity: Medium (~2-3 days)
- Why last: Most complex, builds on CLI patterns from Phase 2
- Adds: `hankweave --config=https://github.com/user/repo@v1.0.0`

## Key Judgement Calls Requiring User Input

Before implementation begins, the following decisions should be confirmed:

### CLI Behavior (ENG-106)

1. **Backward compatibility forever vs deprecation period**
   - Current recommendation: Support both old (`--config=value`) and new (`--config value`) syntax permanently
   - Question: Is there any reason to eventually deprecate the equals syntax?

2. **TUI as default behavior**
   - Current recommendation: TUI on by default, `--headless` to disable
   - Question: Are there CI/CD scenarios where this would cause problems? The TUI is non-blocking, but this is a behavior change.

3. **Relative path handling (ENG-21)**
   - The Step 2 Agent believes this already works. The plan recommends testing before implementing changes.
   - Question: Can we close ENG-21 as "already works" if tests pass, or is there a specific reproduction case?

### Execution Safety (ENG-88)

4. **Three-tier safety strictness**
   - Tier 1 (managed directory `~/.hankweave-executions/`): Always blocked
   - Tier 2 (existing `.hankweave/`): Blocked unless `--force` (creates backup)
   - Tier 3 (non-empty directory): Warning + prompt
   - Question: Is the strictness of these tiers appropriate? Some users may want Tier 2 to be a warning+prompt instead of error.

5. **Security warning prominence**
   - Running in existing directories gives agents access to modify files
   - Question: Is the warning message ("Hankweave agents will have access to READ and MODIFY files") sufficient?

### Repository URLs (ENG-105)

6. **Cache TTL for branches**
   - Current recommendation: 1 hour default for branch references
   - Question: Is 1 hour appropriate? Should this be configurable?

7. **Security prompt for remote hanks**
   - First-run always prompts showing hank summary (unless `--yes`)
   - Question: Is the security model sufficient? Should there be a whitelist file in addition to environment variable?

### Frontmatter (ENG-87)

8. **Strict schema validation**
   - Current recommendation: Reject unknown frontmatter fields to catch typos
   - Question: Could this be too strict? Should there be an `x-` prefix for custom fields like HTTP headers?

9. **Precedence order**
   - CLI > Frontmatter > Codon config > Hank recommendations > Defaults
   - Question: Is this intuitive? Some users might expect codon config to override prompt frontmatter since it's "closer" to the codon definition.

## Cross-Cutting Concerns

### Shared Code Patterns

Several tasks introduce similar patterns that should be consistent:

1. **User prompts for confirmation**
   - ENG-88, ENG-91, ENG-105 all add confirmation prompts
   - Should use consistent phrasing: `Continue? [y/N]`
   - Should all respect `-y` flag and `HANKWEAVE_*` environment variables

2. **Error message formatting**
   - New error messages should follow existing patterns
   - Include actionable recovery steps
   - Reference specific flags or commands that can help

3. **Help text structure**
   - ENG-106 significantly expands help text
   - Other tasks (ENG-93, ENG-105) add to it
   - Should be organized consistently with examples

### Testing Strategy

Each plan includes testing recommendations. Key integration tests to coordinate:

1. **CLI parsing tests** - Should cover all combinations of old/new syntax
2. **Path resolution tests** - Verify relative paths work from various locations
3. **Execution safety tests** - Test all three tiers with various flag combinations
4. **Resume behavior tests** - Config change detection and warning display

### Documentation Updates

Several tasks require README updates:

1. ENG-106: New CLI syntax examples (make positional arguments the "preferred" style)
2. ENG-92: Update all examples using `trackedFiles` to `checkpointedFiles`
3. ENG-87: New section on prompt frontmatter
4. ENG-105: New section on remote hanks

These should be coordinated to avoid conflicting edits.

## Files Most Affected

| File | Tasks Modifying It |
|------|-------------------|
| `server/index.ts` | ENG-106, ENG-93, ENG-91, ENG-88, ENG-105 |
| `server/execution-setup.ts` | ENG-91, ENG-88 |
| `server/config.ts` | ENG-92, ENG-106 |
| `server/hankweave-runtime.ts` | ENG-92 |
| `server/types/types.ts` | ENG-92, ENG-91, ENG-87 |
| `README.md` | All tasks |

## New Files

| Task | New File |
|------|----------|
| ENG-105 | `server/hank-downloader.ts` |
| ENG-87 | `server/prompt-frontmatter.ts` |

## New Dependencies

| Task | Dependency | Reason |
|------|------------|--------|
| ENG-87 | `gray-matter` | YAML frontmatter parsing |

Note: ENG-105 uses `simple-git` which is already a dependency (used by `checkpoint-git.ts`).

## Supporting Documentation

Each plan references supporting documents with original analysis from Steps 1-3:

- `supporting-docs/*-full-task.md` - Original task with Step 1/2/3 agent analysis
- `supporting-docs/*-related-code.md` - Codebase integration points identified by Step 2
- `supporting-docs/*-changes-decisions-and-judgement-calls.md` - Technical decision analysis

These provide additional context but are not required for implementation. The final-standalone plans contain all necessary information.

## Summary

This batch improves Hankweave's CLI ergonomics and adds powerful new capabilities:

1. **Better CLI** (ENG-106): Modern syntax, sensible defaults
2. **Flexible Input** (ENG-93): Stdin and inline text support
3. **Shareable Hanks** (ENG-105): Run hanks directly from Git repositories
4. **Safer Execution** (ENG-88, ENG-91): Better warnings and controls
5. **Self-Documenting Prompts** (ENG-87): Metadata in prompt files
6. **Clearer Naming** (ENG-92): `checkpointedFiles` instead of `trackedFiles`

Total estimated effort: 5-7 days of focused implementation work.
