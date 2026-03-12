import { spawn } from "node:child_process";
import { ensureOpencodeAvailable } from "./agent/opencode.js";
import { errorMessage } from "./utils/output.js";

interface SelfTestCheck {
  name: string;
  passed: boolean;
  message: string;
}

async function runCommand(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const isWindows = process.platform === "win32";

  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", () => resolve({ code: 1, stdout, stderr }));
  });
}

export async function runSelfTest(version: string): Promise<number> {
  const checks: SelfTestCheck[] = [];
  let binary = "";
  let opencodeVersion = "unknown";

  try {
    binary = await ensureOpencodeAvailable();
    checks.push({
      name: "agent_found",
      passed: true,
      message: `Found OpenCode at ${binary}`,
    });

    const versionResult = await runCommand(binary, ["--version"]);
    if (versionResult.code === 0) {
      opencodeVersion = versionResult.stdout.trim() || "unknown";
      checks.push({
        name: "agent_version",
        passed: true,
        message: `OpenCode version ${opencodeVersion}`,
      });
    } else {
      checks.push({
        name: "agent_version",
        passed: false,
        message: versionResult.stderr.trim() || "Unable to read OpenCode version",
      });
    }

    const modelsResult = await runCommand(binary, ["models", "google"]);
    checks.push({
      name: "models_command",
      passed: modelsResult.code === 0 && modelsResult.stdout.trim().length > 0,
      message:
        modelsResult.code === 0
          ? "OpenCode model listing succeeded"
          : modelsResult.stderr.trim() || "OpenCode model listing failed",
    });
  } catch (error) {
    checks.push({
      name: "agent_found",
      passed: false,
      message: errorMessage(error),
    });
  }

  const hasEnvKey = Boolean(
    process.env.GOOGLE_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY,
  );
  checks.push({
    name: "api_key_hint",
    passed: true,
    message: hasEnvKey
      ? "Detected at least one provider API key in environment"
      : "No provider API key detected in environment; OpenCode may still rely on stored auth",
  });

  const overallPassed = checks.every((check) => check.passed);

  process.stdout.write(
    `${JSON.stringify({
      shim: { name: "opencode-shim", version },
      agent: { name: "opencode", version: opencodeVersion, found: checks.some((c) => c.name === "agent_found" && c.passed) },
      checks,
      overall: {
        passed: overallPassed,
        message: overallPassed ? "All checks passed" : "One or more checks failed",
      },
    }, null, 2)}\n`,
  );

  return overallPassed ? 0 : 1;
}
