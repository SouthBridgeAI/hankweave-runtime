import type { BuildOutput } from "bun";

/** Shared by the npm build and the Node smoke test for the shipped CLI. */
export async function buildCli(outdir: string): Promise<BuildOutput> {
  return Bun.build({
    entrypoints: ["./server/index.ts"],
    outdir,
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
      // The embedded Pi agent and its transitive undici must stay external:
      // inlined undici defeats Bun's built-in undici interception and calls
      // node:worker_threads.markAsUncloneable (absent in Bun ≤1.3 / Node <22.10)
      // at CacheStorage construction → crash in the bundled dist.
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-ai",
      "undici",
      // crossws and srvx will bring their platform-specific implementations
      "crossws",
      "srvx",
    ],
  });
}
