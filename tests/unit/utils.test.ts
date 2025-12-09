import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { rmSync } from "node:fs";
import * as path from "node:path";
import type { FileNode } from "../../server/types/types";
import { buildFileTree, copyFiles, deepMerge, escapeShellArg, Logger } from "../../server/utils";

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
    if (file.lastModified) {
      expect(new Date(file.lastModified).getTime()).toBeGreaterThan(0);
    }
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

// Mock logger
class MockLogger extends Logger {
  logs: Array<{ message: string; level: string }> = [];

  log(message: string, level: "info" | "error" | "debug" = "info"): void {
    this.logs.push({ message, level });
  }

  logSocketTraffic(_socketLogFile: string, _direction: "in" | "out", _data: unknown): void {
    // Mock implementation
  }
}

describe("copyFiles", () => {
  let tempDir: string;
  let destDir: string;
  let mockLogger: MockLogger;

  beforeEach(async () => {
    const timestamp = Date.now();
    tempDir = path.resolve("tests", "test-area", `temp-test-copyfiles-src-${timestamp}`);
    destDir = path.resolve("tests", "test-area", `temp-test-copyfiles-dest-${timestamp}`);
    await fs.promises.mkdir(tempDir, { recursive: true });
    mockLogger = new MockLogger("");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  });

  test("copies single file to destination", async () => {
    await fs.promises.writeFile(path.join(tempDir, "test.txt"), "test content");

    await copyFiles(tempDir, ["test.txt"], destDir, mockLogger);

    expect(await fs.promises.readFile(path.join(destDir, "test.txt"), "utf-8")).toBe(
      "test content",
    );
  });

  test("copies multiple files", async () => {
    await fs.promises.writeFile(path.join(tempDir, "file1.txt"), "content1");
    await fs.promises.writeFile(path.join(tempDir, "file2.txt"), "content2");

    await copyFiles(tempDir, ["*.txt"], destDir, mockLogger);

    expect(await fs.promises.readFile(path.join(destDir, "file1.txt"), "utf-8")).toBe("content1");
    expect(await fs.promises.readFile(path.join(destDir, "file2.txt"), "utf-8")).toBe("content2");
  });

  test("preserves directory structure", async () => {
    await fs.promises.mkdir(path.join(tempDir, "nested", "deep"), {
      recursive: true,
    });
    await fs.promises.writeFile(path.join(tempDir, "nested", "file.txt"), "nested content");
    await fs.promises.writeFile(
      path.join(tempDir, "nested", "deep", "deep-file.txt"),
      "deep content",
    );

    await copyFiles(tempDir, ["**/*.txt"], destDir, mockLogger);

    expect(await fs.promises.readFile(path.join(destDir, "nested", "file.txt"), "utf-8")).toBe(
      "nested content",
    );
    expect(
      await fs.promises.readFile(path.join(destDir, "nested", "deep", "deep-file.txt"), "utf-8"),
    ).toBe("deep content");
  });

  test("creates destination directory if it doesn't exist", async () => {
    await fs.promises.writeFile(path.join(tempDir, "test.txt"), "content");

    rmSync(destDir, { recursive: true, force: true });
    expect(fs.existsSync(destDir)).toBe(false);

    await copyFiles(tempDir, ["test.txt"], destDir, mockLogger);

    expect(fs.existsSync(destDir)).toBe(true);
    expect(await fs.promises.readFile(path.join(destDir, "test.txt"), "utf-8")).toBe("content");
  });

  test("handles glob patterns correctly", async () => {
    await fs.promises.writeFile(path.join(tempDir, "file.js"), "js content");
    await fs.promises.writeFile(path.join(tempDir, "file.ts"), "ts content");
    await fs.promises.writeFile(path.join(tempDir, "readme.md"), "md content");

    await copyFiles(tempDir, ["*.js", "*.ts"], destDir, mockLogger);

    expect(fs.existsSync(path.join(destDir, "file.js"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "file.ts"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "readme.md"))).toBe(false);
  });

  test("handles empty file list gracefully", async () => {
    await fs.promises.writeFile(path.join(tempDir, "ignored.txt"), "content");

    await copyFiles(tempDir, ["*.nonexistent"], destDir, mockLogger);

    expect(fs.existsSync(path.join(destDir, "ignored.txt"))).toBe(false);
  });

  test("copies directories recursively", async () => {
    await fs.promises.mkdir(path.join(tempDir, "source-dir", "subdir"), {
      recursive: true,
    });
    await fs.promises.writeFile(path.join(tempDir, "source-dir", "file.txt"), "dir content");
    await fs.promises.writeFile(
      path.join(tempDir, "source-dir", "subdir", "nested.txt"),
      "nested dir content",
    );

    await copyFiles(tempDir, ["source-dir/**"], destDir, mockLogger);

    expect(await fs.promises.readFile(path.join(destDir, "source-dir", "file.txt"), "utf-8")).toBe(
      "dir content",
    );
    expect(
      await fs.promises.readFile(path.join(destDir, "source-dir", "subdir", "nested.txt"), "utf-8"),
    ).toBe("nested dir content");
  });

  test("ignores .gitignore rules and copies all matching files", async () => {
    await fs.promises.writeFile(path.join(tempDir, "include.txt"), "included");
    await fs.promises.writeFile(path.join(tempDir, "ignore.txt"), "ignored");
    await fs.promises.writeFile(path.join(tempDir, ".gitignore"), "ignore.txt\n");

    await copyFiles(tempDir, ["*.txt"], destDir, mockLogger);

    expect(fs.existsSync(path.join(destDir, "include.txt"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, "ignore.txt"))).toBe(true);

    expect(await fs.promises.readFile(path.join(destDir, "include.txt"), "utf-8")).toBe("included");
    expect(await fs.promises.readFile(path.join(destDir, "ignore.txt"), "utf-8")).toBe("ignored");
  });
});

describe("deepMerge", () => {
  test("merges flat objects", () => {
    const obj1: Record<string, unknown> = { a: 1, b: 2 };
    const obj2: Record<string, unknown> = { b: 3, c: 4 };
    const result = deepMerge(obj1, obj2);

    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  test("merges nested objects recursively", () => {
    const obj1: Record<string, unknown> = { a: 1, nested: { x: 10, y: 20 } };
    const obj2: Record<string, unknown> = { a: 2, nested: { y: 30, z: 40 } };
    const result = deepMerge(obj1, obj2);

    expect(result).toEqual({
      a: 2,
      nested: { x: 10, y: 30, z: 40 },
    });
  });

  test("replaces arrays (not merge)", () => {
    const obj1 = { items: [1, 2, 3] };
    const obj2 = { items: [4, 5] };
    const result = deepMerge(obj1, obj2);

    expect(result).toEqual({ items: [4, 5] });
  });

  test("handles multiple sources in order", () => {
    const obj1: Record<string, unknown> = { a: 1, b: 2 };
    const obj2: Record<string, unknown> = { b: 3, c: 4 };
    const obj3: Record<string, unknown> = { c: 5, d: 6 };
    const result = deepMerge(obj1, obj2, obj3);

    expect(result).toEqual({ a: 1, b: 3, c: 5, d: 6 });
  });

  test("skips undefined sources", () => {
    const obj1: Record<string, unknown> = { a: 1 };
    const obj2 = undefined;
    const obj3: Record<string, unknown> = { b: 2 };
    const result = deepMerge(obj1, obj2, obj3);

    expect(result).toEqual({ a: 1, b: 2 });
  });

  test("skips undefined values in sources", () => {
    const obj1: Record<string, unknown> = { a: 1, b: 2 };
    const obj2: Record<string, unknown> = { b: undefined, c: 3 };
    const result = deepMerge(obj1, obj2);

    expect(result).toEqual({ a: 1, b: 2, c: 3 });
  });

  test("handles null values (replaces with null)", () => {
    const obj1: Record<string, unknown> = { a: 1, b: "test" };
    const obj2: Record<string, unknown> = { b: null };
    const result = deepMerge(obj1, obj2);

    expect(result).toEqual({ a: 1, b: null });
  });

  test("handles deeply nested structures", () => {
    const obj1: Record<string, unknown> = {
      level1: {
        level2: {
          level3: {
            a: 1,
            b: 2,
          },
        },
      },
    };
    const obj2: Record<string, unknown> = {
      level1: {
        level2: {
          level3: {
            b: 3,
            c: 4,
          },
        },
      },
    };
    const result = deepMerge(obj1, obj2);

    expect(result).toEqual({
      level1: {
        level2: {
          level3: {
            a: 1,
            b: 3,
            c: 4,
          },
        },
      },
    });
  });

  test("handles mixed types correctly", () => {
    const obj1: Record<string, unknown> = {
      string: "hello",
      number: 42,
      boolean: true,
      array: [1, 2],
      object: { x: 1 },
    };
    const obj2: Record<string, unknown> = {
      string: "world",
      number: 99,
      boolean: false,
      array: [3, 4, 5],
      object: { y: 2 },
    };
    const result = deepMerge(obj1, obj2);

    expect(result).toEqual({
      string: "world",
      number: 99,
      boolean: false,
      array: [3, 4, 5],
      object: { x: 1, y: 2 },
    });
  });

  test("handles empty objects", () => {
    const obj1 = {};
    const obj2 = { a: 1 };
    const result = deepMerge(obj1, obj2);

    expect(result).toEqual({ a: 1 });
  });

  test("returns empty object when all sources are undefined", () => {
    const result = deepMerge(undefined, undefined);
    expect(result).toEqual({});
  });

  test("simulates config layer cake merge", () => {
    // Simulate the 5-layer config merge from the spec
    const defaults: Record<string, unknown> = {
      port: 7777,
      autostart: true,
      model: "sonnet" as const,
      sentinel: {
        enablePersistence: true,
        healthCheckGracePeriodMs: 2000,
      },
    };

    const recommendations: Record<string, unknown> = {
      model: "opus" as const,
      dataHashTimeLimit: 10000,
    };

    const runtimeConfig: Record<string, unknown> = {
      port: 8080,
      sentinel: {
        healthCheckGracePeriodMs: 5000,
      },
    };

    const envConfig: Record<string, unknown> = {
      autostart: false,
    };

    const cliArgs: Record<string, unknown> = {
      model: "sonnet" as const,
    };

    const result = deepMerge(defaults, recommendations, runtimeConfig, envConfig, cliArgs);

    expect(result).toEqual({
      port: 8080, // From runtimeConfig (layer 3)
      autostart: false, // From envConfig (layer 2)
      model: "sonnet", // From cliArgs (layer 1)
      dataHashTimeLimit: 10000, // From recommendations (layer 4)
      sentinel: {
        enablePersistence: true, // From defaults (layer 5)
        healthCheckGracePeriodMs: 5000, // From runtimeConfig (layer 3)
      },
    });
  });
});
