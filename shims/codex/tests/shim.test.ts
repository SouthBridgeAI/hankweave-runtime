import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureEnv, restoreEnv } from "../../../tests/utils/env-test-helpers";
import { CodexShim } from "../src/shim.js";

const MINIMAL_ARGS = {
  model: "gpt-5.1-codex-max",
  verbose: false,
  idleTimeout: 60000,
  sandbox: "none" as const,
  selfTest: false,
  version: false,
  help: false,
};

function makeSetup() {
  let tempDir: string;
  let savedEnv: Record<string, string | undefined>;
  let homedirSpy: ReturnType<typeof spyOn<typeof os, "homedir">>;
  return {
    beforeEach() {
      savedEnv = captureEnv();
      delete process.env.OPENAI_API_KEY;
      delete process.env.CODEX_API_KEY;
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-key-test-"));
      // os.homedir() uses getpwuid() on macOS and ignores process.env.HOME,
      // so we spy on it directly to control what path the apiKeySource getter sees.
      homedirSpy = spyOn(os, "homedir").mockReturnValue(tempDir);
    },
    afterEach() {
      homedirSpy.mockRestore();
      restoreEnv(savedEnv);
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
    createAuthJson() {
      fs.mkdirSync(path.join(tempDir, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(tempDir, ".codex", "auth.json"), "{}");
    },
  };
}

describe("CodexShim.resolvedApiKey", () => {
  const setup = makeSetup();
  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  const shim = () => new CodexShim(MINIMAL_ARGS, "");

  test("returns OPENAI_API_KEY value when only OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(shim().resolvedApiKey).toBe("sk-openai");
  });

  test("returns CODEX_API_KEY value when only CODEX_API_KEY is set", () => {
    process.env.CODEX_API_KEY = "sk-codex";
    expect(shim().resolvedApiKey).toBe("sk-codex");
  });

  test("returns OPENAI_API_KEY when both are set", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.CODEX_API_KEY = "sk-codex";
    expect(shim().resolvedApiKey).toBe("sk-openai");
  });

  test("returns undefined when neither is set", () => {
    expect(shim().resolvedApiKey).toBeUndefined();
  });

  test("treats empty OPENAI_API_KEY as unset and falls back to CODEX_API_KEY", () => {
    process.env.OPENAI_API_KEY = "";
    process.env.CODEX_API_KEY = "sk-codex";
    expect(shim().resolvedApiKey).toBe("sk-codex");
  });
});

describe("CodexShim.apiKeySource", () => {
  const setup = makeSetup();
  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  const shim = () => new CodexShim(MINIMAL_ARGS, "");

  test("returns OPENAI_API_KEY when only OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(shim().apiKeySource).toBe("OPENAI_API_KEY");
  });

  test("returns CODEX_API_KEY when only CODEX_API_KEY is set", () => {
    process.env.CODEX_API_KEY = "sk-codex";
    expect(shim().apiKeySource).toBe("CODEX_API_KEY");
  });

  test("returns ~/.codex/auth.json when only auth.json exists", () => {
    setup.createAuthJson();
    expect(shim().apiKeySource).toBe("~/.codex/auth.json");
  });

  test("returns none when nothing is configured", () => {
    expect(shim().apiKeySource).toBe("none");
  });

  test("prefers OPENAI_API_KEY over CODEX_API_KEY", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.CODEX_API_KEY = "sk-codex";
    expect(shim().apiKeySource).toBe("OPENAI_API_KEY");
  });

  test("prefers OPENAI_API_KEY over auth.json", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    setup.createAuthJson();
    expect(shim().apiKeySource).toBe("OPENAI_API_KEY");
  });

  test("prefers CODEX_API_KEY over auth.json", () => {
    process.env.CODEX_API_KEY = "sk-codex";
    setup.createAuthJson();
    expect(shim().apiKeySource).toBe("CODEX_API_KEY");
  });

  test("treats empty OPENAI_API_KEY as unset", () => {
    process.env.OPENAI_API_KEY = "";
    expect(shim().apiKeySource).toBe("none");
  });
});

describe("CodexShim.isAuthConfigured", () => {
  const setup = makeSetup();
  beforeEach(setup.beforeEach);
  afterEach(setup.afterEach);

  const shim = () => new CodexShim(MINIMAL_ARGS, "");

  test("returns true when OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    expect(shim().isAuthConfigured).toBe(true);
  });

  test("returns true when CODEX_API_KEY is set", () => {
    process.env.CODEX_API_KEY = "sk-codex";
    expect(shim().isAuthConfigured).toBe(true);
  });

  test("returns true when auth.json exists", () => {
    setup.createAuthJson();
    expect(shim().isAuthConfigured).toBe(true);
  });

  test("returns false when nothing is configured", () => {
    expect(shim().isAuthConfigured).toBe(false);
  });
});
