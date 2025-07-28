### **Executive Summary**

The objective is to refine the data source handling in Tadpole for greater flexibility and clarity. This will be accomplished by implementing two primary changes:

1.  **Direct Data Source Hashing:** The system will now generate a stable hash for the user-provided data source, whether it's a file or a directory, without creating intermediate directories. This simplifies the hashing logic.
2.  **Explicit Directory Naming and Structure:**
    *   The internal directory representing the data source will be named `read_only_data_source` to clearly communicate its immutable nature to the AI.
    *   If the user provides a directory, it will be linked as `read_only_data_source`.
    *   If the user provides a file, a `read_only_data_source` directory will be created, and the file will be linked inside it.

This plan outlines the necessary modifications to the hashing utility, execution setup, configuration files, and both unit and end-to-end tests to implement this feature robustly.

---

### **Guiding Principles for this Plan**

*   **Hash In-Place:** The hashing function must operate directly on the user-provided path (`--data`), whether it is a file or a directory.
*   **Consistent Naming:** The linked data within the execution environment must always reside in a directory named `read_only_data_source`.
*   **Logical Linking:** The method of creating the `read_only_data_source` directory depends on the source type (link the directory vs. create a directory and link the file).

---

### **Detailed Implementation Plan**

Here are the specific changes, organized by the files that need to be modified.

#### **Step 1: Modify Hashing Logic**

The first step is to create a unified hashing function that can handle both files and directories.

**File:** `<server/data-hasher.ts>`

1.  **Create `hashFile` Helper:**
    *   Create a new internal (not exported) function: `async function hashFile(filePath: string): Promise<string>`.
    *   This function will generate a hash based on the file's content and metadata to ensure uniqueness.
    *   **Implementation:**
        ```typescript
        const stats = await fs.promises.stat(filePath);
        const fileContent = await fs.promises.readFile(filePath);
        const hash = crypto.createHash("sha256");
        // Include metadata to differentiate files with same content but different names/timestamps
        hash.update(`file:${path.basename(filePath)}:${stats.size}:${stats.mtimeMs}`);
        hash.update(fileContent);
        return hash.digest("hex").substring(0, 12);
        ```

2.  **Update `hashDataDirectory` to `hashDataSource`:**
    *   Rename the exported function `hashDataDirectory` to `hashDataSource`.
    *   At the top of this new `hashDataSource` function, add logic to check if the provided `dataPath` is a file or a directory using `fs.promises.stat`.
    *   If it's a file, call the new `hashFile` helper and return its result.
    *   If it's a directory, proceed with the existing directory-hashing logic.
    *   If it's neither (e.g., a symlink to nowhere), throw an error.

**File:** `<server/cleanup-command.ts>`

1.  **Update Hasher Call:**
    *   In the `execute` method, change the call from `hashDataDirectory(this.options.dataSourcePath)` to `hashDataSource(this.options.dataSourcePath)`.

#### **Step 2: Update Execution Environment Setup**

This is the core of the new file/directory handling logic.

**File:** `<server/execution-setup.ts>`

1.  **Rename Directory Variable:**
    *   Change `const dataPathInExecutionDir = path.join(finalExecutionPath, "data");`
    *   To: `const dataPathInExecutionDir = path.join(finalExecutionPath, "read_only_data_source");`

2.  **Update Hasher Call:**
    *   Change the call from `hashDataDirectory(...)` to the new `hashDataSource(...)` function.

3.  **Implement File vs. Directory Linking Logic:**
    *   Inside `setupExecutionEnvironment`, after the `stats` variable is defined (`const stats = await fs.promises.stat(readOnlySourceDataPath);`), modify the linking section.
    *   **Current logic assumes it's always a directory.** Replace it with a conditional block:

        ```typescript
        // Set up data access (symlink or copy)
        let linkType: "symlink" | "copy" = useSymlink ? "symlink" : "copy";
        if (isNewExecution || !fs.existsSync(dataPathInExecutionDir)) {
          if (stats.isDirectory()) {
            // --- Directory Logic (Existing, but with new destination) ---
            if (useSymlink) {
              try {
                await fs.promises.symlink(readOnlySourceDataPath, dataPathInExecutionDir, "dir");
              } catch (error) {
                console.warn(`Failed to create symlink for directory: ${error}. Falling back to copy.`);
                await copyDirectory(readOnlySourceDataPath, dataPathInExecutionDir);
                linkType = "copy";
              }
            } else {
              await copyDirectory(readOnlySourceDataPath, dataPathInExecutionDir);
            }
          } else if (stats.isFile()) {
            // --- File Logic (New) ---
            // 1. Create the 'read_only_data_source' directory
            await fs.promises.mkdir(dataPathInExecutionDir, { recursive: true });
            const destFilePath = path.join(dataPathInExecutionDir, path.basename(readOnlySourceDataPath));

            // 2. Link or copy the file into it
            if (useSymlink) {
               try {
                await fs.promises.symlink(readOnlySourceDataPath, destFilePath);
              } catch (error) {
                console.warn(`Failed to create symlink for file: ${error}. Falling back to copy.`);
                await fs.promises.copyFile(readOnlySourceDataPath, destFilePath);
                linkType = "copy";
              }
            } else {
              await fs.promises.copyFile(readOnlySourceDataPath, destFilePath);
            }
          }
        }
        ```

#### **Step 3: Update System-Wide References to the Data Directory**

1.  **File:** `<server/claude-process-manager.ts>`
    *   In both `buildSystemPrompt` and `feedPrompt` methods, find and replace the template variable logic:
    *   From: `.replace(/<%DATA_DIR%>/g, path.join(this.executionPath, "data"));`
    *   To: `.replace(/<%DATA_DIR%>/g, path.join(this.executionPath, "read_only_data_source"));`

2.  **File:** `<server/file-resolver.ts>`
    *   In the `getIgnoreRules` method, update the hardcoded ignore rules for the checkpoint system:
    *   From: `ig.add("/data/");` and `ig.add("/data/**");`
    *   To: `ig.add("/read_only_data_source/");` and `ig.add("/read_only_data_source/**");`

3.  **File:** `<server/index.ts>`
    *   Update the CLI help message to reflect the changes:
        *   Mention that `--data` now accepts a file or a directory.
        *   Change `(execution-dir/data)` to `(execution-dir/read_only_data_source)`.
