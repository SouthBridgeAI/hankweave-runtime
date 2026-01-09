#!/usr/bin/env bun
/**
 * Build script for strandweave npm package
 *
 * This script:
 * 1. Bundles server/index.ts and all dependencies
 * 2. Minifies the output
 * 3. Creates a standalone executable that works with node/bun/pnpm
 */

import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const distDir = join(import.meta.dir, "..", "dist");
const outfile = join(distDir, "index.js");

async function build() {
  console.log("🏗️  Building strandweave for npm distribution...\n");

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

  // Make executable
  await Bun.$`chmod +x ${outfile}`;

  console.log("\n✅ Build complete!");
  console.log(`📁 Output: ${outfile}`);

  // Show bundle size
  const builtFile = Bun.file(outfile);
  const sizeKB = (builtFile.size / 1024).toFixed(2);
  console.log(`📊 Bundle size: ${sizeKB} KB (minified)\n`);
}

build().catch((error) => {
  console.error("❌ Build failed:", error);
  process.exit(1);
});
