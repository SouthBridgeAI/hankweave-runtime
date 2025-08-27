import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import * as path from "node:path";
import type { FileNode } from "../../server/types/types";
import { buildFileTree, copyFiles, escapeShellArg } from "../../server/utils";

describe("escapeShellArg", () => {
  test("escapes single quotes correctly", () => {
    expect(escapeShellArg("test'value")).toBe("'test'\\''value'");
  });

  test("handles empty strings", () => {
    expect(escapeShellArg("")).toBe("''");
  });

  test("handles strings with newlines", () => {
    expect(escapeShellArg("line1\nline2")).toBe("'line1\nline2'");
  });

  test("handles strings with special shell characters ($, `, \\, !)", () => {
    expect(escapeShellArg("$test")).toBe("'$test'");
    expect(escapeShellArg("`command`")).toBe("'`command`'");
    expect(escapeShellArg("\\path")).toBe("'\\path'");
    expect(escapeShellArg("!history")).toBe("'!history'");
  });

  test("handles unicode characters", () => {
    expect(escapeShellArg("こんにちは")).toBe("'こんにちは'");
    expect(escapeShellArg("🚀")).toBe("'🚀'");
  });

  test("handles very long strings", () => {
    const longString = "a".repeat(10000);
    const escaped = escapeShellArg(longString);
    expect(escaped).toBe(`'${longString}'`);
  });

  test("prevents command injection attempts", () => {
    expect(escapeShellArg("'; rm -rf /")).toBe("''\\''; rm -rf /'");
    expect(escapeShellArg("$(whoami)")).toBe("'$(whoami)'");
    expect(escapeShellArg("&&malicious")).toBe("'&&malicious'");
  });
});

describe("buildFileTree", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.resolve(
      "tests",
      "test-area",
      `temp-test-filetree-${Date.now()}`
    );
    await fs.promises.mkdir(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("builds tree from flat file list", async () => {
    // Create test files
    await fs.promises.writeFile(path.join(tempDir, "file1.txt"), "content1");
    await fs.promises.writeFile(path.join(tempDir, "file2.txt"), "content2");

    const tree = await buildFileTree(tempDir, "*.txt");

    expect(tree).toHaveLength(2);
    const fileNames = tree.map((node) => node.name).sort();
    expect(fileNames).toEqual(["file1.txt", "file2.txt"]);

    tree.forEach((node) => {
      expect(node.isDirectory).toBe(false);
      // TypeScript assertion since we know all nodes are files
      const fileNode = node as FileNode & { isDirectory: false };
      expect(fileNode.lastModified).toBeDefined();
    });
  });

  test("handles nested directories correctly", async () => {
    // Create nested structure
    await fs.promises.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.promises.mkdir(path.join(tempDir, "src", "utils"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(tempDir, "src", "index.ts"),
      "export {}"
    );
    await fs.promises.writeFile(
      path.join(tempDir, "src", "utils", "helper.ts"),
      "export {}"
    );

    const tree = await buildFileTree(tempDir, "**/*.ts");

    // Find the src node
    const srcNode = tree.find((node) => node.name === "src");
    expect(srcNode).toBeDefined();
    expect(srcNode?.isDirectory).toBe(true);
    expect(srcNode?.children).toBeDefined();

    // Check index.ts in src
    const indexFile = srcNode?.children?.find(
      (child) => child.name === "index.ts"
    );
    expect(indexFile).toBeDefined();
    expect(indexFile?.isDirectory).toBe(false);

    // Check utils directory
    const utilsDir = srcNode?.children?.find((child) => child.name === "utils");
    expect(utilsDir).toBeDefined();
    expect(utilsDir?.isDirectory).toBe(true);

    // Check helper.ts in utils
    const helperFile = utilsDir?.children?.find(
      (child) => child.name === "helper.ts"
    );
    expect(helperFile).toBeDefined();
    expect(helperFile?.isDirectory).toBe(false);
  });

  test("sorts files within directories", async () => {
    // Create files in non-alphabetical order
    await fs.promises.writeFile(path.join(tempDir, "b.txt"), "b");
    await fs.promises.writeFile(path.join(tempDir, "a.txt"), "a");
    await fs.promises.writeFile(path.join(tempDir, "c.txt"), "c");

    const tree = await buildFileTree(tempDir, "*.txt");
    const names = tree.map((node) => node.name);

    expect(names).toEqual(["a.txt", "b.txt", "c.txt"]);
  });

  test("includes lastModified for files", async () => {
    await fs.promises.writeFile(path.join(tempDir, "test.txt"), "content");

    const tree = await buildFileTree(tempDir, "*.txt");
    const fileNode = tree.find((node) => node.name === "test.txt");

    expect(fileNode).toBeDefined();
    expect(fileNode?.isDirectory).toBe(false);
    // Type assertion since we verified it's not a directory
    const file = fileNode as FileNode & { isDirectory: false };
    expect(file.lastModified).toBeDefined();
    if (file.lastModified) {
      expect(new Date(file.lastModified).getTime()).toBeGreaterThan(0);
    }
  });

  test("marks directories with isDirectory flag", async () => {
    await fs.promises.mkdir(path.join(tempDir, "dir"), { recursive: true });
    await fs.promises.writeFile(
      path.join(tempDir, "dir", "file.txt"),
      "content"
    );

    const tree = await buildFileTree(tempDir, "**/*.txt");

    const dirNode = tree.find((node) => node.name === "dir");
    expect(dirNode?.isDirectory).toBe(true);

    const fileInDir = dirNode?.children?.find(
      (child) => child.name === "file.txt"
    );
    expect(fileInDir?.isDirectory).toBe(false);
  });

  test("handles empty directories", async () => {
    const tree = await buildFileTree(tempDir, "**/*");
    expect(tree).toEqual([]);
  });

  test("handles files at root level", async () => {
    await fs.promises.writeFile(path.join(tempDir, "root.txt"), "root");
    await fs.promises.mkdir(path.join(tempDir, "dir"), { recursive: true });
    await fs.promises.writeFile(
      path.join(tempDir, "dir", "nested.txt"),
      "nested"
    );

    const tree = await buildFileTree(tempDir, "**/*.txt");

    const rootFile = tree.find((node) => node.name === "root.txt");
    expect(rootFile).toBeDefined();
    expect(rootFile?.path).toBe("root.txt");
    expect(rootFile?.isDirectory).toBe(false);

    const dirNode = tree.find((node) => node.name === "dir");
    expect(dirNode).toBeDefined();
    expect(dirNode?.isDirectory).toBe(true);

    const nestedFile = dirNode?.children?.find(
      (child) => child.name === "nested.txt"
    );
    expect(nestedFile).toBeDefined();
    expect(nestedFile?.isDirectory).toBe(false);
  });
});

describe("copyFiles", () => {
  let tempDir: string;
  let destDir: string;

  beforeEach(async () => {
    const timestamp = Date.now();
    tempDir = path.resolve(
      "tests",
      "test-area",
      `temp-test-copyfiles-src-${timestamp}`
    );
    destDir = path.resolve(
      "tests",
      "test-area",
      `temp-test-copyfiles-dest-${timestamp}`
    );
    await fs.promises.mkdir(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  });

  test("copies single file to destination", async () => {
    await fs.promises.writeFile(path.join(tempDir, "test.txt"), "test content");

    await copyFiles(tempDir, ["test.txt"], destDir);

    const copiedContent = await fs.promises.readFile(
      path.join(destDir, "test.txt"),
      "utf-8"
    );
    expect(copiedContent).toBe("test content");
  });

  test("copies multiple files", async () => {
    await fs.promises.writeFile(path.join(tempDir, "file1.txt"), "content1");
    await fs.promises.writeFile(path.join(tempDir, "file2.txt"), "content2");

    await copyFiles(tempDir, ["*.txt"], destDir);

    const content1 = await fs.promises.readFile(
      path.join(destDir, "file1.txt"),
      "utf-8"
    );
    const content2 = await fs.promises.readFile(
      path.join(destDir, "file2.txt"),
      "utf-8"
    );
    expect(content1).toBe("content1");
    expect(content2).toBe("content2");
  });

  test("preserves directory structure", async () => {
    await fs.promises.mkdir(path.join(tempDir, "nested", "deep"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(tempDir, "nested", "file.txt"),
      "nested content"
    );
    await fs.promises.writeFile(
      path.join(tempDir, "nested", "deep", "deep-file.txt"),
      "deep content"
    );

    await copyFiles(tempDir, ["**/*.txt"], destDir);

    const nestedContent = await fs.promises.readFile(
      path.join(destDir, "nested", "file.txt"),
      "utf-8"
    );
    const deepContent = await fs.promises.readFile(
      path.join(destDir, "nested", "deep", "deep-file.txt"),
      "utf-8"
    );
    expect(nestedContent).toBe("nested content");
    expect(deepContent).toBe("deep content");
  });

  test("creates destination directory if it doesn't exist", async () => {
    await fs.promises.writeFile(path.join(tempDir, "test.txt"), "content");

    rmSync(destDir, { recursive: true, force: true });
    expect(fs.existsSync(destDir)).toBe(false);

    await copyFiles(tempDir, ["test.txt"], destDir);

    expect(fs.existsSync(destDir)).toBe(true);
    const copiedContent = await fs.promises.readFile(
      path.join(destDir, "test.txt"),
      "utf-8"
    );
    expect(copiedContent).toBe("content");
  });

  test("handles glob patterns correctly", async () => {
    await fs.promises.writeFile(path.join(tempDir, "file.js"), "js content");
    await fs.promises.writeFile(path.join(tempDir, "file.ts"), "ts content");
    await fs.promises.writeFile(path.join(tempDir, "readme.md"), "md content");

    await copyFiles(tempDir, ["*.js", "*.ts"], destDir);

    expect(fs.existsSync(path.join(destDir, "file.js"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "file.ts"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "readme.md"))).toBe(false);
  });

  test("handles empty file list gracefully", async () => {
    await fs.promises.writeFile(path.join(tempDir, "ignored.txt"), "content");

    await copyFiles(tempDir, ["*.nonexistent"], destDir);

    expect(fs.existsSync(path.join(destDir, "ignored.txt"))).toBe(false);
  });

  test("copies directories recursively", async () => {
    await fs.promises.mkdir(path.join(tempDir, "source-dir", "subdir"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(tempDir, "source-dir", "file.txt"),
      "dir content"
    );
    await fs.promises.writeFile(
      path.join(tempDir, "source-dir", "subdir", "nested.txt"),
      "nested dir content"
    );

    await copyFiles(tempDir, ["source-dir/**"], destDir);

    const dirContent = await fs.promises.readFile(
      path.join(destDir, "source-dir", "file.txt"),
      "utf-8"
    );
    const nestedDirContent = await fs.promises.readFile(
      path.join(destDir, "source-dir", "subdir", "nested.txt"),
      "utf-8"
    );
    expect(dirContent).toBe("dir content");
    expect(nestedDirContent).toBe("nested dir content");
  });

  test("handles mixed files and directories", async () => {
    await fs.promises.mkdir(path.join(tempDir, "dir"), { recursive: true });
    await fs.promises.writeFile(
      path.join(tempDir, "root-file.txt"),
      "root content"
    );
    await fs.promises.writeFile(
      path.join(tempDir, "dir", "dir-file.txt"),
      "dir content"
    );

    await copyFiles(tempDir, ["**/*.txt"], destDir);

    const rootContent = await fs.promises.readFile(
      path.join(destDir, "root-file.txt"),
      "utf-8"
    );
    const dirContent = await fs.promises.readFile(
      path.join(destDir, "dir", "dir-file.txt"),
      "utf-8"
    );
    expect(rootContent).toBe("root content");
    expect(dirContent).toBe("dir content");
  });

  test("creates nested destination directories as needed", async () => {
    await fs.promises.mkdir(path.join(tempDir, "a", "b", "c"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(tempDir, "a", "b", "c", "deep.txt"),
      "deep content"
    );

    await copyFiles(tempDir, ["**/*.txt"], destDir);

    const deepContent = await fs.promises.readFile(
      path.join(destDir, "a", "b", "c", "deep.txt"),
      "utf-8"
    );
    expect(deepContent).toBe("deep content");

    expect(fs.existsSync(path.join(destDir, "a"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "a", "b"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "a", "b", "c"))).toBe(true);
  });

  test("respects .gitignore rules", async () => {
    await fs.promises.writeFile(path.join(tempDir, "include.txt"), "included");
    await fs.promises.writeFile(path.join(tempDir, "ignore.txt"), "ignored");
    await fs.promises.writeFile(
      path.join(tempDir, ".gitignore"),
      "ignore.txt\n"
    );

    await copyFiles(tempDir, ["*.txt"], destDir);

    expect(fs.existsSync(path.join(destDir, "include.txt"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "ignore.txt"))).toBe(false);

    const content = await fs.promises.readFile(
      path.join(destDir, "include.txt"),
      "utf-8"
    );
    expect(content).toBe("included");
  });

  test("handles nested .gitignore files", async () => {
    await fs.promises.mkdir(path.join(tempDir, "src"), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, "root.txt"), "root");
    await fs.promises.writeFile(path.join(tempDir, "src", "src.txt"), "src");
    await fs.promises.writeFile(
      path.join(tempDir, "src", "ignore.txt"),
      "ignored"
    );

    await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "*.log\n");
    await fs.promises.writeFile(
      path.join(tempDir, "src", ".gitignore"),
      "ignore.txt\n"
    );

    await copyFiles(tempDir, ["**/*.txt"], destDir);

    expect(fs.existsSync(path.join(destDir, "root.txt"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "src", "src.txt"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "src", "ignore.txt"))).toBe(false);
  });
});
