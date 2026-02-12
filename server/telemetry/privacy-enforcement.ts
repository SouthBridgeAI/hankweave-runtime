/**
 * Type-Safe Privacy Enforcement (Spec Part 0)
 *
 * When someone adds a field to Codon, Loop, or Run, TypeScript will fail
 * until they add it to the corresponding privacy map below.
 *
 * Each field must be explicitly marked with how it's handled for telemetry.
 */

import type { Codon, Loop } from "../config.js";
import type { Run } from "../types/state-types.js";

// =============================================================================
// Privacy handling categories
// =============================================================================

type PrivacyHandling =
  | "include" // Include as-is (safe data like model names)
  | "hash" // SHA256 hash (for IDs we want to correlate)
  | "length" // Replace with character count
  | "count" // Replace with item count
  | "count_and_size" // Replace with count + byte size
  | "type_only" // Keep type/enum, drop details
  | "exclude" // Don't include at all
  | "nested"; // Has its own privacy-preserving version

// =============================================================================
// Codon Privacy Map
// =============================================================================

/**
 * Every field on the Codon type must appear here.
 * If you add a field to Codon and forget to add it here, this file won't compile.
 */
type CodonPrivacyMap = {
  [K in keyof Codon]: PrivacyHandling;
};

const _codonPrivacyMap: CodonPrivacyMap = {
  type: "include",
  id: "hash",
  name: "exclude",
  model: "include",
  continuationMode: "include",
  promptText: "length",
  promptFile: "count_and_size",
  appendSystemPromptText: "length",
  appendSystemPromptFile: "count_and_size",
  description: "length",
  checkpointedFiles: "count",
  env: "count",
  rigSetup: "nested",
  sentinels: "nested",
  outputFiles: "count",
  archiveOnSuccess: "count",
  onFailure: "include",
  retryConfig: "include",
  exhaustWithPrompt: "length",
  maxExtensions: "include",
};

// Compile-time check: every Codon field must be in the map
type _AssertAllCodonFieldsHandled = Exclude<
  keyof Codon,
  keyof typeof _codonPrivacyMap
> extends never
  ? true
  : [
      "ERROR: Unhandled codon field - add to _codonPrivacyMap",
      Exclude<keyof Codon, keyof typeof _codonPrivacyMap>,
    ];

// This line fails to compile if a Codon field is missing from the map
const _codonCheck: _AssertAllCodonFieldsHandled = true;

// =============================================================================
// Loop Privacy Map
// =============================================================================

type LoopPrivacyMap = {
  [K in keyof Loop]: PrivacyHandling;
};

const _loopPrivacyMap: LoopPrivacyMap = {
  type: "include",
  id: "hash",
  name: "exclude",
  description: "length",
  terminateOn: "include",
  codons: "nested",
  archiveOnSuccess: "count",
};

type _AssertAllLoopFieldsHandled = Exclude<keyof Loop, keyof typeof _loopPrivacyMap> extends never
  ? true
  : [
      "ERROR: Unhandled loop field - add to _loopPrivacyMap",
      Exclude<keyof Loop, keyof typeof _loopPrivacyMap>,
    ];

const _loopCheck: _AssertAllLoopFieldsHandled = true;

// =============================================================================
// Run Privacy Map
// =============================================================================

type RunPrivacyMap = {
  [K in keyof Run]: PrivacyHandling;
};

const _runPrivacyMap: RunPrivacyMap = {
  runId: "hash",
  runFolder: "exclude",
  gitBranch: "exclude",
  startingConditions: "nested",
  codons: "nested",
  status: "include",
  startTime: "include",
  endTime: "include",
  serverPid: "exclude",
};

type _AssertAllRunFieldsHandled = Exclude<keyof Run, keyof typeof _runPrivacyMap> extends never
  ? true
  : [
      "ERROR: Unhandled run field - add to _runPrivacyMap",
      Exclude<keyof Run, keyof typeof _runPrivacyMap>,
    ];

const _runCheck: _AssertAllRunFieldsHandled = true;

// =============================================================================
// Suppress unused variable warnings (these exist only for compile-time checks)
// =============================================================================

void _codonCheck;
void _loopCheck;
void _runCheck;
void _codonPrivacyMap;
void _loopPrivacyMap;
void _runPrivacyMap;
