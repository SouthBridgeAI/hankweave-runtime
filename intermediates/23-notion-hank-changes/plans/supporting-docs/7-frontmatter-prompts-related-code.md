# ENG-87: Frontmatter on Prompts - Related Code

## Current Prompt Loading

**No frontmatter parsing exists yet** - prompts are loaded as plain text files.

**Relevant code locations**:

### 1. CodonRunner (`server/codon-runner.ts`)

Likely contains prompt loading logic - need to check how prompts are assembled.

### 2. Config Schema (`server/config.ts` lines 249-268)

```typescript
promptFile: z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe("Path to a file containing the prompt"),
promptText: z
  .string()
  .optional()
  .describe("Inline prompt text"),
appendSystemPromptFile: z
  .union([z.string(), z.array(z.string())])
  .optional(),
appendSystemPromptText: z
  .string()
  .optional(),
```

Currently supports:
- Single file or multiple files
- Inline text
- System prompt files/text
- All are simple concatenation (no metadata)

## What Frontmatter Enables

**Example prompt.md**:
```markdown
---
name: Code Analyzer
description: Analyzes code for patterns and issues
model: opus  # Override codon model
continuationMode: fresh
tags: [analysis, code-review]
---

Your actual prompt content here...
```

**Benefits**:
1. Self-documenting prompts
2. Model selection at prompt level (not just codon level)
3. Metadata for prompt libraries/sharing
4. Version tracking within prompt files

## Implementation Pattern

### 1. Frontmatter Parsing

**Use `gray-matter` library** (standard for frontmatter):
```bash
bun add gray-matter
```

```typescript
import matter from 'gray-matter';

function loadPromptWithFrontmatter(filePath: string) {
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const { data, content } = matter(fileContent);

  return {
    metadata: data,
    prompt: content
  };
}
```

### 2. Schema for Frontmatter

**Define allowed frontmatter fields**:
```typescript
const promptFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.string().optional(),  // Override codon model
  continuationMode: z.enum(['fresh', 'continue-previous']).optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().optional(),
  author: z.string().optional(),
}).strict();
```

### 3. Precedence Rules

**Question**: What happens if both codon config and prompt frontmatter specify model?

**Recommendation**: Frontmatter > Codon Config > Defaults

**Rationale**: Prompt is most specific, codon is less specific, defaults are fallback.

**Example**:
```json
// hank.json
{
  "codons": [{
    "id": "analyze",
    "model": "sonnet",
    "promptFile": "prompts/analyze.md"
  }]
}
```

```markdown
<!-- prompts/analyze.md -->
---
model: opus
---
Analyze this code deeply...
```

**Result**: Uses `opus` (frontmatter wins).

### 4. Integration Points

**In CodonRunner initialization**:
```typescript
// Load prompt
let promptContent: string;
let promptMetadata: PromptFrontmatter | undefined;

if (codon.promptFile) {
  const files = Array.isArray(codon.promptFile)
    ? codon.promptFile
    : [codon.promptFile];

  for (const file of files) {
    const { metadata, prompt } = loadPromptWithFrontmatter(file);

    // First file's metadata takes precedence
    if (!promptMetadata && metadata) {
      promptMetadata = promptFrontmatterSchema.parse(metadata);
    }

    promptContent += prompt + '\n\n';
  }
}

// Apply frontmatter overrides
if (promptMetadata) {
  if (promptMetadata.model) {
    // Override codon model
    codon = { ...codon, model: resolveModel(promptMetadata.model) };
  }
  if (promptMetadata.continuationMode) {
    codon = { ...codon, continuationMode: promptMetadata.continuationMode };
  }
}
```

## Backward Compatibility

**Prompts without frontmatter**: Continue to work as plain text.

**Detection**:
```typescript
// gray-matter returns empty object if no frontmatter
const { data, content } = matter(fileContent);
if (Object.keys(data).length === 0) {
  // No frontmatter - use entire file as prompt
  return { metadata: undefined, prompt: fileContent };
}
```

**No breaking changes** - this is purely additive.

## Use Cases

### 1. Prompt Libraries
```markdown
<!-- prompts/analyze-typescript.md -->
---
name: TypeScript Code Analyzer
description: Analyzes TS code for type safety and patterns
model: opus
tags: [typescript, analysis, static-analysis]
version: 1.2.0
author: team@example.com
---
...prompt content...
```

### 2. Model Selection
```markdown
<!-- prompts/quick-check.md -->
---
model: sonnet  # Fast model for quick checks
---
...
```

### 3. Self-Documenting Hanks
```markdown
<!-- prompts/step1-research.md -->
---
name: Research Phase
description: Reads codebase and gathers context
continuationMode: fresh
---
...
```

## Summary

**New dependency**: `gray-matter` (standard frontmatter parser)
**Files to modify**:
- CodonRunner: Add frontmatter loading
- Config types: Add PromptFrontmatter type
- Validation: Validate frontmatter schema

**Complexity**: Low-Medium (~200 lines + tests)
