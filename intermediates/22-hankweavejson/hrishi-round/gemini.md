# Hankweave Configuration System Specification (v3)

## 1. Motivation

### The Problem
Currently, Hankweave conflates **Program Logic** (prompts, sequences, file tracking) with **Runtime Environment** (ports, logging, model selection, execution paths). This creates several friction points:

1.  **Portability:** Sharing a Hank (workflow) is difficult if it contains hardcoded environment settings (like specific paths or ports) that don't work on another user's machine.
2.  **Version Control Hygiene:** Users modify the Hank definition just to change local runtime settings (e.g., switching to a cheaper model for testing), leading to dirty git diffs on logic files.
3.  **Operational Rigidity:** In CI/CD or containerized environments, injecting configuration via Environment Variables is standard, but currently difficult to map against the JSON configuration.

### The Solution
We are moving to a **Strict Separation of Concerns**. We treat the Hank as "Code" and the Configuration as "Environment".

## 2. Core Philosophy

The execution of a Hankweave server should be viewed as a pure function that accepts three distinct inputs:

$$ \text{Server} = f(\text{Data}, \text{Hank}, \text{Settings}) $$

1.  **Data (Target):** The raw material being worked on. (e.g., a source code directory, a text file). This is Read-Only source material.
2.  **Hank (Logic):** The algorithm. The sequence of Codons, prompts, and architectural decisions designed to transform the Data. This is version-controlled and shared.
3.  **Settings (Environment):** The operational parameters. How much memory? Which port? Which API keys? Which model class? This is ephemeral or user-specific.

## 3. Resolution Hierarchy (The "Layer Cake")

To determine the final value of any setting (e.g., `model`), Hankweave employs a **Deep Merge** strategy. Values defined in higher priority layers overwrite those in lower layers.

| Priority | Layer Name | Source | Persona | Intent |
| :--- | :--- | :--- | :--- | :--- |
| **1 (Highest)** | **CLI Arguments** | Command Line Flags | Operator | *"I need to override this specific setting right now for this one run."* |
| **2** | **Environment** | `process.env` | DevOps / CI | *"The infrastructure dictates these constraints (secrets, ports)."* |
| **3** | **Runtime Config** | JSON File | User | *"This is how I prefer to run Hankweave on my machine."* |
| **4** | **Hank Recs** | JSON File (Hank) | Architect | *"This workflow performs best with these settings (e.g., Opus)."* |
| **5 (Lowest)** | **Defaults** | Source Code | System | *"Safe fallbacks to prevent crashing."* |

---

## 4. Schema Definitions

### A. The Hank File (`hank.json`)
*Formerly `codon-sequence.json`.*

This file defines the logic. While primarily a list of Codons, it now supports a metadata wrapper to allow Architects to suggest settings.

**Structure:**
```typescript
interface HankFile {
  // Metadata for sharing/indexing
  meta?: {
    name: string;
    version: string;
    description?: string;
    author?: string;
  };

  // Architect's Recommendations (Priority Level 4)
  // These are "Soft Defaults" specific to this logic.
  recommendations?: {
    model?: "sonnet" | "opus"; // "This task needs high reasoning"
    dataHashTimeLimit?: number; // "This task handles massive repos"
    sentinel?: {
      enablePersistence?: boolean; // "Sentinel history is critical here"
    }
  };

  // The immutable logic sequence
  hank: CodonConfig[];
}
```

> **Backward Compatibility:** If the loaded JSON is an Array `[]`, it is treated as the `hank` property with empty `meta` and `recommendations`.

### B. The Runtime Config (`hankweave.json`)
This file defines the environment. It is flat, strictly typed, and contains no logic.

**Structure:**
```typescript
interface RuntimeConfig {
  // Server Behaviors
  port?: number;
  autostart?: boolean;      // If true, run immediately on client connect
  withoutProxy?: boolean;   // Bypass internal LLM proxy

  // Model & API
  model?: "sonnet" | "opus"; // User's preferred default
  anthropicBaseUrl?: string; // For corporate proxies

  // Resources & Limits
  outputDirectory?: string;  // Where to put results (relative to CWD)
  executionBaseDir?: string; // Where to create temp execution environments

  logParsingInterval?: number;
  dataHashTimeLimit?: number;

  // Sentinel System
  sentinel?: {
    enablePersistence?: boolean;
    healthCheckGracePeriodMs?: number;
  }
}
```

---

## 5. The Settings Reference

This table defines every configurable key and how it maps across the layers.

| Setting Key | CLI Flag | Env Variable | Description |
| :--- | :--- | :--- | :--- |
| `port` | `--port` | `HANKWEAVE_PORT` | WebSocket server port. |
| `model` | `--model` | `HANKWEAVE_MODEL` | Default model for codons that don't specify one, OR override if specified globally. |
| `autostart` | `--no-autostart` (Negated) | `HANKWEAVE_AUTOSTART` | Start execution immediately upon client connection. |
| `withoutProxy` | `--without-proxy` | `HANKWEAVE_WITHOUT_PROXY` | Disable the internal LLM proxy. |
| `anthropicBaseUrl`| `--anthropic-base-url` | `HANKWEAVE_ANTHROPIC_BASE_URL` | Custom endpoint for LLM calls. |
| `outputDirectory` | `--output-dir` | `HANKWEAVE_OUTPUT_DIR` | Where result files are copied on completion. |
| `executionBaseDir`| `--execution-base` | `HANKWEAVE_EXECUTION_BASE` | Root folder for isolated execution environments. |

---

## 6. Usage & Behaviors

### The "No Magic" CLI Contract
We are removing logic that hunts up the directory tree for config files. Configuration MUST be explicit or follow the strict CWD convention.

#### 1. Implicit Execution (Convenience)
If running from a project root with standard naming.
```bash
$ hankweave --data=./src
```
1.  Looks for `hank.json` in CWD. If missing -> **Error**.
2.  Looks for `hankweave.json` in CWD. If found, loads Layer 3 settings. If missing, uses defaults.

#### 2. Explicit Execution (Production/Scripting)
Specifying exact files.
```bash
$ hankweave \
    --hank=./workflows/audit.json \
    --config=./configs/staging.json \
    --data=./src
```
1.  Loads Hank from `--hank`.
2.  Loads Runtime Settings from `--config`.
3.  Ignores any `hank.json` or `hankweave.json` in CWD.

#### 3. The Override (Development)
The Architect designed the hank for `opus`, but the Developer wants to test quickly/cheaply with `sonnet`.

**`hank.json` (Architect):**
```json
{ "recommendations": { "model": "opus" }, "hank": [...] }
```

**CLI Command (Developer):**
```bash
$ hankweave --hank=hank.json --data=./src --model=sonnet
```

**Resolution:**
1.  Layer 1 (CLI): `model = sonnet`
2.  Layer 4 (Recs): `model = opus`
3.  **Result:** `sonnet` wins.

---

## 7. Implementation Detail: `resolveSettings`

The `config.ts` module will export a resolver function.

```typescript
type ResolvedConfig = RuntimeConfig & { hank: CodonConfig[] };

async function resolveSettings(args: CLIArgs): Promise<ResolvedConfig> {
    // 1. Load Hank (Logic + Recommendations)
    const hankFile = args.hank || './hank.json';
    const hankData = await loadHankFile(hankFile); // Handles object or array

    // 2. Load Runtime Config (User Prefs)
    const configFile = args.config || './hankweave.json';
    const fileConfig = await loadConfigFile(configFile).catch(() => ({}));

    // 3. Load Env Vars
    const envConfig = loadEnvVars();

    // 4. Merge (The Layer Cake)
    // Note: lodash.merge or deep merge util required for nested objects like 'sentinel'
    const finalSettings = deepMerge(
        DEFAULT_CONFIG,                  // Layer 5
        hankData.recommendations,      // Layer 4
        fileConfig,                      // Layer 3
        envConfig,                       // Layer 2
        args                             // Layer 1
    );

    return {
        ...finalSettings,
        hank: hankData.hank
    };
}
```

## 8. FAQs & Gotchas

**Q: Does the `model` setting override a specific model set on a Codon?**
**A:** **Yes.** If `model` is set in the Runtime Config, CLI, or Env, it acts as a **Global Override**.
*Rationale:* If a user sets `--model=sonnet`, they usually mean "Run this whole thing with Sonnet, I don't care what the file says."
*Exception:* If `model` is only set in "Recommendations" (Layer 4) or "Defaults" (Layer 5), it behaves as a fallback for codons that don't specify a model.

**Q: Can I define the `data` source in the `hankweave.json` config file?**
**A:** **No.** Data is a runtime execution target, not a configuration preference. It must be passed via CLI (`--data`) or implicitly assumed to be CWD if not provided (though explicit is preferred). This prevents accidental execution against the wrong target directory.

**Q: How do boolean flags work in CLI vs JSON?**
**A:**
*   JSON: `"autostart": false`
*   CLI: `--no-autostart` (Sets `autostart: false`)
*   CLI: `--autostart` (Sets `autostart: true`)
The CLI parser must map `--no-X` to `{ X: false }`.

**Q: What happens to the `.hankweave` folder location?**
**A:** It continues to live inside the **Execution Directory** (the isolated temp folder), NOT the User's CWD. This ensures the runtime artifacts (logs, history) are bound to the specific execution instance, not the config file location.