import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";

/**
 * Machine-health canary for the bun child-stdio cliff, root-caused live on
 * 2026-07-26/27 (intermediates/56 §incident):
 *
 * When a bun process holds MORE THAN 10,237 open file descriptors, Bun
 * (1.3.14, macOS) spawns every subsequent child with fd 0/1/2 CLOSED — no
 * pipes get wired, the child's writes hit EBADF and vanish, while exit codes
 * still arrive. Bisected exactly: works at 10,237 total fds, breaks at
 * 10,238 (plain `bun`, clean baseline, /dev/null fds — 20-line repro in the
 * incident note). Node on the same inputs is immune.
 *
 * How a test process ever gets near 10k fds: `bun test`'s discovery crawl
 * holds an open dirfd per directory under the cwd. Leftover
 * tests/test-area/execution-* dirs carry installed node_modules trees inside
 * their agent workspaces; ~40 of them reached 281,277 directories and parked
 * every bun-test process at ~10,204 fds — where importing fast-glob's module
 * graph (+58 dirfds) crossed the cliff. Downstream: CheckpointGit commits
 * "returning null", servers with empty stderr, SDK sessions never
 * establishing — 30+ phantom failures, one cause.
 *
 * The runner sweeps aged test-area residue and runs this canary as a
 * PREFLIGHT before every run; on failure it aborts with the remediation
 * instead of emitting untrustworthy results.
 */

// /dev/fd does not exist on Windows (its first CI execution proved it —
// readdirSync threw and the preflight read as the stdio defect). The fd
// mechanism this defends — bun's per-directory dirfds during discovery —
// is POSIX-shaped anyway; Windows keeps the spawn-bytes canary below.
test.skipIf(process.platform === "win32")(
  "fd table is nowhere near bun's 10,237 child-stdio cliff",
  () => {
    const openFds = fs.readdirSync("/dev/fd").length;
    // 8,000 leaves ~2,200 fds of margin for module loading (fast-glob's graph
    // adds ~58) and suite runtime. Above this, spawns are one big import away
    // from silently losing stdio — clean tests/test-area residue (the usual
    // source of directory bloat that bun's discovery crawl pins as dirfds).
    expect(openFds).toBeLessThan(8000);
  },
);

test("child processes still produce observable stdout after fast-glob loads", async () => {
  // Dynamic on purpose (rule exception): the SUBJECT of this canary is the
  // load boundary itself — fast-glob's graph must enter the module registry
  // (and open its dirfds) before the spawn below, in this exact order.
  await import("fast-glob");

  // Minimal env mirrors CheckpointGit's replaced-env children, the first
  // observed victims of the defect. Windows child processes need SystemRoot
  // (winsock init) and PATH (executable resolution) to run at all — keep
  // exactly those, nothing else.
  const env: Record<string, string> =
    process.platform === "win32"
      ? {
          HOME: "/tmp",
          GIT_TERMINAL_PROMPT: "0",
          SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
          PATH: process.env.PATH ?? "",
        }
      : { HOME: "/tmp", GIT_TERMINAL_PROMPT: "0" };

  const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn("git", ["--version"], { env });
    let stdout = "";
    child.stdout?.on("data", (d) => {
      stdout += d;
    });
    child.on("error", () => resolve({ code: null, stdout }));
    child.on("close", (code) => resolve({ code, stdout }));
  });

  expect(result.code).toBe(0);
  // The defect's signature is exit 0 with ZERO bytes captured.
  expect(result.stdout).toContain("git version");
});
