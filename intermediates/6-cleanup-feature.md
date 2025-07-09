## Detailed Implementation Plan for Cleanup Feature

### Module Structure

```
server/
├── cleanup/
│   ├── manifest-builder.ts      # Builds cleanup manifest from config
│   ├── git-operations.ts        # Git-specific operations
│   ├── file-operations.ts       # Safe file/directory removal
│   ├── command-analyzer.ts      # Analyzes commands for side effects
│   └── types.ts                 # Cleanup-specific types
├── cleanup-command.ts           # Main cleanup orchestration
└── index.ts                     # CLI integration
```

### 1. Types Definition

**File**: `server/cleanup/types.ts`

```typescript
import type { PhaseId } from "../branded-types.js";

export interface CleanupManifest {
  // What will be cleaned
  gitTrackedFiles: GitTrackedFile[];
  copiedItems: CopiedItem[];
  langtonDir: LangtonDirInfo;

  // What we can't clean
  executedCommands: ExecutedCommand[];

  // Metadata
  checkpointRepoExists: boolean;
  currentCommitHash?: string;
  initialCommitHash?: string;
  isAtInitialCommit: boolean;
}

export interface GitTrackedFile {
  path: string;
  status: "added" | "modified" | "deleted";
  sizeBytes?: number;
}

export interface CopiedItem {
  type: "file" | "directory";
  source: string; // Original source path from config
  destination: string; // Where it was copied to
  exists: boolean; // Whether it currently exists
  sizeBytes?: number;
  phaseId: PhaseId; // Which phase created it
}

export interface LangtonDirInfo {
  path: string;
  exists: boolean;
  sizeBytes: number;
  contents: {
    logs: string[];
    checkpoints: boolean;
    other: string[];
  };
}

export interface ExecutedCommand {
  command: string;
  workingDirectory: string;
  phaseId: PhaseId;
  possibleSideEffects: string[]; // Inferred from command analysis
}

export interface CleanupOptions {
  configPath: string;
  projectPath: string;
  skipConfirmation: boolean;
  dryRun?: boolean; // For future use
}

export interface CleanupResult {
  success: boolean;
  filesRemoved: string[];
  directoriesRemoved: string[];
  gitFilesReset: string[];
  warnings: string[];
  errors: string[];
}
```

### 2. Manifest Builder

**File**: `server/cleanup/manifest-builder.ts`

```typescript
import fs from "node:fs";
import path from "node:path";
import { loadPhaseConfig } from "../config.js";
import type { PhaseConfig } from "../types.js";
import type {
  CleanupManifest,
  CopiedItem,
  ExecutedCommand,
  LangtonDirInfo,
} from "./types.js";
import { GitOperations } from "./git-operations.js";
import { CommandAnalyzer } from "./command-analyzer.js";
import { FileOperations } from "./file-operations.js";

export class ManifestBuilder {
  constructor(private configPath: string, private projectPath: string) {}

  async build(): Promise<CleanupManifest> {
    const phases = loadPhaseConfig(this.configPath);

    const [copiedItems, executedCommands, langtonDir, gitInfo] =
      await Promise.all([
        this.findCopiedItems(phases),
        this.findExecutedCommands(phases),
        this.analyzeLangtonDir(),
        this.analyzeGitState(),
      ]);

    return {
      gitTrackedFiles: gitInfo.trackedFiles,
      copiedItems,
      langtonDir,
      executedCommands,
      checkpointRepoExists: gitInfo.repoExists,
      currentCommitHash: gitInfo.currentCommit,
      initialCommitHash: gitInfo.initialCommit,
      isAtInitialCommit: gitInfo.isAtInitial,
    };
  }

  private async findCopiedItems(phases: PhaseConfig[]): Promise<CopiedItem[]> {
    const items: CopiedItem[] = [];

    for (const phase of phases) {
      if (!phase.workspaceSetup) continue;

      for (const setup of phase.workspaceSetup) {
        if (setup.type === "copy" && setup.copy) {
          const destPath = path.join(this.projectPath, setup.copy.to);
          const exists = fs.existsSync(destPath);

          let type: "file" | "directory" = "file";
          let sizeBytes: number | undefined;

          if (exists) {
            const stats = await fs.promises.stat(destPath);
            type = stats.isDirectory() ? "directory" : "file";

            if (type === "directory") {
              sizeBytes = await FileOperations.getDirectorySize(destPath);
            } else {
              sizeBytes = stats.size;
            }
          }

          items.push({
            type,
            source: setup.copy.from,
            destination: setup.copy.to,
            exists,
            sizeBytes,
            phaseId: phase.id,
          });
        }
      }
    }

    return items;
  }

  private async findExecutedCommands(
    phases: PhaseConfig[]
  ): Promise<ExecutedCommand[]> {
    const commands: ExecutedCommand[] = [];

    for (const phase of phases) {
      if (!phase.workspaceSetup) continue;

      let lastCopiedDir: string | null = null;

      for (const setup of phase.workspaceSetup) {
        if (setup.type === "copy" && setup.copy) {
          // Track last copied directory for workingDirectory resolution
          const destPath = path.join(this.projectPath, setup.copy.to);
          if (fs.existsSync(destPath) && fs.statSync(destPath).isDirectory()) {
            lastCopiedDir = destPath;
          }
        } else if (setup.type === "command" && setup.command) {
          const workingDir =
            setup.command.workingDirectory === "lastCopied" && lastCopiedDir
              ? lastCopiedDir
              : this.projectPath;

          commands.push({
            command: setup.command.run,
            workingDirectory:
              path.relative(this.projectPath, workingDir) || ".",
            phaseId: phase.id,
            possibleSideEffects: CommandAnalyzer.analyze(setup.command.run),
          });
        }
      }
    }

    return commands;
  }

  private async analyzeLangtonDir(): Promise<LangtonDirInfo> {
    const langtonPath = path.join(this.projectPath, ".langton");

    if (!fs.existsSync(langtonPath)) {
      return {
        path: ".langton",
        exists: false,
        sizeBytes: 0,
        contents: { logs: [], checkpoints: false, other: [] },
      };
    }

    const contents = {
      logs: [] as string[],
      checkpoints: false,
      other: [] as string[],
    };

    // Scan .langton contents
    const entries = await fs.promises.readdir(langtonPath, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (entry.name === "logs" && entry.isDirectory()) {
        const logFiles = await fs.promises.readdir(
          path.join(langtonPath, "logs")
        );
        contents.logs = logFiles;
      } else if (entry.name === "checkpoints" && entry.isDirectory()) {
        contents.checkpoints = true;
      } else {
        contents.other.push(entry.name);
      }
    }

    const sizeBytes = await FileOperations.getDirectorySize(langtonPath);

    return {
      path: ".langton",
      exists: true,
      sizeBytes,
      contents,
    };
  }

  private async analyzeGitState(): Promise<{
    repoExists: boolean;
    trackedFiles: GitTrackedFile[];
    currentCommit?: string;
    initialCommit?: string;
    isAtInitial: boolean;
  }> {
    const checkpointPath = path.join(
      this.projectPath,
      ".langton",
      "checkpoints"
    );

    if (!fs.existsSync(checkpointPath)) {
      return {
        repoExists: false,
        trackedFiles: [],
        isAtInitial: true,
      };
    }

    const gitOps = new GitOperations(this.projectPath, checkpointPath);

    try {
      const [isRepo, currentCommit, initialCommit, trackedFiles] =
        await Promise.all([
          gitOps.isGitRepository(),
          gitOps.getCurrentCommit(),
          gitOps.getInitialCommit(),
          gitOps.getTrackedFiles(),
        ]);

      return {
        repoExists: isRepo,
        trackedFiles,
        currentCommit,
        initialCommit,
        isAtInitial: currentCommit === initialCommit,
      };
    } catch (error) {
      return {
        repoExists: false,
        trackedFiles: [],
        isAtInitial: true,
      };
    }
  }
}
```

### 3. Git Operations Module

**File**: `server/cleanup/git-operations.ts`

```typescript
import simpleGit, { type SimpleGit } from "simple-git";
import path from "node:path";
import type { GitTrackedFile } from "./types.js";

export class GitOperations {
  private git: SimpleGit;

  constructor(private projectPath: string, private checkpointPath: string) {
    this.git = simpleGit(projectPath, {
      config: [
        `core.worktree=${projectPath}`,
        `core.gitdir=${path.join(checkpointPath, ".git")}`,
      ],
    }).env({
      GIT_DIR: path.join(checkpointPath, ".git"),
      GIT_WORK_TREE: projectPath,
    });
  }

  async isGitRepository(): Promise<boolean> {
    try {
      await this.git.rev.parse(["--git-dir"]);
      return true;
    } catch {
      return false;
    }
  }

  async getCurrentCommit(): Promise<string | undefined> {
    try {
      return await this.git.revparse(["HEAD"]);
    } catch {
      return undefined;
    }
  }

  async getInitialCommit(): Promise<string | undefined> {
    try {
      const log = await this.git.log(["--reverse", "--oneline"]);
      return log.all[0]?.hash;
    } catch {
      return undefined;
    }
  }

  async getTrackedFiles(): Promise<GitTrackedFile[]> {
    try {
      const initialCommit = await this.getInitialCommit();
      if (!initialCommit) return [];

      // Get diff between initial commit and current state
      const diff = await this.git.diff([
        "--name-status",
        initialCommit,
        "HEAD",
      ]);

      const files: GitTrackedFile[] = [];
      const lines = diff.split("\n").filter((line) => line.trim());

      for (const line of lines) {
        const [status, ...pathParts] = line.split("\t");
        const filePath = pathParts.join("\t");

        if (!filePath) continue;

        files.push({
          path: filePath,
          status:
            status === "A"
              ? "added"
              : status === "M"
              ? "modified"
              : status === "D"
              ? "deleted"
              : "modified",
        });
      }

      // Also check working directory changes
      const workingChanges = await this.git.status();
      for (const file of workingChanges.files) {
        if (!files.find((f) => f.path === file.path)) {
          files.push({
            path: file.path,
            status:
              file.working_dir === "A"
                ? "added"
                : file.working_dir === "M"
                ? "modified"
                : file.working_dir === "D"
                ? "deleted"
                : "modified",
          });
        }
      }

      return files;
    } catch {
      return [];
    }
  }

  async resetToInitial(): Promise<void> {
    const initialCommit = await this.getInitialCommit();
    if (!initialCommit) {
      throw new Error("No initial commit found");
    }

    await this.git.reset(["--hard", initialCommit]);
  }

  async hasUncommittedChanges(): Promise<boolean> {
    const status = await this.git.status();
    return !status.isClean();
  }
}
```

### 4. Command Analyzer

**File**: `server/cleanup/command-analyzer.ts`

```typescript
export class CommandAnalyzer {
  private static readonly PATTERNS = {
    mkdir: /(?:mkdir|md)\s+(?:-[pm]\s+)?(.+)/,
    touch: /touch\s+(.+)/,
    npm: /npm\s+(install|init|create)/,
    yarn: /yarn\s+(install|init|create)/,
    pnpm: /pnpm\s+(install|init|create)/,
    bun: /bun\s+(install|init|create)/,
    git: /git\s+(init|clone)/,
    echo: /echo\s+.+\s*>\s*(.+)/,
    tee: /tee\s+(.+)/,
  };

  static analyze(command: string): string[] {
    const effects: string[] = [];
    const normalizedCmd = command.trim().toLowerCase();

    // Check for directory creation
    if (CommandAnalyzer.PATTERNS.mkdir.test(normalizedCmd)) {
      const match = normalizedCmd.match(CommandAnalyzer.PATTERNS.mkdir);
      if (match?.[1]) {
        effects.push(`May have created directory: ${match[1].trim()}`);
      }
    }

    // Check for file creation
    if (CommandAnalyzer.PATTERNS.touch.test(normalizedCmd)) {
      const match = normalizedCmd.match(CommandAnalyzer.PATTERNS.touch);
      if (match?.[1]) {
        effects.push(`May have created file: ${match[1].trim()}`);
      }
    }

    // Check for package managers
    if (CommandAnalyzer.PATTERNS.npm.test(normalizedCmd)) {
      effects.push(
        "May have created node_modules/ and modified package-lock.json"
      );
    }
    if (CommandAnalyzer.PATTERNS.yarn.test(normalizedCmd)) {
      effects.push("May have created node_modules/ and modified yarn.lock");
    }
    if (CommandAnalyzer.PATTERNS.pnpm.test(normalizedCmd)) {
      effects.push(
        "May have created node_modules/ and modified pnpm-lock.yaml"
      );
    }
    if (CommandAnalyzer.PATTERNS.bun.test(normalizedCmd)) {
      effects.push("May have created node_modules/ and modified bun.lockb");
    }

    // Check for git operations
    if (CommandAnalyzer.PATTERNS.git.test(normalizedCmd)) {
      effects.push("May have created .git/ directory");
    }

    // Check for file redirection
    if (
      CommandAnalyzer.PATTERNS.echo.test(normalizedCmd) ||
      CommandAnalyzer.PATTERNS.tee.test(normalizedCmd)
    ) {
      effects.push("May have created or modified files");
    }

    // Generic warning for complex commands
    if (
      normalizedCmd.includes("&&") ||
      normalizedCmd.includes("||") ||
      normalizedCmd.includes("|") ||
      normalizedCmd.includes(";")
    ) {
      effects.push("Complex command with multiple operations");
    }

    if (effects.length === 0) {
      effects.push("Unknown side effects");
    }

    return effects;
  }
}
```

### 5. File Operations Module

**File**: `server/cleanup/file-operations.ts`

```typescript
import fs from "node:fs";
import path from "node:path";

export class FileOperations {
  static async getDirectorySize(dirPath: string): Promise<number> {
    let totalSize = 0;

    async function walkDir(currentPath: string): Promise<void> {
      const entries = await fs.promises.readdir(currentPath, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else {
          try {
            const stats = await fs.promises.stat(fullPath);
            totalSize += stats.size;
          } catch {
            // Ignore files we can't stat
          }
        }
      }
    }

    await walkDir(dirPath);
    return totalSize;
  }

  static formatSize(bytes: number): string {
    if (bytes === 0) return "0 B";

    const units = ["B", "KB", "MB", "GB"];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${units[i]}`;
  }

  static async removeDirectory(
    dirPath: string,
    projectPath: string
  ): Promise<void> {
    // Safety check: ensure we're within project directory
    const absolutePath = path.resolve(dirPath);
    const absoluteProjectPath = path.resolve(projectPath);
    const relative = path.relative(absoluteProjectPath, absolutePath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(
        `Refusing to delete directory outside project: ${dirPath}`
      );
    }

    // Additional safety: don't delete critical directories
    const basename = path.basename(dirPath);
    const dangerousDirs = [".git", "node_modules", "/", "~", "."];
    if (dangerousDirs.includes(basename) || dangerousDirs.includes(dirPath)) {
      throw new Error(
        `Refusing to delete potentially dangerous directory: ${dirPath}`
      );
    }

    await fs.promises.rm(dirPath, { recursive: true, force: true });
  }

  static async removeFile(
    filePath: string,
    projectPath: string
  ): Promise<void> {
    // Safety check: ensure we're within project directory
    const absolutePath = path.resolve(filePath);
    const absoluteProjectPath = path.resolve(projectPath);
    const relative = path.relative(absoluteProjectPath, absolutePath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing to delete file outside project: ${filePath}`);
    }

    await fs.promises.unlink(filePath);
  }
}
```

### 6. Main Cleanup Command

**File**: `server/cleanup-command.ts`

```typescript
import type {
  CleanupOptions,
  CleanupResult,
  CleanupManifest,
} from "./cleanup/types.js";
import { ManifestBuilder } from "./cleanup/manifest-builder.js";
import { GitOperations } from "./cleanup/git-operations.js";
import { FileOperations } from "./cleanup/file-operations.js";
import path from "node:path";
import fs from "node:fs";

export class CleanupCommand {
  constructor(private options: CleanupOptions) {}

  async execute(): Promise<CleanupResult> {
    const result: CleanupResult = {
      success: false,
      filesRemoved: [],
      directoriesRemoved: [],
      gitFilesReset: [],
      warnings: [],
      errors: [],
    };

    try {
      // Build manifest
      const manifestBuilder = new ManifestBuilder(
        this.options.configPath,
        this.options.projectPath
      );
      const manifest = await manifestBuilder.build();

      // Display plan
      this.displayCleanupPlan(manifest);

      // Get confirmation
      if (!this.options.skipConfirmation) {
        const confirmed = await this.getConfirmation();
        if (!confirmed) {
          console.log("\n❌ Cleanup cancelled by user");
          return result;
        }
      }

      // Execute cleanup
      console.log("\n🧹 Executing cleanup...\n");

      // 1. Reset git if available
      if (manifest.checkpointRepoExists && !manifest.isAtInitialCommit) {
        await this.resetGit(manifest, result);
      }

      // 2. Remove copied directories
      await this.removeCopiedItems(manifest, result);

      // 3. Remove .langton directory
      await this.removeLangtonDir(manifest, result);

      result.success = result.errors.length === 0;

      // Display results
      this.displayResults(result);
    } catch (error) {
      result.errors.push(
        error instanceof Error ? error.message : String(error)
      );
    }

    return result;
  }

  private displayCleanupPlan(manifest: CleanupManifest): void {
    console.log("🧹 Langton Cleanup Tool\n");
    console.log(`📋 Analyzing configuration: ${this.options.configPath}\n`);

    console.log("The following will be removed:\n");

    // Show copied directories
    if (manifest.copiedItems.length > 0) {
      console.log("📁 Directories (from workspace setup):");
      for (const item of manifest.copiedItems) {
        if (item.exists) {
          const size = item.sizeBytes
            ? ` (${FileOperations.formatSize(item.sizeBytes)})`
            : "";
          console.log(
            `  ✗ ${item.destination}${size} (copied from ${item.source})`
          );
        }
      }
      console.log();
    }

    // Show git-tracked files
    if (manifest.gitTrackedFiles.length > 0) {
      console.log("📄 Files (tracked in git):");
      for (const file of manifest.gitTrackedFiles) {
        const status =
          file.status === "added"
            ? "(new)"
            : file.status === "modified"
            ? "(modified)"
            : file.status === "deleted"
            ? "(deleted)"
            : "";
        console.log(`  ✗ ${file.path} ${status}`);
      }
      console.log();
    }

    // Show .langton directory
    if (manifest.langtonDir.exists) {
      console.log("📁 Langton data:");
      console.log(
        `  ✗ ${manifest.langtonDir.path}/ (${FileOperations.formatSize(
          manifest.langtonDir.sizeBytes
        )})`
      );

      if (manifest.langtonDir.contents.logs.length > 0) {
        for (const log of manifest.langtonDir.contents.logs.slice(0, 5)) {
          console.log(`    - logs/${log}`);
        }
        if (manifest.langtonDir.contents.logs.length > 5) {
          console.log(
            `    - ... and ${
              manifest.langtonDir.contents.logs.length - 5
            } more log files`
          );
        }
      }

      if (manifest.langtonDir.contents.checkpoints) {
        console.log("    - checkpoints/.git/");
        console.log("    - checkpoints/.gitconfig");
      }
      console.log();
    }

    // Show warnings about commands
    if (manifest.executedCommands.length > 0) {
      console.log("⚠️  The following commands were run and CANNOT be undone:");
      for (const cmd of manifest.executedCommands) {
        const dir =
          cmd.workingDirectory === "."
            ? ""
            : `, workingDirectory: ${cmd.workingDirectory}`;
        console.log(`  - ${cmd.command} (in ${cmd.phaseId}${dir})`);
        for (const effect of cmd.possibleSideEffects) {
          console.log(`    → ${effect}`);
        }
      }
      console.log();
    }

    // Additional warnings
    console.log("⚠️  Additional warnings:");
    console.log("  - Claude may have created files outside tracked patterns");
    console.log("  - System changes from Claude's tool use cannot be undone");
    console.log(
      "  - If any of these directories existed before, they will be lost"
    );
    console.log();
  }

  private async getConfirmation(): Promise<boolean> {
    console.log("❓ Proceed with cleanup? This cannot be undone! (y/N): ");

    // Read user input
    return new Promise((resolve) => {
      process.stdin.once("data", (data) => {
        const input = data.toString().trim().toLowerCase();
        resolve(input === "y" || input === "yes");
      });
    });
  }

  private async resetGit(
    manifest: CleanupManifest,
    result: CleanupResult
  ): Promise<void> {
    if (!manifest.checkpointRepoExists || !manifest.initialCommitHash) {
      result.warnings.push(
        "No checkpoint repository found, skipping git reset"
      );
      return;
    }

    const checkpointPath = path.join(
      this.options.projectPath,
      ".langton",
      "checkpoints"
    );
    const gitOps = new GitOperations(this.options.projectPath, checkpointPath);

    try {
      console.log("📝 Resetting git to initial commit...");
      await gitOps.resetToInitial();
      result.gitFilesReset = manifest.gitTrackedFiles.map((f) => f.path);
      console.log(`  ✓ Reset ${result.gitFilesReset.length} tracked files`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Git reset failed: ${message}`);
      console.log(`  ✗ Git reset failed: ${message}`);
    }
  }

  private async removeCopiedItems(
    manifest: CleanupManifest,
    result: CleanupResult
  ): Promise<void> {
    for (const item of manifest.copiedItems) {
      if (!item.exists) continue;

      const fullPath = path.join(this.options.projectPath, item.destination);

      try {
        if (item.type === "directory") {
          console.log(`🗑️  Removing directory: ${item.destination}`);
          await FileOperations.removeDirectory(
            fullPath,
            this.options.projectPath
          );
          result.directoriesRemoved.push(item.destination);
        } else {
          console.log(`🗑️  Removing file: ${item.destination}`);
          await FileOperations.removeFile(fullPath, this.options.projectPath);
          result.filesRemoved.push(item.destination);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`Failed to remove ${item.destination}: ${message}`);
        console.log(`  ✗ Failed: ${message}`);
      }
    }
  }

  private async removeLangtonDir(
    manifest: CleanupManifest,
    result: CleanupResult
  ): Promise<void> {
    if (!manifest.langtonDir.exists) return;

    const langtonPath = path.join(
      this.options.projectPath,
      manifest.langtonDir.path
    );

    try {
      console.log(`🗑️  Removing .langton directory...`);
      await fs.promises.rm(langtonPath, { recursive: true, force: true });
      result.directoriesRemoved.push(".langton");
      console.log("  ✓ Removed .langton directory");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`Failed to remove .langton: ${message}`);
      console.log(`  ✗ Failed: ${message}`);
    }
  }

  private displayResults(result: CleanupResult): void {
    console.log("\n" + "=".repeat(50) + "\n");

    if (result.success) {
      console.log("✅ Cleanup completed successfully!\n");

      if (result.filesRemoved.length > 0) {
        console.log(`📄 Files removed: ${result.filesRemoved.length}`);
      }
      if (result.directoriesRemoved.length > 0) {
        console.log(
          `📁 Directories removed: ${result.directoriesRemoved.length}`
        );
      }
      if (result.gitFilesReset.length > 0) {
        console.log(`📝 Git files reset: ${result.gitFilesReset.length}`);
      }
    } else {
      console.log("❌ Cleanup completed with errors\n");

      for (const error of result.errors) {
        console.log(`  Error: ${error}`);
      }
    }

    if (result.warnings.length > 0) {
      console.log("\n⚠️  Warnings:");
      for (const warning of result.warnings) {
        console.log(`  - ${warning}`);
      }
    }
  }
}
```

### 7. CLI Integration

**File**: `server/index.ts` (additions)

```typescript
// Add to imports
import { CleanupCommand } from "./cleanup-command.js";

// Add to argument parsing
const cleanupMode = args.includes("--cleanup");
const skipConfirmation = args.includes("-y");

// Update help text
if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Langton Server - Claude Phase Orchestration

Usage: bun server/index.ts [options]

Options:
  --config=<path>           Path to phases configuration file (default: phases.json)
  --port=<port>             WebSocket server port (default: 7777)
  --basic, -b               Run in basic TUI mode (prints events to console)
  --validate, -v            Validate configuration without running server
  --cleanup                 Clean up all Langton artifacts (requires --config)
  -y                        Skip confirmation prompts (for scripts/tests)
  --anthropic-base-url=<url> Custom Anthropic API base URL (for proxies/gateways)
  --help, -h                Show this help message

Examples:
  bun server/index.ts                          # Normal WebSocket server
  bun server/index.ts --basic                  # Basic TUI mode
  bun server/index.ts --validate               # Validate configuration
  bun server/index.ts --cleanup --config=phases.json     # Clean up project
  bun server/index.ts --cleanup --config=phases.json -y  # Clean up without prompts
`);
  process.exit(0);
}

// Add cleanup mode handling
if (cleanupMode) {
  if (!configPath || configPath === "phases.json") {
    console.error("❌ Error: --cleanup requires explicit --config=<path>");
    console.error("   This ensures you're cleaning up the right project.");
    process.exit(1);
  }

  try {
    const cleanup = new CleanupCommand({
      configPath,
      projectPath: process.cwd(),
      skipConfirmation,
    });

    const result = await cleanup.execute();
    process.exit(result.success ? 0 : 1);
  } catch (error) {
    console.error(
      `\n❌ Cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  }
}
```

### 8. Package.json Scripts

**File**: `package.json` (additions)

```json
{
  "scripts": {
    // ... existing scripts ...
    "cleanup": "echo 'Error: --cleanup requires --config' && exit 1",
    "cleanup:example": "bun server/index.ts --cleanup --config=phases.json",
    "cleanup:force": "bun server/index.ts --cleanup --config=phases.json -y"
  }
}
```

## Key Modularity Features for Future Phase Rollback

1. **GitOperations class**: Can be extended to find phase-specific commits
2. **ManifestBuilder**: Can generate phase-specific manifests
3. **Separate tracking of phase operations**: Each copied item and command knows its phaseId
4. **CleanupResult structure**: Can be adapted for partial cleanup reporting

For phase rollback, you could:

- Find the git commit for a specific phase completion
- Build a manifest of only that phase's operations
- Reset git to that phase's commit
- Remove only that phase's copied items

This modular structure makes implementing phase rollback much easier in the future!
