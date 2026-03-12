#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

bun install
bun run build

node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const dependencies = packageJson.dependencies ?? {};
const primaryDependency = Object.keys(dependencies).find((name) => name !== '@shims/common');

let resolvedVersion = 'n/a';
if (primaryDependency) {
  const packagePath = path.join('node_modules', ...primaryDependency.split('/'), 'package.json');
  const dependencyPackageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  resolvedVersion = dependencyPackageJson.version || 'n/a';
}
fs.writeFileSync('VERSION', `${resolvedVersion}\n`, 'utf8');

const shebang = '#!/usr/bin/env node';
const distIndexPath = path.join('dist', 'index.js');
let distIndex = fs.readFileSync(distIndexPath, 'utf8');
if (!distIndex.startsWith(shebang)) {
  distIndex = `${shebang}\n${distIndex}`;
  fs.writeFileSync(distIndexPath, distIndex, 'utf8');
}
fs.chmodSync(distIndexPath, 0o755);
fs.copyFileSync(distIndexPath, 'index.js');
fs.chmodSync('index.js', 0o755);
NODE

printf 'Rebuilt codex-shim (%s)\n' "$(tr -d '\n' < VERSION)"
