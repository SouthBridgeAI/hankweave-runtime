# Complete Guide to Codon Configuration

This guide covers all the ways you can configure codons in Strandweave Runner, from simple single-codon workflows to complex multi-codon automations with rig setup, file tracking, and environment management.

## Table of Contents
1. [Strand File Format](#strand-file-format)
2. [Basic Codon Structure](#basic-codon-structure)
3. [Prompt Configuration](#prompt-configuration)
4. [Model Selection](#model-selection)
5. [Continuation Modes](#continuation-modes)
6. [Loops](#loops)
7. [Rig Setup](#rig-setup)
8. [File Tracking](#file-tracking)
9. [Environment Variables](#environment-variables)
10. [Output Configuration](#output-configuration)
11. [Complete Examples](#complete-examples)
12. [Best Practices](#best-practices)
13. [Common Patterns](#common-patterns)

## Strand File Format

Strand configuration files (typically named `strand.json`) use an object format that includes optional metadata, runtime recommendations, and the codon sequence:

```json
{
  "meta": {
    "name": "My Workflow",
    "version": "1.0.0",
    "description": "A workflow for analyzing and refactoring code",
    "author": "Your Name"
  },
  "recommendations": {
    "model": "opus",
    "dataHashTimeLimit": 15000,
    "sentinel": {
      "enablePersistence": true
    }
  },
  "strand": [
    {
      "id": "codon-1",
      "name": "First Codon",
      "model": "sonnet",
      "continuationMode": "fresh",
      "promptText": "Do something"
    }
  ]
}
```

**Required Top-Level Fields**:
- `strand` - Array of codon configurations (or loops containing codons)

**Optional Top-Level Fields**:
- `meta` - Metadata about the workflow:
  - `name` (required if meta is present) - Human-readable name for the workflow
  - `version` (required if meta is present) - Version string (e.g., "1.0.0", "2.1.3-beta")
  - `description` (optional) - Description of the workflow's purpose
  - `author` (optional) - Author name or organization
- `recommendations` - Suggested runtime settings for this workflow
  - These are part of the [5-layer configuration system](./running-the-server.md#configuration-system)
  - Users can override recommendations with environment variables or CLI flags
  - See [Runtime Configuration](./running-the-server.md#layer-3-strand-file-recommendations) for available fields

**Minimal Example**:
```json
{
  "strand": [
    {
      "id": "analyze",
      "name": "Analyze Code",
      "model": "sonnet",
      "continuationMode": "fresh",
      "promptFile": "./prompts/analyze.md"
    }
  ]
}
```

**Example with Complete Metadata**:
```json
{
  "meta": {
    "name": "Full Stack Migration Workflow",
    "version": "2.1.0",
    "description": "Migrates a legacy JavaScript application to TypeScript with full test coverage",
    "author": "Engineering Team at Southbridge"
  },
  "recommendations": {
    "model": "sonnet",
    "dataHashTimeLimit": 120000
  },
  "strand": [
    {
      "id": "analyze",
      "name": "Analyze Legacy Code",
      "model": "opus",
      "continuationMode": "fresh",
      "promptFile": "./prompts/analyze-legacy.md"
    },
    {
      "id": "migrate",
      "name": "Perform Migration",
      "model": "sonnet",
      "continuationMode": "continue-previous",
      "promptFile": "./prompts/migrate-to-typescript.md"
    }
  ]
}
```

## Basic Codon Structure

Every codon must have these required fields:

```json
{
  "id": "unique-codon-id",           // Must be unique across all codons
  "name": "Human Readable Name",     // Displayed in UI/logs
  "model": "sonnet",                 // "sonnet" or "opus"
  "continuationMode": "fresh"        // "fresh" or "continue-previous"
}
```

Plus one of these prompt sources:
- `promptFile`: Path to a markdown file with the prompt
- `promptText`: Inline prompt text

## Prompt Configuration

### Single Prompt File
```json
{
  "id": "analyze",
  "name": "Code Analysis",
  "promptFile": "./prompts/analyze.md",
  "model": "sonnet",
  "continuationMode": "fresh"
}
```

### Multiple Prompt Files
When you need to combine multiple prompt files:
```json
{
  "promptFile": [
    "./prompts/base-instructions.md",
    "./prompts/specific-task.md",
    "./prompts/output-format.md"
  ]
}
```
Files are concatenated with double newlines between them.

### Inline Prompt Text
For simple prompts or dynamic content:
```json
{
  "promptText": "Please analyze the files in the src/ directory and suggest improvements."
}
```

### System Prompt Additions
Add system-level instructions that Claude will follow:
```json
{
  "appendSystemPromptFile": "./prompts/coding-standards.md",
  // OR
  "appendSystemPromptText": "Always write TypeScript with strict mode enabled.",
  // OR multiple files
  "appendSystemPromptFile": [
    "./prompts/project-context.md",
    "./prompts/style-guide.md"
  ]
}
```

### Template Variables
Both prompts and system prompts support template variables that are replaced at runtime:

- `<%EXECUTION_DIR%>` - The execution directory path (recommended)
- `<%DATA_DIR%>` - The data directory path (`execution-dir/read_only_data_source`)
- `<%PROJECT_DIR%>` - **Deprecated** but still works, maps to execution directory

Example usage:
```markdown
Please analyze the code in <%DATA_DIR%>/src and create documentation in <%EXECUTION_DIR%>/docs
```

This ensures Claude reads from your original data but writes to the execution directory, keeping your project clean. Note that `<%DATA_DIR%>` works consistently whether your data source is a file or directory.

## Model Selection

### Claude 3.5 Sonnet
```json
{
  "model": "sonnet"
}
```
- **Speed**: Fast (typically 5-30 seconds per response)
- **Cost**: $3 per million input tokens, $15 per million output tokens
- **Best for**: Most coding tasks, analysis, refactoring, documentation
- **Context**: 200K tokens

### Claude 3 Opus
```json
{
  "model": "opus"
}
```
- **Speed**: Slower (typically 30-120 seconds per response)
- **Cost**: Higher than Sonnet
- **Best for**: Complex reasoning, architecture decisions, nuanced analysis
- **Context**: 200K tokens

## Continuation Modes

### Fresh Start
Each codon starts a new conversation:
```json
{
  "continuationMode": "fresh"
}
```

### Continue Previous
Maintains conversation context from the previous codon:
```json
{
  "continuationMode": "continue-previous"
}
```

### Multi-Codon Workflow Example
```json
[
  {
    "id": "design",
    "name": "Design API",
    "continuationMode": "fresh",
    "promptText": "Design a REST API for a todo application"
  },
  {
    "id": "implement",
    "name": "Implement API",
    "continuationMode": "continue-previous",
    "promptText": "Now implement the API you just designed in TypeScript"
  },
  {
    "id": "test",
    "name": "Write Tests",
    "continuationMode": "continue-previous",
    "promptText": "Write comprehensive tests for the implementation"
  }
]
```

## Loops

Loops allow you to repeat a sequence of codons multiple times. They're useful for tasks that need to run until a certain condition is met.

### Basic Loop Structure

```json
{
  "type": "loop",
  "id": "my-loop",
  "name": "Write code and review",
  "description": "Write some code and review it 3 times",
  "terminateOn": {
    "type": "iterationLimit",
    "limit": 3
  },
  "codons": [
    {
      "id": "write-code",
      "name": "Write Code",
      "model": "sonnet",
      "continuationMode": "fresh",
      "promptText": "Write some code"
    },
    {
      "id": "review-code",
      "name": "Review Code",
      "model": "sonnet",
      "continuationMode": "continue-previous",
      "promptText": "Review the code you just wrote"
    }
  ]
}
```

### Termination Conditions

Loops support two termination modes:

#### Iteration Limit
Stops after a fixed number of iterations:

```json
{
  "terminateOn": {
    "type": "iterationLimit",
    "limit": 3
  }
}
```

#### Context Exceeded
Continues until Claude's context window is exhausted:

```json
{
  "terminateOn": {
    "type": "contextExceeded"
  }
}
```

### Loop Expansion

Loops are "lazily expanded" at runtime. This means:

1. **Initial plan**: Only the first iteration is added to the execution plan
2. **After each iteration**: The next iteration is added if termination condition is not met
3. **Codon IDs**: Loop codons get iteration-suffixed IDs like `write-code#0`, `write-code#1`, etc.

Example expansion for a loop with 2 codons and `limit: 3`:

```
Initial plan:     [write-code#0, review-code#0]
After iteration 0: [write-code#0, review-code#0, write-code#1, review-code#1]
After iteration 1: [write-code#0, review-code#0, write-code#1, review-code#1, write-code#2, review-code#2]
After iteration 2: (limit reached, no more expansion)
```

### Validation Rules for contextExceeded Loops

Loops with `contextExceeded` termination have special validation rules to prevent infinite loops and ensure proper behavior:

#### Rule 1: No `fresh` Continuation Mode Inside Loop

All codons inside a `contextExceeded` loop **must** use `continuationMode: "continue-previous"`.

**Why?** A `fresh` continuation mode resets the conversation context making possibility of an endless loop very likely

```json
// INVALID - will throw error
{
  "type": "loop",
  "terminateOn": { "type": "contextExceeded" },
  "codons": [
    {
      "id": "my-codon",
      "continuationMode": "fresh",  // ERROR: Would cause infinite loop
      "promptText": "..."
    }
  ]
}
```

```json
// VALID
{
  "type": "loop",
  "terminateOn": { "type": "contextExceeded" },
  "codons": [
    {
      "id": "my-codon",
      "continuationMode": "continue-previous",  // Correct: context accumulates
      "promptText": "..."
    }
  ]
}
```

#### Rule 2: Codon After Loop Cannot Use `continue-previous`

A codon that follows a `contextExceeded` loop **cannot** use `continuationMode: "continue-previous"`.

**Why?** When a `contextExceeded` loop terminates, the context is exhausted - there's nothing meaningful to continue from.

```json
// INVALID - will throw error
[
  {
    "type": "loop",
    "id": "my-loop",
    "terminateOn": { "type": "contextExceeded" },
    "codons": [{ "id": "work", "continuationMode": "continue-previous", ... }]
  },
  {
    "id": "after-loop",
    "continuationMode": "continue-previous",  // ERROR: Context is exhausted
    "promptText": "..."
  }
]
```

```json
// VALID
[
  {
    "type": "loop",
    "id": "my-loop",
    "terminateOn": { "type": "contextExceeded" },
    "codons": [{ "id": "work", "continuationMode": "continue-previous", ... }]
  },
  {
    "id": "after-loop",
    "continuationMode": "fresh",  // Correct: starts new conversation
    "promptText": "..."
  }
]
```

### Rig Setup in Loop Codons

Codons inside loops can have `rigSetup` operations, but consider:

1. **Rig setup runs every iteration**: If you copy files or run commands, they execute each time the codon runs
2. **Use `allowFailure: true`**: For operations that might fail on subsequent iterations (e.g., file already exists)

```json
{
  "type": "loop",
  "codons": [
    {
      "id": "setup-and-work",
      "rigSetup": [
        {
          "type": "copy",
          "copy": { "from": "./template", "to": "output" },
          "allowFailure": true  // Won't fail loop if target exists
        }
      ],
      "promptText": "..."
    }
  ]
}
```

**Warning**: If rig setup in a loop codon doesn't have `allowFailure: true`, you will receive a warning during config validation.

### Complete Loop Examples

#### Example 1: Iterative Development (Fixed Iterations)
```json
{
  "type": "loop",
  "id": "dev-loop",
  "name": "Development Cycle",
  "terminateOn": { "type": "iterationLimit", "limit": 3 },
  "codons": [
    {
      "id": "implement",
      "name": "Implement Feature",
      "model": "sonnet",
      "continuationMode": "fresh",
      "promptText": "Implement the next feature from the TODO list",
      "trackedFiles": ["src/**/*.ts"]
    },
    {
      "id": "test",
      "name": "Write Tests",
      "model": "sonnet",
      "continuationMode": "continue-previous",
      "promptText": "Write tests for the feature you just implemented",
      "trackedFiles": ["tests/**/*.ts"]
    },
    {
      "id": "review",
      "name": "Code Review",
      "model": "opus",
      "continuationMode": "continue-previous",
      "promptText": "Review the implementation and tests. Suggest improvements.",
      "trackedFiles": ["**/*.ts"]
    }
  ]
}
```

#### Example 2: Context-Aware Processing (Until Context Full)
```json
[
  {
    "id": "setup",
    "name": "Initial Setup",
    "model": "sonnet",
    "continuationMode": "fresh",
    "promptText": "Initialize the project structure",
    "trackedFiles": ["**/*"]
  },
  {
    "type": "loop",
    "id": "processing-loop",
    "name": "Process Documents",
    "terminateOn": { "type": "contextExceeded" },
    "codons": [
      {
        "id": "process",
        "name": "Process Next Batch",
        "model": "sonnet",
        "continuationMode": "continue-previous",
        "promptText": "Process the next batch of documents and add to the analysis",
        "trackedFiles": ["output/**/*"]
      }
    ]
  },
  {
    "id": "summarize",
    "name": "Final Summary",
    "model": "sonnet",
    "continuationMode": "fresh",
    "promptText": "Read all processed output and create a final summary",
    "trackedFiles": ["output/**/*", "summary.md"]
  }
]
```

### Loop Limitations

- **No nested loops**: Loops cannot contain other loops (only Codon objects allowed inside)
- **No loop ID conflicts**: Loop IDs must be unique and cannot conflict with codon IDs
- **Codon IDs must be unique within the entire configuration**: Even across different loops

## Rig Setup

### Copy Operations
Copy files or directories before the codon starts:

```json
{
  "rigSetup": [
    {
      "type": "copy",
      "copy": {
        "from": "./templates/express-starter",
        "to": "backend"
      }
    }
  ]
}
```

### Command Execution
Run shell commands to prepare the environment:

```json
{
  "rigSetup": [
    {
      "type": "command",
      "command": {
        "run": "npm init -y",
        "workingDirectory": "project"
      }
    }
  ]
}
```

### Combined Setup
A complete setup sequence:

```json
{
  "rigSetup": [
    // First, copy template files
    {
      "type": "copy",
      "copy": {
        "from": "./templates/react-app",
        "to": "frontend"
      }
    },
    // Then install dependencies in the copied directory
    {
      "type": "command",
      "command": {
        "run": "npm install",
        "workingDirectory": "lastCopied"  // Special value: uses "frontend" from above
      }
    },
    // Run any other setup commands
    {
      "type": "command",
      "command": {
        "run": "npm run build",
        "workingDirectory": "lastCopied"
      }
    }
  ]
}
```

### Working Directory Options
- `"project"`: Run in the project root (where you run the command from)
- `"lastCopied"`: Run in the destination of the last copy operation

## File Tracking

### Basic Patterns
```json
{
  "trackedFiles": [
    "*.js",           // All JS files in root
    "src/**/*.ts",    // All TS files in src (recursive)
    "docs/**/*",      // Everything in docs
    "config/*.json"   // JSON files in config
  ]
}
```

### Advanced Patterns
```json
{
  "trackedFiles": [
    "**/*.{ts,tsx}",        // TypeScript and TSX files
    "src/**/!(*.test).ts",  // Exclude test files
    "!node_modules",        // Exclude node_modules
    "!**/*.log",            // Exclude all log files
    "build/index.js"        // Include specific build output
  ]
}
```

### Pattern Reference
- `*` - Any characters except `/`
- `**` - Any characters including `/`
- `?` - Single character
- `[abc]` - Character class
- `!(pattern)` - Negation
- `{a,b,c}` - Brace expansion

## Environment Variables

### Codon-Specific Variables
```json
{
  "env": {
    "API_KEY": "codon-specific-key",
    "NODE_ENV": "development",
    "DEBUG": "true"
  }
}
```

### System Variables (STRANDWEAVE_ prefix)
Set in your shell before running the server:
```bash
export STRANDWEAVE_GITHUB_TOKEN=ghp_xxxxx
export STRANDWEAVE_API_ENDPOINT=https://api.example.com
```

Claude will see these as:
- `GITHUB_TOKEN=ghp_xxxxx`
- `API_ENDPOINT=https://api.example.com`

**Note**: Sentinels use a different set of environment variables (`STRANDWEAVE_SENTINEL_*` prefix) for their LLM API keys. See the [Sentinel Configuration Guide](./sentinels/configuration-guide.md#environment-variables) for details.

## Configuring Sentinels

You can run one or more parallel observation agents, called Sentinels, during a codon. They are defined in a `sentinels` array within the codon configuration.

### The Wrapper Pattern

To keep sentinel definitions reusable across different codons, Strandweave uses a "wrapper" pattern. For each sentinel you want to run, you provide an object that separates the sentinel's definition from its settings for this specific codon.

```json
{
  "id": "codon-1",
  // ...
  "sentinels": [
    {
      "sentinelConfig": "./sentinels/my-narrator.json",
      "settings": {
        "failCodonIfNotLoaded": true,
        "outputPaths": {
          "logFile": "codon-1-narrative.log"
        }
      }
    }
  ]
}
```

- `sentinelConfig`: This can be either a string (a path to a JSON file containing the sentinel's configuration) or an inline JSON object with the full sentinel configuration.
- `settings`: An optional object containing settings that apply to this sentinel only for this codon.

### Codon-Specific Settings (`settings`)

#### `failCodonIfNotLoaded`
- **Type**: `boolean`
- **Default**: `false`

If set to `true`, the entire codon will fail to start if this specific sentinel cannot be loaded (e.g., its configuration file is not found or contains errors). This is useful for critical sentinels that are essential for the codon's purpose.

#### `outputPaths`
- **Type**: `object`

This object specifies where the sentinel should write its output files.

- `logFile`: A path for an append-only log file. Every output from the sentinel will be added to this file.
- `lastValueFile`: A path for a file that will be overwritten with the latest output from the sentinel.

**Path Resolution Logic**:
- **Filename only** (e.g., `"summary.md"`): The file will be placed in a dedicated directory for that sentinel inside the execution environment at `.strandweave/sentinels/outputs/<sentinel-id>/summary.md`. This is the recommended approach to keep outputs organized.
- **Path with a slash** (e.g., `"reports/summary.md"`): The path is treated as relative to the root of the execution directory. This allows sentinels to write files into the execution environment, where they could potentially be read by the primary agent.

#### `reportToWebsocket`
- **Type**: `object`

This object allows you to override the sentinel's default settings for which of its internal events are reported to the WebSocket client. This is useful for reducing noise in the event stream.

- `lifecycle`: `true` or `false`
- `errors`: `true` or `false`
- `outputs`: `true` or `false`
- `triggers`: `true` or `false`

### Full Example of a `CodonSentinelEntry`

```json
{
  "sentinels": [
    {
      "sentinelConfig": "./sentinels/code-reviewer.json",
      "settings": {
        "failCodonIfNotLoaded": false,
        "outputPaths": {
          "logFile": "code-review.log",
          "lastValueFile": "latest-review.txt"
        },
        "reportToWebsocket": {
          "outputs": false,
          "triggers": true
        }
      }
    }
  ]
}
```

For a deep dive into creating the sentinel configuration files themselves (including triggers, execution strategies, and prompts), see the **[Sentinel Configuration Guide](./sentinels/configuration-guide.md)**.

## Output Configuration

Strandweave can automatically copy files from the execution directory to a `strandweave-results` directory where you run the command from. This makes it easy to access the output of your codons without navigating to the execution directory.

### Basic Output Configuration

Add an `outputFiles` array to your codon configuration (one or more copy groups):

```json
{
  "id": "analyze",
  "name": "Code Analysis",
  "promptFile": "./prompts/analyze.md",
  "model": "sonnet",
  "continuationMode": "fresh",
  "trackedFiles": ["analysis.md"],
  "outputFiles": [
    {
      "copy": ["analysis.md"]
    }
  ]
}
```

This will copy `analysis.md` from the execution directory to `strandweave-results/analysis.md` when the codon completes successfully.

### Before-copy Commands

You can run shell commands before copying files in each output group using the `beforeCopy` array. These are especially useful when you need to rename files before copying them to the `strandweave-results` in the directory where you run strandweave.

**Please note**: if one of the `beforeCopy` commands fails, the whole copy group fails and nothing is copied to `strandweave-results` for this specific group. Strandweave will however attempt to run remaining copy groups.

```json
{
  "outputFiles": [
    {
      "beforeCopy": [
        {
          "type": "command",
          "command": {
            "run": "mv analysis.md $(date +%Y_%m_%d)_analysis.md"
          }
        }
      ],
      "copy": ["*_analysis.md"]
    }
  ]
}
```

This example renames the analysis file with a timestamp before copying it.

### Copy Patterns

The `copy` array supports glob patterns for flexible file selection:

```json
{
  "outputFiles": [
    {
      "copy": [
        "*.md",                    // All markdown files
        "reports/**/*",            // Everything in reports directory
        "src/**/*.{ts,js}",        // TypeScript and JavaScript files in src
        "!src/**/*.test.*"         // Exclude test files
      ]
    }
  ]
}
```

### Output File Lifecycle

1. Codon executes and modifies files in the execution directory
2. Codon completes successfully
3. For each output group, `beforeCopy` commands run (if specified)
4. Files matching each group's `copy` patterns are copied to `strandweave-results/`. Subdirectories are recreated recursively inside `strandweave-results/` if needed.
5. Files accumulate in `strandweave-results/` across multiple codons

### Complete Output Example

```json
{
  "id": "documentation-codon",
  "name": "Generate Documentation",
  "promptFile": "./prompts/generate-docs.md",
  "model": "sonnet",
  "continuationMode": "fresh",
  "trackedFiles": ["docs/**/*.md", "README.md"],
  "outputFiles": [
    {
      "beforeCopy": [
        {
          "type": "command",
          "command": {
            "run": "mkdir -p versioned-docs/$(date +%Y-%m-%d)"
          }
        },
        {
          "type": "command",
          "command": {
            "run": "cp -r docs/* versioned-docs/$(date +%Y-%m-%d)/"
          }
        }
      ],
      "copy": [
        "versioned-docs/**/*",
        "README.md"
      ]
    }
  ]
}
```

## Complete Examples

### Example 1: Simple Analysis Codon
```json
{
  "id": "analyze-codebase",
  "name": "Codebase Analysis",
  "model": "sonnet",
  "continuationMode": "fresh",
  "promptFile": "./prompts/analyze.md",
  "trackedFiles": ["analysis.md"],
  "outputFiles": [
    {
      "copy": ["analysis.md"]
    }
  ]
}
```

### Example 2: Full Stack Application Setup
```json
[
  {
    "id": "setup-backend",
    "name": "Setup Express Backend",
    "model": "sonnet",
    "continuationMode": "fresh",
    "promptText": "Create an Express.js backend with TypeScript, including user authentication",
    "rigSetup": [
      {
        "type": "copy",
        "copy": {
          "from": "./templates/express-ts",
          "to": "backend"
        }
      },
      {
        "type": "command",
        "command": {
          "run": "npm install && npm run build",
          "workingDirectory": "lastCopied"
        }
      }
    ],
    "trackedFiles": [
      "backend/src/**/*.ts",
      "backend/package.json"
    ],
    "env": {
      "PORT": "3001"
    }
  },
  {
    "id": "setup-frontend",
    "name": "Create React Frontend",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "promptText": "Now create a React frontend that connects to the backend you just created",
    "rigSetup": [
      {
        "type": "command",
        "command": {
          "run": "npx create-react-app frontend --template typescript",
          "workingDirectory": "project"
        }
      }
    ],
    "trackedFiles": [
      "frontend/src/**/*.{ts,tsx}",
      "frontend/package.json"
    ]
  },
  {
    "id": "integrate",
    "name": "Integrate Frontend and Backend",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "promptText": "Connect the frontend to the backend API and create a working login flow",
    "trackedFiles": [
      "frontend/src/**/*.{ts,tsx}",
      "backend/src/**/*.ts"
    ]
  }
]
```

### Example 3: Migration Workflow
```json
[
  {
    "id": "analyze-legacy",
    "name": "Analyze Legacy Code",
    "model": "opus",  // Use more capable model for analysis
    "continuationMode": "fresh",
    "promptFile": "./prompts/analyze-for-migration.md",
    "trackedFiles": ["migration-plan.md"],
    "appendSystemPromptFile": "./prompts/migration-guidelines.md"
  },
  {
    "id": "create-tests",
    "name": "Create Test Suite",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "promptText": "Based on your analysis, create comprehensive tests for the legacy code before we migrate it",
    "trackedFiles": ["tests/**/*.test.js"]
  },
  {
    "id": "migrate-code",
    "name": "Perform Migration",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "promptFile": "./prompts/migrate-to-typescript.md",
    "trackedFiles": [
      "src/**/*.ts",
      "src/**/*.js"  // Track both old and new files
    ]
  },
  {
    "id": "verify",
    "name": "Verify Migration",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "promptText": "Run the tests and verify the migration was successful. Fix any issues.",
    "rigSetup": [
      {
        "type": "command",
        "command": {
          "run": "npm test",
          "workingDirectory": "project"
        }
      }
    ]
  }
]
```

## Best Practices

### 1. Codon Granularity
- Keep codons focused on a single logical task
- Each codon should produce a clear, verifiable output

### 2. Model Selection Strategy
```json
{
  // Use Opus for complex reasoning
  "model": "opus",  // Design decisions, architecture planning

  // Use Sonnet for implementation
  "model": "sonnet"  // Coding, refactoring, documentation
}
```

### 3. File Tracking Strategy
- Track only files that the codon will create/modify
- Exclude large binary files and dependencies
- Use specific patterns to improve performance

### 4. Rig Setup Tips

#### Performance Calculations

**Setup Time Estimation:**
```
T_setup = T_copy + T_commands
```

Where:
- `T_copy = ∑(S_i / R_disk)` for each copied item
- `S_i` = size of item i in bytes
- `R_disk` = disk read/write rate
- `T_commands = ∑(T_cmd_i)` for each command

**Copy vs Symlink Performance:**
```
T_symlink = O(1) ≈ 1ms
T_copy = O(n) = S_total / R_disk
```

#### Best Practices
- Test commands locally first
- Ensure commands are idempotent (safe to run multiple times)
- Use `&&` for command chaining, not separate command blocks
- Add error handling: `command || echo 'Command failed but continuing'`
- Consider copy time when using large templates: `T_copy ≈ size_GB × 10s` (typical SSD)

### 5. Continuation Strategy
- Use `fresh` when starting a new logical task
- Use `continue-previous` for multi-step processes
- Don't rely on continuation after very long codons (>100 messages)

### 6. Environment Variable Management
```bash
# Create a .env file for development
STRANDWEAVE_API_KEY=xxx
STRANDWEAVE_DB_URL=postgres://...

# Source it before running
source .env && bun run server
```

## Common Patterns

### Pattern 1: Iterative Development
```json
[
  { "id": "v1", "continuationMode": "fresh", "name": "Initial Implementation" },
  { "id": "review", "continuationMode": "continue-previous", "name": "Code Review" },
  { "id": "v2", "continuationMode": "continue-previous", "name": "Apply Improvements" }
]
```

### Pattern 2: Test-Driven Development
```json
[
  { "id": "spec", "name": "Write Specifications" },
  { "id": "tests", "continuationMode": "continue-previous", "name": "Write Tests" },
  { "id": "implement", "continuationMode": "fresh", "name": "Implementation" },
  { "id": "verify", "continuationMode": "fresh", "name": "Run Tests & Fix" }
]
```

### Pattern 3: Documentation Generation
```json
{
  "id": "document",
  "name": "Generate Documentation",
  "model": "sonnet",
  "continuationMode": "fresh",
  "promptFile": "./prompts/document.md",
  "appendSystemPromptText": "Use JSDoc format for all documentation",
  "trackedFiles": [
    "src/**/*.js",  // Read source files
    "docs/**/*.md"  // Write documentation
  ]
}
```

### Pattern 4: Refactoring Workflow
```json
[
  {
    "id": "analyze-code-smells",
    "name": "Identify Issues",
    "model": "opus",
    "promptText": "Analyze the codebase for code smells and anti-patterns",
    "trackedFiles": ["refactoring-plan.md"]
  },
  {
    "id": "refactor-step-1",
    "name": "Refactor Core Module",
    "model": "sonnet",
    "continuationMode": "continue-previous",
    "promptText": "Refactor the core module based on your analysis",
    "trackedFiles": ["src/core/**/*.ts"]
  }
]
```

## Debugging Configuration Issues

### Validation Command
Always validate before running:
```bash
bun run validate --config=my-codon-sequence.json
```

### Common Errors

1. **Missing Required Fields**
   ```
   Error: Codon "codon-1" is missing required field 'model'
   ```

2. **Invalid Continuation Mode**
   ```
   Warning: First codon has continuationMode "continue-previous"
   ```

3. **File Not Found**
   ```
   Error: promptFile "./prompts/missing.md" does not exist
   ```

4. **Invalid Glob Pattern**
   ```
   Warning: Pattern "src/**.ts" should be "src/**/*.ts"
   ```

5. **Fresh Continuation in contextExceeded Loop**
   ```
   Error: Loop with contextExceeded termination cannot contain codons with continuationMode "fresh".
   Codon "my-codon" (my-codon) has continuationMode "fresh", which would prevent context
   from building up and cause an infinite loop. Change to "continue-previous" to allow
   context to accumulate.
   ```

6. **Continue-Previous After contextExceeded Loop**
   ```
   Error: Cannot use continuationMode "continue-previous" after a loop with contextExceeded
   termination. Loop "my-loop" (my-loop) terminates only when context is exhausted, meaning
   there's no meaningful conversation to continue. Change to "fresh" to start a new conversation.
   ```

7. **Duplicate Codon ID**
   ```
   Error: Duplicate codon ID "my-id" found
   ```

8. **Empty Loop**
   ```
   Error: Loop must contain at least one codon
   ```

9. **Invalid Iteration Limit**
   ```
   Error: Iteration limit must be at least 1
   ```

### Configuration Debugging Tips

1. Start with a minimal configuration and add features incrementally
2. Test rig setup commands in isolation first
3. Use the `--no-autostart` flag to manually control codon execution
4. Check `.strandweave/runs/<runId>/` for Claude's actual output
