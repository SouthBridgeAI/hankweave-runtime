import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

interface ShimRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-shim-test-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Write a cross-platform fake executable backed by a Node.js script.
 * On Unix, writes a file with a `#!/usr/bin/env node` shebang.
 * On Windows, writes a `.js` file plus a `.cmd` trampoline that invokes node.
 */
function writeFakeNodeScript(dir: string, baseName: string, nodeScript: string): string {
  const script = nodeScript.startsWith("#!") ? nodeScript : `#!/usr/bin/env node\n${nodeScript}`;
  if (process.platform === "win32") {
    const jsPath = path.join(dir, `${baseName}.js`);
    fs.writeFileSync(jsPath, script, { encoding: "utf8" });
    const cmdPath = path.join(dir, `${baseName}.cmd`);
    fs.writeFileSync(cmdPath, `@node "%~dp0${baseName}.js" %*\r\n`, "utf8");
    return cmdPath;
  }
  const binPath = path.join(dir, baseName);
  fs.writeFileSync(binPath, script, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(binPath, 0o755);
  return binPath;
}

function parseJsonl(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function getSystemSessionId(stdout: string): string | undefined {
  const messages = parseJsonl(stdout);
  const system = messages.find((message) => message.type === "system");
  return typeof system?.session_id === "string" ? system.session_id : undefined;
}

async function runShimWithFakeOpencode(params: {
  fakeOpencodeBody: string;
  prompt?: string;
  args?: string[];
  includeDebugDir?: boolean;
  env?: Record<string, string | undefined>;
  tempDir?: string;
  workspaceDir?: string;
  fakeOpencodePath?: string;
}): Promise<ShimRunResult> {
  const tempDir = params.tempDir ?? makeTempDir();
  const workspaceDir = params.workspaceDir ?? path.join(tempDir, "workspace");
  const debugDir = path.join(workspaceDir, ".shim-debug");
  fs.mkdirSync(workspaceDir, { recursive: true });

  const fakeOpencode =
    params.fakeOpencodePath ??
    writeFakeNodeScript(tempDir, "fake-opencode", params.fakeOpencodeBody);

  const args = [path.join(import.meta.dir, "..", "src", "index.ts"), "--model", "google/gemini-2.5-flash"];
  if (params.includeDebugDir ?? true) {
    args.push("--debug-dir", debugDir);
  }
  if (params.args) {
    args.push(...params.args);
  }

  return await new Promise<ShimRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: workspaceDir,
      env: {
        ...process.env,
        ...params.env,
        OPENCODE_BIN: fakeOpencode,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });

    child.stdin.end(params.prompt ?? "test prompt\n");
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("shim runtime regressions", () => {
  test("pre-work silence triggers the baseline idle timeout", async () => {
    const result = await runShimWithFakeOpencode({
      fakeOpencodeBody: `
const args = process.argv.slice(2);
if (args[0] === "run") {
  process.stdin.resume();
  process.stdin.on("end", () => setTimeout(() => process.exit(0), 200));
} else {
  process.exit(0);
}
`,
      args: ["--idle-timeout", "0.05"],
    });

    expect(result.exitCode).toBe(1);
    const messages = parseJsonl(result.stdout);
    expect(messages[0]?.type).toBe("system");
    expect(messages.at(-1)?.type).toBe("result");
    expect(messages.at(-1)?.is_error).toBe(true);
    expect(result.stdout).toContain("Idle timeout");
  });

  test("process exit without a terminal stop step is treated as an error", async () => {
    const result = await runShimWithFakeOpencode({
      fakeOpencodeBody: `
const args = process.argv.slice(2);
if (args[0] === "run") {
  process.stdin.resume();
  process.stdin.on("end", () => {
    const events = [
      '{"type":"step_start","timestamp":1,"sessionID":"ses_fake","part":{"messageID":"msg_fake1"}}',
      '{"type":"tool_use","timestamp":2,"sessionID":"ses_fake","part":{"messageID":"msg_fake1","callID":"nativecall1","tool":"write","state":{"status":"completed","input":{"filePath":"out.txt","content":"x"},"output":"Wrote file successfully."}}}',
      '{"type":"step_finish","timestamp":3,"sessionID":"ses_fake","part":{"messageID":"msg_fake1","reason":"tool-calls","cost":0.1,"tokens":{"input":10,"output":2,"cache":{"read":0,"write":0}}}}',
    ];
    for (const e of events) process.stdout.write(e + "\\n");
    process.exit(0);
  });
} else {
  process.exit(0);
}
`,
    });

    expect(result.exitCode).toBe(1);
    const messages = parseJsonl(result.stdout);
    expect(messages[0]?.type).toBe("system");
    expect(messages.at(-1)?.type).toBe("result");
    expect(messages.at(-1)?.is_error).toBe(true);
    expect(result.stdout).toContain("OpenCode exited without a terminal step_finish reason");
  });

  test("resume without --debug-dir uses native session lookup and does not create ~/.shim", async () => {
    const tempDir = makeTempDir();
    const workspaceDir = path.join(tempDir, "workspace");
    const fakeStatePath = path.join(tempDir, "fake-opencode-state.txt");
    const fakeOpencode = writeFakeNodeScript(
      tempDir,
      "fake-opencode",
      `
const fs = require("node:fs");
const statePath = ${JSON.stringify(fakeStatePath)};
const args = process.argv.slice(2);
const cmd = args[0] || "";
const rest = args.slice(1);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

if (cmd === "session" && rest[0] === "list") {
  let stateExists = false;
  try { fs.accessSync(statePath); stateExists = true; } catch {}
  process.stdout.write("Session ID                      Title                                                Updated\\n");
  process.stdout.write("\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n");
  if (stateExists) {
    const title = fs.readFileSync(statePath, "utf8");
    process.stdout.write("ses_nativesaved123  " + title + "  11:50 PM\\n");
  }
  process.exit(0);
}

if (cmd === "run") {
  let title = "";
  let session = "";
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--title" && i + 1 < rest.length) { title = rest[++i]; }
    else if (rest[i] === "--session" && i + 1 < rest.length) { session = rest[++i]; }
  }

  // Drain stdin before producing output
  process.stdin.resume();
  process.stdin.on("end", () => {
    if (session) {
      if (session !== "ses_nativesaved123") {
        process.stderr.write("unexpected session " + session + "\\n");
        process.exit(1);
      }
      process.stdout.write('{"type":"step_start","timestamp":11,"sessionID":"ses_nativesaved123","part":{"messageID":"msg_resume"}}\\n');
      process.stdout.write('{"type":"text","timestamp":12,"sessionID":"ses_nativesaved123","part":{"messageID":"msg_resume","text":"The token was BLUE_SKY_TOKEN."}}\\n');
      process.stdout.write('{"type":"step_finish","timestamp":13,"sessionID":"ses_nativesaved123","part":{"messageID":"msg_resume","reason":"stop","cost":0.1,"tokens":{"input":10,"output":5,"cache":{"read":0,"write":0}}}}\\n');
      process.exit(0);
    }
    if (!title) {
      process.stderr.write("missing --title on fresh session\\n");
      process.exit(1);
    }
    fs.writeFileSync(statePath, title, "utf8");
    process.stdout.write('{"type":"step_start","timestamp":1,"sessionID":"ses_nativesaved123","part":{"messageID":"msg_first"}}\\n');
    process.stdout.write('{"type":"text","timestamp":2,"sessionID":"ses_nativesaved123","part":{"messageID":"msg_first","text":"I noted BLUE_SKY_TOKEN."}}\\n');
    process.stdout.write('{"type":"step_finish","timestamp":3,"sessionID":"ses_nativesaved123","part":{"messageID":"msg_first","reason":"stop","cost":0.1,"tokens":{"input":10,"output":3,"cache":{"read":0,"write":0}}}}\\n');
    process.exit(0);
  });
  return;
}

process.exit(0);
`,
    );

    const fakeHome = path.join(tempDir, "home");
    fs.mkdirSync(fakeHome, { recursive: true });

    const first = await runShimWithFakeOpencode({
      fakeOpencodeBody: "",
      fakeOpencodePath: fakeOpencode,
      tempDir,
      workspaceDir,
      includeDebugDir: false,
      prompt: "Remember BLUE_SKY_TOKEN.\n",
      env: {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
    });

    expect(first.exitCode).toBe(0);
    const publicSessionId = getSystemSessionId(first.stdout);
    expect(publicSessionId).toBeDefined();
    expect(fs.existsSync(path.join(fakeHome, ".shim"))).toBe(false);

    const second = await runShimWithFakeOpencode({
      fakeOpencodeBody: "",
      fakeOpencodePath: fakeOpencode,
      tempDir,
      workspaceDir,
      includeDebugDir: false,
      prompt: "What token did I tell you?\n",
      args: ["--resume", publicSessionId as string],
      env: {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
      },
    });

    expect(second.exitCode).toBe(0);
    expect(getSystemSessionId(second.stdout)).toBe(publicSessionId);
    expect(second.stdout).toContain("BLUE_SKY_TOKEN");
    expect(fs.existsSync(path.join(fakeHome, ".shim"))).toBe(false);
  });
});
