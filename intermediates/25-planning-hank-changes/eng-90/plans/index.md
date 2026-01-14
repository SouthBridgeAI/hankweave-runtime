# Implementation Plans Index

## Overview

This directory contains the implementation plan for a single bug fix in Hankweave's execution directory management system. The task addresses two specific bugs that create a cumbersome user experience: validation mode unnecessarily creating directories, and the `--start-new --force` combination not properly overwriting data sources when reusing execution directories.

## About Hankweave

Hankweave is a runtime for reliable, brownfield AI engineering. It freezes ephemeral agentic behaviors into **Hanks**—declarative, reproducible AI programs that execute deterministically. The system orchestrates agent harnesses (Claude Code, Gemini CLI, and others) to execute hanks reliably, providing execution isolation, checkpointing, event streaming, and rollback capabilities.

The execution directory is a core concept in Hankweave. Each hank execution happens in an isolated directory (either auto-managed in `~/.hankweave-executions/` or explicitly specified by the user) that contains the workspace, read-only data access, execution metadata, and shadow git repository for checkpointing. This bug fix improves how those directories are created and managed.

## Task Summary

| # | Task | Linear ID | Complexity | Priority | Status |
|---|------|-----------|------------|----------|--------|
| 1 | Fixing Execution Directory Behavior | [ENG-90](https://linear.app/southbridge/issue/ENG-90) | Low-Medium | High (P1) | Ready for Implementation |

**Total tasks**: 1
**Dependencies**: None (this is the only task)
**Estimated scope**: Focused bug fix affecting 2 files with 7 implementation steps

## Implementation Plan

Since this is a single focused bug fix, there's only one implementation plan. It can be executed independently.

### [Task 1: Fixing Execution Directory Behavior](./final-standalone-1-fixing-execution-directory-behavior.md)

**What it fixes**:
- Bug 1: `--validate` mode creates execution directories unnecessarily (should perform preflight checks without filesystem side effects)
- Bug 2: `--start-new --force` doesn't overwrite the existing `read_only_data_source` symlink/copy when rerunning in an existing directory with different data

**How it works**:
The fix creates a lightweight `determinePaths()` function that simulates execution setup without side effects, reorders the validation flow in `server/index.ts` to check for `--validate` before calling `setupExecutionEnvironment()`, and updates the data linking condition in `server/execution-setup.ts` to handle the force-overwrite case.

**Key design decisions**:
- Dry-run approach validated against Kubernetes Enhancement Proposal patterns
- Preserves the existing three-tier safety system (intentional, not a bug)
- Uses `fs.promises.rm()` with retry options for cross-platform robustness
- Skips hash validation warnings when user explicitly provides `--start-new --force`

**Files to modify**:
- `./tadpole/server/index.ts` - Add `determinePaths()`, reorder validation flow, update help text
- `./tadpole/server/execution-setup.ts` - Update data linking condition, add data removal logic
- `./tadpole/tests/unit/execution-setup.test.ts` - Add test for force overwrite
- `./tadpole/tests/unit/validate-mode.test.ts` (new) - Add validation mode tests

**Implementation time**: This is a surgical fix with clear, focused changes. The existing codebase has high quality, comprehensive test coverage (598 lines in `execution-setup.test.ts`), and excellent error messages.

## Outstanding Questions

### For Implementation

**Should validation test actual model availability?**

The `validateHank()` function runs self-tests for shims (model adapters), which requires API keys and makes network requests. The current plan recommends keeping this behavior but documenting it clearly. Validation isn't just syntax checking—it's a full preflight check. Engineers should be aware that validation is not offline-only and requires configured API credentials.

**Future enhancement consideration: --dry-run flag?**

Step 2 Agent considered whether to add a separate `--dry-run` flag instead of overloading `--validate`. The decision was to keep it as `--validate` behavior because for most users, "validate my configuration" includes "make sure it will work with these paths." However, if future user feedback indicates confusion, a `--dry-run` flag could be added later without disrupting the current implementation.

## Judgement Calls Summary

Five key decisions were made during the planning process:

1. **Validation mode paths** - Create separate `determinePaths()` function that mirrors `setupExecutionEnvironment()` logic without side effects (validated against Kubernetes KEP dry-run patterns)

2. **Force flag behavior** - Skip data hash check with `--start-new --force` but log a prominent warning about data source changes (matches user intent while maintaining safety)

3. **Auto-create behavior** - Keep current behavior requiring `--start-new` to create directories (prevents ambiguity and accidental directory creation)

4. **Config change warnings** - Skip the hank.json change warning entirely when `startNew === true` (starting fresh means comparing to previous state doesn't make sense)

5. **Data source validation** - Require data source to exist even in validation mode (enables accurate path simulation and early error detection)

All decisions are thoroughly documented with options considered, rationale, and supporting research in the final plan.

## Implementation Checklist

An engineer implementing this task should:

- [ ] Read the [final standalone plan](./final-standalone-1-fixing-execution-directory-behavior.md) completely
- [ ] Understand the three-tier safety system (don't break it!)
- [ ] Implement the 7 steps in order
- [ ] Follow the existing code patterns (emoji prefixes, error message format, etc.)
- [ ] Run the unit tests after each change
- [ ] Complete the manual testing checklist (9 scenarios)
- [ ] Verify all 598 existing tests still pass
- [ ] Update help text to accurately describe new behavior

## Supporting Documents

All original working documents from the planning process are preserved in `./supporting-docs/`:

- **Step 1 expansion**: [`1-fixing-execution-directory-behavior-full-task.md`](./supporting-docs/1-fixing-execution-directory-behavior-full-task.md) - Initial task expansion with code exploration, problem decomposition, and six detailed questions about implementation
- **Step 2 code analysis**: [`1-fixing-execution-directory-behavior-related-code.md`](./supporting-docs/1-fixing-execution-directory-behavior-related-code.md) - Deep dive into codebase with specific line numbers, patterns, and the three-tier safety system
- **Step 3 research & decisions**: [`1-fixing-execution-directory-behavior-changes-decisions-and-judgement-calls.md`](./supporting-docs/1-fixing-execution-directory-behavior-changes-decisions-and-judgement-calls.md) - Research validation (Kubernetes KEP, Node.js fs.promises, cross-platform considerations) and implementation decisions

These supporting documents provide additional context but are not required for implementation—the final standalone plan is fully self-contained.

## Related Work

**ENG-88** (Status: Done) - "Run strands in existing run directories"

This completed ticket implemented the `--start-new` and `--force` flags along with the three-tier safety system that prevents accidental overwrites. ENG-90 builds on this foundation to fix edge cases and clarify behavior. The Linear ticket mentions `.strandweave` but the code uses `.hankweave`—this is from before the project was renamed from Strandweave to Hankweave.

## Background Context

The original Linear ticket described the problem as "--start-new fails if directory exists" but code exploration revealed this is actually the three-tier safety system working as designed:

- **Tier 1**: Hard block on using `~/.hankweave-executions/` as an explicit path (prevents accidents)
- **Tier 2**: Require `--force` for directories with existing `.hankweave/` (prevents overwrites)
- **Tier 3**: Prompt for confirmation on non-empty directories without `.hankweave/` (safety check)

The real bugs are more focused: validation creating directories unnecessarily, and force mode not properly overwriting data links. This reframing was critical to designing the right fix.

## Notes for Engineers

**Code quality is high**: The codebase has comprehensive test coverage, clear error messages, defensive programming patterns, and well-structured abstractions. Follow the existing patterns.

**This is a bug fix, not a refactor**: Resist the temptation to "improve" surrounding code. Make surgical changes to the specific issues described in the plan.

**Research is validated**: The `determinePaths()` approach aligns with Kubernetes Enhancement Proposal patterns for dry-run implementation. The `fs.promises.rm()` options for retry handling are Node.js best practices. The design is sound.

**If something seems wrong**: The planning process was thorough but not infallible. If you discover something during implementation that contradicts the plan, document it clearly and make the right engineering decision. The plan is a guide, not gospel.

## Getting Help

If you have questions about this plan or discover issues during implementation:

1. Check the supporting documents in `./supporting-docs/` for additional context
2. Review the Linear tickets: [ENG-90](https://linear.app/southbridge/issue/ENG-90) and [ENG-88](https://linear.app/southbridge/issue/ENG-88)
3. Look at the external research sources linked in the final plan
4. Reach out to the team with specific questions

---

*This planning documentation was generated through a multi-step process: task expansion (Step 1), code exploration (Step 2), research validation (Step 3), plan synthesis (Step 4), and organization (Step 5). Each step's outputs are preserved in the supporting-docs folder for reference.*
