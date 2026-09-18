import { describe, expect, test } from "bun:test";
import { HANKWEAVE_ENV_UNSET, hankweaveEnvEntries } from "../../server/hankweave-env.js";

describe("hankweaveEnvEntries", () => {
  test("strips the prefix, keeps enumeration order, and skips server-owned names", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/bin",
      HANKWEAVE_ANTHROPIC_BASE_URL: "http://proxy",
      HANKWEAVE_RUNTIME_PORT: "8080",
      HANKWEAVE_SENTINEL_OPENAI_API_KEY: "sk-secret",
      HANKWEAVE_HTTP_PROXY: HANKWEAVE_ENV_UNSET,
      HANKWEAVE_EMPTY: "",
      HANKWEAVE_MISSING: undefined,
    };
    expect(hankweaveEnvEntries(env)).toEqual([
      { name: "ANTHROPIC_BASE_URL", value: "http://proxy" },
      { name: "HTTP_PROXY", value: "unset" },
      { name: "EMPTY", value: "" },
    ]);
  });

  test("reads the server's own environment by default", () => {
    process.env.HANKWEAVE_TEST_PASSTHROUGH = "1";
    try {
      expect(hankweaveEnvEntries()).toContainEqual({ name: "TEST_PASSTHROUGH", value: "1" });
    } finally {
      delete process.env.HANKWEAVE_TEST_PASSTHROUGH;
    }
  });
});
