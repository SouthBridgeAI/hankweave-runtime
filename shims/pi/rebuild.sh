#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Installing dependencies..."
bun install

echo "Building bundle..."
bun run build

PRIMARY_DEP="$(node -e "const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));const deps=Object.keys(pkg.dependencies||{}).filter((name)=>name!=='@shims/common');process.stdout.write(deps[0]||'');")"
PRIMARY_VERSION="n/a"

if [ -n "$PRIMARY_DEP" ]; then
  PRIMARY_VERSION="$(node -e "const fs=require('fs');const dep=process.argv[1];const pkgPath='node_modules/'+dep+'/package.json';const pkg=JSON.parse(fs.readFileSync(pkgPath,'utf8'));process.stdout.write(pkg.version||'unknown');" "$PRIMARY_DEP")"
fi

printf '%s\n' "$PRIMARY_VERSION" > VERSION

echo "Normalizing dist/index.js shebang..."
node -e "const fs=require('fs');const file='dist/index.js';let content=fs.readFileSync(file,'utf8');content=content.replace(/^#!.*\n/,'');content='#!/usr/bin/env node\n'+content;fs.writeFileSync(file,content);fs.copyFileSync(file,'index.js');"

chmod +x dist/index.js
chmod +x index.js

echo "Rebuild complete"
echo "  primary dependency: ${PRIMARY_DEP:-none}"
echo "  resolved version:   ${PRIMARY_VERSION}"
echo "  bundle:             dist/index.js"
echo "  drop-in bundle:     index.js"
