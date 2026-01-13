# ENG-92: Rename trackedFiles to checkpointedFiles

## From Step 3 Agent

This is a straightforward terminology improvement that needs minimal research - it's about internal API clarity rather than external standards. The deprecation strategy outlined in Step 2 (support both names with auto-migration) is the right approach. One thing to consider: update not just the schema description but also error messages and documentation to emphasize the checkpoint/rollback functionality. When users see "checkpointedFiles" they should immediately understand it relates to the "save game" system. This is low-hanging fruit that improves developer experience significantly for minimal effort. No external research needed - this is purely about better communication of existing functionality.

## From Step 2 Agent

Recommend renaming to `checkpointedFiles` (more accurate than "tracked"). Found usage in 3 files (config.ts, strandweave-runtime.ts, init-command.ts). Implement with deprecation period: support both names, auto-migrate trackedFiles→checkpointedFiles, warn on old usage. Low complexity (4-6 hours including tests). The schema refine() can handle migration automatically. Remove old name after 2-3 versions. Also update schema description to emphasize checkpoint role: "files saved in Git checkpoints after each codon completes, enabling rollback" rather than just "tracked for changes".

## From Step 1 Agent

This is a straightforward naming improvement to make Strandweave's configuration more intuitive. The current name "trackedFiles" is ambiguous and could imply Git tracking, file watching, or monitoring, when the actual purpose is to specify which files should be included in the shadow Git checkpoint system between codons. The new name "checkpointedFiles" makes the intent crystal clear and aligns with Strandweave's "save game" mental model. The implementation is primarily a find-and-replace operation across the codebase (schema definitions, validation logic, documentation, tests, and example strands), but care must be taken to maintain backward compatibility or provide clear migration guidance for existing strand.json files in the wild.

---

## Linear Task Information

**Identifier:** ENG-92
**Title:** Rename trackedFiles to checkpointedFiles
**Status:** In Progress
**Priority:** Medium
**Labels:** Minor
**Created:** 2025-12-18 by Hrishi Olickel
**Assignee:** None (unassigned)

### Original Description

Hrishi wrote: "Simple - makes it more obvious to humans (like me) and AIs"

### Comments

No comments on this issue.

### Related Issues

No related issues linked.

---

## Step 1 Agent Analysis

### Understanding the Current State

Based on the README that the Step 1 Agent has seen, `trackedFiles` is a codon-level configuration that specifies which files the shadow Git system should track and checkpoint. From the README:

```json
{
  "id": "phase-1-analysis",
  "name": "Analyze Codebase",
  "trackedFiles": ["analysis.md"]
}
```

The purpose is to tell Strandweave which files to commit to the shadow Git repository when the codon completes. This enables the "save game" / time-travel feature where you can rollback to previous codons.

### Why the Current Name Is Problematic

The name "trackedFiles" is ambiguous in several ways:

1. **Git confusion:** In Git terminology, "tracked" means files that are under version control, as opposed to untracked files. This could lead users to think these are files already being tracked by the project's main Git repository.

2. **Monitoring confusion:** "Tracked" could imply real-time monitoring or watching for changes, like a file watcher.

3. **Unclear purpose:** It doesn't clearly communicate that these files will be checkpointed between phases.

4. **AI confusion:** Hrishi specifically mentions "and AIs" - when LLMs read strand configurations, "trackedFiles" doesn't give strong semantic clues about its purpose. The Step 1 Agent agrees with this assessment based on its own understanding.

### Why "checkpointedFiles" Is Better

The new name makes the intent immediately clear:

1. **Explicit purpose:** "Checkpointed" directly describes what happens to these files - they're saved at checkpoint boundaries.

2. **Mental model alignment:** It reinforces the "save game" mental model that Strandweave uses (from the README: "The 'Save Game' System (Shadow Git)").

3. **Action-oriented:** The past participle form suggests these files undergo an action (checkpointing).

4. **Disambiguation:** There's no other common meaning for "checkpointed" in this context, so it's unambiguous.

### Implementation Scope

While Hrishi says "Simple," the Step 1 Agent knows that renaming in a codebase is never truly simple. This change will touch:

1. **Schema definitions** - Wherever the codon schema is defined (probably in `server/schemas/` based on directory listing)

2. **Type definitions** - TypeScript interfaces in `server/types/`

3. **Validation code** - Config validation in `server/config-validation/`

4. **Runtime code** - Any code that reads `trackedFiles` from codon configs (probably in `server/codon-runner.ts` or checkpoint system)

5. **Tests** - All tests that create or reference strand configurations

6. **Documentation** - README, any example strands, comments

7. **Migration** - Potentially supporting both names during a transition period

### Backward Compatibility Consideration

This is where "simple" becomes complex. There are likely existing strand.json files out in the wild (or at least in the test suite and examples) that use `trackedFiles`. What should happen when someone tries to run an old strand with the new code?

**Option 1: Hard break**
- Only accept `checkpointedFiles`
- Old strands fail with an error message like "Unknown property 'trackedFiles'. Did you mean 'checkpointedFiles'?"
- Include migration instructions

**Option 2: Deprecation period**
- Accept both `trackedFiles` (deprecated) and `checkpointedFiles`
- Log a warning when `trackedFiles` is used
- Update all examples and docs to use new name
- Remove support for old name in a future version

**Option 3: Automatic migration**
- If the parser sees `trackedFiles`, automatically rename it to `checkpointedFiles` internally
- Log a warning
- Never remove support (fully backward compatible)

The Step 1 Agent thinks Option 2 (deprecation period) is the best balance. It gives users time to migrate while being clear about the direction.

### Related Naming

Are there other related names in the codebase that should be updated for consistency?

Looking at the README, the Step 1 Agent sees:
- `outputFiles` - This name is fine, it's clear
- `rigSetup` - This is also clear
- `continuationMode` - Clear
- `promptText` / `promptFile` - Clear

So `trackedFiles` appears to be the only confusingly-named field. Good news for implementation scope!

### Testing Strategy

Tests should verify:
1. Strands using `checkpointedFiles` work correctly
2. If supporting backward compatibility, strands using `trackedFiles` still work (with warning)
3. Validation rejects strands that use both names
4. Checkpoint system correctly reads from the new field name
5. All example strands have been updated

### Documentation Updates Needed

1. **README.md** - Update all examples and references
2. **Any tutorial files** - Update strand.json examples
3. **Error messages** - Update to reference correct field name
4. **Type documentation** - Update JSDoc comments
5. **Changelog** - Note this as a breaking change (or deprecation)

### Implementation Steps

The Step 1 Agent envisions these steps:

1. **Update schema** - Change field name in schema definition, optionally support both
2. **Update types** - Rename in TypeScript interfaces
3. **Update validation** - Ensure validation uses new name
4. **Update runtime** - Update code that reads this field
5. **Update tests** - Change all test strand configs
6. **Update examples** - Change all example strand configs
7. **Update docs** - Update README and other documentation
8. **Add migration warning** - If supporting old name, add deprecation warning
9. **Test comprehensively** - Ensure nothing broken

### Open Questions for Step 2

The Step 2 agent should investigate:

- Where exactly is the codon schema defined? (Look in `server/schemas/`)
- How many files currently reference `trackedFiles`? (Grep the codebase)
- Are there any published strands or examples outside the repo that would break?
- What's the project's policy on breaking changes? (Look at changelog, version history)
- Is there a standard pattern for deprecated fields in the validation system?
- Should we update the field name in the shadow Git commits/messages too?
