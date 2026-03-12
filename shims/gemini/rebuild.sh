#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

bun install
bun run build

PRIMARY_DEP=$(node <<'NODE'
const fs = require('node:fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const deps = Object.keys(pkg.dependencies || {}).filter((name) => name !== '@shims/common');
process.stdout.write(deps[0] || '');
NODE
)

if [[ -z "$PRIMARY_DEP" ]]; then
  printf 'n/a\n' > VERSION
else
  node - "$PRIMARY_DEP" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const depName = process.argv[2];
const depPkgPath = path.join(process.cwd(), 'node_modules', ...depName.split('/'), 'package.json');
const depPkg = JSON.parse(fs.readFileSync(depPkgPath, 'utf8'));
fs.writeFileSync('VERSION', `${depPkg.version || 'unknown'}\n`, 'utf8');
NODE
fi

node <<'NODE'
const fs = require('node:fs');
const filePath = 'dist/index.js';
let content = fs.readFileSync(filePath, 'utf8');
if (!content.startsWith('#!/usr/bin/env node\n')) {
  content = `#!/usr/bin/env node\n${content}`;
  fs.writeFileSync(filePath, content, 'utf8');
}
NODE

chmod +x dist/index.js
cp dist/index.js index.js
chmod +x index.js
