import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashDataSource } from "../../server/data-hasher.js";

test.each(["empty", "latest", "explicit"])(
  "cleanup CLI selects existing executions before prompting: %s",
  async (mode) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-cli-"));
    const executions = path.join(root, "executions");
    const data = path.join(root, "data.txt");
    const config = path.join(root, "hank.json");
    fs.mkdirSync(executions);
    fs.writeFileSync(data, "cleanup fixture");
    fs.writeFileSync(config, JSON.stringify({ codons: [] }));
    const older = path.join(executions, "1000000-older");
    const newer = path.join(executions, "2000000-newer");
    try {
      if (mode !== "empty") {
        const dataHash = await hashDataSource(data);
        for (const dir of [older, newer]) {
          fs.mkdirSync(path.join(dir, ".hankweave"), { recursive: true });
          fs.writeFileSync(
            path.join(dir, ".hankweave", "execution-meta.json"),
            JSON.stringify({ dataHash }),
          );
        }
      }
      const child = Bun.spawn(
        [
          process.execPath,
          path.resolve("server/index.ts"),
          config,
          data,
          "--cleanup",
          ...(mode === "explicit" ? ["--execution", older] : []),
          ...(mode === "empty" ? [] : ["-y"]),
        ],
        {
          env: {
            ...process.env,
            HANKWEAVE_TELEMETRY: "0",
            HANKWEAVE_RUNTIME_EXECUTION_BASE_DIR: executions,
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      // Keep stdin open so an unexpected confirmation prompt cannot silently exit.
      const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(code, stdout + stderr).toBe(0);
        if (mode === "empty") {
          expect(stdout).toContain("No execution directories found for this data source.");
          expect(stdout).not.toContain("Proceed with cleanup?");
          expect(stdout).not.toContain("will be removed");
          expect(fs.readdirSync(executions)).toEqual([]);
        } else {
          expect(fs.existsSync(older)).toBe(mode === "latest");
          expect(fs.existsSync(newer)).toBe(mode === "explicit");
          expect(fs.readdirSync(executions)).toHaveLength(1);
        }
      } finally {
        clearTimeout(timeout);
        child.stdin.end();
        child.kill("SIGKILL");
        await child.exited;
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);
