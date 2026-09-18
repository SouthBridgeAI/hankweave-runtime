import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HankDir, type HankRef, type ResolvedPath } from "../../server/hank-dir.js";
import {
  forbiddenRefSpelling,
  lexicallyEscapesBase,
  normalizeRefField,
  refViolationMessage,
} from "../../server/utils.js";

const kindOf = (r: ReturnType<HankRef["validate"]>) => r?.kind;

function resolveRefField(
  hank: HankDir,
  value: string | string[] | undefined | null,
  baseDir: string = hank.root,
): ResolvedPath[] {
  return normalizeRefField(value).map((ref) => hank.ref(ref, { baseDir: baseDir }).path);
}

describe("HankRef.path", () => {
  const base = path.resolve(os.tmpdir(), "hank-dir-refs-base");
  const hank = new HankDir(base);

  test("resolves a relative ref against the base dir", () => {
    expect(hank.ref("prompts/main.md", { baseDir: base }).path as string).toBe(
      path.join(base, "prompts", "main.md"),
    );
  });

  test("passes an absolute ref through exactly as written", () => {
    const abs = `${base}${path.sep}a${path.sep}..${path.sep}b.md`;
    expect(hank.ref(abs, { baseDir: base }).path as string).toBe(abs);
  });

  test("resolves .. traversal in relative refs", () => {
    expect(hank.ref("../shared/x.md", { baseDir: base }).path as string).toBe(
      path.join(path.dirname(base), "shared", "x.md"),
    );
  });

  test("throws on an empty ref", () => {
    expect(() => hank.ref("", { baseDir: base }).path).toThrow(/empty file reference/);
  });

  test("throws on a relative base dir", () => {
    expect(() => hank.ref("a.md", { baseDir: "relative/dir" }).path).toThrow(/must be absolute/);
    expect(() => hank.ref("a.md", { baseDir: "" }).path).toThrow(/must be absolute/);
  });
});

describe("normalizeRefField", () => {
  test("scalar string becomes a one-element array", () => {
    expect(normalizeRefField("a.md")).toEqual(["a.md"]);
  });

  test("arrays pass through as-is", () => {
    expect(normalizeRefField(["a.md", "b.md"])).toEqual(["a.md", "b.md"]);
  });

  test("empty-string scalar means absent", () => {
    expect(normalizeRefField("")).toEqual([]);
  });

  test("undefined and null mean absent", () => {
    expect(normalizeRefField(undefined)).toEqual([]);
    expect(normalizeRefField(null)).toEqual([]);
  });

  test("empty-string elements inside arrays are preserved so they can error", () => {
    expect(normalizeRefField(["a.md", ""])).toEqual(["a.md", ""]);
  });
});

describe("reference field resolution", () => {
  const base = path.resolve(os.tmpdir(), "hank-dir-refs-base");
  const hank = new HankDir(base);

  test("composes normalization and resolution", () => {
    expect(resolveRefField(hank, "a.md", base) as string[]).toEqual([path.join(base, "a.md")]);
    expect(resolveRefField(hank, ["a.md", "b/c.md"], base) as string[]).toEqual([
      path.join(base, "a.md"),
      path.join(base, "b", "c.md"),
    ]);
    expect(resolveRefField(hank, undefined, base)).toEqual([]);
    expect(resolveRefField(hank, "", base)).toEqual([]);
  });

  test("an empty element inside an array throws", () => {
    expect(() => resolveRefField(hank, ["a.md", ""], base)).toThrow(/empty file reference/);
  });
});

describe("HankRef.isRoot", () => {
  const hankDir = path.resolve(os.tmpdir(), "hank-dir-refs-root", "hank");
  const hank = new HankDir(hankDir);

  test("flags every lexical spelling of the hank dir", () => {
    expect(hank.ref(".", { baseDir: hankDir }).isRoot()).toBe(true);
    expect(hank.ref("./", { baseDir: hankDir }).isRoot()).toBe(true);
    expect(hank.ref("sub/..", { baseDir: hankDir }).isRoot()).toBe(true);
    expect(hank.ref(hankDir, { baseDir: hankDir }).isRoot()).toBe(true);
  });

  test("accepts subdirectories, siblings, and parents", () => {
    expect(hank.ref("sub", { baseDir: hankDir }).isRoot()).toBe(false);
    expect(hank.ref("..", { baseDir: hankDir }).isRoot()).toBe(false);
    expect(hank.ref("../other", { baseDir: hankDir }).isRoot()).toBe(false);
  });

  test("pure path math: does not follow symlinks", () => {
    // A ref that only reaches the hank dir through a link is not flagged
    // here — callers that copy from the live filesystem (config.ts) layer
    // a realpath comparison on top.
    expect(hank.ref("../link-to-hank", { baseDir: hankDir }).isRoot()).toBe(false);
  });
});

// POSIX-only: Win32 normalizes ".." lexically BEFORE following symlinks, so
// on Windows the OS itself reads the decoy — the traversal being pinned here
// does not exist there.
describe.skipIf(process.platform === "win32")("absolute refs with .. through a symlink", () => {
  // An authored ABSOLUTE ref must be used exactly as written. Lexical
  // normalization ("link/.." cancels out) picks a different file than the
  // OS does when "link" is a symlink: the kernel follows the link first,
  // then walks .. from the link's TARGET.
  let tempDir: string;
  let hankDir: string;
  let authoredRef: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hank-dir-refs-symlink-"));
    // The real file, reachable only by traversing the symlink then ..
    fs.mkdirSync(path.join(tempDir, "shared", "subdir"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "shared", "prompt.md"), "reached through the symlink");
    // The decoy that lexical collapse of "link/.." lands on instead
    hankDir = path.join(tempDir, "hank");
    fs.mkdirSync(hankDir);
    fs.writeFileSync(path.join(hankDir, "prompt.md"), "wrong file: symlink hop ignored");
    fs.symlinkSync(path.join(tempDir, "shared", "subdir"), path.join(hankDir, "link"));
    // NOT path.join — it collapses ".." lexically itself, which is the very
    // behavior under test. Keep the segments exactly as an author would type.
    authoredRef = `${hankDir}${path.sep}link${path.sep}..${path.sep}prompt.md`;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("sanity: the OS resolves the authored path through the symlink", () => {
    expect(fs.readFileSync(authoredRef, "utf-8")).toBe("reached through the symlink");
  });

  // The resolver's passthrough contract is unchanged; POLICY (rejecting this
  // spelling entirely) lives in validate(), tested below.
  test("path keeps an absolute authored ref exactly as written", () => {
    expect(new HankDir(hankDir).ref(authoredRef, { baseDir: hankDir }).path as string).toBe(
      authoredRef,
    );
  });

  test("readText rejects an absolute spelling before reading", () => {
    expect(() =>
      new HankDir(hankDir).ref(authoredRef, { baseDir: hankDir }).readText({ what: "Prompt" }),
    ).toThrow(/absolute or drive-qualified/);
  });

  test("validate rejects the authored absolute spelling outright", () => {
    expect(new HankDir(hankDir).ref(authoredRef, { baseDir: hankDir }).validate()).toEqual({
      kind: "absolute",
      raw: authoredRef,
    });
  });
});

describe("forbiddenRefSpelling", () => {
  // Every case must produce the same verdict on every platform — that is the
  // whole point of an explicit spelling check over path.isAbsolute.
  test.each([
    ["/x", "absolute"],
    ["C:\\x", "absolute"], // drive-qualified wins over backslash: the ref names a fixed location
    ["C:/x", "absolute"],
    ["C:foo", "absolute"], // drive-relative
    ["C:", "absolute"],
    ["\\foo", "backslash"],
    ["\\\\server\\share", "backslash"],
    ["..\\..\\outside", "backslash"],
    ["a\0b", "invalid"],
  ] as const)("%j → %s", (raw, kind) => {
    expect(forbiddenRefSpelling(raw)).toBe(kind);
  });

  test.each(["x.md", "prompts/x.md", "../x.md", "..templates/x.md", "c/x", "sub/c:x"])(
    "%j is a legal spelling",
    (raw) => {
      expect(forbiddenRefSpelling(raw)).toBeNull();
    },
  );
});

describe("lexicallyEscapesBase", () => {
  test.each(["../x.md", "..", "sub/../../x.md", "../hank/prompts/x.md"])("%j escapes", (raw) => {
    expect(lexicallyEscapesBase(raw)).toBe(true);
  });

  test.each(["x.md", "..templates/x.md", "sub/../prompts/x.md", "./x.md"])(
    "%j stays inside",
    (raw) => {
      expect(lexicallyEscapesBase(raw)).toBe(false);
    },
  );
});

describe("HankRef.validate", () => {
  let tempDir: string;
  let hankDir: string;
  let hank: HankDir;
  let sentinelsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hank-dir-refs-policy-"));
    hankDir = path.join(tempDir, "hank");
    sentinelsDir = path.join(hankDir, "sentinels");
    fs.mkdirSync(path.join(hankDir, "prompts"), { recursive: true });
    fs.mkdirSync(sentinelsDir);
    hank = new HankDir(hankDir);
    fs.writeFileSync(path.join(hankDir, "prompts", "x.md"), "in-hank prompt");
    fs.writeFileSync(path.join(tempDir, "outside.md"), "outside the hank");
  });

  afterEach(() => {
    hank.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("forbidden spellings are rejected with their kind, on every platform", () => {
    expect(kindOf(hank.ref("/etc/passwd", { baseDir: hankDir }).validate())).toBe("absolute");
    expect(kindOf(hank.ref("C:/x", { baseDir: hankDir }).validate())).toBe("absolute");
    expect(kindOf(hank.ref("C:foo", { baseDir: hankDir }).validate())).toBe("absolute");
    expect(kindOf(hank.ref("..\\..\\outside", { baseDir: hankDir }).validate())).toBe("backslash");
    expect(kindOf(hank.ref("a\0b", { baseDir: hankDir }).validate())).toBe("invalid");
  });

  test("../outside.md from the hank root escapes", () => {
    const v = hank.ref("../outside.md", { baseDir: hankDir }).validate();
    expect(kindOf(v)).toBe("escapes");
  });

  test("leave-and-reenter spelling escapes even though it points back inside", () => {
    // Same verdict at the schema layer: R2 is defined on the spelling.
    const raw = `../${path.basename(hankDir)}/prompts/x.md`;
    expect(lexicallyEscapesBase(raw)).toBe(true);
    expect(kindOf(hank.ref(raw, { baseDir: hankDir }).validate())).toBe("escapes");
  });

  test("..templates and internal .. hops that stay inside are legal", () => {
    expect(hank.ref("..templates/x.md", { baseDir: hankDir }).validate()).toBeNull();
    expect(hank.ref("sub/../prompts/x.md", { baseDir: hankDir }).validate()).toBeNull();
  });

  test("from sentinels/, climbing back into the hank is legal but leaving it is not", () => {
    expect(hank.ref("../prompts/x.md", { baseDir: sentinelsDir }).validate()).toBeNull();
    expect(kindOf(hank.ref("../../x.md", { baseDir: sentinelsDir }).validate())).toBe("escapes");
  });

  test("a missing file is not a policy violation (existence checks own it)", () => {
    expect(hank.ref("prompts/missing.md", { baseDir: hankDir }).validate()).toBeNull();
    expect(hank.ref("no-such-dir/deep/x.md", { baseDir: hankDir }).validate()).toBeNull();
  });

  test("a component that is a plain file (ENOTDIR below it) defers like a missing file", () => {
    expect(hank.ref("prompts/x.md/impossible.md", { baseDir: hankDir }).validate()).toBeNull();
  });

  test("wrong-case spelling of an on-disk name is never a symlink violation", () => {
    // Case-insensitive FS: legal ref. Case-sensitive FS: merely missing.
    expect(hank.ref("Prompts/x.md", { baseDir: hankDir }).validate()).toBeNull();
  });

  describe.skipIf(process.platform === "win32")("symlink rejection (R3)", () => {
    test("final component is a symlink", () => {
      fs.symlinkSync(path.join(hankDir, "prompts", "x.md"), path.join(hankDir, "alias.md"));
      expect(hank.ref("alias.md", { baseDir: hankDir }).validate()).toEqual({
        kind: "symlink",
        raw: "alias.md",
        component: path.join(fs.realpathSync(hankDir), "alias.md"),
      });
    });

    test("a parent component is a symlink", () => {
      fs.symlinkSync(path.join(hankDir, "prompts"), path.join(hankDir, "link"));
      expect(kindOf(hank.ref("link/x.md", { baseDir: hankDir }).validate())).toBe("symlink");
    });

    test("a dangling symlink is a symlink first, not a missing file", () => {
      fs.symlinkSync(path.join(hankDir, "gone.md"), path.join(hankDir, "dangling.md"));
      expect(kindOf(hank.ref("dangling.md", { baseDir: hankDir }).validate())).toBe("symlink");
    });

    test("missing leaf behind a real symlink parent is still rejected", () => {
      fs.symlinkSync(path.join(hankDir, "prompts"), path.join(hankDir, "link"));
      expect(kindOf(hank.ref("link/missing.md", { baseDir: hankDir }).validate())).toBe("symlink");
    });

    test("a broken symlink as a parent is still rejected", () => {
      fs.symlinkSync(path.join(hankDir, "gone"), path.join(hankDir, "broken-link"));
      expect(kindOf(hank.ref("broken-link/child", { baseDir: hankDir }).validate())).toBe(
        "symlink",
      );
    });

    test("a self-loop symlink parent is a clean violation naming the loop, not ELOOP", () => {
      fs.symlinkSync(path.join(hankDir, "loop"), path.join(hankDir, "loop"));
      const v = hank.ref("loop/child", { baseDir: hankDir }).validate();
      expect(kindOf(v)).toBe("symlink");
      expect(v && "component" in v ? path.basename(v.component) : null).toBe("loop");
    });

    test("the hank dir reached through a symlinked path is fine (anchor is realpath'd)", () => {
      const aliasedHank = path.join(tempDir, "hank-alias");
      fs.symlinkSync(hankDir, aliasedHank);
      expect(
        new HankDir(aliasedHank).ref("prompts/x.md", { baseDir: aliasedHank }).validate(),
      ).toBeNull();
    });

    test("a symlinked BASE dir below the hank is rejected, not silently dissolved", () => {
      // hank/linked → hank/prompts; validating "x.md" against base
      // hank/linked must inspect the AUTHORED route (linked/x.md, through
      // the symlink), not the resolved one (prompts/x.md, clean).
      fs.symlinkSync(path.join(hankDir, "prompts"), path.join(hankDir, "linked"));
      const v = hank.ref("x.md", { baseDir: path.join(hankDir, "linked") }).validate();
      expect(kindOf(v)).toBe("symlink");
      expect(v && "component" in v ? path.basename(v.component) : null).toBe("linked");
    });

    test("a symlinked base is still rejected when the hank anchor is aliased", () => {
      // Mixed spelling: anchor via the alias, base via the real path. The
      // lexical shortcut can't apply (different prefixes), so the fallback
      // realpaths the base — whose below-hank components are then canonical,
      // and the symlinked component is caught by walking the entry ref
      // instead. Here the base itself resolves clean, so the walk of the
      // combined path must still reject the linked component when the ref
      // spells it.
      const aliasedHank = path.join(tempDir, "hank-alias2");
      fs.symlinkSync(hankDir, aliasedHank);
      fs.symlinkSync(path.join(hankDir, "prompts"), path.join(hankDir, "linked2"));
      const v = new HankDir(aliasedHank).ref("linked2/x.md", { baseDir: aliasedHank }).validate();
      expect(kindOf(v)).toBe("symlink");
    });
  });
});

describe("refViolationMessage", () => {
  test("each kind has a stable author-facing first clause", () => {
    expect(refViolationMessage({ kind: "absolute", raw: "/x" })).toContain(
      '"/x" is an absolute or drive-qualified path',
    );
    expect(refViolationMessage({ kind: "backslash", raw: "a\\b" })).toContain(
      "contains a backslash",
    );
    expect(refViolationMessage({ kind: "invalid", raw: "a\0b" })).toContain("invalid character");
    expect(refViolationMessage({ kind: "escapes", raw: "../x", resolved: "/tmp/x" })).toContain(
      '"../x" resolves outside the hank directory',
    );
    expect(refViolationMessage({ kind: "symlink", raw: "l/x", component: "/h/l" })).toContain(
      'passes through a symlink at "/h/l"',
    );
  });
});

describe("HankRef.readText", () => {
  let tempDir: string;
  let hank: HankDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hank-dir-refs-read-"));
    fs.mkdirSync(path.join(tempDir, "prompts"));
    fs.writeFileSync(path.join(tempDir, "prompts", "main.md"), "hello prompt");
    hank = new HankDir(tempDir);
  });

  afterEach(() => {
    hank.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("resolves and reads utf-8 content, returning the resolved path", () => {
    const { path: resolved, text } = hank
      .ref("prompts/main.md", { baseDir: tempDir })
      .readText({ what: "Prompt" });
    expect(text).toBe("hello prompt");
    expect(resolved as string).toBe(path.join(tempDir, "prompts", "main.md"));
  });

  test("missing-file and policy errors retain the caller's context", () => {
    const options = { what: "Prompt file", context: "codon example" };
    expect(() => hank.ref("prompts/missing.md", { baseDir: tempDir }).readText(options)).toThrow(
      `Prompt file not found: ${path.join(tempDir, "prompts", "missing.md")}\n  (codon example)`,
    );
    const violation = hank.ref("../outside.md").validate();
    if (!violation) throw new Error("expected an escape violation");
    expect(() => hank.ref("../outside.md", { baseDir: tempDir }).readText(options)).toThrow(
      `${refViolationMessage(violation)}\n  (codon example)`,
    );
  });

  test("rejects a directory ref with 'is not a regular file', not a raw EISDIR", () => {
    expect(() => hank.ref("prompts", { baseDir: tempDir }).readText({ what: "Prompt" })).toThrow(
      /is not a regular file/,
    );
  });

  test("propagates non-ENOENT read errors unchanged", () => {
    const failure = Object.assign(new Error("simulated read failure"), { code: "EIO" });
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(() => {
      throw failure;
    });
    let caught: unknown;
    try {
      hank.ref("prompts/main.md", { baseDir: tempDir }).readText({ what: "Prompt" });
    } catch (error) {
      caught = error;
    } finally {
      readSpy.mockRestore();
    }
    expect(caught).toBe(failure);
  });

  test.skipIf(process.platform === "win32")(
    "revalidates a previously vetted ref before reading",
    () => {
      const ref = hank.ref("prompts/main.md");
      expect(ref.validate()).toBeNull();
      const target = path.join(tempDir, "prompts", "main.md");
      fs.unlinkSync(target);
      fs.symlinkSync("missing.md", target);
      expect(() => ref.readText({ what: "Prompt" })).toThrow(/symlink/);
    },
  );
});

describe.skipIf(process.platform === "win32")("HankRef.readText non-regular file guard", () => {
  // A FIFO would block codon startup forever, so reject it before reading.
  const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hank-dir-refs-fifo-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("rejects a FIFO ref before any read", () => {
    const fifo = path.join(tempDir, "pipe.md");
    execFileSync("mkfifo", [fifo]);
    const hank = new HankDir(tempDir);
    expect(() => hank.ref("pipe.md", { baseDir: tempDir }).readText({ what: "Prompt" })).toThrow(
      /is not a regular file/,
    );
  });
});
