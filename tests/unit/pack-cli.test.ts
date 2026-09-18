import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { LintFinding } from "../../server/pack/closure.js";
import {
  defaultBundleFilename,
  PackUsageError,
  parsePackArgs,
  renderBundle,
  renderFindings,
  sortFindings,
  usePackColor,
} from "../../server/pack/pack-command.js";
import type { TarMember } from "../../server/pack/tar.js";
import { isBundlePath } from "../../server/utils.js";

// -------------
// Parser matrix (phase-2 issue 14)
// -------------

describe("pack argument grammar", () => {
  it("defaults to the current directory with no arguments", () => {
    expect(parsePackArgs([])).toEqual({
      hankPathOrDir: ".",
      output: null,
      check: false,
      noLock: false,
      minRuntime: null,
      help: false,
    });
  });

  it("parses positional, -o, --check, --min-runtime in any order", () => {
    expect(parsePackArgs(["fixture", "-o", "out.hank"]).output).toBe("out.hank");
    expect(parsePackArgs(["--check", "fixture"]).check).toBe(true);
    expect(parsePackArgs(["fixture", "--no-lock"]).noLock).toBe(true);
    expect(parsePackArgs(["--no-lock", "--check"]).noLock).toBe(true);
    expect(parsePackArgs(["--min-runtime", "1.2.3", "fixture"]).minRuntime).toBe("1.2.3");
  });

  it("supports --flag=value for long flags", () => {
    expect(parsePackArgs(["--output=out.hank"]).output).toBe("out.hank");
    expect(parsePackArgs(["--min-runtime=1.2.3-alpha.1"]).minRuntime).toBe("1.2.3-alpha.1");
  });

  it("expresses a leading-dash path via --", () => {
    expect(parsePackArgs(["--", "-fixture"]).hankPathOrDir).toBe("-fixture");
  });

  it("sets help without touching anything else; unknown flags still error", () => {
    expect(parsePackArgs(["--help"]).help).toBe(true);
    expect(parsePackArgs(["-h", "whatever"]).help).toBe(true);
    expect(() => parsePackArgs(["-h", "--unknown"])).toThrow(PackUsageError);
  });

  const usageErrors: Array<[string, string[], RegExp]> = [
    ["two positionals", ["a", "b"], /at most one hank path/],
    ["-o without value", ["-o"], /requires a value/],
    ["duplicate -o", ["-o", "a.hank", "--output", "b.hank"], /duplicate/],
    ["--min-runtime without value", ["--min-runtime"], /requires a value/],
    ["duplicate --min-runtime", ["--min-runtime", "1.0.0", "--min-runtime", "2.0.0"], /duplicate/],
    ["removed format flag", ["--format=pretty"], /unknown option/],
    ["unknown flag", ["--unknown"], /unknown option/],
    ["--no-lock with a value", ["--no-lock=yes"], /takes no value/],
    ["--check with a value", ["--check=yes"], /takes no value/],
    ["--check with -o", ["--check", "-o", "out.hank"], /--check emits no archive/],
    ["non-semver --min-runtime", ["--min-runtime", "banana"], /not a canonical SemVer/],
    ["v-prefixed --min-runtime", ["--min-runtime", "v1.2.3"], /not a canonical SemVer/],
    ["unrecognized output suffix", ["-o", "artifact"], /must end in \.hank or \.tar\.zst/],
  ];
  it.each(usageErrors)("usage error: %s", (_label, argv, message) => {
    expect(() => parsePackArgs(argv)).toThrow(PackUsageError);
    expect(() => parsePackArgs(argv)).toThrow(message);
  });

  it("accepts both recognized bundle suffixes", () => {
    expect(isBundlePath("a.hank")).toBe(true);
    expect(isBundlePath("a.tar.zst")).toBe(true);
    expect(isBundlePath("a.hank.tar.zst")).toBe(true);
    expect(isBundlePath("artifact")).toBe(false);
    expect(isBundlePath("a.zip")).toBe(false);
  });
});

// -------------
// Finding order
// -------------

describe("lint finding order", () => {
  const finding = (
    severity: "error" | "warn",
    category: string,
    where: string,
    detail: string,
  ): LintFinding => ({ severity, category, where, detail }) as LintFinding;

  it("orders findings deterministically: errors first, then category/where/detail bytewise", () => {
    const shuffled = [
      finding("warn", "network-op", "b", "y"),
      finding("error", "missing-file", "z", "1"),
      finding("warn", "home-ref", "a", "x"),
      finding("error", "load-error", "a", "2"),
      finding("warn", "home-ref", "a", "w"),
    ];
    expect(
      sortFindings(shuffled).map((f) => `${f.severity}/${f.category}/${f.where}/${f.detail}`),
    ).toEqual([
      "error/load-error/a/2",
      "error/missing-file/z/1",
      "warn/home-ref/a/w",
      "warn/home-ref/a/x",
      "warn/network-op/b/y",
    ]);
  });
});

// -------------
// Default filename derivation (phase-2 issue 03)
// -------------

describe("default bundle filename", () => {
  const closureWith = (meta: unknown, hankDir = "/tmp/demo-hank") =>
    ({ raw: { meta }, hankDir }) as Parameters<typeof defaultBundleFilename>[0];

  it("derives <name>-<version>.hank from metadata", () => {
    expect(defaultBundleFilename(closureWith({ name: "demo", version: "1.0.0" }))).toBe(
      "demo-1.0.0.hank",
    );
  });

  it.each([
    ["docs-hank page", "docs-hank-page-1.0.0.hank"],
    ["Hankweave: ground", "hankweave-ground-1.0.0.hank"],
    ["  A -- B!  ", "a-b-1.0.0.hank"],
  ])("slugs the display name %s", (name, expected) => {
    expect(defaultBundleFilename(closureWith({ name, version: "1.0.0" }))).toBe(expected);
  });

  it("falls back to the directory basename and 'unversioned'", () => {
    expect(defaultBundleFilename(closureWith(undefined))).toBe("demo-hank-unversioned.hank");
  });

  const unsafe: Array<[string, unknown]> = [
    ["empty slug", { name: "!!!", version: "1.0.0" }],
    ["whitespace in version", { name: "demo", version: "one two" }],
    ["path traversal", { name: "../../release", version: "1.0.0" }],
    ["separator", { name: "team/demo", version: "1.0.0" }],
    ["backslash separator", { name: "team\\demo", version: "1.0.0" }],
    ["newline", { name: "name\nsuffix", version: "1.0.0" }],
    ["overlong", { name: "x".repeat(300), version: "1.0.0" }],
    ["unsafe version too", { name: "demo", version: "1.0.0/../.." }],
  ];
  it.each(unsafe)("returns null for %s (caller demands -o)", (_label, meta) => {
    expect(defaultBundleFilename(closureWith(meta))).toBeNull();
  });

  it("never yields a name outside cwd for any vector", () => {
    for (const [, meta] of unsafe) {
      const name = defaultBundleFilename(closureWith(meta));
      if (name !== null) {
        expect(name.includes("/")).toBe(false);
        expect(name.includes("\\")).toBe(false);
      }
    }
  });
});

// -------------
// Terminal output
// -------------

describe("pack terminal output", () => {
  const findings: LintFinding[] = [
    { severity: "warn", category: "home-ref", where: "setup.command", detail: "home ref z" },
    { severity: "warn", category: "home-ref", where: "setup.command", detail: "home ref a" },
    { severity: "error", category: "load-error", where: "hank.json", detail: "missing config" },
  ];

  it("groups locations, retains all details, and puts errors before warnings", () => {
    const result = renderFindings(findings, false);
    expect(result).toBe(
      [
        "",
        "Portability check",
        "",
        "  ERROR load-error (1)",
        "    hank.json",
        "      • missing config",
        "",
        "  WARN home-ref (2)",
        "    setup.command",
        "      • home ref a",
        "      • home ref z",
        "",
        "  1 error · 2 warnings",
        "  Resolve the errors above before packing.",
      ].join("\n"),
    );
    expect(renderFindings([...findings].reverse(), false)).toBe(result);
    expect(renderFindings([], false)).toContain("0 errors · 0 warnings");
  });

  it("colors errors red and warnings yellow without changing the text", () => {
    const colored = renderFindings(findings, true);
    expect(colored).toContain("\x1b[31mERROR");
    expect(colored).toContain("\x1b[33mWARN");
    expect(stripVTControlCharacters(colored)).toBe(renderFindings(findings, false));
  });

  it("escapes authored control sequences and newlines in findings and tree labels", () => {
    const hostile = "bad\n\x1b[31m\u009b\u202e";
    const result = renderFindings([{ ...findings[0], where: hostile, detail: hostile }], false);
    expect(result).not.toContain(hostile);
    expect(result).toContain("bad\\n\\u001b[31m\\u009b\\u202e");
    const tree = renderBundle(
      `${hostile}.hank`,
      "hash",
      [{ path: hostile, bytes: Buffer.alloc(0), mode: "644" }],
      0,
      false,
    );
    expect(tree).not.toContain(hostile);
    expect(tree).toContain("bad\\n\\u001b[31m\\u009b\\u202e");
  });

  it("shows a deterministic directory-first tree with sizes and executable files", () => {
    const members: TarMember[] = [
      { path: "hank.lock", bytes: Buffer.alloc(1024), mode: "644" },
      { path: "hank.json", bytes: Buffer.alloc(3), mode: "644" },
      { path: "tpl/bin/run.sh", bytes: Buffer.alloc(2), mode: "755" },
      { path: "prompts/a.md", bytes: Buffer.alloc(1), mode: "644" },
      { path: "tpl/config.json", bytes: Buffer.alloc(0), mode: "644" },
    ];
    const result = renderBundle("demo.hank", "abc123", members, 500, false);
    expect(result).toBe(
      [
        "",
        "Packed demo.hank",
        "",
        "  demo.hank",
        "  ├── prompts/",
        "  │   └── a.md  1 B",
        "  ├── tpl/",
        "  │   ├── bin/",
        "  │   │   └── run.sh  2 B · executable",
        "  │   └── config.json  0 B",
        "  ├── hank.json  3 B",
        "  └── hank.lock  1.0 KiB",
        "",
        "  5 files · 1.0 KiB unpacked · 500 B compressed",
        "  bundleHash abc123",
      ].join("\n"),
    );
    expect(renderBundle("demo.hank", "abc123", [...members].reverse(), 500, false)).toBe(result);
    const colored = renderBundle("demo.hank", "abc123", members, 500, true);
    expect(colored).toContain("\x1b[36mprompts/");
    expect(stripVTControlCharacters(colored)).toBe(result);
  });

  it("appends runtime.min, the warning count, and the sidecar path when given", () => {
    const members: TarMember[] = [{ path: "hank.json", bytes: Buffer.alloc(3), mode: "644" }];
    const result = renderBundle("demo.hank", "abc123", members, 500, false, {
      minRuntime: "0.10.0",
      warnings: 1,
      sidecar: "/h/hank.lock",
    });
    expect(
      result.endsWith(
        "\n  bundleHash abc123\n  runtime.min 0.10.0 · 1 warning\n  wrote hank.lock to /h/hank.lock",
      ),
    ).toBe(true);
    expect(renderBundle("demo.hank", "abc123", members, 500, false)).not.toContain("runtime.min");
  });

  it("handles a deeply nested tree without recursive traversal", () => {
    const result = renderBundle(
      "deep.hank",
      "hash",
      [{ path: `${"d/".repeat(1000)}leaf`, bytes: Buffer.alloc(0), mode: "644" }],
      0,
      false,
    );
    expect(result).toContain("└── leaf  0 B");
  });

  it("uses terminal capability", () => {
    expect(usePackColor(true, {})).toBe(true);
    expect(usePackColor(false, {})).toBe(false);
    expect(usePackColor(true, { TERM: "dumb" })).toBe(false);
  });
});
