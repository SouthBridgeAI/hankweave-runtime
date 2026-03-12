import { describe, expect, mock, test } from "bun:test";
import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  test("defaults", () => {
    const result = parseArgs([]);
    expect(result.model).toBe("");
    expect(result.verbose).toBe(false);
    expect(result.idleTimeout).toBe(120);
    expect(result.selfTest).toBe(false);
    expect(result.version).toBe(false);
    expect(result.sandbox).toBe("none");
    expect(result.help).toBe(false);
  });

  test("--model", () => {
    const result = parseArgs(["--model", "codex"]);
    expect(result.model).toBe("codex");
  });

  test("--idle-timeout overrides default", () => {
    const result = parseArgs(["--idle-timeout", "60"]);
    expect(result.idleTimeout).toBe(60);
  });

  test("--key=value format", () => {
    const result = parseArgs(["--model=flash", "--idle-timeout=45"]);
    expect(result.model).toBe("flash");
    expect(result.idleTimeout).toBe(45);
  });

  test("boolean flags", () => {
    const result = parseArgs(["--verbose", "--self-test", "--version", "--help"]);
    expect(result.verbose).toBe(true);
    expect(result.selfTest).toBe(true);
    expect(result.version).toBe(true);
    expect(result.help).toBe(true);
  });

  test("--resume and --debug-dir", () => {
    const result = parseArgs(["--resume", "abc", "--debug-dir", "/tmp/debug"]);
    expect(result.resume).toBe("abc");
    expect(result.debugDir).toBe("/tmp/debug");
  });

  test("--append-system-prompt", () => {
    const result = parseArgs(["--append-system-prompt", "be concise"]);
    expect(result.appendSystemPrompt).toBe("be concise");
  });

  test("aliases resolve to long flags", () => {
    const aliases = { "-m": "--model", "-v": "--verbose", "-h": "--help" };
    const result = parseArgs(["-m", "flash", "-v", "-h"], aliases);
    expect(result.model).toBe("flash");
    expect(result.verbose).toBe(true);
    expect(result.help).toBe(true);
  });

  test("unknown args are ignored", () => {
    const result = parseArgs(["--unknown", "--model", "codex", "-p"]);
    expect(result.model).toBe("codex");
  });

  test("--sandbox standard", () => {
    const result = parseArgs(["--sandbox", "standard"]);
    expect(result.sandbox).toBe("standard");
  });

  test("--sandbox strict", () => {
    const result = parseArgs(["--sandbox", "strict"]);
    expect(result.sandbox).toBe("strict");
  });

  test("--sandbox=standard (equals format)", () => {
    const result = parseArgs(["--sandbox=standard"]);
    expect(result.sandbox).toBe("standard");
  });

  test("--sandbox rejects invalid value", () => {
    const exit = mock(() => {});
    process.exit = exit as any;
    parseArgs(["--sandbox", "invalid"]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("--idle-timeout rejects non-numeric value", () => {
    const exit = mock(() => {});
    process.exit = exit as any;
    parseArgs(["--idle-timeout", "abc"]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("--idle-timeout rejects negative value", () => {
    const exit = mock(() => {});
    process.exit = exit as any;
    parseArgs(["--idle-timeout", "-5"]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("--idle-timeout rejects zero", () => {
    const exit = mock(() => {});
    process.exit = exit as any;
    parseArgs(["--idle-timeout", "0"]);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
