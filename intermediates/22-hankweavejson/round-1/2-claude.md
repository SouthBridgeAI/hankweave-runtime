# Hankweave.json Design Analysis & Recommendations

## Executive Summary

The goal is to centralize configuration into a single `hankweave.json` file while preserving the existing precedence hierarchy (CLI > env > config > defaults). This analysis covers what should go into this file, what should stay separate, and proposes a concrete schema.

---

## Design Principles

### 1. Separation of Concerns

Not all configuration belongs in `hankweave.json`. I propose three categories:

| Category | Location | Rationale |
|----------|----------|-----------|
| **Project config** | `hankweave.json` | Checked into repo, shared across team |
| **Secrets** | Environment variables | Never committed, per-environment |
| **Runtime overrides** | CLI args | One-off debugging, CI variations |

### 2. What Should Go Into hankweave.json

**Yes - include these:**
- Default port, output directory, log paths
- Cost tracking configuration
- Runtime tunables (log parsing interval, hash time limits, truncation lengths)
- Sentinel defaults (health check timing, persistence)
- Bun runtime version specification
- Docker configuration preferences
- LLM provider preferences (not keys!)
- Default model selection
- Proxy settings
- Autostart behavior

**No - keep these separate:**
- API keys (stay in env vars for security)
- Execution paths (runtime-specific)
- The codon sequence itself (keep in `codon-sequence.json` - it's workflow, not config)

### 3. Relationship to codon-sequence.json

Keep these as separate files with distinct purposes:

- `hankweave.json` - **How** hankweave behaves (runtime configuration)
- `codon-sequence.json` - **What** hankweave runs (workflow definition)

The `hankweave.json` could optionally specify where to find the codon sequence:

```json
{
  "workflow": {
    "configFile": "workflows/my-sequence.json"
  }
}
```

---

## Proposed Schema

```json
{
  "$schema": "./hankweave.schema.json",
  "version": "1.0.0",

  "server": {
    "port": 7777,
    "withoutProxy": false
  },

  "paths": {
    "outputDirectory": "hankweave-results",
    "lockFile": ".hankweave/runtime.lock",
    "logs": {
      "websocket": ".hankweave/logs/websocket.log",
      "server": ".hankweave/logs/server.log"
    }
  },

  "workflow": {
    "configFile": "codon-sequence.json",
    "autostart": true,
    "dataHashTimeLimit": 5000
  },

  "costs": {
    "perMTok": {
      "input": 3.0,
      "inputCache": 3.75,
      "cacheRead": 0.3,
      "output": 15.0
    }
  },

  "llm": {
    "defaultModel": "sonnet",
    "providers": {
      "anthropic": {
        "baseUrl": null
      }
    },
    "replay": {
      "enabled": false,
      "dataPath": null
    }
  },

  "runtime": {
    "logParsingInterval": 1000,
    "toolResultTruncateLength": 2500,
    "handshakeHistoryLimit": 50,
    "bun": {
      "version": null
    }
  },

  "docker": {
    "enabled": false,
    "image": null
  },

  "sentinel": {
    "enablePersistence": true,
    "healthCheckGracePeriodMs": 2000,
    "waitForAllHealthChecks": false
  }
}
```

---

## Implementation Considerations

### 1. File Discovery

Hankweave should look for `hankweave.json` in this order:
1. Path specified via `--hankweave-config=<path>` (new CLI arg)
2. Current working directory
3. Parent directories (walk up to find nearest)
4. User home `~/.config/hankweave/hankweave.json` (global defaults)

### 2. Merging Strategy

Use deep merge with the following precedence:
```
CLI args > env vars > hankweave.json (local) > hankweave.json (global) > DEFAULT_CONFIG
```

For nested objects, merge at the leaf level, don't replace entire sections.

### 3. Validation

- Create a JSON Schema (`hankweave.schema.json`) for editor autocomplete and validation
- Extend the existing Zod validation in `server/config.ts` to handle the new structure
- Validate early at startup, fail fast with clear error messages

### 4. Migration Path

Since this is new, no migration needed. However:
- Keep `DEFAULT_CONFIG` in code as the ultimate fallback
- Document which CLI args map to which config fields
- Consider a `hankweave init` command to generate a starter config

---

## Questions & Trade-offs

### Q1: Should codon-sequence.json merge into hankweave.json?

**Recommendation: No**

Reasons:
- Separation of concerns (config vs workflow)
- Workflow files may be generated or templated
- Allows multiple workflows with shared config
- Keeps hankweave.json smaller and focused

Alternative if merging is desired:
```json
{
  "config": { /* runtime config */ },
  "workflow": { /* inline codon sequence */ }
}
```

### Q2: How to handle environment-specific config?

Options:
1. **Separate files**: `hankweave.json`, `hankweave.prod.json`
2. **Environment sections within file** (not recommended - complexity)
3. **Environment variables only** for differences (current approach)

**Recommendation: Option 1 + 3**
- Base config in `hankweave.json`
- Use `--hankweave-config` to point to environment-specific file in CI
- Secrets always in env vars

### Q3: Should we support YAML/TOML?

**Recommendation: No, JSON only**

Reasons:
- Consistency with existing `codon-sequence.json`
- JSON Schema support for validation
- No additional dependencies
- Comments can be handled via `$comment` fields if needed

### Q4: Backward compatibility with existing DEFAULT_CONFIG?

The new config structure reorganizes fields into logical groups. To maintain backward compatibility:
- Keep the flat structure working during a transition period
- Log deprecation warnings for flat field usage
- Provide a migration script or command

---

## CLI Mapping

| CLI Argument | hankweave.json Path |
|--------------|----------------------|
| `--port` | `server.port` |
| `--without-proxy` | `server.withoutProxy` |
| `--no-autostart` | `workflow.autostart` (inverted) |
| `--model` | `llm.defaultModel` |
| `--anthropic-base-url` | `llm.providers.anthropic.baseUrl` |
| `--config` | `workflow.configFile` |

CLI arguments should continue to override config file values.

---

## Next Steps

1. **Decide on schema** - Review proposed structure, adjust as needed
2. **Create JSON Schema** - For validation and editor support
3. **Implement config loader** - File discovery + merging logic
4. **Update Zod schemas** - Extend validation for new structure
5. **Add CLI arg** - `--hankweave-config` for explicit path
6. **Document** - Update README with config file documentation
7. **Optional: `hankweave init`** - Interactive config generator
