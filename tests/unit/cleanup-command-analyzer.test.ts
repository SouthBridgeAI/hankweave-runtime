import { describe, test, expect } from "bun:test";
import { analyzeCommand } from "../../server/cleanup/command-analyzer.js";

describe("analyzeCommand", () => {
  test("analyzes mkdir commands", () => {
    const effects = analyzeCommand("mkdir -p output/test");
    expect(effects).toContain("May have created directory: output/test");
  });

  test("analyzes mkdir with md alias", () => {
    const effects = analyzeCommand("md test-dir");
    expect(effects).toContain("May have created directory: test-dir");
  });

  test("analyzes touch commands", () => {
    const effects = analyzeCommand("touch newfile.txt");
    expect(effects).toContain("May have created file: newfile.txt");
  });

  test("analyzes npm install", () => {
    const effects = analyzeCommand("npm install");
    expect(effects).toContain(
      "May have created node_modules/ and modified package-lock.json"
    );
  });

  test("analyzes npm init", () => {
    const effects = analyzeCommand("npm init -y");
    expect(effects).toContain(
      "May have created node_modules/ and modified package-lock.json"
    );
  });

  test("analyzes yarn commands", () => {
    const effects = analyzeCommand("yarn install");
    expect(effects).toContain(
      "May have created node_modules/ and modified yarn.lock"
    );
  });

  test("analyzes pnpm commands", () => {
    const effects = analyzeCommand("pnpm install");
    expect(effects).toContain(
      "May have created node_modules/ and modified pnpm-lock.yaml"
    );
  });

  test("analyzes bun commands", () => {
    const effects = analyzeCommand("bun install");
    expect(effects).toContain(
      "May have created node_modules/ and modified bun.lockb"
    );
  });

  test("analyzes git init", () => {
    const effects = analyzeCommand("git init");
    expect(effects).toContain("May have created .git/ directory");
  });

  test("analyzes git clone", () => {
    const effects = analyzeCommand(
      "git clone https://github.com/user/repo.git"
    );
    expect(effects).toContain("May have created .git/ directory");
  });

  test("analyzes echo with redirection", () => {
    const effects = analyzeCommand("echo 'test' > file.txt");
    expect(effects).toContain("May have created or modified files");
  });

  test("analyzes tee command", () => {
    const effects = analyzeCommand("echo 'test' | tee output.log");
    expect(effects).toContain("May have created or modified files");
  });

  test("analyzes complex commands with &&", () => {
    const effects = analyzeCommand("mkdir test && cd test && npm init");
    expect(effects).toContain("Complex command with multiple operations");
  });

  test("analyzes complex commands with ||", () => {
    const effects = analyzeCommand("mkdir test || echo 'failed'");
    expect(effects).toContain("Complex command with multiple operations");
  });

  test("analyzes complex commands with pipes", () => {
    const effects = analyzeCommand("cat file | grep pattern | sort");
    expect(effects).toContain("Complex command with multiple operations");
  });

  test("analyzes complex commands with semicolons", () => {
    const effects = analyzeCommand("cd test; npm install; cd ..");
    expect(effects).toContain("Complex command with multiple operations");
  });

  test("returns unknown for unrecognized commands", () => {
    const effects = analyzeCommand("someunknowncommand --flag");
    expect(effects).toContain("Unknown side effects");
  });

  test("handles empty commands", () => {
    const effects = analyzeCommand("");
    expect(effects).toContain("Unknown side effects");
  });

  test("handles commands with extra spaces", () => {
    const effects = analyzeCommand("  mkdir   -p   test  ");
    expect(effects).toContain("May have created directory: test");
  });

  test("case insensitive matching", () => {
    const effects = analyzeCommand("MKDIR test");
    expect(effects).toContain("May have created directory: test");
  });
});
