#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

bun install
bun run build

PRIMARY_VERSION="$(node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const dependencies = Object.keys(pkg.dependencies || {}).filter((name) => name !== '@shims/common');

if (dependencies.length === 0) {
  process.stdout.write('n/a');
  process.exit(0);
}

const primary = dependencies[0];

try {
  const depPkgPath = require.resolve(`${primary}/package.json`, { paths: [process.cwd()] });
  const depPkg = JSON.parse(fs.readFileSync(depPkgPath, 'utf8'));
  process.stdout.write(depPkg.version || 'n/a');
} catch {
  process.stdout.write('n/a');
}
NODE
)"

printf '%s\n' "$PRIMARY_VERSION" > VERSION

node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const distPath = path.join(process.cwd(), 'dist', 'index.js');
const rootPath = path.join(process.cwd(), 'index.js');
const shebang = '#!/usr/bin/env node';

let content = fs.readFileSync(distPath, 'utf8');
if (!content.startsWith(shebang)) {
  content = `${shebang}\n${content}`;
  fs.writeFileSync(distPath, content, 'utf8');
}

fs.chmodSync(distPath, 0o755);
fs.copyFileSync(distPath, rootPath);
fs.chmodSync(rootPath, 0o755);
NODE

echo "Rebuilt opencode-shim (VERSION=$(cat VERSION))"
