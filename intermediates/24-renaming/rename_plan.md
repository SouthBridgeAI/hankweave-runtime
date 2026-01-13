### Naming Decisions

| Old                        | New                      |
| -------------------------- | ------------------------ |
| Strandweave                | Hankweave                |
| strandweave                | hankweave                |
| STRANDWEAVE                | HANKWEAVE                |
| Strand                     | Hank                     |
| strand                     | hank                     |
| strands                    | hanks                    |
| strand.json                | hank.json                |
| .strandweave/              | .hankweave/              |
| ~/.strandweave-executions/ | ~/.hankweave-executions/ |
| ~/.strandweave/            | ~/.hankweave/            |
| strandweave-results/       | hankweave-results/       |

### Environment Variables

| Old                                | New                              |
| ---------------------------------- | -------------------------------- |
| `STRANDWEAVE_RUNTIME_*`            | `HANKWEAVE_RUNTIME_*`            |
| `STRANDWEAVE_SENTINEL_*`           | `HANKWEAVE_SENTINEL_*`           |
| `STRANDWEAVE_CACHE_DIR`            | `HANKWEAVE_CACHE_DIR`            |
| `STRANDWEAVE_TEST_*`               | `HANKWEAVE_TEST_*`               |
| `__STRANDWEAVE_TEST_EVENT_TRACKER` | `__HANKWEAVE_TEST_EVENT_TRACKER` |

### GitHub Secrets (Manual Update Required)

| Old                                      | New                                    |
| ---------------------------------------- | -------------------------------------- |
| `STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY` | `HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY` |

## Phase 1: File Renames

Rename files first so git tracks them properly (before content changes).

### 1.1 Server Files

```bash
# Navigate to repo root
cd /path/to/repo

# Rename server files
git mv server/strandweave-runtime.ts server/hankweave-runtime.ts
git mv server/remote-strand.ts server/remote-hank.ts
```

### 1.2 Test Files

```bash
git mv tests/utils/strandweave-server-test-helpers.ts tests/utils/hankweave-server-test-helpers.ts
git mv tests/integration/strandweave-server.test.ts tests/integration/hankweave-server.test.ts
git mv tests/integration/sentinel-strandweave-integration.test.ts tests/integration/sentinel-hankweave-integration.test.ts
git mv tests/e2e/strandweave-server.test.ts tests/e2e/hankweave-server.test.ts
```

### 1.3 Documentation Files

> **Note:** Git status shows documentation/ files are already deleted from this branch. Skip this step if the folder doesn't exist.

```bash
# Check if documentation folder exists first - skip if not present
if [ -d "documentation" ]; then
  git mv documentation/strandweave-folder-structure.md documentation/hankweave-folder-structure.md 2>/dev/null || true
fi
```

### 1.4 Commit File Renames

```bash
git add -A
git commit -m "chore: rename files for Hankweave rebrand

Renamed:
- strandweave-runtime.ts → hankweave-runtime.ts
- remote-strand.ts → remote-hank.ts
- Test files updated accordingly

Content changes to follow in next commit."
```

---

## Phase 2: Content Replacements

### 2.1 Replacement Order (Important!)

Replace in this order to avoid partial matches:

1. `Strandweave` → `Hankweave` (proper noun, capitalized)
2. `STRANDWEAVE` → `HANKWEAVE` (all caps, if any)
3. `strandweave` → `hankweave` (lowercase)
4. `Strands` → `Hanks` (plural, capitalized)
5. `STRANDS` → `HANKS` (all caps, if any)
6. `strands` → `hanks` (plural, lowercase)
7. `Strand` → `Hank` (singular, capitalized)
8. `STRAND` → `HANK` (all caps, if any)
9. `strand` → `hank` (singular, lowercase) — **most dangerous, do last**

### 2.2 Execute Replacements (suggestion)

**Option A: Using sed (macOS/Linux)**

```bash
# IMPORTANT: Exclude intermediates, node_modules, .git, and binary files
# Run from repo root
# NOTE: Include *.yml for GitHub workflows

# 1. Strandweave → Hankweave
find . -type f \( -name "*.ts" -o -name "*.json" -o -name "*.md" -o -name "*.template" -o -name "*.sh" -o -name "*.yml" \) \
  -not -path "./intermediates/*" \
  -not -path "./node_modules/*" \
  -not -path "./.git/*" \
  -not -name "rename_plan.md" \
  -not -name "RENAME_PLAN.md" \
  -exec sed -i '' 's/Strandweave/Hankweave/g' {} +

# 2. STRANDWEAVE → HANKWEAVE
find . -type f \( -name "*.ts" -o -name "*.json" -o -name "*.md" -o -name "*.template" -o -name "*.sh" -o -name "*.yml" \) \
  -not -path "./intermediates/*" \
  -not -path "./node_modules/*" \
  -not -path "./.git/*" \
  -not -name "rename_plan.md" \
  -not -name "RENAME_PLAN.md" \
  -exec sed -i '' 's/STRANDWEAVE/HANKWEAVE/g' {} +

# 3. strandweave → hankweave
find . -type f \( -name "*.ts" -o -name "*.json" -o -name "*.md" -o -name "*.template" -o -name "*.sh" -o -name "*.yml" \) \
  -not -path "./intermediates/*" \
  -not -path "./node_modules/*" \
  -not -path "./.git/*" \
  -not -name "rename_plan.md" \
  -not -name "RENAME_PLAN.md" \
  -exec sed -i '' 's/strandweave/hankweave/g' {} +

# 4. Strands → Hanks (careful: word boundary)
find . -type f \( -name "*.ts" -o -name "*.json" -o -name "*.md" -o -name "*.template" -o -name "*.sh" -o -name "*.yml" \) \
  -not -path "./intermediates/*" \
  -not -path "./node_modules/*" \
  -not -path "./.git/*" \
  -not -name "rename_plan.md" \
  -not -name "RENAME_PLAN.md" \
  -exec sed -i '' 's/Strands/Hanks/g' {} +

# 5. strands → hanks
find . -type f \( -name "*.ts" -o -name "*.json" -o -name "*.md" -o -name "*.template" -o -name "*.sh" -o -name "*.yml" \) \
  -not -path "./intermediates/*" \
  -not -path "./node_modules/*" \
  -not -path "./.git/*" \
  -not -name "rename_plan.md" \
  -not -name "RENAME_PLAN.md" \
  -exec sed -i '' 's/strands/hanks/g' {} +

# 6. Strand → Hank (word boundary to avoid "Stranded" → "Hanked")
# Using perl for word boundaries since sed doesn't support \b on macOS
find . -type f \( -name "*.ts" -o -name "*.json" -o -name "*.md" -o -name "*.template" -o -name "*.sh" -o -name "*.yml" \) \
  -not -path "./intermediates/*" \
  -not -path "./node_modules/*" \
  -not -path "./.git/*" \
  -not -name "rename_plan.md" \
  -not -name "RENAME_PLAN.md" \
  -exec perl -i -pe 's/\bStrand\b/Hank/g' {} +

# 7. strand → hank (word boundary)
find . -type f \( -name "*.ts" -o -name "*.json" -o -name "*.md" -o -name "*.template" -o -name "*.sh" -o -name "*.yml" \) \
  -not -path "./intermediates/*" \
  -not -path "./node_modules/*" \
  -not -path "./.git/*" \
  -not -name "rename_plan.md" \
  -not -name "RENAME_PLAN.md" \
  -exec perl -i -pe 's/\bstrand\b/hank/g' {} +
```

### 2.3 Special Cases to Handle Manually

After automated replacement, check these manually:

```bash
# Check for any remaining "strand" that might be in comments or strings
rg -i "strand" --type ts --type json --type md \
  -g '!intermediates/*' -g '!node_modules/*' | head -50
```

**Known edge cases:**

1. **Import paths** - Verify all imports updated after file renames
2. **Config schema references** - Check Zod schemas reference new names
3. **Test snapshots** - May contain old strings
4. **Error messages** - Check user-facing errors updated
5. **URLs and links** - Documentation links to files
6. **CHANGELOG.md** - Contains `StrandweaveServerTestInstance` and `@southbridgeai/strandweave`
7. **scripts/release.ts** - ASCII banner and comments mention Strandweave
8. **scripts/build-executable.ts** - Comments and default output filename
9. **Test config JSON files** - `tests/config/*.json` have `"strand": [` array keys
10. **Test state JSON data** - `tests/test-data/states/*.json` have `.strandweave` paths

### 2.4 Init Command Templates (IMPORTANT!)

The file `server/init-command.ts` contains **inlined template strings** that need special attention.
The automated replacement should catch most, but verify these template keys are renamed:

```typescript
// In server/init-command.ts, the templates object key:
"strand.json"  →  "hank.json"

// And the content inside templates should have:
// - "strandweave init" → "hankweave init"
// - "strandweave workflow" → "hankweave workflow"
// - "# Strand" → "# Hank" (in README template)
// - Console output messages updated
```

After replacement, verify:

```bash
grep -n "strand" server/init-command.ts
```

### 2.5 CHANGELOG.md

The CHANGELOG contains references that need updating:

- Line 18: `StrandweaveServerTestInstance` class name
- Line 104: `@southbridgeai/strandweave` package name reference

After replacement, verify:

```bash
grep -n -i "strand" CHANGELOG.md
```

### 2.6 Cache Directory Defaults

These files have hardcoded cache paths that need updating:

```typescript
// server/claude-runtime-extractor.ts and server/shim-runtime-extractor.ts
path.join(os.homedir(), ".strandweave")  →  path.join(os.homedir(), ".hankweave")
```

### 2.7 Scripts Files

These script files have Strandweave references in comments and strings:

**scripts/release.ts:**

- Line 4: `"Release automation script for Strandweave"`
- Lines 221-223: ASCII banner `║   Strandweave Release Automation      ║`

**scripts/build-executable.ts:**

- Lines 3-5: Comments mentioning "Strandweave standalone executable"
- Line 14: Default output filename description mentions `strandweave`
- Line 88: Default output base is `strandweave`
- Line 105: Build message "Building Strandweave standalone executable"

After automated replacement, verify:

```bash
grep -n -i "strand" scripts/*.ts
```

### 2.8 Test Data Files

**Test config JSON files** in `tests/config/` have `"strand": [` array keys:

- `test-codons.config.json`
- `test-codons-with-loop.config.json`
- `test-codons-with-loop-error.config.json`
- `test-codons-with-loop-rig-setup.config.json`
- `test-context-exhaustion.config.json`
- `test-context-exhaustion-with-iteration-terminate.config.json`

**Test state JSON data** `tests/test-data/states/execution-state-test-state.json` contains `.strandweave` in paths.

After automated replacement, verify:

```bash
grep -n "strand" tests/config/*.json
grep -n "strandweave" tests/test-data/states/*.json
```

### 2.9 GitHub Workflows (Critical!)

The files `.github/workflows/release.yml` and `.github/workflows/ci.yml` contain:

- Binary names: `strandweave`, `strandweave.exe`
- Artifact names: `strandweave-linux-x64`, `strandweave-darwin-arm64`, etc.
- Release titles and notes (line 220: `# Strandweave Release`, line 278: `Strandweave v${{...}}`)
- Environment variable references: `STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY`
- Branch names: `strandweave-npx` in ci.yml

**Special attention for ci.yml:**
Line 8 has `strandweave-npx` branch with `# TODO: remove strandweave-npx after merge`.
Consider removing this branch reference entirely rather than renaming:

```yaml
# Before
- strandweave-npx
# After (option 1: rename)
- hankweave-npx
# After (option 2: remove - recommended if branch is merged)
# (delete the line entirely)
```

The sed commands above (with `*.yml`) should catch these, but verify:

```bash
grep -i "strand" .github/workflows/*.yml | head -30
```

---

## Phase 3: Package Configuration

### 3.1 Update package.json

```json
{
  "name": "@southbridgeai/hankweave",
  "bin": {
    "hankweave": "dist/index.js"
  }
}
```

**Full changes needed:**

```bash
# View current package.json bin and name
grep -E '"name"|"bin"' package.json
```

Then edit `package.json`:

- Change `"name": "@southbridgeai/strandweave"` → `"name": "@southbridgeai/hankweave"`
- Change `"strandweave":` → `"hankweave":` in bin section
- Update `"keywords"` array: `"strandweave"` → `"hankweave"`

### 3.2 Update .gitignore

Edit `.gitignore` to update folder references:

```
# Old
strandweave-results
.strandweave

# New
hankweave-results
.hankweave
```

### 3.3 Update biome.json (if applicable)

Check if any project-specific config references old names.

---

## Phase 4: Fix Import Paths

After file renames, imports will be broken. Fix them:

```bash
# Find broken imports
bun tc
```

**Common fixes:**

```typescript
// Old
import { something } from "./strandweave-runtime";
import { something } from "./strand-source";
import { helpers } from "../utils/strandweave-server-test-helpers";

// New
import { something } from "./hankweave-runtime";
import { something } from "./hank-source";
import { helpers } from "../utils/hankweave-server-test-helpers";
```

---

## Phase 5: Verification

### 5.1 Lint and Type Check

```bash
# Fix any lint issues from the rename
bun lint:fix

# Type check - this catches broken imports
bun tc
```

### 5.2 Search for Stragglers

**Critical: Multiple search strategies to catch what was missed**

```bash
# === STRATEGY 1: Direct grep for old terms ===

# Check for any remaining "strandweave" (case insensitive)
rg -i "strandweave" --type ts --type json --type md --type-add 'template:*.template' --type template \
  -g '!intermediates/*' -g '!node_modules/*' -g '!RENAME_PLAN.md'

# Check for any remaining "strand" as a word (not "stranded", etc.)
rg -w "strand" --type ts --type json --type md --type-add 'template:*.template' --type template \
  -g '!intermediates/*' -g '!node_modules/*' -g '!RENAME_PLAN.md'

# Check for "strands" plural
rg -w "strands" --type ts --type json --type md --type-add 'template:*.template' --type template \
  -g '!intermediates/*' -g '!node_modules/*' -g '!RENAME_PLAN.md'

# === STRATEGY 2: Check file names ===

# Any files still containing "strand" in name
find . -name "*strand*" -not -path "./intermediates/*" -not -path "./node_modules/*" -not -path "./.git/*"

# Any files still containing "strandweave" in name
find . -name "*strandweave*" -not -path "./intermediates/*" -not -path "./node_modules/*" -not -path "./.git/*"

# === STRATEGY 3: Check specific high-risk locations ===

# Package.json
grep -i "strand" package.json

# All config files
rg -i "strand" -g "*.json" -g "*.config.*" -g '!intermediates/*' -g '!node_modules/*'

# All template files
rg -i "strand" -g "*.template" -g '!intermediates/*'

# Documentation
rg -i "strand" documentation/

# README specifically
grep -i "strand" README.md | head -20

# === STRATEGY 4: Check for broken references ===

# Look for "hank" with wrong casing that might have been created
rg "StrandWeave|strandWeave|hankWeave|HankWeave" --type ts --type json --type md \
  -g '!intermediates/*' -g '!node_modules/*'

# === STRATEGY 5: Check gitignore ===
grep -i "strand" .gitignore

# === STRATEGY 6: Check environment variables ===
rg "STRANDWEAVE_" --type ts -g '!intermediates/*' -g '!node_modules/*'

# === STRATEGY 7: Check GitHub workflows ===
rg -i "strand" .github/workflows/

# === STRATEGY 8: Check init command templates ===
grep -n "strand" server/init-command.ts

# === STRATEGY 9: Check cache directory paths ===
rg "\.strandweave" --type ts -g '!intermediates/*' -g '!node_modules/*' -g '!RENAME_PLAN.md'

# === STRATEGY 10: Check global test types ===
rg "__STRANDWEAVE" --type ts -g '!intermediates/*'

# === STRATEGY 11: Check scripts ===
grep -n -i "strand" scripts/*.ts

# === STRATEGY 12: Check CHANGELOG ===
grep -n -i "strand" CHANGELOG.md

# === STRATEGY 13: Check test config JSON files ===
grep -n "strand" tests/config/*.json

# === STRATEGY 14: Check test state JSON files ===
grep -n "strandweave" tests/test-data/states/*.json
```

### 5.3 Verification Checklist

Run through this checklist manually:

**Package & Config:**

- [ ] `package.json` name field is `@southbridgeai/hankweave`
- [ ] `package.json` bin field uses "hankweave"
- [ ] `package.json` keywords updated
- [ ] `.gitignore` references `.hankweave` and `hankweave-results`
- [ ] `CLAUDE.md` updated if it references project name

**Documentation:**

- [ ] README.md title is "# Hankweave Runner"
- [ ] All docs reference "hank.json" not "strand.json"
- [ ] CHANGELOG.md references updated (package name, class names)

**Code:**

- [ ] No files named `*strand*` outside intermediates
- [ ] Environment variables use `HANKWEAVE_*` prefix
- [ ] Cache directory defaults to `~/.hankweave/`
- [ ] Init command creates `hank.json` (check `server/init-command.ts`)

**Scripts:**

- [ ] `scripts/release.ts` banner shows "Hankweave Release Automation"
- [ ] `scripts/build-executable.ts` default output is "hankweave"
- [ ] `scripts/build-executable.ts` comments updated

**Test Data:**

- [ ] Test config JSON files use `"hank": [` array key
- [ ] Test state JSON files use `.hankweave` paths

**GitHub:**

- [ ] `.github/workflows/release.yml` uses `hankweave` binary names
- [ ] `.github/workflows/release.yml` release title is "Hankweave v..."
- [ ] `.github/workflows/ci.yml` updated
- [ ] Branch names updated or removed (if applicable)

**Build Verification:**

- [ ] `bun tc` passes with no errors
- [ ] `bun lint:fix` passes with no errors
- [ ] Can run `bun server/index.ts --help` without "strand" in output
- [ ] Help text shows "Hankweave Runtime"

### 5.4 Test Run (You Run This)

```bash
# Run the test suite to catch runtime issues
# (Ask user to run - don't run yourself per CLAUDE.md)
```

---

## Phase 6: Commit Content Changes

```bash
git add -A
git diff --cached --stat  # Review what changed

git commit -m "$(cat <<'EOF'
chore: rename Strandweave to Hankweave

BREAKING CHANGE: Complete rebrand from Strandweave to Hankweave

- Project name: Strandweave → Hankweave
- Config files: strand.json → hank.json
- CLI command: strandweave → hankweave
- Execution folder: .strandweave/ → .hankweave/
- Concept: strands → hanks

This is a breaking change. Existing users must:
1. Rename their config files from strand.json to hank.json
2. Update any scripts using the strandweave CLI
3. Update any references to .strandweave/ folders
EOF
)"
```

---

## Phase 7: GitHub Changes

### 7.1 Rename Repository

1. Go to: https://github.com/SouthBridgeAI/tadpole/settings
2. Scroll to "Repository name"
3. Change `tadpole` → `hankweave`
4. Click "Rename"

**Note:** GitHub will automatically redirect `SouthBridgeAI/tadpole` → `SouthBridgeAI/hankweave` for about a year.

### 7.2 Update Repository Description

1. Go to: https://github.com/SouthBridgeAI/hankweave (new URL)
2. Click the gear icon next to "About"
3. Update description to reflect Hankweave name

### 7.3 Update GitHub Secrets (CRITICAL!)

The workflows reference secrets that need to be renamed:

1. Go to: https://github.com/SouthBridgeAI/hankweave/settings/secrets/actions
2. Rename or create new secrets:
   - `STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY` → `HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY`
3. Delete old secrets after verifying workflows work

**Alternative:** Keep old secret names and update workflow files to use new names gradually.

### 7.4 Update Local Remote

```bash
# After GitHub rename, update your local remote
git remote set-url origin https://github.com/SouthBridgeAI/hankweave.git

# Verify
git remote -v
```

### 7.5 Notify Team

Team members need to update their remotes:

```bash
git remote set-url origin https://github.com/SouthBridgeAI/hankweave.git
```

---

## Phase 8: First Hankweave Release

### 8.1 Merge to Release Branch

```bash
# Create PR from develop → release/alpha
# Or merge directly if you prefer
git checkout release/alpha
git merge develop
git push origin release/alpha
```

### 8.2 Create v0.2.0 Tag and Release

````bash
# Tag the release
git tag v0.2.0
git push origin v0.2.0

# Create GitHub release
gh release create v0.2.0 \
  --title "Hankweave v0.2.0" \
  --notes "$(cat <<'EOF'
## Hankweave v0.2.0

🎉 **Introducing Hankweave** - formerly known as Strandweave.

### Breaking Changes

This release includes a complete rebrand:

- **Project name:** Strandweave → Hankweave
- **Config files:** `strand.json` → `hank.json`
- **CLI command:** `strandweave` → `hankweave`
- **Execution folder:** `.strandweave/` → `.hankweave/`
- **Concept:** strands → hanks

### Migration Guide

If upgrading from v0.1.x:

1. Rename your config files:
   ```bash
   mv strand.json hank.json
````

2. Update any scripts using the CLI:

   ```bash
   # Old
   strandweave --config=strand.json

   # New
   hankweave --config=hank.json
   ```

3. Update references to execution folders if you have custom tooling.

4. Update environment variables:
   \`\`\`bash

   # Old

   export STRANDWEAVE_RUNTIME_PORT=8080
   export STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY=sk-...

   # New

   export HANKWEAVE_RUNTIME_PORT=8080
   export HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY=sk-...
   \`\`\`

5. (Optional) Rename local directories:
   \`\`\`bash
   mv ~/.strandweave-executions ~/.hankweave-executions
   mv ~/.strandweave ~/.hankweave
   \`\`\`

### What's New

- Fresh branding and naming
- Same reliable execution engine
- All existing functionality preserved

EOF
)"

````

---

## Phase 9: Post-Rename Cleanup

### 9.1 Update Any External References

Check and update:
- [ ] `CLAUDE.md` project description (if applicable)
- [ ] Any external documentation
- [ ] CI/CD configs (if you add them later)
- [ ] Any webhooks pointing to old repo
- [ ] Team bookmarks/links

### 9.2 Clean Up Intermediates (Optional)

If you want to clean up intermediates in `develop` branch as well (since they reference old names heavily):

```bash
# Option 1: Delete entirely
rm -rf intermediates/

# Option 2: Keep but accept old names as historical
# (No action needed)
````

---

## Rollback Procedure

If something goes catastrophically wrong:

### Revert Code Changes

```bash
# Find the commit before the rename
git log --oneline -10

# Reset to before rename (replace COMMIT_SHA)
git reset --hard COMMIT_SHA
git push --force origin develop  # Careful with force push!
```

### Revert GitHub Rename

1. Go to repo settings
2. Rename back to `tadpole`

### Revert Remote URL

```bash
git remote set-url origin https://github.com/SouthBridgeAI/tadpole.git
```

---

## Checklist Summary

### Execute (in order)

- [ ] Phase 1: Rename files
- [ ] Phase 2: Content replacements (including env vars, workflows)
- [ ] Phase 3: Package configuration
- [ ] Phase 4: Fix import paths
- [ ] Phase 5: Verification (all 10 search strategies)
- [ ] Phase 5.4: Run tests (you run)
- [ ] Phase 6: Commit changes
- [ ] Phase 7: GitHub changes (repo rename, secrets, description)

### Verification Commands Quick Reference

```bash
# Check for stragglers (comprehensive)
rg -i "strandweave" -g '!intermediates/*' -g '!node_modules/*' -g '!RENAME_PLAN.md' -g '!rename_plan.md'
rg -w "strand" -g '!intermediates/*' -g '!node_modules/*' -g '!RENAME_PLAN.md' -g '!rename_plan.md'
find . -name "*strand*" -not -path "./intermediates/*" -not -path "./node_modules/*" -not -path "./.git/*"

# Check environment variables
rg "STRANDWEAVE_" --type ts -g '!intermediates/*' -g '!node_modules/*'

# Check GitHub workflows
rg -i "strand" .github/workflows/

# Check cache paths
rg "\.strandweave" --type ts -g '!intermediates/*' -g '!RENAME_PLAN.md' -g '!rename_plan.md'

# Check scripts
grep -n -i "strand" scripts/*.ts

# Check CHANGELOG
grep -n -i "strand" CHANGELOG.md

# Check test data files
grep -n "strand" tests/config/*.json
grep -n "strandweave" tests/test-data/states/*.json

# Verify build
bun tc
bun lint:fix

# Check package.json
grep -E '"name"|"hankweave"' package.json

# Test CLI help
bun server/index.ts --help | grep -i "hank"
```

---

## FAQ

**Q: What about npm publishing?**
A: `hankweave` is available on npm. When you're ready to publish, the name is reserved by being first to publish.

**Q: Will old GitHub URLs break?**
A: GitHub redirects old URLs for ~1 year after rename. Direct links will continue working.

**Q: What about the old releases?**
A: They remain as "Strandweave v0.1.x" - this is fine and provides historical context.

**Q: Should we update intermediates?**
A: Since they're removed from release branch, it's optional. They serve as historical record of development.

**Q: What about environment variables?**
A: All `STRANDWEAVE_*` environment variables become `HANKWEAVE_*`. Users need to update their shell profiles and CI/CD configs.

**Q: Do I need to rename ~/.strandweave-executions?**
A: No, but old executions won't be found by the new version. You can rename it manually or just let new executions use the new directory.

**Q: What about GitHub Actions secrets?**
A: Secrets like `STRANDWEAVE_SENTINEL_ANTHROPIC_API_KEY` need to be renamed in the GitHub UI to `HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY`.
