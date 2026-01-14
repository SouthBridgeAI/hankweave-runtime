# Design Proposal: Centralized `hankweave.json` Configuration

This document outlines a design for centralizing Hankweave's configuration into a single `hankweave.json` file. The goal is to create a more user-friendly, discoverable, and extensible configuration system.

## 1. Introduction & Goals

Currently, configuration is scattered across CLI arguments, environment variables, JSON files, and hardcoded defaults. This proposal aims to unify them.

### Key Goals:
- **Centralization**: Establish `hankweave.json` as the primary source of truth for project configuration.
- **Discoverability**: Allow users to easily find and modify all relevant settings in one place.
- **Extensibility**: Create a flexible structure that can accommodate future settings (e.g., runtime versions, testing configurations).
- **Clear Precedence**: Maintain a logical and predictable override hierarchy.
- **Security**: Keep secrets like API keys out of version-controlled configuration files.

## 2. Proposed `hankweave.json` Structure

We propose a modular structure with top-level keys for different configuration areas. This allows for clear organization and validation.

To enhance the developer experience, we will provide a **JSON Schema**. This will enable editor features like autocompletion, validation, and documentation on-hover for any IDE that supports them.

### Example `hankweave.json`:

```json
{
  "$schema": "./node_modules/@schemas/hankweave.schema.json",
  "project": {
    "name": "My Hankweave Project",
    "version": "1.0.0",
    "dataDirectory": "./data",
    "outputDirectory": "hankweave-results"
  },
  "server": {
    "port": 7777,
    "autostart": true,
    "proxy": {
      "enabled": true
    },
    "logging": {
      "serverLogFile": ".hankweave/logs/server.log",
      "websocketLogFile": ".hankweave/logs/websocket.log"
    }
  },
  "llm": {
    "defaultModel": "sonnet",
    "providers": {
      "anthropic": {
        "apiKey": "${ANTHROPIC_API_KEY}",
        "baseURL": "https://api.anthropic.com/v1"
      },
      "openai": {
        "apiKey": "${OPENAI_API_KEY}"
      },
      "google": {
        "apiKey": "${GOOGLE_API_KEY}"
      },
      "groq": {
        "apiKey": "${GROQ_API_KEY}"
      }
    },
    "sentinelOverrides": {
      "anthropic": {
        "apiKey": "${HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY}"
      }
    }
  },
  "workflow": {
    "type": "sequence",
    "codons": [
      {
        "id": "example-codon",
        "name": "Example Codon",
        "promptFile": "prompts/example.md",
        "model": "opus",
        "env": {
          "CUSTOM_VAR": "codon-specific-value"
        }
      }
    ]
  },
  "advanced": {
    "lockFile": ".hankweave/runtime.lock",
    "dataHashTimeLimit": 5000,
    "toolResultTruncateLength": 2500,
    "costsPerMTok": {
      "input": 3.0,
      "output": 15.0,
      "inputCache": 3.75,
      "cacheRead": 0.3
    },
    "sentinel": {
      "enablePersistence": true,
      "healthCheckGracePeriodMs": 2000,
      "waitForAllHealthChecks": false
    }
  }
}
```

## 3. Configuration Loading & Precedence

The new configuration system will load and merge settings from multiple sources, following a strict order of precedence. This ensures that runtime overrides behave as expected while maintaining a clear base configuration.

### New Precedence Order:
1.  **Command-Line Arguments**: Highest precedence. Used for one-off overrides (e.g., `hankweave --port=8080`).
2.  **Environment Variables**: For secrets and CI/CD environments. Values in `hankweave.json` like `"${VAR_NAME}"` will be substituted.
3.  **`hankweave.json`**: The project's base configuration. The application will search for this file in the root directory. The `--config` CLI flag can specify an alternate path.
4.  **Hardcoded Defaults**: Lowest precedence. Sensible fallbacks defined within the application.

### Handling Secrets
API keys and other secrets should not be stored in `hankweave.json`. The proposed design uses **environment variable substitution**. The configuration loader will recognize `"${...}"` syntax and replace it with the corresponding environment variable's value at runtime. If the variable is not set, it will result in an error, preventing accidental use of null keys.

## 4. Mapping Old to New

The following table demonstrates how existing configuration settings map to the new `hankweave.json` structure.

| Old Config                                | Location                | New `hankweave.json` Path                       |
| ----------------------------------------- | ----------------------- | ------------------------------------------------- |
| `--config=<path>`                         | CLI                     | Remains a CLI flag to locate the config file.     |
| `--port=<port>`                           | CLI                     | `server.port`                                     |
| `--data=<path>`                           | CLI                     | `project.dataDirectory`                           |
| `--model=<model>`                         | CLI                     | `llm.defaultModel`                                |
| `--anthropic-base-url=<url>`              | CLI                     | `llm.providers.anthropic.baseURL`                 |
| `--no-autostart`                          | CLI                     | `server.autostart` (as `false`)                   |
| `--without-proxy`                         | CLI                     | `server.proxy.enabled` (as `false`)               |
| `ANTHROPIC_API_KEY`                       | Environment Var         | `llm.providers.anthropic.apiKey` (via `"${...}"`) |
| `HANKWEAVE_SENTINEL_ANTHROPIC_API_KEY`  | Environment Var         | `llm.sentinelOverrides.anthropic.apiKey`          |
| `codon-sequence.json`                     | File                    | `workflow` object                                 |
| `DEFAULT_CONFIG` object                   | `server/config.ts`      | Spread across `project`, `server`, and `advanced` |

## 5. High-Level Implementation Plan

1.  **Create Config Service & Schema**:
    -   Develop a `ConfigLoader` service (`server/config-loader.ts`) responsible for finding, reading, parsing, and validating `hankweave.json`.
    -   Implement environment variable substitution (`"${VAR_NAME}"`).
    -   Define a comprehensive Zod schema for `hankweave.json` to ensure type safety and structure. This schema will be the single source of truth for the config shape.

2.  **Refactor CLI Entrypoint (`server/index.ts`)**:
    -   Integrate the `ConfigLoader` at application startup.
    -   Modify CLI argument parsing logic to *override* the configuration loaded from `hankweave.json`, not create it from scratch.
    -   The final, merged config object will be passed down to the rest of the application.

3.  **Refactor Config Logic (`server/config.ts`)**:
    -   Remove the `DEFAULT_CONFIG` object, replacing it with the merged config from the new service.
    -   Adapt the existing Zod validation logic to operate on the `workflow` section of the new config object.

4.  **Update Sub-Systems**:
    -   Refactor modules like `server/llm/provider-config.ts` to receive their configuration from the centralized config object instead of reading directly from `process.env`.

5.  **Documentation**:
    -   Create a new guide explaining `hankweave.json`, its structure, and the precedence rules.
    -   Update all existing documentation to reflect the new configuration-centric approach.

This refactoring will significantly improve the usability and maintainability of Hankweave by providing a clear, centralized, and secure-by-design configuration system.
