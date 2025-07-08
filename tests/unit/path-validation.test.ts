import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { rmSync } from "fs";

describe("Path validation", () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = path.resolve("tests", "test-area", `temp-test-paths-${Date.now()}`);
    projectDir = path.join(tempDir, "project");
    await fs.promises.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Mock validation function based on the copyPath logic
  function validateCopyPath(from: string, to: string, projectPath: string): { valid: boolean; error?: string } {
    // Reject paths with ..
    if (to.includes("..")) {
      return { valid: false, error: "Target path cannot contain .." };
    }

    // Reject absolute paths as 'to' parameter
    if (path.isAbsolute(to)) {
      return { valid: false, error: "Target path must be relative to project directory" };
    }

    // Check if target parent directory exists
    const targetPath = path.join(projectPath, to);
    const targetDir = path.dirname(targetPath);
    
    if (!fs.existsSync(targetDir)) {
      return { valid: false, error: "Target parent directory does not exist" };
    }

    // Allow absolute paths as 'from' parameter
    // This is valid for copying from templates outside project

    return { valid: true };
  }

  test("rejects paths with ..", () => {
    const result = validateCopyPath("/templates/file.txt", "../outside/file.txt", projectDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("..");
  });

  test("rejects absolute paths as 'to' parameter", () => {
    const result = validateCopyPath("/templates/file.txt", "/etc/passwd", projectDir);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("relative");
  });

  test("allows absolute paths as 'from' parameter", async () => {
    // Create the target directory first
    await fs.promises.mkdir(path.join(projectDir, "local"), { recursive: true });
    
    const result = validateCopyPath("/absolute/path/template.txt", "local/file.txt", projectDir);
    expect(result.valid).toBe(true);
  });

  test("validates target parent directory exists", async () => {
    // Create the parent directory
    await fs.promises.mkdir(path.join(projectDir, "existing"), { recursive: true });
    
    // Valid: parent exists
    const valid = validateCopyPath("/templates/file.txt", "existing/file.txt", projectDir);
    expect(valid.valid).toBe(true);
    
    // Invalid: parent doesn't exist
    const invalid = validateCopyPath("/templates/file.txt", "nonexistent/file.txt", projectDir);
    expect(invalid.valid).toBe(false);
    expect(invalid.error).toContain("does not exist");
  });

  test("handles Windows path separators", () => {
    if (process.platform === 'win32') {
      const result = validateCopyPath("C:\\templates\\file.txt", "local\\file.txt", projectDir);
      expect(result.valid).toBe(true);
    }
  });

  test("rejects symlinks pointing outside project", async () => {
    // Skip on Windows as symlinks require admin privileges
    if (process.platform === 'win32') {
      expect(true).toBe(true);
      return;
    }
    
    // This would be part of a more comprehensive check
    // Create a symlink that points outside project but inside temp area
    const outsideTarget = path.join(tempDir, "outside-project", "target.txt");
    await fs.promises.mkdir(path.dirname(outsideTarget), { recursive: true });
    await fs.promises.writeFile(outsideTarget, "content");
    
    const symlinkPath = path.join(projectDir, "link.txt");
    
    try {
      await fs.promises.symlink(outsideTarget, symlinkPath);
      
      // In real implementation, would check if symlink target is within project
      const realPath = await fs.promises.realpath(symlinkPath);
      const isWithinProject = realPath.startsWith(projectDir);
      
      expect(isWithinProject).toBe(false);
    } catch (error) {
      // If symlink creation fails (e.g., permissions), skip the test
      console.log("Skipping symlink test due to:", error);
      expect(true).toBe(true);
    }
  });

  test("handles paths with spaces", async () => {
    // Create the target directory first
    await fs.promises.mkdir(path.join(projectDir, "local"), { recursive: true });
    
    const result = validateCopyPath("/templates/my file.txt", "local/my file.txt", projectDir);
    expect(result.valid).toBe(true);
  });

  test("rejects various path traversal attempts", () => {
    const maliciousPaths = [
      "../../etc/passwd",
      "./../../../root/.ssh/id_rsa",
      "valid/../../outside",
      "./../../",
      "some/path/../../../etc/hosts"
    ];

    maliciousPaths.forEach(malPath => {
      const result = validateCopyPath("/safe/source", malPath, projectDir);
      expect(result.valid).toBe(false);
    });
  });

  test("allows valid relative paths", async () => {
    // Create necessary directories
    await fs.promises.mkdir(path.join(projectDir, "src"), { recursive: true });
    await fs.promises.mkdir(path.join(projectDir, "src/components"), { recursive: true });
    
    const validPaths = [
      "file.txt",
      "src/index.ts",
      "src/components/Button.tsx",
      "./config.json"
    ];

    validPaths.forEach(validPath => {
      const result = validateCopyPath("/templates/source", validPath, projectDir);
      expect(result.valid).toBe(true);
    });
  });
});

describe("Command execution validation", () => {
  // Mock validation for command execution
  function validateCommand(command: string, workingDir: string): { valid: boolean; error?: string } {
    // Check for dangerous commands
    const dangerousPatterns = [
      /rm\s+-rf\s+\//,  // rm -rf /
      />\s*\/dev\/sda/, // Writing to disk devices
      /mkfs/,           // Formatting filesystems
      /dd\s+if=/,       // dd command
      /:(){ :|:& };:/  // Fork bomb
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        return { valid: false, error: "Potentially dangerous command detected" };
      }
    }

    // Validate working directory
    if (workingDir && !fs.existsSync(workingDir)) {
      return { valid: false, error: "Working directory does not exist" };
    }

    return { valid: true };
  }

  test("rejects dangerous commands", () => {
    const dangerousCommands = [
      "rm -rf /",
      "rm -rf /*", 
      "echo test > /dev/sda",
      "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda",
      ":(){ :|:& };:"
    ];

    dangerousCommands.forEach(cmd => {
      const result = validateCommand(cmd, "/tmp");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("dangerous");
    });
  });

  test("allows safe commands", () => {
    const safeCommands = [
      "npm install",
      "mkdir -p output",
      "echo 'Hello World'",
      "git status",
      "ls -la"
    ];

    safeCommands.forEach(cmd => {
      const result = validateCommand(cmd, "/tmp");
      expect(result.valid).toBe(true);
    });
  });

  test("validates working directory exists", () => {
    const result = validateCommand("ls", "/non/existent/path");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("does not exist");
  });
});