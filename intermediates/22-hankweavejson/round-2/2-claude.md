# Hankweave.json Round 2: Flat Config Design

## Key Design Change from Round 1

Round 1 proposed a nested configuration structure. Round 2 pivots to a **flat settings model** for runtime configuration, ensuring clear 1:1 mapping between:

- Config file keys → CLI args → Environment variables

This simplifies override semantics and makes the config more predictable.

---

## hankweave.json Example

A complete, shareable hank configuration:

```json
{
  "$schema": "https://hankweave.dev/schemas/hankweave.schema.json",
  "version": "1.0.0",

  "port": 7777,
  "autostart": true,
  "withoutProxy": false,
  "model": "sonnet",
  "anthropicBaseUrl": null,
  "outputDirectory": "hankweave-results",
  "logParsingInterval": 1000,
  "dataHashTimeLimit": 5000,
  "toolResultTruncateLength": 2500,
  "handshakeHistoryLimit": 50,
  "sentinelEnablePersistence": true,
  "sentinelHealthCheckGracePeriodMs": 2000,
  "sentinelWaitForAllHealthChecks": false,

  "hank": [
    {
      "id": "generate",
      "name": "Code Generator",
      "type": "codon",
      "promptFile": "prompts/generate.md",
      "model": "sonnet",
      "trackedFiles": ["src/**/*.ts"],
      "outputFiles": [{ "copy": ["src/**/*.ts"] }]
    },
    {
      "id": "review",
      "name": "Code Review",
      "type": "codon",
      "promptFile": "prompts/review.md",
      "model": "opus",
      "trackedFiles": ["src/**/*.ts"],
      "sentinels": [{ "sentinelConfig": "sentinels/lint.json" }]
    },
    {
      "type": "loop",
      "id": "fix-loop",
      "name": "Fix Issues",
      "terminateOn": { "type": "iterationLimit", "limit": 3 },
      "codons": [
        {
          "id": "fix",
          "name": "Apply Fixes",
          "type": "codon",
          "promptFile": "prompts/fix.md",
          "model": "sonnet"
        }
      ]
    }
  ]
}
```

---

## hankweave.local.json Example

Local overrides (gitignored, never shared):

```json
{
  "port": 8888,
  "model": "opus",
  "anthropicBaseUrl": "http://localhost:4000/v1",
  "autostart": false,
  "withoutProxy": true
}
```

Note: `hankweave.local.json` contains **only overrides**, not a complete config. It cannot override the `hank` definition—only runtime settings.

---

## CLI Args Mapping

| Setting | CLI Arg | Env Variable |
|---------|---------|--------------|
| `port` | `--port=<n>` | `HANKWEAVE_PORT` |
| `autostart` | `--no-autostart` | `HANKWEAVE_AUTOSTART=false` |
| `withoutProxy` | `--without-proxy` | `HANKWEAVE_WITHOUT_PROXY=true` |
| `model` | `--model=<sonnet\|opus>` | `HANKWEAVE_MODEL` |
| `anthropicBaseUrl` | `--anthropic-base-url=<url>` | `HANKWEAVE_ANTHROPIC_BASE_URL` |
| `outputDirectory` | `--output-directory=<path>` | `HANKWEAVE_OUTPUT_DIRECTORY` |
| `logParsingInterval` | `--log-parsing-interval=<ms>` | `HANKWEAVE_LOG_PARSING_INTERVAL` |
| `dataHashTimeLimit` | `--data-hash-time-limit=<ms>` | `HANKWEAVE_DATA_HASH_TIME_LIMIT` |
| `toolResultTruncateLength` | `--tool-result-truncate-length=<n>` | `HANKWEAVE_TOOL_RESULT_TRUNCATE_LENGTH` |
| `handshakeHistoryLimit` | `--handshake-history-limit=<n>` | `HANKWEAVE_HANDSHAKE_HISTORY_LIMIT` |
| `sentinelEnablePersistence` | `--sentinel-enable-persistence` | `HANKWEAVE_SENTINEL_ENABLE_PERSISTENCE` |
| `sentinelHealthCheckGracePeriodMs` | `--sentinel-health-check-grace-period-ms=<ms>` | `HANKWEAVE_SENTINEL_HEALTH_CHECK_GRACE_PERIOD_MS` |
| `sentinelWaitForAllHealthChecks` | `--sentinel-wait-for-all-health-checks` | `HANKWEAVE_SENTINEL_WAIT_FOR_ALL_HEALTH_CHECKS` |

### Example CLI Invocations

```bash
# Basic override
hankweave --port=9000 --model=opus

# Development mode with local proxy
hankweave --without-proxy --no-autostart --anthropic-base-url=http://localhost:4000/v1

# CI mode with explicit config
hankweave --config=/path/to/ci-hank.json --config-override=/path/to/ci-overrides.json

# Using env vars
HANKWEAVE_PORT=9000 HANKWEAVE_MODEL=opus hankweave
```

---

## Precedence Resolution Example

Given:

**hankweave.json**:
```json
{ "port": 7777, "model": "sonnet", "autostart": true }
```

**hankweave.local.json**:
```json
{ "port": 8888 }
```

**Environment**:
```bash
export HANKWEAVE_MODEL=opus
```

**CLI**:
```bash
hankweave --port=9999
```

**Resolved config**:
```json
{ "port": 9999, "model": "opus", "autostart": true }
```

Breakdown:
- `port`: 9999 (CLI wins over local.json's 8888)
- `model`: opus (env var wins over hankweave.json's sonnet)
- `autostart`: true (hankweave.json, no overrides)

---

## Alternative Approaches

### 1. Nested Config Structure (Round 1 Approach)

```json
{
  "server": { "port": 7777, "withoutProxy": false },
  "llm": { "defaultModel": "sonnet", "providers": { "anthropic": { "baseUrl": null } } },
  "sentinel": { "enablePersistence": true, "healthCheckGracePeriodMs": 2000 }
}
```

**Pros**:
- Logical grouping, easier to understand structure
- Matches how developers often think about configuration
- Self-documenting hierarchy

**Cons**:
- CLI/env mapping becomes awkward: `--server-port` or `--server.port`?
- Deep nesting creates precedence ambiguity: does replacing `llm.providers` replace the whole object or merge?
- More complex validation and merge logic

### 2. Separate Files for Hank and Settings

```
hankweave.json      → runtime settings only
hank.json           → codon definitions only
```

**Pros**:
- Clear separation of concerns
- Settings can be reused across multiple hanks
- Smaller, more focused files

**Cons**:
- Two files to share instead of one
- Must keep hank and compatible settings in sync
- Additional file discovery complexity

### 3. Environment-Based Config Variants

```
hankweave.json           → base
hankweave.dev.json       → development overrides
hankweave.prod.json      → production overrides
```

Selected via `HANKWEAVE_ENV=prod` or `--env=prod`.

**Pros**:
- Familiar pattern from many frameworks
- Environment-specific configs can be committed
- No need for local.json pattern

**Cons**:
- Proliferation of config files
- Environment names become part of the contract
- Harder to share single-file hanks

---

## Potential Shortcomings of Proposed Design

### 1. Flat Config Naming Collisions

Flattening creates long, awkward names like `sentinelHealthCheckGracePeriodMs`. As more settings are added, names become unwieldy.

**Mitigation**: Accept this trade-off for clarity, or use short prefixes: `sentinel_gracePeriodMs`.

### 2. Hank Definition Not Overridable

The current design doesn't allow `hankweave.local.json` to modify the hank (codon list). This is intentional (hank is the "shareable unit") but limits flexibility.

**Scenario**: Developer wants to skip a codon locally for faster iteration.

**Mitigation**: Support codon-level flags like `"disabled": true` that *can* be overridden locally:

```json
// hankweave.local.json
{
  "codonOverrides": {
    "review": { "disabled": true }
  }
}
```

### 3. No Validation of Override Keys

If someone typos `"ports": 8888` in local.json, it silently does nothing.

**Mitigation**:
- Strict validation that rejects unknown keys
- Or warn on unknown keys but don't fail

### 4. Boolean Flag Inconsistency

Some settings are positive (`autostart: true`), some are negative (`withoutProxy: true`). CLI uses `--no-autostart` but `--without-proxy`.

**Mitigation**: Standardize on positive flags with `--no-` prefix for negation:
- `proxy: true` → `--no-proxy` to disable
- `autostart: true` → `--no-autostart` to disable

### 5. Config File Discovery May Surprise Users

Walking up directories to find config can be confusing:

```
~/projects/
  hankweave.json         ← might accidentally use parent config
  my-project/
    run-hankweave.sh     ← runs here, picks up parent config
```

**Mitigation**:
- Don't walk up directories—only check explicit paths
- Or require explicit `--config` in ambiguous cases
- Log which config file was loaded at startup

### 6. Missing Schema Versioning Strategy

What happens when hankweave adds new settings? Old configs might break with new versions.

**Mitigation**:
- `version` field indicates schema version
- Maintain backward compatibility for older versions
- Document migration paths between versions

### 7. No Comments in JSON

Users can't document their config choices inline.

**Mitigation**:
- Support JSONC (JSON with Comments)
- Or use `"$comment"` fields (ugly but works)
- Or switch to YAML/TOML (adds dependency)

---

## Recommendations

1. **Accept the flat structure** — the CLI/env clarity outweighs naming awkwardness
2. **Add codonOverrides support** — enables local workflow customization
3. **Strict validation with warnings** — reject unknown keys, warn on deprecated
4. **Standardize boolean naming** — all positive, use `--no-` prefix
5. **Skip directory walking** — explicit config or cwd only
6. **Support JSONC** — comments are valuable for shared configs
7. **Version the schema** — plan for evolution from day one
