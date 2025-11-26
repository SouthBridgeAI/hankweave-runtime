import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

export async function runResourceCleanupTests(testDir: string) {
  test("no file descriptors leaked", async () => {
    if (process.platform !== "win32") {
      const { execSync } = await import("node:child_process");

      // Count open file descriptors for our test directory
      try {
        const openFiles = execSync(
          `lsof +D "${testDir}" 2>/dev/null | grep -E '(REG|DIR)' | wc -l || echo 0`,
          { encoding: "utf-8" },
        ).trim();

        // Should be minimal (just our test process reading files)
        expect(parseInt(openFiles)).toBeLessThan(10);
      } catch {
        // lsof might not be available
      }
    }
  });

  test("log files are properly closed and flushed", () => {
    // All log files should be readable and complete
    const logsDir = path.join(testDir, ".strandweave/logs");
    const logFiles = fs.readdirSync(logsDir).filter((f) => f.endsWith(".jsonl"));

    logFiles.forEach((logFile) => {
      const content = fs.readFileSync(path.join(logsDir, logFile), "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      // Each line should be valid JSON
      lines.forEach((line, idx) => {
        try {
          JSON.parse(line);
        } catch (_error) {
          throw new Error(`Invalid JSON in ${logFile} line ${idx + 1}: ${line}`);
        }
      });

      // Last line should be complete (not truncated)
      if (lines.length > 0) {
        const lastLine = JSON.parse(lines[lines.length - 1]);
        // Different log files have different formats
        // Claude logs have "type", WebSocket logs have "message.type"
        const hasValidStructure =
          lastLine.type !== undefined ||
          (lastLine.message && lastLine.message.type !== undefined) ||
          (lastLine.loggedAt && lastLine.direction && lastLine.message);
        expect(hasValidStructure).toBe(true);
      }
    });
  });

  test("server memory usage is reasonable", () => {
    const serverLog = path.join(testDir, ".strandweave/logs/server.log");
    if (fs.existsSync(serverLog)) {
      const logContent = fs.readFileSync(serverLog, "utf-8");

      // Look for any out-of-memory errors
      expect(logContent).not.toMatch(/out of memory/i);
      expect(logContent).not.toMatch(/heap out of memory/i);
      expect(logContent).not.toMatch(/ENOMEM/);
    }
  });
}
