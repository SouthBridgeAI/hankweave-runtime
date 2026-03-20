#!/usr/bin/env bun
/**
 * Build script for hankweave npm package
 *
 * This script:
 * 1. Bundles server/index.ts and all dependencies (main CLI)
 * 2. Builds public export entry points (schemas, types) for library consumers
 * 3. Generates .d.ts declaration files for the exports
 * 4. Copies shims to dist
 */

import { mkdir, rm, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const distDir = join(import.meta.dir, "..", "dist");
const outfile = join(distDir, "index.js");

async function build() {
  console.log("🏗️  Building hankweave for npm distribution...\n");

  // Clean dist directory
  if (existsSync(distDir)) {
    console.log("🧹 Cleaning dist directory...");
    await rm(distDir, { recursive: true, force: true });
  }
  await mkdir(distDir, { recursive: true });

  console.log("📦 Bundling and minifying...");

  const result = await Bun.build({
    entrypoints: ["./server/index.ts"],
    outdir: distDir,
    target: "node",
    format: "esm",
    minify: true,
    sourcemap: "external",
    splitting: false, // Single file bundle for easier distribution

    // Keep these as external - they're runtime dependencies
    // Most packages will be bundled for portability and minification
    external: [
      // Keep AI SDK packages external - they have their own dependencies
      "@anthropic-ai/claude-agent-sdk",
      "@openai/codex-sdk",
      "ai",
      "@ai-sdk/anthropic",
      "@ai-sdk/google",
      "@ai-sdk/groq",
      "@ai-sdk/openai",
      // crossws and srvx will bring their platform-specific implementations
      "crossws",
      "srvx",
    ],
  });

  if (!result.success) {
    console.error("❌ Build failed:");
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  // Add shebang to the output file
  console.log("✍️  Adding shebang...");
  const file = Bun.file(outfile);
  let content = await file.text();

  // Remove any existing shebangs from the bundled code
  content = content.replace(/^#!.*\n/gm, "");

  // Add the Node.js shebang
  const withShebang = `#!/usr/bin/env node\n${content}`;
  await Bun.write(outfile, withShebang);

  // Make executable (Unix-only, silently skip on Windows)
  try {
    await Bun.$`chmod +x ${outfile}`;
  } catch {
    // chmod fails on Windows, which is expected
  }

  // Copy shims directory to dist (excluding build artifacts)
  console.log("📋 Copying shims directory...");
  const shimsSource = join(import.meta.dir, "..", "shims");
  const shimsTarget = join(distDir, "shims");

  const SHIM_EXCLUDE = new Set([
    "node_modules",
    "src",
    "tests",
    "docs",
    "bun.lock",
    "tsconfig.json",
    "rebuild.sh",
  ]);

  if (existsSync(shimsSource)) {
    await cp(shimsSource, shimsTarget, {
      recursive: true,
      filter: (source) => {
        const parts = source
          .replace(shimsSource, "")
          .split("/")
          .filter(Boolean);
        return !parts.some((part) => SHIM_EXCLUDE.has(part));
      },
    });
    console.log(`✅ Copied shims to ${shimsTarget}`);
  } else {
    console.warn("⚠️  Warning: shims directory not found at", shimsSource);
  }

  // Build public export entry points (schemas, types) for library consumers.
  // These are separate from the main CLI bundle — unbundled ESM modules
  // that consumers import via the package.json "exports" field.
  console.log("📚 Building public export entry points...");

  const exportsResult = await Bun.build({
    entrypoints: ["./server/exports/schemas.ts", "./server/exports/types.ts"],
    outdir: join(distDir, "exports"),
    target: "node",
    format: "esm",
    minify: false,
    splitting: true,
    external: [
      "zod",
      // Don't bundle anything — let consumers resolve deps
      // The .d.ts files handle type resolution
    ],
  });

  if (!exportsResult.success) {
    console.error("❌ Exports build failed:");
    for (const log of exportsResult.logs) {
      console.error(log);
    }
    process.exit(1);
  }
  console.log(`✅ Built ${exportsResult.outputs.length} export modules`);

  // Generate .d.ts declaration files for the exports.
  // Uses tsconfig.exports.json which targets only the public API surface.
  console.log("🔤 Generating type declarations...");
  const tscResult = Bun.spawnSync(
    ["bun", "run", "tsc", "--project", "tsconfig.exports.json"],
    {
      cwd: join(import.meta.dir, ".."),
      stdio: ["inherit", "pipe", "pipe"],
    },
  );

  if (tscResult.exitCode !== 0) {
    const stderr = tscResult.stderr.toString();
    console.error(`❌ Declaration generation failed:\n${stderr}`);
    process.exit(1);
  }

  // Move the generated declarations to match the exports output structure.
  // tsc emits to dist/ mirroring the server/ directory structure.
  // We need dist/exports/schemas.d.ts and dist/exports/types.d.ts to exist
  // alongside the built JS files.
  console.log("✅ Type declarations generated");

  console.log("\n✅ Build complete!");
  console.log(`📁 CLI bundle: ${outfile}`);
  console.log(`📁 Exports: ${join(distDir, "exports/")}`);

  // Show bundle size
  const builtFile = Bun.file(outfile);
  const sizeKB = (builtFile.size / 1024).toFixed(2);
  console.log(`📊 CLI bundle size: ${sizeKB} KB (minified)\n`);
}

build().catch((error) => {
  console.error("❌ Build failed:", error);
  process.exit(1);
});
