Of course. This is an excellent feature that will significantly improve the user experience by making Tadpole's results more accessible. Implementing this requires careful modifications to the configuration schema and the server's core execution logic.

Here is a detailed implementation plan, breaking down the necessary changes step-by-step.

### High-Level Plan

1.  **Update Configuration Schema**: We will modify the structure of `phases.json`. It will become a root object containing the `phases` array and a new optional `finalOutput` object. We will also add an optional `phaseOutput` object to each individual phase configuration.
2.  **Refactor Config Loading**: The function `loadPhaseConfig` will be updated to parse this new object structure.
3.  **Enhance Server Logic**: The `TadpoleServer` will be updated to:
    *   Track the user's original working directory.
    *   Implement a new private method to handle the file copying logic, including glob pattern resolution.
    *   Trigger the copy operation for a phase upon its successful completion.
    *   Trigger the final copy operation when the entire workflow concludes successfully.
4.  **Update Documentation**: We'll note the necessary updates to user-facing documentation to reflect these new features.

---

### Phase 1: Configuration Schema Changes

The most significant change is that `phases.json` will no longer be a simple array. It will be an object, allowing for top-level configuration like `finalOutput`.

#### **File: `server/config.ts`**

1.  **Define a new schema for output operations.** This will be used for both phase-level and final outputs.

    ```typescript
    // server/config.ts

    // Add this new schema near the other schema definitions
    const outputItemSchema = z.object({
      type: z.literal("copy"),
      source: z.union([z.string(), z.array(z.string())]), // path or glob patterns
      destination: z.string().optional().default("."), // relative to the results dir
    });

    const phaseOutputSchema = z.array(outputItemSchema);
    ```
    *Self-correction: A simple array of glob strings is cleaner and sufficient for the requested feature. Let's simplify.*

    **Corrected Approach:** Let's define a simpler, more direct schema for the copy operation.

    ```typescript
    // server/config.ts

    // Add this new schema near other schema definitions
    const outputSchema = z.object({
      copy: z.array(z.string()).min(1, "The 'copy' array cannot be empty."),
    }).strict();
    ```

2.  **Update the `phaseConfigSchema`** to include the new optional `phaseOutput` property.

    ```typescript
    // server/config.ts

    // Find the phaseConfigSchema definition
    const phaseConfigSchema = z
      .object({
        id: z.string().min(1, /* ... */),
        name: z.string().min(1, /* ... */),
        // ... existing properties
        trackedFiles: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
        phaseOutput: outputSchema.optional(), // <-- ADD THIS LINE
      })
      .strict()
      // ... existing refines
    ```

3.  **Create a new top-level schema** and refactor `loadPhaseConfig` to handle the new object structure.

    ```typescript
    // server/config.ts

    // This schema will now represent the entire phases.json file
    const tadpoleConfigSchema = z.object({
        phases: z.array(phaseConfigSchema).min(1, "At least one phase is required."),
        finalOutput: outputSchema.optional(),
    }).strict();

    // RENAME loadPhaseConfig to loadTadpoleConfig and update its logic
    export function loadTadpoleConfig(configPath: string): { phases: PhaseConfig[], finalOutput?: z.infer<typeof outputSchema> } {
      try {
        const content = fs.readFileSync(configPath, "utf-8");
        const rawConfig = JSON.parse(content);

        // Validate the new top-level configuration object
        const result = tadpoleConfigSchema.safeParse(rawConfig);
        if (!result.success) {
          const errors = formatZodErrors(result.error, rawConfig);
          throw new Error(`Invalid configuration in ${configPath}:\n${errors}`);
        }

        const configDir = path.dirname(configPath);
        // Resolve paths within each phase, as before
        const resolvedPhases = result.data.phases.map((phase) => {
          // ... (existing path resolution logic for promptFile, etc.)
          // No paths to resolve in phaseOutput or finalOutput, as they are relative to the execution dir
          return phase;
        });

        // Validate file existence etc., as before
        // ... (existing validation loop)

        const finalConfig = {
            phases: resolvedPhases.map((phase) => ({
                ...phase,
                id: PhaseId(phase.id),
            })),
            finalOutput: result.data.finalOutput,
        };

        return finalConfig;
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Failed to load config from ${configPath}: ${error.message}`);
        }
        throw error;
      }
    }
    ```
    ***Note:*** All calls to `loadPhaseConfig` throughout the codebase, especially in `server/index.ts`, must be updated to `loadTadpoleConfig` and handle the returned object `{ phases, finalOutput }`.

---

### Phase 2: Server Core Logic

Now we will implement the logic to perform the copy operations.

#### **File: `server/index.ts`**

1.  **Capture and Pass `originalCwd`**: The server changes its working directory, so we must capture the original CWD at startup and pass it to the server instance.

    ```typescript
    // server/index.ts -> in main()

    // This line already exists, we just need to use it
    const originalCwd = process.cwd();

    // ... later, inside the try block for normal server mode ...

    // The call to loadTadpoleConfig will now return an object
    const { phases, finalOutput, warnings } = await validateAndLoadTadpoleConfig(absoluteConfigPath, executionSetup.executionPath);

    // ...

    // Update the serverConfig object
    const serverConfig = {
        // ... existing properties
        phases,
        finalOutput, // <-- ADD THIS
        originalCwd, // <-- ADD THIS
        autostart: !noAutostart,
    };

    const server = new TadpoleServer(serverConfig);
    await server.start();
    ```

#### **File: `server/tadpole-server.ts`**

1.  **Update `ServerConfig` type and `TadpoleServer` constructor**: Store the new properties.

    ```typescript
    // server/types/types.ts

    export interface ServerConfig {
      // ... existing properties
      finalOutput?: { copy: string[] }; // Add this
      originalCwd: string; // Add this
    }

    // server/tadpole-server.ts

    export class TadpoleServer extends TypedEventEmitter<ServerInternalEvents> {
      // ... existing properties
      private readonly finalOutput?: { copy: string[] };
      private readonly originalCwd: string;

      constructor(config: ServerConfig) { // Update config type if not inferred
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.finalOutput = config.finalOutput; // Store finalOutput
        this.originalCwd = config.originalCwd; // Store originalCwd
        // ... rest of constructor
      }
    }
    ```

2.  **Implement the `copyOutputs` helper method**: This method will contain the logic for resolving globs and copying files.

    ```typescript
    // server/tadpole-server.ts -> inside the TadpoleServer class

    private async copyOutputs(
      outputConfig: { copy: string[] },
      phaseName: string
    ): Promise<void> {
      const resultsDir = path.join(this.originalCwd, "tadpole-results");
      try {
        await fs.promises.mkdir(resultsDir, { recursive: true });
        this.logger.log(`Ensured tadpole-results directory exists at: ${resultsDir}`);

        // Resolve glob patterns from within the execution directory
        const filesToCopy = await fileResolver.resolveFiles(
          this.config.executionPath,
          outputConfig.copy
        );

        if (filesToCopy.length === 0) {
          this.logger.log(`[${phaseName}] No files found matching output patterns: ${outputConfig.copy.join(", ")}`, "info");
          return;
        }

        this.logger.log(`[${phaseName}] Found ${filesToCopy.length} file(s) to copy to results directory.`);

        for (const file of filesToCopy) {
          const sourcePath = path.join(this.config.executionPath, file);
          const destPath = path.join(resultsDir, file);

          // Ensure the destination subdirectory exists
          await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

          // Using fs.cp for robust recursive copying
          await fs.promises.cp(sourcePath, destPath, { recursive: true });
          this.logger.log(`Copied "${file}" to results.`);
        }
      } catch (error) {
        const errorMessage = `Failed to copy output files for ${phaseName}: ${toError(error).message}`;
        this.logger.log(errorMessage, "error");
        // We will log this error but not fail the entire run.
        this.sendEvent({
          id: EventId(generateId()),
          timestamp: new Date().toISOString(),
          type: "error",
          data: {
            message: errorMessage,
            fatal: false,
            severity: ErrorSeverity.WARNING,
          },
        } as ErrorEvent);
      }
    }
    ```

3.  **Hook into `handlePhaseComplete`**: Trigger the phase-level copy operation on success.

    ```typescript
    // server/tadpole-server.ts -> inside handlePhaseComplete()

    // ... after determining finalStatus
    const phaseConfig = this.config.phases.find(p => p.id === phaseId);

    if (finalStatus === "completed" && phaseConfig?.phaseOutput) {
      await this.copyOutputs(phaseConfig.phaseOutput, phaseConfig.name);
    }

    // The rest of the function continues...
    // this.sendEvent({ type: "phase.completed", ... });
    ```

4.  **Hook into `shutdown`**: Trigger the final copy operation when the entire workflow is done.

    ```typescript
    // server/tadpole-server.ts -> inside shutdown()

    async shutdown(reason: string): Promise<void> {
      // ... existing shutdown logic
      this.isShuttingDown = true;

      // ADD THIS BLOCK
      if (reason === "all phases completed" && this.finalOutput) {
        this.logger.log("All phases completed, processing final output...");
        await this.copyOutputs(this.finalOutput, "Final Output");
      }

      // ... rest of shutdown logic
    }
    ```

---

### Phase 3: Example Usage

Here is how a user would update their `phases.json` to use this new feature.

**`phases.json`:**

```json
{
  "phases": [
    {
      "id": "phase-1-analysis",
      "name": "Phase 1: Initial Analysis",
      "promptFile": "prompts/1-analyze.md",
      "model": "sonnet",
      "continuationMode": "fresh",
      "trackedFiles": ["analysis.md"],
      "phaseOutput": {
        "copy": ["analysis.md"]
      }
    },
    {
      "id": "phase-2-implementation",
      "name": "Phase 2: Implementation",
      "promptFile": "prompts/2-implement.md",
      "model": "sonnet",
      "continuationMode": "continue-previous",
      "trackedFiles": ["src/**/*.ts"]
    }
  ],
  "finalOutput": {
    "copy": [
      "src/**/*.ts",
      "analysis.md"
    ]
  }
}
```

**Expected Result:**

1.  When "Phase 1" completes successfully, `analysis.md` from the execution directory will be copied to `<original_cwd>/tadpole-results/analysis.md`.
2.  "Phase 2" runs and modifies files in `src/`.
3.  When the entire workflow finishes, all files from `src/` and the `analysis.md` file from the execution directory will be copied to `<original_cwd>/tadpole-results/`, resulting in a final structure like:
    ```
    my-project/
    ├── tadpole-results/
    │   ├── analysis.md
    │   └── src/
    │       └── ... (all modified typescript files)
    ├── src/
    └── phases.json
    ```

---

### Phase 4: Documentation Updates

To ensure users can leverage this feature, the following documentation should be updated:

1.  **`README.md`**: Add a section briefly explaining the output feature and link to the more detailed guide.
2.  **`documentation/phase-configuration-guide.md`**: Add detailed sections for the new `phaseOutput` and `finalOutput` properties, explaining their structure, how to use glob patterns, and where the files will be copied.
3.  **`documentation/execution-model-guide.md`**: Mention the `tadpole-results` directory as a key user-facing artifact of a successful run.

This plan provides a complete, robust, and user-friendly implementation of the requested output feature.