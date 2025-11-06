# Chronicler File Output: Execution Spec

## 1. Overview

This document outlines the plan to implement file output capabilities for Chroniclers. The goal is to allow a Chronicler to write its output to two distinct types of files:

1.  **Append-only Log File**: A file that accumulates all outputs from a Chronicler over its lifetime, with optional separators.
2.  **Last Value File**: A file that is overwritten with the latest output from the Chronicler.

This feature will enable persistence of Chronicler results, making them available for external tools, downstream processing, and easier inspection.

The implementation will focus on changes within the Chronicler system, primarily in the configuration schema and the `Chronicler` class itself.

## 2. Configuration Changes

The primary changes will be in `server/config-validation/chronicler.schema.ts`. We will replace the existing `output` object in `chroniclerConfigSchema` with a more comprehensive structure.

### Proposed Schema

The new `output` object will be defined as follows:

```typescript
// To be added inside server/config-validation/chronicler.schema.ts

const fileOutputSchema = z.object({
  logFile: z.string().optional().describe("Path to the append-only log file, relative to the execution directory."),
  lastValueFile: z.string().optional().describe("Path to the file for the last value, relative to the execution directory."),
  joinString: z.string().optional().default("\\n---\\n").describe("String to join entries in the text-based log file."),
}).refine(data => data.logFile || data.lastValueFile, {
  message: "At least one of `logFile` or `lastValueFile` must be provided in the output configuration.",
  path: [],
});

// ... inside chroniclerConfigSchema ...
// The existing `output` property will be replaced with this:
output: fileOutputSchema.optional(),
```

### Rationale for Schema Changes

- **`logFile` & `lastValueFile`**: These two distinct properties provide clarity and align with the feature requirements for an append-log and a last-value file.
- **Paths Relative to Execution Directory**: The description for the paths explicitly states they are relative to the execution directory. This is a crucial detail for portability.
- **`joinString`**: A dedicated property for the join string, with a sensible default (`\n---\n`), makes it easy to format text logs.
- **`refine`**: The `refine` call enforces the requirement that at least one of the two file paths must be provided if the `output` object is present, making the feature meaningful when used.
- **Replaces existing `output`**: The current `output` schema is too simplistic for these new requirements. A clean replacement is better than trying to adapt the old one.

## 3. Implementation Details

### 3.1. Path Validation and Initialization

**Location**: The logic for validating paths and preparing the output files will reside in the `Chronicler` class constructor in `server/chroniclers/chronicler.ts`.

**Execution Directory**: The `Chronicler` class currently does not have a concept of the "execution directory". We will need to pass this path down from its creator, the `ChroniclerManager`.

**Proposed Changes**:

1.  **`ChroniclerManager`**:

    - The `loadChroniclersForPhase` method in `server/chroniclers/chronicler-manager.ts` should accept a new optional parameter: `executionDir?: string`.
    - If provided, this path will be passed to the `Chronicler` constructor.

2.  **`Chronicler` Constructor**:
    - The constructor will accept the new `executionDir?: string` parameter.
    - It will have a new private property, e.g., `private outputPaths?: { logFile?: string; lastValueFile?: string; }`.
    - If `config.output` is present:
      - It will resolve `logFile` and `lastValueFile` paths relative to `executionDir`. If `executionDir` is not provided, it should log a warning and disable file output.
      - It will perform validation:
        - Check if the directory for the output file exists. If not, attempt to create it using `fs.mkdirSync(..., { recursive: true })`. This is acceptable in the constructor as it's a one-time setup cost.
        - Validate file extensions based on `structuredOutput` config:
          - If `structuredOutput` is enabled: `logFile` must end with `.ndjson` (or `.jsonl`), and `lastValueFile` must end with `.json`.
          - If `structuredOutput` is _not_ enabled: `logFile` and `lastValueFile` should probably be `.txt` or `.md`. We can enforce this or just recommend it in documentation. For simplicity, let's start by not enforcing extensions for plain text.
        - Any validation failure should throw a `ChroniclerFatalError` to prevent the Chronicler from running with a misconfigured output.
      - Store the resolved, absolute paths in `this.outputPaths`.

### 3.2. File Writing Logic

**Location**: The file writing will be implemented in a new private method within the `Chronicler` class, e.g., `private async writeOutput(output: string | object): Promise<void>`. This method will be called at the end of `executeTextGeneration` and `executeStructuredOutput` after a successful LLM call.

**Implementation Steps**:

1.  **Create `writeOutput` method**:

    ```typescript
    private async writeOutput(output: string | object): Promise<void> {
      if (!this.outputPaths) {
        return;
      }

      const isStructured = typeof output === 'object';

      // Handle logFile (append)
      if (this.outputPaths.logFile) {
        const contentToAppend = isStructured
          ? JSON.stringify(output) + '\\n'
          : output + (this.config.output?.joinString ?? '');

        try {
          await fs.promises.appendFile(this.outputPaths.logFile, contentToAppend);
        } catch (error) {
          this.logger?.log(`[Chronicler:${this.config.id}] Error appending to log file: ${error}`, "error");
        }
      }

      // Handle lastValueFile (overwrite)
      if (this.outputPaths.lastValueFile) {
        const contentToWrite = isStructured
          ? JSON.stringify(output, null, 2)
          : output;

        try {
          await fs.promises.writeFile(this.outputPaths.lastValueFile, contentToWrite);
        } catch (error) {
          this.logger?.log(`[Chronicler:${this.config.id}] Error writing to last value file: ${error}`, "error");
        }
      }
    }
    ```

2.  **Integrate into Execution Flow**:
    - In `executeTextGeneration`, after a successful `llmCall`, call `this.writeOutput(response.text)`. For conversational chroniclers, this should be after `historyManager.addMessagePair`.
    - In `executeStructuredOutput`, after a successful `llmObjectCall`, call `this.writeOutput(response.object)`.

### 3.3. `joinString` Implementation

The `joinString` will be handled within the `writeOutput` method as shown above. When appending to a text-based `logFile`, the `joinString` from the config will be appended after the content. This is a simple and effective way to implement this requirement.

## 4. Testing Strategy

1.  **Unit Tests (`chronicler-validation.test.ts`)**:

    - Add tests for the new `output` schema in `chroniclerConfigSchema`.
    - Test that valid configurations pass (e.g., only `logFile`, only `lastValueFile`, both).
    - Test that invalid configurations fail (e.g., empty `output` object, providing neither `logFile` nor `lastValueFile`).

2.  **Integration Tests (new file, e.g., `chronicler-output.test.ts`)**:
    - Create a temporary directory for test executions.
    - **Text Output**:
      - Run a chronicler with `logFile` and `lastValueFile` configured for text output.
      - Use the `chronicler-test-harness` to feed it events.
      - After `completeAllWork()`, read the content of the generated files and assert that:
        - The `logFile` contains all outputs, separated by the `joinString`.
        - The `lastValueFile` contains only the last output.
    - **Structured Output**:
      - Do the same for a chronicler with `structuredOutput` enabled.
      - Assert that `logFile` is valid NDJSON (i.e., each line is a valid JSON object).
      - Assert that `lastValueFile` is a valid, pretty-printed JSON file.
    - **Path Validation**:
      - Write a test that checks if the `Chronicler` constructor correctly creates nested directories for output files.
      - Write tests to ensure that `ChroniclerFatalError` is thrown for invalid file extensions with structured output.

## 5. Design Considerations & Potential Issues

- **Configuration Location (Chronicler vs. Phase)**:

  - The user correctly pointed out that output paths are execution-specific and should ultimately live in the **phase configuration**.
  - However, since Chroniclers are not yet fully integrated with the `TadpoleServer` and phase lifecycle, implementing it in the Chronicler config for now is a pragmatic choice. It allows us to build and test the core functionality in isolation.
  - **Recommendation**: We should add a `// TODO` comment in the schema definition, explicitly stating that this `output` configuration should be moved to the phase configuration once the integration is complete. This avoids over-engineering a complex phase-to-chronicler config injection mechanism right now.

- **File I/O Performance**:

  - File I/O is inherently blocking. While we are using `async` methods, on a very high-frequency Chronicler, this could still introduce some overhead.
  - The current design performs I/O after the LLM call for each trigger execution. This is simple and reliable. We should not attempt to batch file writes or create a more complex buffered writing system at this stage, as that would be premature optimization and potential over-engineering. The current approach is sufficient.

- **Error Handling**:
  - File I/O errors (e.g., disk full, permissions error) are logged but do not crash the Chronicler. This is consistent with the fault-tolerant nature of Chroniclers. A failed file write should not stop the main agent or the Chronicler itself from processing further events.
