import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_SDK_VERSION } from "../../server/claude-runtime-extractor.js";

describe("Claude Runtime Extractor", () => {
  describe("CLAUDE_SDK_VERSION", () => {
    test("should match the @anthropic-ai/claude-agent-sdk version pinned in package.json", () => {
      // CLAUDE_SDK_VERSION is the only cache-busting key for the extraction
      // directory (~/.hankweave/claude-sdk/<version>/). If it lags behind the
      // pinned SDK version, a user upgrading an already-used standalone binary
      // keeps the previously extracted native runtime: the new build sees the
      // old marker as valid and pairs its JS SDK with a stale executable.
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(import.meta.dir, "../../package.json"), "utf-8"),
      );
      const pinned = packageJson.dependencies["@anthropic-ai/claude-agent-sdk"];
      expect(CLAUDE_SDK_VERSION).toBe(pinned);
    });
  });
});
