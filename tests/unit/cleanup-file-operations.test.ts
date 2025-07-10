import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  getDirectorySize,
  formatSize,
  removeDirectory,
  removeFile,
} from "../../server/cleanup/file-operations.js";
import * as fs from "fs";
import * as path from "path";
import { rmSync } from "fs";

describe("FileOperations", () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = path.resolve(
      "tests",
      "test-area",
      `temp-test-file-ops-${Date.now()}`
    );
    projectDir = path.join(tempDir, "project");
    await fs.promises.mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("getDirectorySize", () => {
    test("calculates size of empty directory", async () => {
      const emptyDir = path.join(projectDir, "empty");
      await fs.promises.mkdir(emptyDir);

      const size = await getDirectorySize(emptyDir);
      expect(size).toBe(0);
    });

    test("calculates size of directory with files", async () => {
      const testDir = path.join(projectDir, "test");
      await fs.promises.mkdir(testDir);
      await fs.promises.writeFile(path.join(testDir, "file1.txt"), "hello");
      await fs.promises.writeFile(path.join(testDir, "file2.txt"), "world!");

      const size = await getDirectorySize(testDir);
      expect(size).toBe(11); // 5 + 6 bytes
    });

    test("calculates size of nested directories", async () => {
      const topDir = path.join(projectDir, "top");
      const subDir = path.join(topDir, "sub");
      await fs.promises.mkdir(subDir, { recursive: true });

      await fs.promises.writeFile(path.join(topDir, "file1.txt"), "test");
      await fs.promises.writeFile(path.join(subDir, "file2.txt"), "nested");

      const size = await getDirectorySize(topDir);
      expect(size).toBe(10); // 4 + 6 bytes
    });

    test("handles non-existent directory", async () => {
      await expect(
        getDirectorySize(path.join(projectDir, "non-existent"))
      ).rejects.toThrow();
    });
  });

  describe("formatSize", () => {
    test("formats 0 bytes", () => {
      expect(formatSize(0)).toBe("0 B");
    });

    test("formats bytes", () => {
      expect(formatSize(500)).toBe("500.0 B");
    });

    test("formats kilobytes", () => {
      expect(formatSize(1536)).toBe("1.5 KB");
    });

    test("formats megabytes", () => {
      expect(formatSize(1048576)).toBe("1.0 MB");
      expect(formatSize(1572864)).toBe("1.5 MB");
    });

    test("formats gigabytes", () => {
      expect(formatSize(1073741824)).toBe("1.0 GB");
    });
  });

  describe("removeDirectory", () => {
    test("removes empty directory", async () => {
      const testDir = path.join(projectDir, "to-remove");
      await fs.promises.mkdir(testDir);

      await removeDirectory(testDir, projectDir);
      expect(fs.existsSync(testDir)).toBe(false);
    });

    test("removes directory with contents", async () => {
      const testDir = path.join(projectDir, "to-remove");
      const subDir = path.join(testDir, "sub");
      await fs.promises.mkdir(subDir, { recursive: true });
      await fs.promises.writeFile(path.join(testDir, "file.txt"), "content");
      await fs.promises.writeFile(path.join(subDir, "nested.txt"), "nested");

      await removeDirectory(testDir, projectDir);
      expect(fs.existsSync(testDir)).toBe(false);
    });

    test("throws when path is outside project", async () => {
      const outsideDir = path.join(tempDir, "outside");
      await fs.promises.mkdir(outsideDir);

      await expect(removeDirectory(outsideDir, projectDir)).rejects.toThrow(
        "outside project"
      );
    });

    test("throws when path contains ..", async () => {
      const maliciousPath = path.join(projectDir, "../escape");

      await expect(removeDirectory(maliciousPath, projectDir)).rejects.toThrow(
        "outside project"
      );
    });

    test("throws for dangerous directories", async () => {
      // These paths will be rejected as outside project (which is also correct)
      await expect(removeDirectory(".git", projectDir)).rejects.toThrow(
        "outside project"
      );

      await expect(removeDirectory("node_modules", projectDir)).rejects.toThrow(
        "outside project"
      );

      await expect(removeDirectory("/", projectDir)).rejects.toThrow(
        "outside project"
      );

      await expect(removeDirectory("~", projectDir)).rejects.toThrow(
        "outside project"
      );

      // Test dangerous directories within project
      const gitInProject = path.join(projectDir, ".git");
      await expect(removeDirectory(gitInProject, projectDir)).rejects.toThrow(
        "dangerous"
      );

      const nodeModulesInProject = path.join(projectDir, "node_modules");
      await expect(
        removeDirectory(nodeModulesInProject, projectDir)
      ).rejects.toThrow("dangerous");
    });
  });

  describe("removeFile", () => {
    test("removes file", async () => {
      const testFile = path.join(projectDir, "to-remove.txt");
      await fs.promises.writeFile(testFile, "content");

      await removeFile(testFile, projectDir);
      expect(fs.existsSync(testFile)).toBe(false);
    });

    test("throws when file is outside project", async () => {
      const outsideFile = path.join(tempDir, "outside.txt");
      await fs.promises.writeFile(outsideFile, "content");

      await expect(removeFile(outsideFile, projectDir)).rejects.toThrow(
        "outside project"
      );
    });

    test("throws when path contains ..", async () => {
      const maliciousPath = path.join(projectDir, "../escape.txt");

      await expect(removeFile(maliciousPath, projectDir)).rejects.toThrow(
        "outside project"
      );
    });

    test("throws for non-existent file", async () => {
      const missingFile = path.join(projectDir, "missing.txt");

      await expect(removeFile(missingFile, projectDir)).rejects.toThrow();
    });
  });
});
