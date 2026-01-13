# ENG-88: Existing Run Directories - Changes and Decisions

## Step 2 Agent Analysis

The restriction exists for safety, but it's too restrictive for real-world workflows. Users want to run Strandweave in their project directories.

## Decision 1: Allow Non-Empty Directories

**Remove restriction** BUT add safety checks and warnings.

**Key insight**: The real danger is running INSIDE `.strandweave-executions/`, not running in a user's project directory.

## Decision 2: Three-Tier Safety System

**Tier 1 - Hard Error**: Running in managed execution directory
```bash
strandweave --execution ~/.strandweave-executions/xyz --start-new
# ERROR: Cannot use ~/.strandweave-executions/ as explicit execution directory
```

**Tier 2 - Hard Error**: Directory already has Strandweave metadata
```bash
strandweave --execution /path/with/.strandweave --start-new
# ERROR: Directory already contains Strandweave execution
```

**Tier 3 - Warning + Prompt**: Non-empty directory without Strandweave
```bash
strandweave --execution /my/project --start-new
# WARNING: Using existing non-empty directory...
# Continue? [y/N]
```

## Decision 3: Confirmation Behavior

**With `-y` flag**: Skip all prompts (trust user)
**Without `-y`**: Prompt on Tier 3 warnings
**With `--force`**: Skip Tier 2 errors (allow overwriting .strandweave)

## Decision 4: Documentation Requirements

Add prominent examples in README:
```markdown
### Running in Your Project Directory

You can run Strandweave directly in your project directory:

```bash
cd ~/my-project
strandweave --execution=. --start-new my-strand.json .
```

This creates a `.strandweave/` subdirectory for execution metadata while
leaving your project files intact.

⚠️ **Note**: Strandweave agents will have access to modify files in this directory.
Always use version control and test strands on non-critical directories first.
```

## Complexity Assessment

**Implementation**: Low-Medium
- Remove restriction: ~5 lines (delete error throw)
- Add safety checks: ~60 lines
- Add warnings: ~40 lines
- Add prompts: ~50 lines
- Update docs: ~30 lines

**Total**: 4-5 hours

## Step 2 Agent Recommendation

Implement this - it's a key usability improvement. The safety system prevents footguns while enabling the flexibility users need.

**Critical**: Add loud warnings so users understand they're running agents with filesystem access in their project directory.
