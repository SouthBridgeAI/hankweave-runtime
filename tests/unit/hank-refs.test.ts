import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  forbiddenRefSpelling,
  lexicallyEscapesBase,
  normalizeRefField,
  RefReadError,
  readRef,
  refViolationMessage,
  resolveRef,
  resolveRefField,
  type ValidatedRef,
  validateRef,
} from "../../server/hank-refs";

// validateRef returns the branded ref for a legal spelling; these unwrap the
// union for assertions.
const kindOf = (r: ReturnType<typeof validateRef>) => (typeof r === "string" ? undefined : r.kind);
const vet = (raw: string, baseDir: string, hankDir: string): ValidatedRef => {
  const r = validateRef(raw, baseDir, hankDir);
  if (typeof r !== "string") throw new Error(`expected a legal ref, got ${r.kind}`);
  return r;
};

describe("resolveRef", () => {
  const base = path.resolve(os.tmpdir(), "hank-refs-base");

  test("resolves a relative ref against the base dir", () => {
    expect(resolveRef("prompts/main.md", base) as string).toBe(
      path.join(base, "prompts", "main.md"),
    );
  });

  test("passes an absolute ref through exactly as written", () => {
    const abs = `${base}${path.sep}a${path.sep}..${path.sep}b.md`;
    expect(resolveRef(abs, base) as string).toBe(abs);
  });

  test("resolves .. traversal in relative refs", () => {
    expect(resolveRef("../shared/x.md", base) as string).toBe(
      path.join(path.dirname(base), "shared", "x.md"),
    );
  });

  test("throws on an empty ref", () => {
    expect(() => resolveRef("", base)).toThrow(/empty file reference/);
  });

  test("throws on a relative base dir", () => {
    expect(() => resolveRef("a.md", "relative/dir")).toThrow(/must be absolute/);
    expect(() => resolveRef("a.md", "")).toThrow(/must be absolute/);
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

describe("resolveRefField", () => {
  const base = path.resolve(os.tmpdir(), "hank-refs-base");

  test("composes normalization and resolution", () => {
    expect(resolveRefField("a.md", base) as string[]).toEqual([path.join(base, "a.md")]);
    expect(resolveRefField(["a.md", "b/c.md"], base) as string[]).toEqual([
      path.join(base, "a.md"),
      path.join(base, "b", "c.md"),
    ]);
    expect(resolveRefField(undefined, base) as string[]).toEqual([]);
    expect(resolveRefField("", base) as string[]).toEqual([]);
  });

  test("an empty element inside an array throws", () => {
    expect(() => resolveRefField(["a.md", ""], base)).toThrow(/empty file reference/);
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hank-refs-symlink-"));
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
  // spelling entirely) lives in validateRef, tested below.
  test("resolveRef keeps an absolute authored ref exactly as written", () => {
    expect(resolveRef(authoredRef, hankDir) as string).toBe(authoredRef);
  });

  test("readRef reads the file the OS would, not the lexically collapsed one", () => {
    // Forged brand: policy forbids absolute refs, so no ValidatedRef like
    // this can exist in production — the cast documents the RESOLVER's
    // passthrough semantics in isolation from policy.
    expect(readRef(authoredRef as ValidatedRef, hankDir).text).toBe("reached through the symlink");
  });

  test("validateRef rejects the authored absolute spelling outright", () => {
    expect(validateRef(authoredRef, hankDir, hankDir)).toEqual({
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

describe("validateRef", () => {
  let tempDir: string;
  let hankDir: string;
  let sentinelsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hank-refs-policy-"));
    hankDir = path.join(tempDir, "hank");
    sentinelsDir = path.join(hankDir, "sentinels");
    fs.mkdirSync(path.join(hankDir, "prompts"), { recursive: true });
    fs.mkdirSync(sentinelsDir);
    fs.writeFileSync(path.join(hankDir, "prompts", "x.md"), "in-hank prompt");
    fs.writeFileSync(path.join(tempDir, "outside.md"), "outside the hank");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("forbidden spellings are rejected with their kind, on every platform", () => {
    expect(kindOf(validateRef("/etc/passwd", hankDir, hankDir))).toBe("absolute");
    expect(kindOf(validateRef("C:/x", hankDir, hankDir))).toBe("absolute");
    expect(kindOf(validateRef("C:foo", hankDir, hankDir))).toBe("absolute");
    expect(kindOf(validateRef("..\\..\\outside", hankDir, hankDir))).toBe("backslash");
    expect(kindOf(validateRef("a\0b", hankDir, hankDir))).toBe("invalid");
  });

  test("../outside.md from the hank root escapes", () => {
    const v = validateRef("../outside.md", hankDir, hankDir);
    expect(kindOf(v)).toBe("escapes");
  });

  test("leave-and-reenter spelling escapes even though it points back inside", () => {
    // Same verdict at the schema layer: R2 is defined on the spelling.
    const raw = `../${path.basename(hankDir)}/prompts/x.md`;
    expect(lexicallyEscapesBase(raw)).toBe(true);
    expect(kindOf(validateRef(raw, hankDir, hankDir))).toBe("escapes");
  });

  test("..templates and internal .. hops that stay inside are legal", () => {
    expect(validateRef("..templates/x.md", hankDir, hankDir) as string).toBe("..templates/x.md");
    expect(validateRef("sub/../prompts/x.md", hankDir, hankDir) as string).toBe(
      "sub/../prompts/x.md",
    );
  });

  test("from sentinels/, climbing back into the hank is legal but leaving it is not", () => {
    expect(validateRef("../prompts/x.md", sentinelsDir, hankDir) as string).toBe("../prompts/x.md");
    expect(kindOf(validateRef("../../x.md", sentinelsDir, hankDir))).toBe("escapes");
  });

  test("a missing file is not a policy violation (existence checks own it)", () => {
    expect(validateRef("prompts/missing.md", hankDir, hankDir) as string).toBe(
      "prompts/missing.md",
    );
    expect(validateRef("no-such-dir/deep/x.md", hankDir, hankDir) as string).toBe(
      "no-such-dir/deep/x.md",
    );
  });

  test("a component that is a plain file (ENOTDIR below it) defers like a missing file", () => {
    expect(validateRef("prompts/x.md/impossible.md", hankDir, hankDir) as string).toBe(
      "prompts/x.md/impossible.md",
    );
  });

  test("wrong-case spelling of an on-disk name is never a symlink violation", () => {
    // Case-insensitive FS: legal ref. Case-sensitive FS: merely missing.
    expect(validateRef("Prompts/x.md", hankDir, hankDir) as string).toBe("Prompts/x.md");
  });

  describe.skipIf(process.platform === "win32")("symlink rejection (R3)", () => {
    test("final component is a symlink", () => {
      fs.symlinkSync(path.join(hankDir, "prompts", "x.md"), path.join(hankDir, "alias.md"));
      expect(validateRef("alias.md", hankDir, hankDir)).toEqual({
        kind: "symlink",
        raw: "alias.md",
        component: path.join(fs.realpathSync(hankDir), "alias.md"),
      });
    });

    test("a parent component is a symlink", () => {
      fs.symlinkSync(path.join(hankDir, "prompts"), path.join(hankDir, "link"));
      expect(kindOf(validateRef("link/x.md", hankDir, hankDir))).toBe("symlink");
    });

    test("a dangling symlink is a symlink first, not a missing file", () => {
      fs.symlinkSync(path.join(hankDir, "gone.md"), path.join(hankDir, "dangling.md"));
      expect(kindOf(validateRef("dangling.md", hankDir, hankDir))).toBe("symlink");
    });

    test("missing leaf behind a real symlink parent is still rejected", () => {
      fs.symlinkSync(path.join(hankDir, "prompts"), path.join(hankDir, "link"));
      expect(kindOf(validateRef("link/missing.md", hankDir, hankDir))).toBe("symlink");
    });

    test("a broken symlink as a parent is still rejected", () => {
      fs.symlinkSync(path.join(hankDir, "gone"), path.join(hankDir, "broken-link"));
      expect(kindOf(validateRef("broken-link/child", hankDir, hankDir))).toBe("symlink");
    });

    test("a self-loop symlink parent is a clean violation naming the loop, not ELOOP", () => {
      fs.symlinkSync(path.join(hankDir, "loop"), path.join(hankDir, "loop"));
      const v = validateRef("loop/child", hankDir, hankDir);
      expect(kindOf(v)).toBe("symlink");
      expect(v && "component" in v ? path.basename(v.component) : null).toBe("loop");
    });

    test("the hank dir reached through a symlinked path is fine (anchor is realpath'd)", () => {
      const aliasedHank = path.join(tempDir, "hank-alias");
      fs.symlinkSync(hankDir, aliasedHank);
      expect(validateRef("prompts/x.md", aliasedHank, aliasedHank) as string).toBe("prompts/x.md");
    });

    test("a symlinked BASE dir below the hank is rejected, not silently dissolved", () => {
      // hank/linked → hank/prompts; validating "x.md" against base
      // hank/linked must inspect the AUTHORED route (linked/x.md, through
      // the symlink), not the resolved one (prompts/x.md, clean).
      fs.symlinkSync(path.join(hankDir, "prompts"), path.join(hankDir, "linked"));
      const v = validateRef("x.md", path.join(hankDir, "linked"), hankDir);
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
      const v = validateRef("linked2/x.md", aliasedHank, aliasedHank);
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

describe("readRef", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hank-refs-read-"));
    fs.mkdirSync(path.join(tempDir, "prompts"));
    fs.writeFileSync(path.join(tempDir, "prompts", "main.md"), "hello prompt");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("resolves and reads utf-8 content, returning the resolved path", () => {
    const { path: resolved, text } = readRef(vet("prompts/main.md", tempDir, tempDir), tempDir);
    expect(text).toBe("hello prompt");
    expect(resolved as string).toBe(path.join(tempDir, "prompts", "main.md"));
  });

  test("throws RefReadError with authored ref, resolved path, and ENOENT cause", () => {
    let caught: unknown;
    try {
      readRef(vet("prompts/missing.md", tempDir, tempDir), tempDir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RefReadError);
    const err = caught as RefReadError;
    expect(err.authoredRef).toBe("prompts/missing.md");
    expect(err.resolvedPath as string).toBe(path.join(tempDir, "prompts", "missing.md"));
    expect((err.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(err.message).toContain("prompts/missing.md");
  });

  test("rejects a directory ref with 'is not a regular file', not a raw EISDIR", () => {
    expect(() => readRef(vet("prompts", tempDir, tempDir), tempDir)).toThrow(
      /is not a regular file/,
    );
  });
});

describe.skipIf(process.platform === "win32")("readRef non-regular file guard", () => {
  // readRef is the choke point for every nested config ref (sentinel
  // userPromptFile/systemPromptFile/schemaFile, global system prompts).
  // Reading a FIFO would block codon startup forever, so the guard must
  // reject it before the read.
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hank-refs-fifo-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("rejects a FIFO ref before any read", () => {
    const fifo = path.join(tempDir, "pipe.md");
    execSync(`mkfifo ${JSON.stringify(fifo)}`);
    let caught: unknown;
    try {
      readRef(vet("pipe.md", tempDir, tempDir), tempDir);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RefReadError);
    expect(((caught as RefReadError).cause as Error).message).toMatch(/is not a regular file/);
  });
});
