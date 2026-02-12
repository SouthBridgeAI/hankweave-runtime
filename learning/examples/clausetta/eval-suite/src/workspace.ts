import { mkdir, rm, writeFile, readFile, stat } from "fs/promises";
import { join, dirname } from "path";
import { existsSync } from "fs";

/**
 * Manages test workspace directories
 */
export class WorkspaceManager {
  private baseDir: string;
  private runId: string;

  constructor(baseDir: string, runId: string) {
    this.baseDir = baseDir;
    this.runId = runId;
  }

  /**
   * Get the runs directory path
   */
  get runsDir(): string {
    return join(this.baseDir, "runs");
  }

  /**
   * Get the current run directory path
   */
  get runDir(): string {
    return join(this.runsDir, this.runId);
  }

  /**
   * Get tests directory within current run
   */
  get testsDir(): string {
    return join(this.runDir, "tests");
  }

  /**
   * Initialize the run directory structure
   */
  async initialize(): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    await mkdir(this.testsDir, { recursive: true });
  }

  /**
   * Create a test workspace directory
   */
  async createTestWorkspace(testName: string): Promise<string> {
    const testDir = join(this.testsDir, testName);
    const workspaceDir = join(testDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  /**
   * Get test directory for a given test name
   */
  getTestDir(testName: string): string {
    return join(this.testsDir, testName);
  }

  /**
   * Write test artifacts (input, output, stderr)
   */
  async writeTestArtifacts(
    testName: string,
    artifacts: {
      input?: string;
      output?: string;
      stderr?: string;
    }
  ): Promise<void> {
    const testDir = this.getTestDir(testName);
    await mkdir(testDir, { recursive: true });

    if (artifacts.input !== undefined) {
      await writeFile(join(testDir, "input.txt"), artifacts.input);
    }
    if (artifacts.output !== undefined) {
      await writeFile(join(testDir, "output.jsonl"), artifacts.output);
    }
    if (artifacts.stderr !== undefined) {
      await writeFile(join(testDir, "stderr.txt"), artifacts.stderr);
    }
  }

  /**
   * Write a report file
   */
  async writeReport(filename: string, content: string): Promise<void> {
    await writeFile(join(this.runDir, filename), content);
  }

  /**
   * Create fixture files in a workspace
   */
  async createFixtures(workspaceDir: string, fixtures: Record<string, string | Buffer>): Promise<void> {
    for (const [path, content] of Object.entries(fixtures)) {
      const fullPath = join(workspaceDir, path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content);
    }
  }

  /**
   * Check if a file exists in the workspace
   */
  async fileExists(workspaceDir: string, path: string): Promise<boolean> {
    const fullPath = join(workspaceDir, path);
    return existsSync(fullPath);
  }

  /**
   * Read a file from the workspace
   */
  async readFile(workspaceDir: string, path: string): Promise<string> {
    const fullPath = join(workspaceDir, path);
    return readFile(fullPath, "utf-8");
  }

  /**
   * Check if a directory exists in the workspace
   */
  async dirExists(workspaceDir: string, path: string): Promise<boolean> {
    const fullPath = join(workspaceDir, path);
    try {
      const stats = await stat(fullPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Clean up a test workspace (optional, for cleanup after tests)
   */
  async cleanupTestWorkspace(testName: string): Promise<void> {
    const testDir = this.getTestDir(testName);
    await rm(testDir, { recursive: true, force: true });
  }
}

/**
 * Generate a run ID based on current timestamp and shim name
 */
export function generateRunId(shimName: string): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${timestamp}-${shimName}`;
}

