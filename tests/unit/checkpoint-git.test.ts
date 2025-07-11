import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
} from "bun:test";
import { CheckpointGit } from "../../server/checkpoint-git";
import { Logger } from "../../server/utils";
import * as fs from "fs";
import * as path from "path";
import { rmSync } from "fs";

describe("CheckpointGit", () => {
  let tempDir: string;
  let checkpointGit: CheckpointGit;
  let logger: Logger;

  beforeAll(async () => {
    // Check if git is available
    try {
      const proc = Bun.spawn(["git", "--version"]);
      await proc.exited;
    } catch (error) {
      console.error("Git is not available in test environment");
      throw new Error("Git is required for CheckpointGit tests");
    }
  });

  beforeEach(async () => {
    // Create a temporary directory for testing with absolute path
    tempDir = path.resolve(
      "tests",
      "test-area",
      `temp-test-checkpoint-${Date.now()}`
    );
    await fs.promises.mkdir(tempDir, { recursive: true });

    // Create a mock logger
    const logPath = path.join(tempDir, "test.log");
    logger = new Logger(logPath);

    // Initialize CheckpointGit
    checkpointGit = new CheckpointGit(tempDir, logger);
  });

  afterEach(async () => {
    // Clean up
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("isInitialized returns false before initialization", () => {
    expect(checkpointGit.isInitialized()).toBe(false);
  });

  test("isInitialized returns true after initialization", async () => {
    await checkpointGit.initialize();
    expect(checkpointGit.isInitialized()).toBe(true);
  });

  test("getPath returns correct checkpoint repository path", () => {
    const expectedPath = path.join(tempDir, ".langton", "checkpoints");
    expect(checkpointGit.getPath()).toBe(expectedPath);
  });

  test("initialize creates git repository", async () => {
    await checkpointGit.initialize();

    const gitDir = path.join(checkpointGit.getPath(), ".git");
    expect(fs.existsSync(gitDir)).toBe(true);
  });

  test("addPatterns stores patterns for later use", async () => {
    await checkpointGit.initialize();

    const patterns = ["*.log", "*.tmp"];
    await checkpointGit.addPatterns(patterns);

    // Create test files matching the patterns
    await fs.promises.writeFile(path.join(tempDir, "test.log"), "log content");
    await fs.promises.writeFile(path.join(tempDir, "test.tmp"), "tmp content");
    await fs.promises.writeFile(path.join(tempDir, "test.txt"), "txt content");

    // Commit should only add files matching the patterns
    const commitHash = await checkpointGit.commit("Test commit");
    expect(commitHash).not.toBeNull();

    // Verify only pattern-matching files were tracked
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".git"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "ls-tree", "-r", "HEAD", "--name-only"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const trackedFiles = await new Response(proc.stdout).text();

    expect(trackedFiles).toContain("test.log");
    expect(trackedFiles).toContain("test.tmp");
    expect(trackedFiles).not.toContain("test.txt");
  });

  test("commit creates a commit with message", async () => {
    await checkpointGit.initialize();

    // Create a test file
    const testFile = path.join(tempDir, "test.txt");
    await fs.promises.writeFile(testFile, "test content");

    // Add pattern and create commit
    await checkpointGit.addPatterns(["*.txt"]);
    const commitHash = await checkpointGit.commit("Test commit");

    expect(commitHash).not.toBeNull();
    expect(commitHash).toMatch(/^[a-f0-9]{7,}$/);
  });

  test("commit returns null when no changes", async () => {
    await checkpointGit.initialize();

    // Add patterns first, but don't create any files
    await checkpointGit.addPatterns(["*.txt"]);

    // Try to commit without any changes
    const commitHash = await checkpointGit.commit("Empty commit");

    expect(commitHash).toBeNull();
  });

  test("commit with allowEmpty creates empty commit", async () => {
    await checkpointGit.initialize();

    // Create empty commit
    const commitHash = await checkpointGit.commit("Empty commit", {
      allowEmpty: true,
    });

    expect(commitHash).not.toBeNull();
    expect(commitHash).toMatch(/^[a-f0-9]{7,}$/);
  });

  test("commit on branch creates and switches branch", async () => {
    await checkpointGit.initialize();

    // Create a test file
    const testFile = path.join(tempDir, "test.txt");
    await fs.promises.writeFile(testFile, "test content");

    // Add pattern and create commit on branch
    await checkpointGit.addPatterns(["*.txt"]);
    const commitHash = await checkpointGit.commit("Branch commit", {
      branch: "test-branch",
    });

    expect(commitHash).not.toBeNull();

    // To check git state, we need to use the same env vars that CheckpointGit uses
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".git"),
      GIT_WORK_TREE: tempDir,
    };

    // Check that we're back on main branch
    const proc = Bun.spawn(["git", "branch", "--show-current"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const currentBranch = await new Response(proc.stdout).text();
    expect(currentBranch.trim()).toBe("main");

    // Check that branch exists
    const proc2 = Bun.spawn(["git", "branch"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const branches = await new Response(proc2.stdout).text();
    expect(branches).toContain("test-branch");
  });

  test("handles complex patterns correctly", async () => {
    await checkpointGit.initialize();

    // Create nested directory structure
    await fs.promises.mkdir(path.join(tempDir, "src", "components"), {
      recursive: true,
    });
    await fs.promises.mkdir(path.join(tempDir, "src", "utils"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(tempDir, "src", "components", "Button.tsx"),
      "export {}"
    );
    await fs.promises.writeFile(
      path.join(tempDir, "src", "utils", "helper.ts"),
      "export {}"
    );
    await fs.promises.writeFile(path.join(tempDir, "README.md"), "# Test");

    // Add patterns
    await checkpointGit.addPatterns(["src/**/*.tsx", "src/**/*.ts", "*.md"]);

    // Create commit
    const commitHash = await checkpointGit.commit("Add files");
    expect(commitHash).not.toBeNull();

    // Verify files were tracked
    const gitEnv = {
      GIT_DIR: path.join(checkpointGit.getPath(), ".git"),
      GIT_WORK_TREE: tempDir,
    };

    const proc = Bun.spawn(["git", "ls-tree", "-r", "HEAD", "--name-only"], {
      cwd: tempDir,
      env: { ...process.env, ...gitEnv },
    });
    const trackedFiles = await new Response(proc.stdout).text();

    expect(trackedFiles).toContain("src/components/Button.tsx");
    expect(trackedFiles).toContain("src/utils/helper.ts");
    expect(trackedFiles).toContain("README.md");
  });
});
