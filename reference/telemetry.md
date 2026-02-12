# Telemetry

Hankweave collects anonymous usage statistics to help improve the tool. **No personal information, file contents, or prompts are collected.**

## Opting Out

```bash
# Universal standard
export DO_NOT_TRACK=1

# Or Hankweave-specific
export HANKWEAVE_TELEMETRY=0

# Or in hankweave.json
# { "telemetry": { "enabled": false } }
```

Telemetry is automatically disabled in CI environments.

## What We Collect

We follow strict privacy principles:

| Rule             | Example                                |
| ---------------- | -------------------------------------- |
| Content → Size   | Prompt text → `{ length_chars: 4500 }` |
| Paths → Counts   | File paths → `{ pattern_count: 3 }`    |
| IDs → Hashes     | Codon IDs → SHA256 hash                |
| Messages → Types | Error messages → `{ type: "timeout" }` |
| Secrets → Counts | Env vars → `{ count: 2 }`              |

### What we collect

- **Hank structure** — How many codons, which models, whether you use loops/sentinels/rigs (never the actual content)
- **Run metrics** — Duration, cost, token counts, success/failure rates
- **Model usage** — Which models, token counts, cache hit rates, latency
- **Tool usage** — Which tools (Read, Edit, Bash), call counts, error rates
- **Error types** — Failure categories (timeout, rate-limit, etc.) without error messages
- **Environment** — OS, architecture, Hankweave version, Node version

### What we DO NOT collect

- Prompt text, system prompts, or any content
- File paths, directory structures, or project names
- Codon names, descriptions, or raw IDs
- Environment variable keys or values
- Error messages (only error type classifications)
- Rig setup commands
- Git branch names or commit messages
- API keys or secrets

## Debug Mode

To see exactly what would be sent:

```bash
export HANKWEAVE_TELEMETRY_DEBUG=1
hankweave run
```

Events are printed to the console and written to `~/.hankweave/telemetry-debug.jsonl`.

## User Identity

Each installation gets a random UUID stored at `~/.hankweave/telemetry.json`. This ID:

- Is completely random (not derived from system info)
- Cannot be linked to personal identity
- Persists across runs until manually deleted

To reset: `rm ~/.hankweave/telemetry.json`

## Configuration

| Variable                             | Effect                    |
| ------------------------------------ | ------------------------- |
| `DO_NOT_TRACK=1`                     | Disable telemetry         |
| `HANKWEAVE_TELEMETRY=0`              | Disable telemetry         |
| `HANKWEAVE_TELEMETRY_DEBUG=1`        | Print payloads to console |
| `HANKWEAVE_TELEMETRY_ENDPOINT=<url>` | Override endpoint         |

Or in `hankweave.json`:

```json
{
  "telemetry": {
    "enabled": false
  }
}
```

## First-Run Notice

On first run, Hankweave displays a one-time notice about telemetry collection. This notice appears even if telemetry is already disabled — transparency is the goal.

## For Developers

When adding a field to `Codon`, `Loop`, or `Run`, TypeScript will error until you add it to the privacy map in `server/telemetry/privacy-enforcement.ts`. This ensures every new field is explicitly classified as `include`, `hash`, `length`, `count`, `exclude`, or `nested`.
