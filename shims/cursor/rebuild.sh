#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

bun install
bun run build

node <<'NODE'
const fs = require("node:fs");
const filePath = "dist/index.js";
let content = fs.readFileSync(filePath, "utf8");
if (!content.startsWith("#!/usr/bin/env node\n")) {
  content = `#!/usr/bin/env node\n${content}`;
  fs.writeFileSync(filePath, content, "utf8");
}
NODE

chmod +x dist/index.js
cp dist/index.js index.js
chmod +x index.js
printf '0.1.0\n' > VERSION
