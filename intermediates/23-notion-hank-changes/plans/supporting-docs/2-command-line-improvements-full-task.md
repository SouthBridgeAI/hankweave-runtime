# ENG-106: Command line behavior quality of life improvements

## From Step 3 Agent

CLI design research validates the proposed approach completely. The [Command Line Interface Guidelines (clig.dev)](https://clig.dev/) emphasize "prefer flags to args" for explicitness, but our hybrid approach honors both patterns. Research confirms that [positional arguments are powerful when order matters](https://betterdev.blog/command-line-arguments-anatomy-explained/), and the double-dash convention (`--`) for separating options from positionals is well-established. The space-separated format for flags is standard across Unix tools, and the equals format is actually less common. Given Step 2's finding that relative paths might already work, comprehensive testing is critical before making changes. One key insight from the guidelines: "predictability and familiarity" matter most - supporting both old and new formats maximizes both. The decision to maintain full backward compatibility is wise; breaking working scripts for aesthetic reasons would violate Unix philosophy. Consider adding shell completion scripts (bash/zsh) as a follow-up - with space-separated args, this becomes much more valuable.

## From Step 2 Agent

Surprising finding: ENG-21 (relative paths) might already be fixed - the code correctly saves CWD before changing directories and uses it for resolution. Recommend comprehensive testing before any changes. Core recommendation: implement FULL backward compatibility using enhanced hand-rolled parsing (no need for CLI libraries). Support both `--flag=value` and `--flag value` formats permanently - trivial with our approach and prevents breaking existing scripts. For positionals, use precedence: flags > positionals > defaults. This allows `hankweave hank.json data` while keeping `hankweave --config hank.json --data data` working. Flip proxy default (safe - rarely used) and make TUI default (behavior change but non-breaking since TUI doesn't interfere). Phase implementation: (1) space-separated flags [low risk, 1 day], (2) flip defaults [low risk, hours], (3) positional args [medium complexity, 2 days], (4) docs. Total: ~5-6 days. This is actually 5 tasks masquerading as one, but all can be done with zero breaking changes if implemented carefully. The validation regex already exists, just needs patterns updated to accept both formats.

## From Step 1 Agent

This is a high-priority umbrella task that aims to make Hankweave's command-line interface more intuitive and align it with common CLI conventions. The task encompasses five related subtasks that collectively address friction points in the current design. The most significant proposed change is removing the equals signs from arguments (going from `--config=hank.json` to `--config hank.json`) and making hank and data positional arguments instead of flags, potentially resulting in a much cleaner syntax like `hankweave <hank> <data>`. There are also important decisions about defaults: making the basic TUI mode default and turning off the proxy by default since it's currently unused and causes brittleness. The implementation needs to ensure backward compatibility is handled gracefully or at least that breaking changes are clearly documented.

---

## Linear Task Information

**Identifier:** ENG-106
**Title:** Command line behavior quality of life improvements
**Status:** In Progress
**Priority:** High
**Created:** 2026-01-12 by Hrishi Olickel
**Assignee:** Hrishi Olickel

### Original Description

Hrishi wrote: "Related: ENG-90 and ENG-21 ENG-22 ENG-96 ENG-101. We should do a bit of a rethink to make sure hankweave's command line configs are easy to grok and use. Some things off the top of my head:

1. A hank shouldn't be a parameter (since it's required) - it should just be the input. So no switch. Also data. One way is `hankweave <hank> <data>`?
2. Ideally the basic cli and autostart is on by default.
3. Let's turn off the proxy by default.

What else would make this more intuitive?"

### Comments

No comments on this issue.

### Related Issues

This task explicitly relates to:
- **ENG-90:** Fixing execution directory behavior (Urgent priority)
- **ENG-21:** Allow relative paths when calling the server (High priority)
- **ENG-22:** Remove the equals in arguments passed to the cli (No priority)
- **ENG-96:** Turn off proxy by default (Low priority)
- **ENG-101:** Make --basic the default option (High priority)

---

## Related Task Details

### ENG-21: Allow relative paths when calling the server

**Status:** In Progress
**Priority:** High
**Labels:** Minor, Launch Task
**Created:** 2025-08-18

Hrishi wrote: "Currently it feels like it doesn't. On all platforms we should allow relative paths as command line arguments - also maybe add a test."

**Comment from Hrishi (2025-12-18):** "Realised this is a pretty big hurdle when quickly using the server during the notion hank building. Moving up priority"

The Step 1 Agent notes that this became a high priority after being a pain point during actual usage. This suggests the problem is more than theoretical - it's actively hampering workflow.

### ENG-22: Remove the equals in arguments passed to the cli

**Status:** In Progress
**Priority:** No priority
**Labels:** Bug, Launch Task
**Created:** 2025-08-18

Hrishi wrote: "Better shell autocompletion that way. Currently we need an equals sign. Can we also run tests and make sure we support proper parsing, escaping and unescaping - all the jazz that's needed to do command line args well?"

The Step 1 Agent observes that this is labeled as both a "Bug" and a "Launch Task," suggesting it was identified early as something that should be fixed before any official launch. The mention of shell autocompletion is key - the equals sign format (`--config=value`) prevents bash/zsh completion from working properly. The request to "support proper parsing, escaping and unescaping" indicates awareness that command-line argument handling is subtle and needs to be done correctly.

### ENG-96: Turn off proxy by default

**Status:** In Progress
**Priority:** Low
**Labels:** Minor
**Created:** 2025-12-18

Hrishi wrote: "We're not using it for anything at the moment - and it causes some brittleness. This is a task to discuss whether we should have it off by default?"

The Step 1 Agent interprets the phrasing "to discuss whether" as indicating some uncertainty, but the parent task ENG-106 states definitively "Let's turn off the proxy by default," suggesting the decision has been made. The proxy feature is likely something that was built for future use (possibly to intercept or monitor LLM API calls) but isn't currently utilized and is causing problems.

### ENG-101: Make --basic the default option

**Status:** In Progress
**Priority:** High
**Created:** 2026-01-09

Hrishi wrote: "Let's reduce the number of config params to start hankweave. What do we need to run a hank end to end? Let's reduce the friction there"

The Step 1 Agent notes this was created very recently and has high priority. The "--basic" flag currently enables what's described in the README as the "TUI (Terminal UI)" mode. Making this the default means users would get the interactive terminal interface by default, which is more user-friendly than requiring them to know about the `--basic` flag.

### ENG-90: Fixing execution directory behavior

**Status:** In Progress
**Priority:** Urgent
**Labels:** Improvement
**Created:** 2025-12-18

This is marked as related to ENG-106 in the Linear graph. While not explicitly listed as a subtask of this CLI improvement effort, it's worth noting because it also deals with command-line flag behavior.

Hrishi wrote: "The overall behavior around execution directories makes for a cumbersome experience:
* --start-new fails if the directory exists.
* --validate creates a new directory for some reason.

Let's clean up a bit. (also related to ENG-88) - here's the behavior we want:

1. Validate doesn't make a directory or start up the server. It just runs a comprehensive preflight check to make sure that the server with all the currently enabled settings (whether that's resume, start new, etc) will work once validate flag is removed.
2. --start-new will create a dir if it doesn't exist,
   1. if --force is on, backup .hankweave in existing dir, overwrite read_only_data_source in existing dir, otherwise fail
   2. or run in directory if nothing wrong with it
3. neither will try to resume in a directory."

**Comment from Hrishi (2026-01-13):** "This is a comment for fun"

The Step 1 Agent notes this has "Urgent" priority and includes a detailed specification of desired behavior, suggesting this is causing significant pain in the current workflow.

---

## Step 1 Agent Analysis

### The Big Picture

This task is about reducing friction and aligning Hankweave's CLI with common Unix/CLI conventions. The current design likely evolved organically as features were added, and now there's a need to step back and make it coherent and intuitive.

### Core Proposal: Positional Arguments

The most significant change proposed is moving from flag-based to positional arguments for the two required parameters: hank and data.

**Current (assumed):**
```bash
hankweave --config=./hank.json --data=./my-project
```

**Proposed:**
```bash
hankweave ./hank.json ./my-project
```

Or even simpler with the parent directory convention:
```bash
hankweave . ./my-project  # if hank.json is in current directory
```

This is a massive improvement in ergonomics. The Step 1 Agent thinks this makes sense because:
1. Both parameters are required, so they're not really "options"
2. The order is logical: first you specify what to run (hank), then what to run it on (data)
3. It follows the pattern of many CLI tools (e.g., `cp source dest`, `docker run image`, etc.)

### Question: Backward Compatibility

The Step 1 Agent wonders: should the old flag-based syntax still be supported for backward compatibility? Or is Hankweave early enough in its lifecycle that breaking changes are acceptable? The task doesn't explicitly address this, but the "Launch Task" labels on some of these issues suggest they're meant to be fixed before an official launch, implying breaking changes are acceptable now.

### The Equals Sign Issue (ENG-22)

The current syntax requires equals signs: `--config=value`. The problem with this is that most modern CLI parsers and shell completion systems expect space-separated arguments: `--config value`.

**Why equals signs break shell completion:**
When you type `hankweave --config <TAB>`, the shell's completion system doesn't know what to suggest because it thinks `--config` is a complete argument. With space-separated args, completion systems can be configured to suggest file paths after `--config`.

**The "proper parsing, escaping and unescaping" concern:**
This is about correctly handling edge cases like:
- Paths with spaces: `/path/to/my project/hank.json`
- Paths with special characters: `/path/to/hank's.json`
- Quoted arguments: `--config "my hank.json"`

Most CLI libraries handle this automatically if you use standard space-separated argument parsing. The equals sign format requires custom parsing that can get these edge cases wrong.

### Default Settings Changes

**Making --basic default (ENG-101):**
The TUI ("basic mode") is currently opt-in, but it should be the default because it provides a much better user experience with interactive controls. Users who want non-interactive mode (for CI/CD, scripts, etc.) could use a new flag like `--headless` or `--non-interactive`.

**Turning off proxy by default (ENG-96):**
The proxy is currently on by default but unused and causes brittleness. This should definitely be flipped to off-by-default, with a `--proxy` flag for users who want to enable it. The Step 1 Agent suspects the proxy might have been intended for debugging or monitoring LLM API calls, but if it's not being used, it's just adding complexity.

### Relative Path Support (ENG-21)

Hrishi says "Currently it feels like it doesn't" support relative paths, which suggests it might partially work but has bugs. The fact that this became a "pretty big hurdle when quickly using the server during the notion hank building" indicates it's causing real pain.

The Step 1 Agent suspects the issue might be related to how Hankweave changes directories or resolves paths internally. When the server starts, it might be:
1. Changing the working directory
2. Not resolving relative paths to absolute paths before changing directories
3. Using the wrong base directory for resolving relative paths

This is actually a common bug pattern in CLI tools that deal with file paths and directory traversal.

### Integration Between Tasks

These tasks are highly interdependent:

1. **ENG-22 (remove equals)** affects how all other arguments are parsed
2. **ENG-21 (relative paths)** needs to work with the new positional argument design
3. **ENG-101 (--basic default)** changes what flags users need to know about
4. **ENG-96 (proxy off)** is independent but part of the same "reduce flags" effort
5. The positional argument design from the main ENG-106 task ties everything together

The Step 1 Agent believes these should be implemented as a coordinated effort, not piecemeal, to avoid multiple rounds of breaking changes.

### Proposed Final CLI Design

After all these changes, the Step 1 Agent envisions:

```bash
# Basic usage (most common case)
hankweave <hank> <data>

# With relative paths (just works)
hankweave ./my-hank.json ../my-project

# With remote hank (if ENG-105 is implemented)
hankweave https://github.com/user/repo ./my-project

# Starting fresh (instead of resuming)
hankweave --start-new ./hank.json ./project

# Validation only
hankweave --validate ./hank.json ./project

# Enable proxy if needed
hankweave --proxy ./hank.json ./project

# Non-interactive mode for scripts
hankweave --headless ./hank.json ./project
```

This is clean, intuitive, and follows common CLI conventions.

### Implementation Scope

The Step 1 Agent believes implementing this task requires:

1. **Command-line parser refactoring** - Switch from equals-based to space-separated parsing
2. **Positional argument handling** - Make hank and data positional instead of flags
3. **Path resolution** - Properly resolve relative paths to absolute paths before any directory changes
4. **Default changes** - Flip defaults for --basic (on) and proxy (off)
5. **Tests** - Comprehensive tests for:
   - Relative paths on all platforms
   - Paths with spaces and special characters
   - Positional vs flag-based arguments
   - New defaults
6. **Documentation updates** - README and any tutorials need to be updated
7. **Migration guide** - If breaking changes, document how to update existing scripts/workflows

### Security and Edge Cases

The Step 1 Agent notes that proper argument parsing is important for security. Improper handling of quotes, escapes, and special characters can lead to command injection vulnerabilities if arguments are ever passed to shell commands. This is especially relevant if Hankweave passes user-provided paths to `git`, `npm`, or other external commands during rig setup.

### Open Questions for Step 2

The Step 2 agent should investigate:

- What CLI parsing library does Hankweave currently use? (Look in `server/index.ts` or `server/command-schemas.ts`)
- How are paths currently resolved? Where does the server change directories?
- Are there any existing scripts or workflows (in CI/CD, tests, or docs) that would break with these changes?
- Is there a way to support both old and new syntax during a deprecation period?
- What's the current default behavior for the TUI vs non-TUI mode?
- Where is the proxy configured and what does it currently do?
