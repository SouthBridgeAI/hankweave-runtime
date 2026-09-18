import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ExtractionOutcome, resolveBundleHank } from "./bundle-resolver.js";
import type { ParsedCliArgs } from "./cli-parser.js";
import { ExecutionLayout } from "./execution-layout.js";
import {
  displayHankSummary,
  getHankSummary,
  isRemoteHankUrl,
  resolveRemoteHank,
} from "./remote-hank.js";
import { isBundlePath } from "./utils.js";

/** Startup policy resolved once for validation and execution to consume alike. */
export interface StartupSource {
  dataPath: string;
  inputSourceType: "inline-text" | "stdin" | "path";
  hank: {
    /** Absolute local config path, including for remote and bundled sources. */
    configPath: string;
    /** Original URL or bundle filename for CLI output. */
    displayPath?: string;
    /** Keep verified config bytes intact, including metadata-based replay. */
    skipSchemaRewrite: boolean;
    executionMetadata: {
      bundleHash?: string;
      bundlePath?: string;
    };
  };
}

type CliArgs = ParsedCliArgs;
type InputSourceType = StartupSource["inputSourceType"];

/**
 * A source the user named could not be loaded — piped input missing, a
 * remote hank that would not clone, a bundle that failed verification. The
 * message is complete and user-facing; the CLI prints it without a stack.
 * Anything else escaping resolveStartupSource is a bug and keeps its trace.
 */
export class StartupSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StartupSourceError";
  }
}

/**
 * Read content from stdin.
 * Throws if stdin is a TTY (no piped input).
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new StartupSourceError(
      'No input provided on stdin. Use: echo "text" | hankweave hank.json -',
    );
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Get a stable, content-based file path for inline/stdin input.
 * This ensures the same input content produces the same data hash across runs,
 * enabling proper resume functionality with --execution.
 *
 * The path is deterministic based on content hash, stored in ~/.hankweave-cache/inputs/
 * to persist across runs. If the file already exists, we reuse it (preserving mtime)
 * which keeps the data hash stable.
 */
async function getStableInputPath(content: string, type: "input" | "stdin"): Promise<string> {
  const contentHash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  const cacheDir = path.join(os.homedir(), ".hankweave-cache", "inputs");

  // Ensure cache directory exists
  await fs.promises.mkdir(cacheDir, { recursive: true });

  const filePath = path.join(cacheDir, `${type}-${contentHash}.txt`);

  // Only write if file doesn't exist (preserves mtime for stable hashing)
  if (!fs.existsSync(filePath)) {
    await fs.promises.writeFile(filePath, content);
  }

  return filePath;
}

function readResumedDataPath(execMetaPath: string, resolvedDataPath: string): string {
  try {
    const execMeta = JSON.parse(fs.readFileSync(execMetaPath, "utf-8"));
    if (execMeta.readOnlySourceDataPath && fs.existsSync(execMeta.readOnlySourceDataPath)) {
      resolvedDataPath = execMeta.readOnlySourceDataPath;
      console.log(`> Using data source from execution metadata: ${resolvedDataPath}`);
    }
  } catch {
    // Non-fatal — fall through to CWD-based resolution
  }
  return resolvedDataPath;
}

function resolveResumedDataPath(
  executionPath: string | undefined,
  resolvedDataPath: string,
): string {
  if (!executionPath) return resolvedDataPath;
  const execMetaPath = new ExecutionLayout(path.resolve(executionPath)).metaPath;
  if (!fs.existsSync(execMetaPath)) return resolvedDataPath;
  return readResumedDataPath(execMetaPath, resolvedDataPath);
}

type ResolvedInput = { resolvedDataPath: string; inputSourceType: InputSourceType };

async function resolveStdinInput(): Promise<ResolvedInput> {
  const stdinContent = await readStdin();
  // Use stable content-based paths for consistent data hashing across runs.
  const resolvedDataPath = await getStableInputPath(stdinContent, "stdin");
  console.log(`> Using stdin input (${stdinContent.length} chars)`);
  return { resolvedDataPath, inputSourceType: "stdin" };
}

function resolvePathInput(
  dataSourcePath: string | undefined,
  executionPath: string | undefined,
  originalCwd: string,
): ResolvedInput {
  let resolvedDataPath = path.resolve(originalCwd, dataSourcePath || ".");
  if (!dataSourcePath)
    resolvedDataPath = resolveResumedDataPath(
      executionPath ? path.resolve(originalCwd, executionPath) : undefined,
      resolvedDataPath,
    );
  return { resolvedDataPath, inputSourceType: "path" };
}

async function resolveInput(cliArgs: CliArgs, originalCwd: string): Promise<ResolvedInput> {
  const dataSourcePath = cliArgs.dataPath || cliArgs.dataFlag;
  const inlineInput = cliArgs.inputText;
  if (inlineInput) {
    // Inline text provided via --input
    // Use stable content-based path for consistent data hashing across runs
    const resolvedDataPath = await getStableInputPath(inlineInput, "input");
    console.log(`> Using inline text input (${inlineInput.length} chars)`);
    return { resolvedDataPath, inputSourceType: "inline-text" };
  }
  if (dataSourcePath === "-") return resolveStdinInput();
  return resolvePathInput(dataSourcePath, cliArgs.executionPath, originalCwd);
}

async function resolveHankDirectory(
  resolvedConfigPath: string,
  originalCwd: string,
): Promise<string> {
  const absolutePath = path.isAbsolute(resolvedConfigPath)
    ? resolvedConfigPath
    : path.resolve(originalCwd, resolvedConfigPath);
  try {
    const stats = await fs.promises.stat(absolutePath);
    if (stats.isDirectory()) {
      resolvedConfigPath = path.join(absolutePath, "hank.json");
      console.log(`> Using hank.json from directory: ${resolvedConfigPath}`);
    }
  } catch {
    // Path doesn't exist yet, let it fail later with proper error message
  }
  return resolvedConfigPath;
}

async function resolveExplicitHankPath(
  resolvedConfigPath: string | undefined,
  originalCwd: string,
): Promise<string | undefined> {
  if (!resolvedConfigPath || isRemoteHankUrl(resolvedConfigPath)) return resolvedConfigPath;
  return resolveHankDirectory(resolvedConfigPath, originalCwd);
}

async function findDataHank(resolvedDataPath: string): Promise<string | undefined> {
  try {
    const stats = await fs.promises.stat(resolvedDataPath);
    if (stats.isDirectory()) {
      const potentialConfig = path.join(resolvedDataPath, "hank.json");
      if (fs.existsSync(potentialConfig)) {
        console.log(`> Found hank.json in data directory: ${potentialConfig}`);
        return potentialConfig;
      }
    }
  } catch {
    // Path doesn't exist or can't be accessed, continue with default
  }
  return undefined;
}

async function discoverHankPath(
  resolvedConfigPath: string | undefined,
  resolvedDataPath: string,
  inputSourceType: InputSourceType,
): Promise<string | undefined> {
  if (!resolvedConfigPath && resolvedDataPath && inputSourceType === "path") {
    return findDataHank(resolvedDataPath);
  }
  return resolvedConfigPath;
}

type BundleContext = { bundleHash: string; bundlePath?: string; displayPath?: string };
type ReplayMetadata = {
  hankPath?: string;
  readOnlySourceDataPath?: string;
  bundleHash?: string;
  bundlePath?: string;
};

function readReplayMetadata(replayDir: string | undefined): ReplayMetadata | undefined {
  if (!replayDir) return undefined;
  const replayMetaPath = new ExecutionLayout(path.resolve(replayDir)).metaPath;
  if (!fs.existsSync(replayMetaPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(replayMetaPath, "utf-8"));
  } catch {
    // Non-fatal — explicit --config and --data still work.
    return undefined;
  }
}

function replayHankPath(
  resolvedConfigPath: string | undefined,
  replayMeta: ReplayMetadata,
): string | undefined {
  if (!resolvedConfigPath && replayMeta.hankPath) {
    console.log(`[REPLAY] Using hank config from execution metadata: ${replayMeta.hankPath}`);
    return replayMeta.hankPath;
  }
  return resolvedConfigPath;
}

function replayDataPath(
  cliArgs: CliArgs,
  resolvedDataPath: string,
  replayMeta: ReplayMetadata,
): string {
  const explicitInput = [cliArgs.dataPath, cliArgs.dataFlag, cliArgs.inputText].some(Boolean);
  if (!explicitInput && replayMeta.readOnlySourceDataPath) {
    console.log(
      `[REPLAY] Using data source from execution metadata: ${replayMeta.readOnlySourceDataPath}`,
    );
    return replayMeta.readOnlySourceDataPath;
  }
  return resolvedDataPath;
}

function replayBundleContext(meta: ReplayMetadata | undefined): BundleContext | undefined {
  if (!meta?.hankPath || !meta.bundleHash) return undefined;
  return { bundleHash: meta.bundleHash, bundlePath: meta.bundlePath, displayPath: meta.bundlePath };
}

function resolveReplayPaths(
  cliArgs: CliArgs,
  resolvedConfigPath: string | undefined,
  resolvedDataPath: string,
  originalCwd: string,
) {
  // Replay metadata supplies paths only when the caller did not provide them.
  const replayMeta = readReplayMetadata(
    cliArgs.replayDir ? path.resolve(originalCwd, cliArgs.replayDir) : undefined,
  );
  const bundle = resolvedConfigPath ? undefined : replayBundleContext(replayMeta);
  if (replayMeta) {
    resolvedConfigPath = replayHankPath(resolvedConfigPath, replayMeta);
    resolvedDataPath = replayDataPath(cliArgs, resolvedDataPath, replayMeta);
  }
  return { resolvedConfigPath, resolvedDataPath, bundle };
}

async function fetchRemoteHank(configPath: string): Promise<string> {
  console.log(`\n> Fetching remote hank: ${configPath}`);

  try {
    const cached = await resolveRemoteHank(configPath);
    const absoluteConfigPath = cached.hankPath;

    if (cached.wasFresh) {
      console.log(`  > Using cached version (fetched ${cached.cachedAt.toLocaleString()})`);
    } else {
      console.log(`  ✓ Cloned to cache`);
    }

    // Show hank summary (no confirmation needed - "power user" model)
    // Use resolvedRef from the cache result (handles slashed branch names correctly)
    const displayRef =
      cached.resolvedRef ??
      (await import("./remote-hank.js").then((m) => m.parseRemoteHankUrl(configPath))).ref;
    const summary = getHankSummary(absoluteConfigPath, configPath, displayRef);
    displayHankSummary(summary);
    return absoluteConfigPath;
  } catch (error) {
    throw new StartupSourceError(`Failed to fetch remote hank: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

function describeExtraction(outcome: ExtractionOutcome): string {
  switch (outcome) {
    case "reused":
      return "Reusing verified extraction";
    case "repaired":
      return "Re-extracted (previous extraction did not match the bundle)";
    default:
      return "Extracted to";
  }
}

async function loadBundleHank(bundlePath: string, displayPath: string) {
  console.log(`\n> Loading bundle: ${displayPath}`);
  const resolved = await resolveBundleHank(bundlePath).catch((error: unknown) => {
    throw new StartupSourceError((error as Error).message, { cause: error });
  });
  console.log(
    `  ✓ Verified ${Object.keys(resolved.lock.files).length} files against hank.lock (bundleHash ${resolved.bundleHash.slice(0, 8)}…)`,
  );
  console.log(`  ✓ ${describeExtraction(resolved.extraction)}: ${resolved.hankDir}`);
  displayHankSummary(
    getHankSummary(resolved.hankPath, displayPath, resolved.lock.version),
    "Bundle Hank",
  );
  return {
    absoluteConfigPath: resolved.hankPath,
    bundle: { bundleHash: resolved.bundleHash, bundlePath: resolved.bundlePath, displayPath },
  };
}

async function resolveAbsoluteHankPath(
  configPath: string,
  originalCwd: string,
): Promise<{ absoluteConfigPath: string; bundle?: BundleContext }> {
  if (isRemoteHankUrl(configPath)) return { absoluteConfigPath: await fetchRemoteHank(configPath) };
  if (isBundlePath(configPath))
    return loadBundleHank(path.resolve(originalCwd, configPath), configPath);
  return { absoluteConfigPath: path.resolve(originalCwd, configPath) };
}

/**
 * Select input and hank before any execution-directory chdir or config rewriting.
 * Preserve precedence: explicit hank, discovery in input, replay metadata, default.
 * Bundle extractions are content-addressed and retained so resume and replay find the recorded path.
 * Throws StartupSourceError when a named source cannot be loaded; the CLI owns exit behavior.
 */
export async function resolveStartupSource(
  cliArgs: ParsedCliArgs,
  originalCwd: string,
): Promise<StartupSource> {
  const input = await resolveInput(cliArgs, originalCwd);
  const explicitPath = await resolveExplicitHankPath(
    cliArgs.hankPath || cliArgs.configPath,
    originalCwd,
  );
  const discoveredPath = await discoverHankPath(
    explicitPath,
    input.resolvedDataPath,
    input.inputSourceType,
  );
  const replay = resolveReplayPaths(cliArgs, discoveredPath, input.resolvedDataPath, originalCwd);
  const configPath = replay.resolvedConfigPath || "hank.json";
  const resolved = await resolveAbsoluteHankPath(configPath, originalCwd);
  const bundle = resolved.bundle ?? replay.bundle;
  return {
    dataPath: replay.resolvedDataPath,
    inputSourceType: input.inputSourceType,
    hank: {
      configPath: resolved.absoluteConfigPath,
      displayPath: bundle?.displayPath ?? (isRemoteHankUrl(configPath) ? configPath : undefined),
      skipSchemaRewrite: bundle !== undefined,
      executionMetadata: bundle
        ? { bundleHash: bundle.bundleHash, bundlePath: bundle.bundlePath }
        : {},
    },
  };
}
