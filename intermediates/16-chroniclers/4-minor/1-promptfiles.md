### **Objective**

Refactor the `ChroniclerConfig` schema to replace the single `promptTemplate` field with a more flexible system supporting multiple files and text blocks for both `systemPrompt` and `userPrompt`.

### **Summary of Changes**

| Component                 | Change                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Zod Schema**            | Remove `promptTemplate`. Add `systemPromptFile`, `systemPromptText`, `userPromptFile`, `userPromptText`. Add a `.refine()` check to ensure at least one `userPrompt` source exists. Add `.strict()`. |
| **TypeScript Types**      | Types will be automatically updated via `z.infer`. Re-exports in `chronicler-types.ts` will reflect the new structure.                                                                              |
| **Unit Tests**            | Update existing validation tests and add new ones for the new prompt schema, including cases that should fail.                                                                                    |
| **Configuration Loading** | The plan will outline how a future config loader should resolve file paths and concatenate prompt parts in the correct order.                                                                     |
| **Documentation**         | Update `chronicler-system.md` with the new schema and provide updated examples.                                                                                                                   |

---

### **Detailed Action Plan**

#### **Step 1: Update the Zod Schema (`server/config-validation/chronicler.schema.ts`)**

This is the most critical step as it defines the new "source of truth" for the configuration.

1.  **Locate the Schema:** Open `server/config-validation/chronicler.schema.ts`. Find the `chroniclerConfigSchema` definition.
2.  **Modify the Schema:**
    *   **Remove** the `promptTemplate: z.string().min(1)` line.
    *   **Add** the new optional prompt fields. Each `...File` field should support either a single string or an array of strings.
    *   **Add** a `.strict()` call to the object schema. This will cause validation to fail if the old `promptTemplate` field is present, preventing confusion.
    *   **Add** a `.refine()` call to enforce that at least one `userPrompt` source is provided.

**Before:**
```typescript
export const chroniclerConfigSchema = z.object({
  id: z.string()...
  // ... other fields
  promptTemplate: z.string().min(1),
  model: z.enum(["sonnet", "opus"]).optional(),
  // ...
});
```

**After:**
```typescript
// In server/config-validation/chronicler.schema.ts

export const chroniclerConfigSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, {
      message: "ID must contain only lowercase letters, numbers, and hyphens",
    }),
  name: z.string().min(1),
  description: z.string().optional(),
  trigger: chroniclerTriggerSchema,
  execution: chroniclerExecutionSchema,

  // --- NEW PROMPT FIELDS ---
  systemPromptFile: z.union([z.string(), z.array(z.string())]).optional(),
  systemPromptText: z.string().optional(),
  userPromptFile: z.union([z.string(), z.array(z.string())]).optional(),
  userPromptText: z.string().optional(),
  // --- END NEW PROMPT FIELDS ---

  model: z.enum(["sonnet", "opus"]).optional(),
  output: z
    .object({
      format: z.enum(["text", "json", "jsonl"]).optional(),
      file: z.string().optional(),
    })
    .optional(),
})
.strict() // Enforce no unknown keys like the old `promptTemplate`
.refine(
  (data) => data.userPromptFile || data.userPromptText, {
  message: "Each chronicler must have at least one of `userPromptFile` or `userPromptText` defined.",
  // Path helps pinpoint the error location to the root of the object
  path: [],
});
```

#### **Step 2: Update TypeScript Types (`server/types/chronicler-types.ts`)**

Because we are using a Zod-first approach, this step is mostly about ensuring the re-exports work correctly. The `z.infer` type will update automatically.

1.  **Verify the Export:** Open `server/types/chronicler-types.ts`. The main `ChroniclerConfig` type is exported like this:
    ```typescript
    export type { ChroniclerConfig } from "../config-validation/chronicler.schema.js";
    ```
2.  **No Action Needed:** This is correct. No changes are required in this file. The type system will automatically pick up the schema changes from Step 1.

#### **Step 3: Plan for Prompt Loading and Concatenation**

While we aren't implementing the full logic yet, we need to define *how* the prompts will be assembled. This will guide the future implementation in a class like `Chronicler` or in a configuration loading utility.

**Proposed Logic:**

A helper function, let's call it `assemblePrompt`, would be responsible for this.

```typescript
function assemblePrompt(
  config: ChroniclerConfig,
  promptType: 'system' | 'user'
): string {
  const fileField = promptType === 'system' ? config.systemPromptFile : config.userPromptFile;
  const textField = promptType === 'system' ? config.systemPromptText : config.userPromptText;

  const parts: string[] = [];

  // 1. Process file(s) first
  if (fileField) {
    const files = Array.isArray(fileField) ? fileField : [fileField];
    for (const filePath of files) {
      // In a real implementation, you would resolve and read the file
      // For now, this represents the logic:
      // parts.push(fs.readFileSync(resolvePath(filePath), 'utf-8'));
      // Let's actually go ahead and implement this (the reading of files) and also add tests for the file reading
    }
  }

  // 2. Process text block last
  if (textField) {
    parts.push(textField);
  }

  // Join with double newlines for separation
  return parts.join('\n\n');
}
```
This plan should be documented in a task or comment for the next stage of implementation. The key is establishing the **order of operations**: files in array order, then the text block.

#### **Step 4: Update Unit Tests (`tests/unit/chronicler-validation.test.ts`)**

This is crucial to verify our new schema works as expected.

1.  **Locate Test File:** Open `tests/unit/chronicler-validation.test.ts`.
2.  **Update Existing Tests:** All existing valid configs use `promptTemplate`. They will now fail. Update them to use `userPromptText` or `userPromptFile` instead.
3.  **Add New Positive Test Cases:**
    *   A test case with only `userPromptFile: "path/to/prompt.md"`.
    *   A test case with only `userPromptFile: ["path/1.md", "path/2.md"]`.
    *   A test case with only `userPromptText: "This is a prompt."`.
    *   A test case with both `userPromptFile` and `userPromptText`.
    *   A test case with `systemPromptFile` and `userPromptText`.
    *   A test case with `systemPromptText` and `userPromptFile`.
    *   A test case with all four new prompt fields populated.
4.  **Add New Negative Test Cases:**
    *   **"should fail validation if no user prompt is provided"**: This test is critical. Create a config with *no* `userPromptFile` or `userPromptText` and assert that `chroniclerConfigSchema.safeParse()` returns `success: false` and that the error message matches our `.refine()` message.
    *   **"should fail validation if the old promptTemplate field is used"**: Create a config with the legacy `promptTemplate` field. Because we added `.strict()`, this should now fail with an "unrecognized keys" error. Assert this behavior.

#### **Step 5: Update Documentation (`documentation/chronicler-system.md`)**

1.  **Locate the Documentation:** Open `documentation/chronicler-system.md`.
2.  **Update the "Configuration Examples" section:**
    *   Go through each JSON example.
    *   Replace `promptTemplate: "..."` with `userPromptText: "..."`.
    *   Add a new, more complex example that demonstrates using a system prompt and multiple user prompt files.
3.  **Add a New Section on Prompts:** Create a new subsection explaining the prompt system in detail.

**Example Documentation Section:**

> ### Prompt Configuration
>
> Each chronicler requires a `userPrompt` and can optionally include a `systemPrompt`. These are constructed from files and/or inline text, providing a flexible way to define the chronicler's task.
>
> -   `systemPromptFile`: (Optional) A path or array of paths to files that will be combined to form the system prompt.
> -   `systemPromptText`: (Optional) An inline string that will be appended to the system prompt after the files.
> -   `userPromptFile`: A path or array of paths to files for the user prompt.
> -   `userPromptText`: An inline string for the user prompt.
>
> **At least one of `userPromptFile` or `userPromptText` must be provided.**
>
> The final prompt is assembled in this order:
> 1.  Contents of `systemPromptFile` array, joined by newlines.
> 2.  The `systemPromptText` string.
> 3.  Contents of `userPromptFile` array, joined by newlines.
> 4.  The `userPromptText` string.
>
> #### Example with System and User Prompts
> ```json
> {
>   "id": "code-reviewer",
>   "name": "Code Reviewer",
>   "trigger": { ... },
>   "execution": { ... },
>   "systemPromptText": "You are a senior software engineer performing a code review. Focus on clarity, performance, and adherence to best practices.",
>   "userPromptFile": [
>     "./prompts/review-guidelines.md",
>     "./prompts/format-instructions.md"
>   ],
>   "userPromptText": "Based on the guidelines, review the following events: {{events}}"
> }
> ```

### **Validation and Verification**

To consider this task complete, the following conditions must be met:

1.  All changes are committed to the codebase.
2.  `bun test` runs successfully, with all chronicler validation tests passing.
3.  The linter (`bun run lint`) passes with no errors.
4.  The documentation in `documentation/chronicler-system.md` is updated and accurate.
5.  Manual inspection of the Zod schema confirms the removal of `promptTemplate` and the addition of the four new fields and the refinement logic.