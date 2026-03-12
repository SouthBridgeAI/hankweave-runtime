import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin: string },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });

    child.stdin.end(options.stdin);
  });
}

describe("invalid json repair integration", () => {
  test("resumes the same session to repair invalid json files before reporting success", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gemini-cli-shim-json-repair-"));
    const binDir = path.join(tempRoot, "bin");
    const stateDir = path.join(tempRoot, "state");
    const homeDir = path.join(tempRoot, "home");
    const workDir = path.join(tempRoot, "work");
    const sessionDir = path.join(homeDir, ".gemini", "tmp", "test-project", "chats");
    const statePath = path.join(stateDir, "count.txt");
    const shimEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const isWindows = process.platform === "win32";
    const fakeGeminiJsPath = path.join(binDir, "gemini.js");
    const fakeGeminiPath = isWindows ? path.join(binDir, "gemini.cmd") : path.join(binDir, "gemini");

    await mkdir(binDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    await mkdir(sessionDir, { recursive: true });

    const fakeGemini = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const statePath = path.join(process.env.FAKE_GEMINI_STATE_DIR, "count.txt");
const sessionId = "550e8400-e29b-41d4-a716-446655440001";
const sessionDir = path.join(process.env.HOME, ".gemini", "tmp", "test-project", "chats");
const sessionFile = path.join(sessionDir, "session-2026-03-09T00-00-550e8400.json");
const packageJsonPath = path.join(process.cwd(), "package.json");
const args = process.argv.slice(2);
const resumeIndex = args.indexOf("--resume");
const resumeSession = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
const brokenContent = [
  "{",
  '  "name": "broken-project",',
  '  "scripts": {',
  '    "test": "echo "broken""',
  "  }",
  "}",
  "",
].join("\\n");
const fixedContent = JSON.stringify(
  {
    name: "fixed-project",
    scripts: {
      test: 'echo "fixed"',
    },
  },
  null,
  2,
) + "\\n";
let count = 0;
try {
  count = Number(fs.readFileSync(statePath, "utf8")) || 0;
} catch {}
count += 1;
fs.writeFileSync(statePath, String(count), "utf8");

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}

function writeSession(messages) {
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({
      sessionId,
      projectHash: "test-project",
      startTime: "2026-03-09T00:00:00.000Z",
      lastUpdated: "2026-03-09T00:00:02.000Z",
      messages,
    }, null, 2),
    "utf8",
  );
}

if (count === 1) {
  fs.writeFileSync(packageJsonPath, brokenContent, "utf8");

  writeSession([
    {
      id: "user-1",
      timestamp: "2026-03-09T00:00:00.000Z",
      type: "user",
      content: "Create a package.json",
    },
    {
      id: "gemini-1",
      timestamp: "2026-03-09T00:00:01.000Z",
      type: "gemini",
      model: "gemini-2.5-flash",
      tokens: { input: 10, output: 8, cached: 0, thoughts: 0, tool: 4, total: 22 },
      toolCalls: [
        {
          id: "write-1",
          name: "write_file",
          args: {
            file_path: "package.json",
            content: brokenContent,
          },
          status: "success",
          timestamp: "2026-03-09T00:00:01.000Z",
          result: [
            {
              functionResponse: {
                response: {
                  output: "File written: package.json",
                },
              },
            },
          ],
        },
      ],
    },
  ]);

  emit({ type: "init", timestamp: "2026-03-09T00:00:00.000Z", session_id: sessionId, model: "gemini-2.5-flash" });
  emit({
    type: "tool_use",
    timestamp: "2026-03-09T00:00:00.100Z",
    tool_name: "write_file",
    tool_id: "write-1",
    parameters: {
      file_path: "package.json",
      content: brokenContent,
    },
  });
  emit({
    type: "tool_result",
    timestamp: "2026-03-09T00:00:00.200Z",
    tool_id: "write-1",
    status: "success",
    output: "File written: package.json",
  });
  emit({
    type: "result",
    timestamp: "2026-03-09T00:00:00.300Z",
    status: "success",
    stats: { total_tokens: 22, input_tokens: 10, output_tokens: 8, cached: 0, duration_ms: 5, tool_calls: 1 },
  });
  process.exit(0);
}

if (resumeSession !== sessionId) {
  process.stderr.write("expected --resume " + sessionId + ", got " + resumeSession + "\\n");
  process.exit(2);
}

fs.writeFileSync(packageJsonPath, fixedContent, "utf8");

writeSession([
  {
    id: "user-1",
    timestamp: "2026-03-09T00:00:00.000Z",
    type: "user",
    content: "Create a package.json",
  },
  {
    id: "gemini-1",
    timestamp: "2026-03-09T00:00:02.000Z",
    type: "gemini",
    model: "gemini-2.5-flash",
    tokens: { input: 10, output: 8, cached: 0, thoughts: 0, tool: 4, total: 22 },
    toolCalls: [
      {
        id: "write-2",
        name: "write_file",
        args: {
          file_path: "package.json",
          content: fixedContent,
        },
        status: "success",
        timestamp: "2026-03-09T00:00:02.000Z",
        result: [
          {
            functionResponse: {
              response: {
                output: "File written: package.json",
              },
            },
          },
        ],
      },
    ],
  },
]);

emit({ type: "init", timestamp: "2026-03-09T00:00:02.000Z", session_id: sessionId, model: "gemini-2.5-flash" });
emit({
  type: "tool_use",
  timestamp: "2026-03-09T00:00:02.100Z",
  tool_name: "write_file",
  tool_id: "write-2",
  parameters: {
    file_path: "package.json",
    content: fixedContent,
  },
});
emit({
  type: "tool_result",
  timestamp: "2026-03-09T00:00:02.200Z",
  tool_id: "write-2",
  status: "success",
  output: "File written: package.json",
});
emit({
  type: "message",
  timestamp: "2026-03-09T00:00:02.300Z",
  role: "assistant",
  content: "Repaired package.json so it is valid JSON.",
  delta: true,
});
emit({
  type: "result",
  timestamp: "2026-03-09T00:00:02.400Z",
  status: "success",
  stats: { total_tokens: 24, input_tokens: 10, output_tokens: 10, cached: 0, duration_ms: 7, tool_calls: 1 },
});
process.exit(0);
`;

    await writeFile(fakeGeminiJsPath, fakeGemini, "utf8");
    if (isWindows) {
      await writeFile(fakeGeminiPath, `@node "%~dp0gemini.js" %*\r\n`, "utf8");
    } else {
      await writeFile(fakeGeminiPath, fakeGemini, "utf8");
      await chmod(fakeGeminiPath, 0o755);
    }

    try {
      // On Windows, process.env stores PATH as "Path". Spreading into a plain
      // object and setting "PATH" creates a duplicate key; `where` may read
      // the original "Path" and miss our binDir. Delete conflicting casings.
      const env: Record<string, string | undefined> = { ...process.env };
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === "path") delete env[key];
      }
      env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
      env.HOME = homeDir;
      env.USERPROFILE = homeDir;
      env.FAKE_GEMINI_STATE_DIR = stateDir;

      const result = await runCommand(
        process.execPath,
        [shimEntry, "--model", "gemini-2.5-flash"],
        {
          cwd: workDir,
          env: env as NodeJS.ProcessEnv,
          stdin: "Create a package.json file.",
        },
      );

      const messages = result.stdout
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, any>);

      expect(result.exitCode).toBe(0);
      expect(messages.filter((message) => message.type === "system")).toHaveLength(1);
      expect(messages.at(-1)?.type).toBe("result");
      expect(Number(await readFile(statePath, "utf8"))).toBe(2);
      expect(JSON.parse(await readFile(path.join(workDir, "package.json"), "utf8"))).toMatchObject({
        name: "fixed-project",
      });
      expect(
        messages.some(
          (message) =>
            message.type === "assistant" &&
            Array.isArray(message.message?.content) &&
            message.message.content.some(
              (block: Record<string, unknown>) =>
                block.type === "text" && String(block.text ?? "").includes("Repaired package.json"),
            ),
        ),
      ).toBe(true);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
