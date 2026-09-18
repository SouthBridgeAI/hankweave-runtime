/**
 * The HANKWEAVE_ environment overlay.
 *
 * A `HANKWEAVE_<NAME>` variable in the server's own environment is an
 * instruction for the environment codon agents run in: `HANKWEAVE_FOO=bar`
 * sets `FOO=bar` there, and the literal value "unset" removes `FOO`.
 * `HANKWEAVE_RUNTIME_*` (server config) and `HANKWEAVE_SENTINEL_*` (sentinel
 * API keys) belong to the server and are never passed through.
 *
 * Every consumer reads the overlay through {@link hankweaveEnvEntries} so the
 * prefix rules live in one place: the shim, pi and Claude Agent SDK process
 * managers, the `--validate` report, and the startup strip in index.ts.
 */

const HANKWEAVE_ENV_PREFIX = "HANKWEAVE_";

/** Server-owned namespaces under the prefix; never part of the overlay. */
const SERVER_OWNED_PREFIXES = ["HANKWEAVE_RUNTIME_", "HANKWEAVE_SENTINEL_"] as const;

/** The value that marks a variable for removal from the agent environment. */
export const HANKWEAVE_ENV_UNSET = "unset";

export interface HankweaveEnvEntry {
  /** Variable name with the HANKWEAVE_ prefix stripped. */
  name: string;
  /** Raw value; compare against {@link HANKWEAVE_ENV_UNSET} to detect removal. */
  value: string;
}

/**
 * Overlay entries present in `env` (the server's process.env by default), in
 * enumeration order, with the prefix stripped and server-owned names skipped.
 */
export function hankweaveEnvEntries(env: NodeJS.ProcessEnv = process.env): HankweaveEnvEntry[] {
  const entries: HankweaveEnvEntry[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(HANKWEAVE_ENV_PREFIX)) continue;
    if (SERVER_OWNED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (value === undefined) continue;
    entries.push({ name: key.slice(HANKWEAVE_ENV_PREFIX.length), value });
  }
  return entries;
}
