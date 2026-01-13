# ENG-93: Run strands with simple input text as data

## From Step 3 Agent

The stdin convention research provides strong historical validation for using `-` to represent stdin. [Ken Thompson modified sort in Version 5 Unix to accept "-" as stdin](https://www.baeldung.com/linux/dash-in-command-line-parameters), and this spread throughout the ecosystem. The convention is so established that [many tools treat `-` as a pseudo-filename for stdin/stdout](https://linuxvox.com/blog/what-s-the-magic-of-a-dash-in-command-line-parameters/) automatically. This makes `--data=-` or just `-` as a positional argument the obvious choice. The Step 2 finding that file support already exists is excellent - we just need to create temp files from stdin or inline text. One consideration: temp file cleanup strategy should be explicit even if OS handles it eventually. Consider documenting the temp file location in execution metadata for debugging.

## From Step 2 Agent

File support already exists (execution-setup.ts lines 179-196)! What's missing is stdin and inline text support. Recommend two additions: (1) `--data=-` for stdin (Unix convention: `echo "text" | strandweave strand.json -`), and (2) `--data-text="inline text"` for quick experiments without creating files. Implementation is simple - create temp file in os.tmpdir(), then use existing file handling logic. Low complexity (~50-80 lines, 2-3 hours). This significantly improves UX for quick tests and experimentation. Both approaches create temp files that OS will clean up automatically.

## From Step 1 Agent

This feature would allow users to provide a simple text string as the data input instead of requiring a file or directory, making Strandweave more accessible for quick tests and for strands designed to operate on text content rather than file structures. The proposed interface mirrors Claude Code's `--input` flag, and the implementation would write the provided text to a file in the execution directory instead of creating a read-only symlink to external data. This is particularly useful for "design strands" (presumably strands that generate designs or plans from text descriptions) and for rapid experimentation without needing to set up directory structures. The main implementation question is where to place this text file within the execution directory and how to communicate its location to the strand.

---

## Linear Task Information

**Identifier:** ENG-93
**Title:** Run strands with simple input text as data
**Status:** In Progress
**Priority:** High
**Labels:** Minor
**Created:** 2025-12-18 by Hrishi Olickel
**Assignee:** None (unassigned)

### Original Description

Hrishi wrote: "We can place it into a file in the directory (without symlinks) to do the run. Would be useful for design strands, and for quick testing.

the idea here is that much like claude we can do --input or something and provide a simple string for it to run on."

### Comments

No comments on this issue.

### Related Issues

No related issues linked.

---

## Step 1 Agent Analysis

### Understanding the Use Case

The current Strandweave design assumes that data input is always a file or directory that gets mounted as `read_only_data_source/` in the execution directory. This makes sense for strands that operate on codebases, documents, or file collections. However, there's a whole class of use cases where the input is conceptually simpler - just text.

Examples the Step 1 Agent can imagine:
- **Design strands:** "Design a REST API for a todo app" (input is a text description, output is a design document)
- **Analysis strands:** "Analyze this user feedback and categorize sentiments" (input is text, output is structured analysis)
- **Quick testing:** "Generate 5 test cases for this specification" (input is a spec string)
- **Text transformation:** "Convert this markdown to a presentation outline" (input is markdown text)

For all these cases, requiring the user to create a file or directory just to hold the input text is cumbersome.

### The Claude Code Analogy

Hrishi explicitly references "much like claude we can do --input." The Step 1 Agent interprets this as referring to Claude Code (Anthropic's CLI tool for Claude), which likely has an `--input` flag for providing text directly on the command line.

The proposed syntax would be:
```bash
strandweave --input "Design a REST API for a todo app" ./design-strand.json
```

Or potentially:
```bash
strandweave ./design-strand.json --input "Design a REST API for a todo app"
```

### Implementation Detail: "without symlinks"

Hrishi specifically says "We can place it into a file in the directory (without symlinks)." This is an important architectural detail. Currently, Strandweave creates a symlink from the execution directory to the user's data:

```
~/.strandweave-executions/xyz/read_only_data_source -> /path/to/user/data
```

For simple text input, we can't create a symlink because there's no source directory. Instead, we would directly create a file in the execution directory:

```
~/.strandweave-executions/xyz/input.txt
```

Or perhaps:
```
~/.strandweave-executions/xyz/read_only_data_source/input.txt
```

The Step 1 Agent thinks the second option (keeping the `read_only_data_source/` convention) might be better for consistency, even though it's not actually a symlink in this case.

### Question: File Name and Location

What should the file be called and where should it be placed?

**Option 1: Fixed filename in execution root**
```
~/.strandweave-executions/xyz/input.txt
```
Pro: Simple, predictable
Con: Breaks convention of data being in `read_only_data_source/`

**Option 2: Fixed filename in data source directory**
```
~/.strandweave-executions/xyz/read_only_data_source/input.txt
```
Pro: Consistent with existing convention, strands can always look in `<%DATA_DIR%>/input.txt`
Con: The directory is no longer just a symlink mount point

**Option 3: Configurable filename**
```bash
strandweave --input "text" --input-file "spec.txt" ./strand.json
```
Pro: Flexible, strand can specify expected filename
Con: More complex, adds another parameter

The Step 1 Agent leans toward Option 2 with a fixed, documented filename like `input.txt` or `data.txt`. This maintains the convention that strands always access data via `<%DATA_DIR%>` regardless of how that data arrived.

### Integration with Positional Arguments (ENG-106)

If ENG-106 moves strand and data to positional arguments, how does `--input` fit in?

**Current proposed syntax from ENG-106:**
```bash
strandweave <strand> <data>
```

**With --input, we might have:**
```bash
strandweave <strand> --input "text"
```

Where the second positional argument (data path) is replaced by the `--input` flag. These should be mutually exclusive - you either provide a data path OR use `--input`, not both.

Alternatively, if we're being really clever about CLI design:
```bash
strandweave <strand> "text string"
```

And the system auto-detects that the second argument is a string rather than a path and treats it as inline input. But this could be ambiguous (what if the user has a directory literally named "Design a REST API"?). So explicit `--input` flag is probably clearer.

### Question: Multi-line Input

How would users provide multi-line input?

**Option 1: Shell quoting**
```bash
strandweave --input "Line 1
Line 2
Line 3" ./strand.json
```

This works in bash but can be awkward.

**Option 2: Here-doc style**
```bash
strandweave ./strand.json --input "$(cat <<EOF
Line 1
Line 2
Line 3
EOF
)"
```

Works but very ugly.

**Option 3: Read from stdin**
```bash
cat input.txt | strandweave ./strand.json --input -
```

Where `-` means "read from stdin". This is a common Unix convention.

**Option 4: Read from file**
```bash
strandweave ./strand.json --input-file input.txt
```

This is a bit ironic since we're trying to avoid making users create files, but it's useful for structured input that's not a directory.

The Step 1 Agent thinks we should support both `--input` for inline strings and `--input -` for stdin. The stdin option is especially useful for piping data.

### Use in Strand Prompts

How would strands reference this input? If we place it in `read_only_data_source/input.txt`, then strand prompts could reference it as:

```json
{
  "promptText": "Read the specification from <%DATA_DIR%>/input.txt and generate a design document."
}
```

Or we could introduce a new template variable:

```json
{
  "promptText": "Read the specification: <%INPUT_TEXT%> and generate a design document."
}
```

The Step 1 Agent prefers the file-based approach (first option) because:
1. It's more consistent with how Strandweave currently works
2. It allows the agent to re-read the input if needed
3. It shows up in the execution directory's file listing for debugging

### Testing Considerations

Tests should cover:
- Basic inline text input
- Multi-line text input
- Special characters in input (quotes, newlines, unicode)
- Stdin input (`--input -`)
- Mutual exclusivity with data path argument
- Input text appearing correctly in execution directory
- Strands can successfully read and process the input

### Implementation Scope

The Step 1 Agent believes this task requires:

1. **CLI flag addition** - Add `--input` flag to argument parser
2. **Validation** - Ensure `--input` and data path are mutually exclusive
3. **File creation** - Write input text to appropriate location in execution directory
4. **Path substitution** - Ensure `<%DATA_DIR%>` still resolves correctly
5. **Stdin support** - Handle `--input -` to read from stdin
6. **Documentation** - Update README with examples of `--input` usage
7. **Tests** - Comprehensive tests as outlined above

### Interaction with ENG-105 (Remote Strands)

If ENG-105 is implemented (running strands from URLs), this feature becomes even more powerful:

```bash
strandweave https://github.com/user/design-strand --input "Design a REST API for X"
```

This creates a really low-friction way to execute shared strands on ad-hoc input. Very cool!

### Open Questions for Step 2

The Step 2 agent should investigate:

- Where in the code does Strandweave currently set up the `read_only_data_source/` symlink? (Probably in `server/execution-setup.ts`)
- How does `<%DATA_DIR%>` template variable get resolved? (Look in prompt processing code)
- Are there any strands in tests or examples that could be updated to demonstrate `--input` usage?
- What CLI library is used, and how easy is it to add stdin reading?
- Should there be a size limit on input text? (e.g., refuse to accept >10MB input strings)
