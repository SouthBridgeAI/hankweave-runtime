# ENG-87: Frontmatter on prompts

## From Step 3 Agent

The gray-matter library research confirms it's the industry standard - [used by Gatsby, Netlify, Astro, VitePress, and many others](https://github.com/jonschlinkert/gray-matter). The library is battle-tested and handles edge cases like [non-frontmatter YAML in code blocks](https://www.npmjs.com/package/gray-matter) that break other parsers. The [frontmatter best practices](https://vitepress.dev/guide/frontmatter) from major static site generators emphasize: frontmatter must be at the top, use valid YAML, and maintain consistent schema. The Step 2 decision on precedence order (CLI > frontmatter > codon > strand > defaults) aligns with principle of specificity - more specific always wins. One consideration: document the precedence order prominently in examples. Users will be confused if they set `model: opus` in frontmatter but it gets overridden by codon config. Clear documentation prevents support issues.

## From Step 2 Agent

Zero breaking changes - purely additive feature using standard YAML frontmatter. Use `gray-matter` library (industry standard). Define strict schema for validation: core fields (model, continuationMode) affect execution, metadata fields (name, description, tags, version, author) are documentation-only. Critical decision: precedence order is CLI > frontmatter > codon > strand recommendations > defaults (most specific wins). For multiple prompt files, first file's frontmatter takes precedence. Store frontmatter metadata in execution metadata for audit trail. Low-medium complexity (~240 lines, 1 day). High value for prompt reusability and self-documentation. Get precedence rules right from start - changing them later is breaking.

## From Step 1 Agent

This task proposes adding YAML frontmatter to prompt markdown files to enable better metadata management and organization. Since Strandweave already uses markdown files for prompts, adding frontmatter is a natural extension that would allow including title, comments, author, date, and other metadata without cluttering the actual prompt content. This follows established conventions from tools like Jekyll, Hugo, and various markdown processors. The implementation should be straightforward - add a frontmatter parser (likely using an existing library like gray-matter), extract metadata during prompt loading, and potentially expose this metadata for display in the TUI or for filtering/organization purposes. The main design decision is determining which metadata fields are useful and whether any should be required vs optional.

---

## Linear Task Information

**Identifier:** ENG-87
**Title:** Frontmatter on prompts
**Status:** In Progress
**Priority:** Medium
**Labels:** Minor
**Created:** 2025-12-18 by Hrishi Olickel
**Assignee:** None (unassigned)

### Original Description

Hrishi wrote: "Since prompts are just markdown, it would be useful to add title, comments, author and date to them for better management. Should be easy enough to add the parsing."

### Comments

No comments on this issue.

### Related Issues

No related issues linked.

---

## Step 1 Agent Analysis

### Understanding the Current State

Based on the README, Strandweave currently supports prompts in two ways:

1. **Inline prompts** via `promptText` in the codon config:
```json
{
  "promptText": "Read the source files and write a summary"
}
```

2. **External prompt files** via `promptFile` (inferred from README structure):
```json
{
  "promptFile": "prompts/analyze.md"
}
```

The README's quick start example shows `prompts/analyze.md` being created, confirming that external markdown files are used for prompts.

### What Is Frontmatter?

Frontmatter is metadata placed at the beginning of a markdown file, typically in YAML format, delimited by `---`:

```markdown
---
title: "Analyze Codebase"
author: "Hrishi Olickel"
date: "2025-12-18"
description: "Comprehensive analysis codon for TypeScript projects"
version: "1.0"
tags: ["analysis", "typescript"]
---

Read the source files in <%DATA_DIR%> and analyze:
- Architecture patterns
- Code quality
- Potential issues
...
```

The frontmatter is parsed separately from the content, allowing tools to extract metadata without affecting the displayed content.

### Why This Is Useful

The Step 1 Agent agrees with Hrishi that this would be valuable for several reasons:

**1. Prompt Library Management**
As users accumulate multiple prompt files, being able to see title, description, and tags at a glance helps with organization:
```bash
prompts/
  analyze-typescript.md     (title: "TypeScript Analysis", tags: ["analysis", "typescript"])
  refactor-classes.md       (title: "Class Refactoring", tags: ["refactor", "oop"])
  generate-tests.md         (title: "Test Generation", tags: ["testing", "automation"])
```

**2. Version Tracking**
Including version and date helps track changes over time:
```yaml
version: "2.1"
date: "2025-12-18"
changelog: "Added support for async patterns"
```

**3. Authorship and Attribution**
In team settings, knowing who wrote a prompt is useful:
```yaml
author: "Hrishi Olickel"
contributors: ["Jane Doe", "Bob Smith"]
```

**4. Documentation**
Comments and descriptions provide context:
```yaml
description: "Use this for analyzing React codebases with hooks"
notes: "Works best with projects using TypeScript 5+"
```

**5. Programmatic Filtering**
Metadata enables building prompt libraries with search/filter:
```bash
strandweave --list-prompts --tag analysis
strandweave --list-prompts --author hrishi
```

### Proposed Metadata Fields

Based on Hrishi's mention of "title, comments, author and date," the Step 1 Agent proposes these standard fields:

**Core Fields (commonly used):**
```yaml
title: string           # Display name
description: string     # Brief explanation
author: string         # Primary author
date: string           # Creation/modification date (ISO format)
version: string        # Semantic version
```

**Optional Fields:**
```yaml
tags: string[]         # For categorization
comments: string       # Additional notes
contributors: string[] # Other authors
license: string        # License if sharing
deprecated: boolean    # Mark old prompts
replaces: string       # Reference to prompt this replaces
```

Not all of these need to be implemented initially, but having a schema helps standardization.

### Implementation: The Parser

Hrishi says "Should be easy enough to add the parsing," and the Step 1 Agent agrees. There are excellent existing libraries:

**For Node.js/Bun:**
- **gray-matter** - Most popular, used by many static site generators
- **front-matter** - Simpler, focused alternative

Example with gray-matter:
```typescript
import matter from 'gray-matter';

const fileContent = fs.readFileSync('prompts/analyze.md', 'utf8');
const { data, content } = matter(fileContent);

// data = { title: "...", author: "...", ... }
// content = "Read the source files..." (markdown without frontmatter)
```

The parsing is indeed straightforward - it's mostly deciding what to do with the metadata once parsed.

### Integration Points

Where does frontmatter parsing fit in the current architecture?

**1. Prompt Loading (file-resolver.ts or config.ts)**
When a codon specifies `promptFile`, the system loads the markdown file. This is where frontmatter parsing should happen:
```typescript
function loadPromptFile(path: string): { metadata: Metadata; content: string } {
  const raw = fs.readFileSync(path, 'utf8');
  const { data, content } = matter(raw);
  return { metadata: data, content };
}
```

**2. Codon Configuration**
The parsed metadata could be attached to the codon object:
```typescript
interface Codon {
  // ... existing fields ...
  promptFile?: string;
  promptText?: string;
  promptMetadata?: PromptMetadata;  // NEW
}
```

**3. Display in TUI**
The TUI (basic-tui.ts) could show prompt metadata when displaying codon information:
```
Codon 1: Analyze Codebase
Prompt: "TypeScript Analysis" by Hrishi Olickel (v1.0)
Status: Running...
```

**4. Validation**
Config validation could check that required metadata fields are present (if any are made required).

### Backward Compatibility

Frontmatter should be **optional**. Existing prompts without frontmatter should continue to work:

```markdown
Read the source files and analyze...
```

This is still valid. The parser will just return empty metadata.

### Question: Should Inline Prompts Support Frontmatter?

Currently, there's `promptText` for inline prompts:
```json
{
  "promptText": "Read the files and analyze"
}
```

Could this also support frontmatter?
```json
{
  "promptText": "---\ntitle: Quick Analysis\n---\nRead the files and analyze"
}
```

The Step 1 Agent thinks:
- **Technically possible** - Just parse the `promptText` string the same way
- **Probably not useful** - Inline prompts are typically short and don't need metadata
- **Potentially confusing** - Mixing YAML and instructions in JSON strings is ugly

Best to limit frontmatter to external prompt files only.

### Testing Strategy

Tests should cover:
1. Prompt file with frontmatter (metadata correctly parsed, content correctly extracted)
2. Prompt file without frontmatter (works as before, empty metadata)
3. Prompt file with only frontmatter, no content (edge case - should probably warn)
4. Invalid YAML in frontmatter (should fail with clear error)
5. Prompt file with special characters in content (parsing doesn't break)
6. All specified metadata fields are correctly typed

### Schema Definition

The Step 1 Agent suggests defining a TypeScript interface for the metadata:

```typescript
interface PromptMetadata {
  title?: string;
  description?: string;
  author?: string;
  date?: string;  // ISO 8601 format
  version?: string;
  tags?: string[];
  comments?: string;
  contributors?: string[];
  license?: string;
  deprecated?: boolean;
  replaces?: string;
}
```

This provides type safety and documentation for users creating prompts.

### Documentation Updates

The README should include an example of a prompt with frontmatter:

```markdown
### Creating Prompts with Metadata

Prompt files can include YAML frontmatter for better organization:

\`\`\`markdown
---
title: "Analyze TypeScript Codebase"
author: "Your Name"
date: "2025-12-18"
description: "Comprehensive analysis for TypeScript projects"
tags: ["analysis", "typescript"]
version: "1.0"
---

Read the source files in <%DATA_DIR%> and analyze:
- Code structure and patterns
- Type safety usage
- Potential improvements
\`\`\`
```

### Future Enhancements

Once frontmatter is implemented, it opens doors for:

**1. Prompt Library Command**
```bash
strandweave --list-prompts
# Shows all prompts with their metadata

strandweave --list-prompts --tag analysis
# Filtered view
```

**2. Prompt Validation**
```bash
strandweave --validate-prompt prompts/analyze.md
# Checks metadata schema, references, etc.
```

**3. Prompt Versioning**
Track which version of a prompt was used in each run, stored in checkpoint metadata.

**4. Template Prompts**
Use metadata to define parameters that get filled in:
```yaml
parameters:
  - language: "typescript"
  - framework: "react"
```

But these are out of scope for the initial implementation.

### Implementation Scope

The Step 1 Agent believes this task requires:

1. **Add dependency** - Install gray-matter or similar library
2. **Create parser module** - Wrapper around the library with our schema
3. **Update prompt loading** - Parse frontmatter when loading prompt files
4. **Define metadata schema** - TypeScript interface for metadata
5. **Update types** - Add optional metadata field to codon types
6. **Error handling** - Handle invalid YAML gracefully
7. **Tests** - Comprehensive coverage as outlined
8. **Documentation** - Update README with examples

### Open Questions for Step 2

The Step 2 agent should investigate:

- Where is prompt loading currently implemented? (Look in `server/file-resolver.ts` or `server/config.ts`)
- What's the current prompt loading flow for both `promptFile` and `promptText`?
- Is there any existing metadata or validation for prompts?
- Should metadata be stored in checkpoint state for historical tracking?
- Should the TUI display prompt metadata? Where would it fit in the current display?
- Are there any existing prompt files in tests/examples that should be updated?
