import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Fallback when AWS_REGION is unset — matches pi's and the Agent SDK's own default. */
export const BEDROCK_DEFAULT_REGION = "us-east-1";

/**
 * Keys whose presence marks a profile section as an actual credential source.
 * A section carrying only settings (region, output) selects no credentials —
 * the chain moves on and, off-cloud, fails at first invoke.
 */
const AWS_PROFILE_CREDENTIAL_KEYS = new Set([
  "aws_access_key_id",
  "aws_session_token",
  "credential_process",
  "credential_source",
  // `aws login` (browser sign-in) profiles carry only this selector; the
  // bundled AWS client resolves the cached login session from it.
  "login_session",
  "role_arn",
  "source_profile",
  "sso_session",
  "sso_start_url",
  "sso_account_id",
  "web_identity_token_file",
]);

/**
 * Whether any of `sectionNames` in the INI file at `filePath` carries one of
 * `keys`. Line-level scan, not a full INI parser: section headers and
 * `key = value` lines are all the detection needs.
 */
function profileHasKeys(
  filePath: string,
  sectionNames: string[],
  keys: ReadonlySet<string>,
): boolean {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return false;
  }
  let inTarget = false;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      inTarget = sectionNames.includes(line.slice(1, -1).trim());
      continue;
    }
    if (!inTarget || !line || line.startsWith("#") || line.startsWith(";")) continue;
    const key = line.split("=")[0]?.trim().toLowerCase();
    if (key && keys.has(key)) return true;
  }
  return false;
}

function profileHasCredentialKeys(filePath: string, sectionNames: string[]): boolean {
  return profileHasKeys(filePath, sectionNames, AWS_PROFILE_CREDENTIAL_KEYS);
}

/**
 * Whether any AWS credential *source* is visible: an explicit env credential,
 * container/web-identity creds, or a selected/default profile that actually
 * carries credential keys in the shared credentials/config files. File-backed
 * sources are inspected, not merely stat'd — a config file holding only a
 * region, or profiles unrelated to the selected one, is not a credential
 * source. Presence only — validity is proven at first invoke.
 *
 * Mirrors the Node SDK's default chain, which the Agent SDK child runs on:
 * with AWS_PROFILE set the SDK skips the env key pair entirely ("AWS_PROFILE
 * is set, skipping fromEnv provider"), so an env key pair must not satisfy
 * preflight that the child will never consult it.
 */
export function describeAmbientAwsCredentialSource(): string | null {
  const env = process.env;
  if (env.AWS_BEARER_TOKEN_BEDROCK) return "AWS_BEARER_TOKEN_BEDROCK";
  const credentialsFile =
    env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(os.homedir(), ".aws", "credentials");
  const configFile = env.AWS_CONFIG_FILE ?? path.join(os.homedir(), ".aws", "config");
  if (env.AWS_PROFILE) {
    // Credentials file sections are bare [name]; the config file spells named
    // profiles [profile name] (bare accepted too by some tools).
    if (
      profileHasCredentialKeys(credentialsFile, [env.AWS_PROFILE]) ||
      profileHasCredentialKeys(configFile, [`profile ${env.AWS_PROFILE}`, env.AWS_PROFILE])
    ) {
      return `AWS_PROFILE (${env.AWS_PROFILE})`;
    }
    // An unusable profile name doesn't stop the chain: it still consults the
    // container/web-identity/IMDS providers below and in the caller's probe —
    // but never fromEnv, so the key-pair check below stays profile-gated.
  } else if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return "AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY";
  }
  if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI) {
    return "ECS container credentials";
  }
  if (env.AWS_WEB_IDENTITY_TOKEN_FILE) return "web identity token (IRSA)";
  if (!env.AWS_PROFILE) {
    if (profileHasCredentialKeys(credentialsFile, ["default"])) {
      return `credentials file (${credentialsFile})`;
    }
    // A default profile can live only in the config file (SSO,
    // credential_process) with no credentials file at all.
    if (profileHasCredentialKeys(configFile, ["default"])) return `config file (${configFile})`;
  }
  return null;
}

const REGION_KEY = new Set(["region"]);

/**
 * Whether the default profile (no AWS_PROFILE selected) defines a region in
 * the shared config/credentials files. AWS region resolution is independent
 * of the credential source — the SDK reads [default]'s region even when
 * credentials come from an env key pair, ECS, or IMDS — so callers must not
 * pin a fallback region over it, since an env AWS_REGION would outrank it.
 */
export function defaultProfileDefinesRegion(): boolean {
  const env = process.env;
  const credentialsFile =
    env.AWS_SHARED_CREDENTIALS_FILE ?? path.join(os.homedir(), ".aws", "credentials");
  const configFile = env.AWS_CONFIG_FILE ?? path.join(os.homedir(), ".aws", "config");
  return (
    profileHasKeys(configFile, ["default"], REGION_KEY) ||
    profileHasKeys(credentialsFile, ["default"], REGION_KEY)
  );
}

/**
 * The subset of AWS credential sources expressible as plain env values:
 * bearer token or an explicit key pair. This is what the sentinel provider
 * registry checks — its Bedrock factory deliberately avoids
 * @aws-sdk/credential-providers (a ~6MB transitive tree) and signs with the
 * AI SDK's built-in aws4fetch path, which can only consume these two forms.
 * Profile/SSO, container, IRSA, and IMDS sources are codon-only (the Claude
 * Code and pi harnesses resolve those chains themselves).
 */
export function describeExplicitAwsEnvCredentialSource(): string | null {
  const env = process.env;
  if (env.AWS_BEARER_TOKEN_BEDROCK) return "AWS_BEARER_TOKEN_BEDROCK";
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return "AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY";
  }
  return null;
}

/**
 * The IMDS endpoint the standard SDK chain would use: an explicit
 * AWS_EC2_METADATA_SERVICE_ENDPOINT wins, else the endpoint-mode default —
 * IPv6 instances use http://[fd00:ec2::254] (the IPv4 link-local address is
 * unreachable there), everything else the classic IPv4 address.
 */
function instanceMetadataEndpoint(): string {
  const env = process.env;
  const explicit = env.AWS_EC2_METADATA_SERVICE_ENDPOINT;
  if (explicit) return explicit.replace(/\/+$/, "");
  const mode = (env.AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE ?? "").toLowerCase();
  return mode === "ipv6" ? "http://[fd00:ec2::254]" : "http://169.254.169.254";
}

/**
 * Last-resort probe for EC2/ECS instance-role credentials: the metadata
 * service is only reachable from inside AWS compute, so a fast IMDSv2
 * token request answering at all means the instance-role source exists.
 * The probe targets the same endpoint the SDK chain resolves (explicit
 * AWS_EC2_METADATA_SERVICE_ENDPOINT, IPv6 endpoint mode, or the classic
 * IPv4 address). Off-cloud the address is unroutable and this fails within
 * the timeout — only ever attempted when no static source was found, and
 * never when AWS_EC2_METADATA_DISABLED is set (which the e2e negative
 * control sets to keep instance roles from leaking into its isolation).
 */
export async function detectInstanceMetadataCredentials(timeoutMs = 500): Promise<boolean> {
  if ((process.env.AWS_EC2_METADATA_DISABLED ?? "").toLowerCase() === "true") return false;
  const endpoint = instanceMetadataEndpoint();
  try {
    const tokenResponse = await fetch(`${endpoint}/latest/api/token`, {
      method: "PUT",
      headers: { "x-aws-ec2-metadata-token-ttl-seconds": "60" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!tokenResponse.ok) return false;
    // A reachable IMDS proves we're on AWS compute, not that credentials
    // exist: with no IAM instance profile attached the token endpoint still
    // answers 200. Require an actual role listed under security-credentials —
    // an empty listing or 404 means startup must fail here, not at first
    // Bedrock invoke with a misleading "instance role" source.
    const token = await tokenResponse.text();
    const roleResponse = await fetch(`${endpoint}/latest/meta-data/iam/security-credentials/`, {
      headers: { "x-aws-ec2-metadata-token": token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!roleResponse.ok) return false;
    return (await roleResponse.text()).trim().length > 0;
  } catch {
    return false;
  }
}
