import { beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let configPath: string | undefined;

describe("Server Integration", () => {
  beforeAll(() => {
    // Create temporary directory
    const tempDir = mkdtempSync(path.join(tmpdir(), "tadpole-test-"));
    configPath = path.join(tempDir, "phases.json");

    writeFileSync(
      configPath,
      JSON.stringify(
        [
          {
            id: "phase-1-analysis",
            name: "Phase 1: Initial Analysis",
            promptFile: "prompts/1-analyze.md",
            model: "sonnet",
            continuationMode: "fresh",
            trackedFiles: ["src/**/*.ts", "analysis.md"],
          },
          {
            id: "phase-2-implementation",
            name: "Phase 2: Implementation",
            promptFile: "prompts/2-implement.md",
            model: "sonnet",
            continuationMode: "continue-previous",
            trackedFiles: ["src/**/*.ts"],
          },
        ],
        null,
        2
      )
    );

    // Create prompts directory
    const promptsDir = path.join(tempDir, "prompts");
    mkdirSync(promptsDir);

    // Create prompt files
    writeFileSync(
      path.join(promptsDir, "1-analyze.md"),
      "Please analyze the TypeScript files in the `src/` directory. Identify areas for improvement in terms of code structure, clarity, and potential bugs. Write your findings to a new file named `analysis.md`."
    );

    writeFileSync(
      path.join(promptsDir, "2-implement.md"),
      "Based on our previous discussion and the contents of `analysis.md`, please implement the suggested improvements directly into the source files."
    );
  });

  test("server/index runs in basic TUI mode", (done) => {
    expect(configPath).toBeDefined();

    const serverPath = path.resolve(__dirname, "../../server/index.ts");

    const child = spawn(
      "bun",
      [serverPath, "--basic", `--config=${configPath}`],
      {
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      expect(code).toBe(0);

      // Check that help output contains the basic mode option

      expect(stdout).toContain("Running in basic TUI mode");

      console.log("stdout:", stdout);

      done();
    });

    // Set a timeout to prevent hanging tests
    setTimeout(() => {
      // child.kill();
    }, 5000);
  });
});
