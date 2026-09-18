import { describe, expect, it } from "bun:test";
import { compareSemVer, isStrictSemVer, parseSemVer } from "../../server/pack/semver.js";

/** The shared acceptance table from phase-2 issue 07 — the pack parser,
 * lock schema, and phase-3 comparator all stand on these rulings. */
describe("strict SemVer grammar (phase-2 issue 07)", () => {
  const accepted = [
    "0.0.0",
    "1.2.3",
    "1.2.3-alpha",
    "1.2.3-alpha.1",
    "1.2.3+build.7",
    "1.2.3-alpha.1+build.7",
    "999999999999999999999999.0.0",
  ];
  const rejected = [
    "v1.2.3", // no v prefix
    "1.2", // missing patch
    "01.2.3", // leading zero
    "1.2.3-", // empty prerelease
    "1.2.3-01", // leading zero in numeric prerelease id
    "1.2.3+", // empty build
    "banana",
    " 1.2.3 ", // whitespace
    "1.2.3 ",
    "",
  ];

  it.each(accepted)("accepts %s and stores it verbatim", (input) => {
    const parsed = parseSemVer(input);
    expect(parsed).not.toBeNull();
    expect(parsed?.raw).toBe(input);
    expect(isStrictSemVer(input)).toBe(true);
  });

  it.each(rejected)("rejects %s", (input) => {
    expect(parseSemVer(input)).toBeNull();
    expect(isStrictSemVer(input)).toBe(false);
  });

  it("parses numeric fields as BigInt beyond Number precision", () => {
    const parsed = parseSemVer("999999999999999999999999.0.0");
    expect(parsed?.major).toBe(999999999999999999999999n);
  });
});

describe("SemVer precedence (spec §11)", () => {
  const lt = (a: string, b: string) => {
    const pa = parseSemVer(a);
    const pb = parseSemVer(b);
    if (!pa || !pb) throw new Error("test table has an invalid version");
    expect(compareSemVer(pa, pb)).toBe(-1);
    expect(compareSemVer(pb, pa)).toBe(1);
  };
  const eq = (a: string, b: string) => {
    const pa = parseSemVer(a);
    const pb = parseSemVer(b);
    if (!pa || !pb) throw new Error("test table has an invalid version");
    expect(compareSemVer(pa, pb)).toBe(0);
  };

  it("orders the core triple numerically", () => {
    lt("1.2.3", "1.2.10");
    lt("1.9.0", "2.0.0");
    lt("999999999999999999999998.0.0", "999999999999999999999999.0.0");
  });

  it("orders prerelease below release and by the spec's identifier rules", () => {
    lt("1.2.3-alpha", "1.2.3"); // prerelease < release
    lt("1.0.0-alpha", "1.0.0-alpha.1"); // fewer identifiers < more
    lt("1.0.0-alpha.1", "1.0.0-alpha.beta"); // numeric < alphanumeric
    lt("1.0.0-alpha.1", "1.0.0-alpha.2");
    lt("1.0.0-1", "1.0.0-2");
    lt("1.0.0-alpha.beta", "1.0.0-beta");
    lt("1.0.0-beta.11", "1.0.0-rc.1");
  });

  it("ignores build metadata for precedence", () => {
    eq("1.2.3+build.7", "1.2.3+other");
    eq("1.2.3+build.7", "1.2.3");
  });
});
