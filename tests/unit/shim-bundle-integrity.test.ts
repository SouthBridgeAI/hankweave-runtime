import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const SHIM_DIR = path.resolve(__dirname, "../../shims");
const DIST_SHIM_DIR = path.resolve(__dirname, "../../dist/shims");
const EXPECTED_SHIMS = ["codex", "gemini", "opencode", "pi"];

describe("Shim Bundle Integrity — Source Shims", () => {
  for (const shimName of EXPECTED_SHIMS) {
    const shimPath = path.join(SHIM_DIR, shimName, "index.js");

    test(`shims/${shimName}/index.js exists`, () => {
      expect(fs.existsSync(shimPath)).toBe(true);
    });

    test(`shims/${shimName}/index.js is not empty`, () => {
      const stat = fs.statSync(shimPath);
      expect(stat.size).toBeGreaterThan(100); // A real shim should be at least 100 bytes
    });

    test(`shims/${shimName}/index.js has node shebang`, () => {
      const content = fs.readFileSync(shimPath, "utf-8");
      expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
    });

    test(`shims/${shimName}/index.js is executable`, () => {
      if (process.platform === "win32") {
        // Windows doesn't have Unix permission bits — .js files are
        // executable via their shebang + node association
        return;
      }
      const stat = fs.statSync(shimPath);
      // Check execute bit (owner)
      const isExecutable = (stat.mode & 0o100) !== 0;
      expect(isExecutable).toBe(true);
    });
  }

  test("no unexpected shim directories", () => {
    const shimDirs = fs
      .readdirSync(SHIM_DIR)
      .filter((f) => fs.statSync(path.join(SHIM_DIR, f)).isDirectory());
    for (const dir of shimDirs) {
      expect(EXPECTED_SHIMS).toContain(dir);
    }
  });
});

describe("Shim Bundle Integrity — Dist Shims (after build)", () => {
  // These tests only run if dist/ exists (i.e., after `bun run build`)
  const distExists = fs.existsSync(DIST_SHIM_DIR);

  for (const shimName of EXPECTED_SHIMS) {
    test(`dist/shims/${shimName}/index.js exists after build`, () => {
      if (!distExists) {
        console.log("⏭️  Skipping: dist/ does not exist (run `bun run build` first)");
        return;
      }
      const shimPath = path.join(DIST_SHIM_DIR, shimName, "index.js");
      expect(fs.existsSync(shimPath)).toBe(true);
    });
  }
});

describe("Shim Bundle Integrity — Size Sanity", () => {
  for (const shimName of EXPECTED_SHIMS) {
    test(`shims/${shimName}/index.js is reasonably sized`, () => {
      const shimPath = path.join(SHIM_DIR, shimName, "index.js");
      const stat = fs.statSync(shimPath);
      const sizeKB = stat.size / 1024;
      expect(sizeKB).toBeGreaterThan(1);
      // Pi shim bundles the SDK (~10MB), others are thin subprocess shims (<200KB)
      const maxSizeKB = shimName === "pi" ? 15_000 : 200;
      expect(sizeKB).toBeLessThan(maxSizeKB);
    });
  }
});

describe("Shim Runtime Extractor — SHIM_NAMES includes new shims", () => {
  test("shim-runtime-extractor.ts includes pi and opencode", () => {
    const extractorPath = path.resolve(__dirname, "../../server/shim-runtime-extractor.ts");
    const content = fs.readFileSync(extractorPath, "utf-8");
    expect(content).toContain('"pi"');
    expect(content).toContain('"opencode"');
  });
});

describe("Shim Package Integrity", () => {
  // Self-contained shim packages should have these files for rebuild capability
  const PACKAGING_FILES = ["rebuild.sh", "VERSION", "THIRDPARTY.md"];
  const SELF_CONTAINED_SHIMS = ["pi", "codex", "opencode", "gemini"];

  for (const shimName of SELF_CONTAINED_SHIMS) {
    for (const file of PACKAGING_FILES) {
      test(`shims/${shimName}/${file} exists`, () => {
        const filePath = path.join(SHIM_DIR, shimName, file);
        expect(fs.existsSync(filePath)).toBe(true);
      });
    }

    test(`shims/${shimName}/common/ directory exists (vendored @shims/common)`, () => {
      const commonDir = path.join(SHIM_DIR, shimName, "common");
      expect(fs.existsSync(commonDir)).toBe(true);
      expect(fs.statSync(commonDir).isDirectory()).toBe(true);
    });

    test(`shims/${shimName}/package.json uses file:./common not workspace:*`, () => {
      const pkgPath = path.join(SHIM_DIR, shimName, "package.json");
      if (!fs.existsSync(pkgPath)) return;
      const content = fs.readFileSync(pkgPath, "utf-8");
      // Should not have workspace:* (that requires the metaspec monorepo)
      expect(content).not.toContain("workspace:*");
      // Should use file:./common for self-contained resolution
      expect(content).toContain("file:./common");
    });

    test(`shims/${shimName}/rebuild.sh is executable`, () => {
      if (process.platform === "win32") return;
      const scriptPath = path.join(SHIM_DIR, shimName, "rebuild.sh");
      if (!fs.existsSync(scriptPath)) return;
      const stat = fs.statSync(scriptPath);
      expect((stat.mode & 0o100) !== 0).toBe(true);
    });
  }
});
