import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Integration tests for HIGH-1: early-exit CLI commands should respect
 * telemetry opt-out in hankweave.json.
 *
 * After restructuring, telemetry config is resolved once in the Config Resolution
 * block before any mode branches. --help exits before config resolution (no telemetry).
 * All other modes (--init, --validate, --cleanup) go through config resolution first.
 */

const TEST_DIR = path.resolve("tests", "test-area", "telemetry-early-exit");
const PROJECT_ROOT = path.resolve(import.meta.dir, "../..");

function spawnCli(args: string[], cwd: string) {
  return Bun.spawn(
    ["bun", path.join(PROJECT_ROOT, "server/index.ts"), ...args],
    {
      cwd,
      env: {
        ...process.env,
        HANKWEAVE_TELEMETRY_DEBUG: "1",
        // Clear env vars that would independently disable telemetry,
        // so we're testing file-based opt-out specifically
        DO_NOT_TRACK: undefined,
        HANKWEAVE_TELEMETRY: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

async function getOutput(proc: ReturnType<typeof Bun.spawn>) {
  const exitCode = await proc.exited;
  const stdout = proc.stdout
    ? await new Response(proc.stdout as ReadableStream).text()
    : "";
  const stderr = proc.stderr
    ? await new Response(proc.stderr as ReadableStream).text()
    : "";
  return { exitCode, combined: stdout + stderr };
}

describe("telemetry early-exit opt-out", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) {
      fs.rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("--validate respects telemetry.enabled=false in hankweave.json", async () => {
    // Create hankweave.json with telemetry disabled
    fs.writeFileSync(
      path.join(TEST_DIR, "hankweave.json"),
      JSON.stringify({ telemetry: { enabled: false } }),
    );

    // Create a minimal hank file for --validate to work with
    fs.writeFileSync(
      path.join(TEST_DIR, "hank.json"),
      JSON.stringify({
        hank: [
          {
            id: "test-codon",
            name: "Test",
            model: "sonnet",
            continuationMode: "fresh",
            promptText: "test",
          },
        ],
      }),
    );

    const proc = spawnCli(["--validate", "hank.json"], TEST_DIR);
    const { combined } = await getOutput(proc);

    // --validate goes through config resolution, so it reads hankweave.json.
    // Telemetry should NOT fire — the file says it's disabled.
    expect(combined).not.toContain("[TELEMETRY DEBUG]");
  });
});
