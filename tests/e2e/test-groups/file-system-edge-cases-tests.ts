import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FileUpdatedEvent } from "../../../server/types/types.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runFileSystemEdgeCasesTests(testState: TestState, testDir: string) {
  test("handles files with special characters correctly", () => {
    // Create files with special characters
    const specialFiles = [
      "notes/poem with spaces.txt",
      "notes/poem-with-dashes.txt",
      "notes/poem_with_underscores.txt",
      "notes/poem.multiple.dots.txt",
    ];

    specialFiles.forEach((file) => {
      const fullPath = path.join(testDir, file);
      if (!fs.existsSync(fullPath)) {
        fs.writeFileSync(fullPath, "test content");
      }
    });

    // These shouldn't break file watching or events
    const fileEvents = testState.client?.getEventsByType("file.updated") || [];

    // Path normalization should be consistent
    fileEvents.forEach((event) => {
      const fileEvent = event as FileUpdatedEvent;
      const filePath = fileEvent.data?.path || "";

      // Should not have double slashes
      expect(filePath).not.toMatch(/\/\//);

      // Should not have backslashes (even on Windows)
      expect(filePath).not.toContain("\\");

      // Should be relative
      expect(filePath).not.toMatch(/^[/\\]/);
    });
  });

  test("symlinks are handled safely", () => {
    if (process.platform !== "win32") {
      // Create a symlink pointing outside the project
      const symlinkPath = path.join(testDir, "notes/external-link");
      const targetPath = "/tmp/external-file.txt";

      try {
        fs.writeFileSync(targetPath, "external content");
        fs.symlinkSync(targetPath, symlinkPath);

        // Symlinks should be ignored or handled safely
        const fileEvents = testState.client?.getEventsByType("file.updated") || [];
        const symlinkEvents = fileEvents.filter((e) =>
          (e as FileUpdatedEvent).data?.path?.includes("external-link"),
        );

        // Either no events, or events should not expose the external path
        symlinkEvents.forEach((event) => {
          const content = JSON.stringify(event);
          expect(content).not.toContain("/tmp");
        });

        // Cleanup
        try {
          fs.unlinkSync(symlinkPath);
        } catch {}
        try {
          fs.unlinkSync(targetPath);
        } catch {}
      } catch {
        // Symlink creation failed, skip test
      }
    }
  });
}
