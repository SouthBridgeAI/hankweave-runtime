import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  external: ["bun"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});

