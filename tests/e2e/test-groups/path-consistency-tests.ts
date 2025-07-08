import { expect, test } from "bun:test";
import type { FileTreeUpdatedEvent, FileUpdatedEvent } from "../../../server/types.js";
import { extractPathsFromTree } from "../../utils/test-data-helpers.js";
import type { TestWSClient } from "../../utils/test-helpers.js";

interface TestState {
  client: TestWSClient | null;
}

export function runPathConsistencyTests(testState: TestState) {
  test("all file paths are relative", () => {
    const fileUpdateEvents = testState.client?.getEventsByType("file.updated") || [];
    const fileTreeEvents = testState.client?.getEventsByType("filetree.updated") || [];

    const allFilePaths = [
      ...fileUpdateEvents.map((e) => (e as FileUpdatedEvent).data?.path || ""),
      ...fileTreeEvents.flatMap((e) =>
        extractPathsFromTree((e as FileTreeUpdatedEvent).data?.tree || []),
      ),
    ];

    const absolutePaths = allFilePaths.filter((p) => p.startsWith("/") || p.includes(":"));
    expect(absolutePaths.length).toBe(0);
  });
}
