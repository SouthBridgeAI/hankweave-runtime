#!/usr/bin/env bun

/**
 * Verify models with real keys and propose model-overlay.json entries
 * (spec 70, "The verification loop"). The logic lives in
 * scripts/model-verification.ts.
 *
 * Usage:
 *   bun scripts/verify-models.ts anthropic/claude-haiku-4-5 openai/gpt-5.4-mini
 *   bun scripts/verify-models.ts --new                  # live models.dev vs the bundled snapshot
 *   bun scripts/verify-models.ts <ids…> --codon --json report.json
 *   bun scripts/verify-models.ts <ids…> --codon --write-overlay
 *   bun scripts/verify-models.ts <ids…> --context-probe # near-limit prompt: costs real money
 *   bun scripts/verify-models.ts --check-overlay path/to/model-overlay.json
 */

import { liveVerifyDeps, parseVerifyArgs, runVerifyModels } from "./model-verification";

process.exit(await runVerifyModels(parseVerifyArgs(process.argv.slice(2)), liveVerifyDeps()));
