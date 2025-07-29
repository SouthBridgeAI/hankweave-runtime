import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import * as path from "node:path";
import type { FileNode } from "../../server/types/types";
import { buildFileTree, escapeShellArg } from "../../server/utils";

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
    tempDir = path.resolve("tests", "test-area", `temp-test-filetree-${Date.now()}`);
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
    await fs.promises.writeFile(path.join(tempDir, "src", "index.ts"), "export {}");
    await fs.promises.writeFile(path.join(tempDir, "src", "utils", "helper.ts"), "export {}");

    const tree = await buildFileTree(tempDir, "**/*.ts");

    // Find the src node
    const srcNode = tree.find((node) => node.name === "src");
    expect(srcNode).toBeDefined();
    expect(srcNode?.isDirectory).toBe(true);
    expect(srcNode?.children).toBeDefined();

    // Check index.ts in src
    const indexFile = srcNode?.children?.find((child) => child.name === "index.ts");
    expect(indexFile).toBeDefined();
    expect(indexFile?.isDirectory).toBe(false);

    // Check utils directory
    const utilsDir = srcNode?.children?.find((child) => child.name === "utils");
    expect(utilsDir).toBeDefined();
    expect(utilsDir?.isDirectory).toBe(true);

    // Check helper.ts in utils
    const helperFile = utilsDir?.children?.find((child) => child.name === "helper.ts");
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
    expect(new Date(file.lastModified).getTime()).toBeGreaterThan(0);
  });

  test("marks directories with isDirectory flag", async () => {
    await fs.promises.mkdir(path.join(tempDir, "dir"), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, "dir", "file.txt"), "content");

    const tree = await buildFileTree(tempDir, "**/*.txt");

    const dirNode = tree.find((node) => node.name === "dir");
    expect(dirNode?.isDirectory).toBe(true);

    const fileInDir = dirNode?.children?.find((child) => child.name === "file.txt");
    expect(fileInDir?.isDirectory).toBe(false);
  });

  test("handles empty directories", async () => {
    const tree = await buildFileTree(tempDir, "**/*");
    expect(tree).toEqual([]);
  });

  test("handles files at root level", async () => {
    await fs.promises.writeFile(path.join(tempDir, "root.txt"), "root");
    await fs.promises.mkdir(path.join(tempDir, "dir"), { recursive: true });
    await fs.promises.writeFile(path.join(tempDir, "dir", "nested.txt"), "nested");

    const tree = await buildFileTree(tempDir, "**/*.txt");

    const rootFile = tree.find((node) => node.name === "root.txt");
    expect(rootFile).toBeDefined();
    expect(rootFile?.path).toBe("root.txt");
    expect(rootFile?.isDirectory).toBe(false);

    const dirNode = tree.find((node) => node.name === "dir");
    expect(dirNode).toBeDefined();
    expect(dirNode?.isDirectory).toBe(true);

    const nestedFile = dirNode?.children?.find((child) => child.name === "nested.txt");
    expect(nestedFile).toBeDefined();
    expect(nestedFile?.isDirectory).toBe(false);
  });
});
