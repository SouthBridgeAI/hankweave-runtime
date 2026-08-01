/**
 * Welcome Wizard
 *
 * The main orchestrator for the first-run wizard experience.
 * Triggered when a user runs `npx hankweave` with no arguments
 * and no hank.json in the current directory.
 *
 * Flow:
 * 1. Tesseract splash (animated) → Press Enter
 * 2. Environment check (spinner) → Results display
 * 3. Telemetry disclosure → opt-in/out confirm
 * 4. If nothing usable → show help links, explain what's needed, exit
 * 5. If ready → menu of next steps
 * 6. Execute chosen action → sign-off
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as p from "@clack/prompts";
import { initProject } from "../init-command.js";
import { hasNoticeBeenShown, markNoticeShown } from "../telemetry/telemetry-identity.js";
import {
  amber,
  amberBold,
  box,
  darkSlate,
  emerald,
  padVisible,
  sky,
  slate,
  tealBold,
  warmYellow,
  white,
  whiteBold,
} from "./colors.js";
import {
  checkEnvironment,
  type EnvironmentResult,
  getDemoModelChoice,
  validateApiCredits,
} from "./environment-check.js";
import { showTesseractSplash } from "./tesseract-splash.js";

// ── URL opener ────────────────────────────────────────────────

function openUrl(url: string): boolean {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" });
    } else if (platform === "linux") {
      execSync(`xdg-open "${url}"`, { stdio: "ignore" });
    } else if (platform === "win32") {
      execSync(`start "" "${url}"`, { stdio: "ignore" });
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ── Environment Display ───────────────────────────────────────

/** Column width for harness/key names in the environment panel. */
const NAME_COL = 22;

function displayEnvironmentResults(env: EnvironmentResult): void {
  const lines: string[] = [];

  // Harnesses section
  lines.push(slate("Harnesses"));
  for (const h of env.harnesses) {
    if (h.found) {
      const name = padVisible(white(h.name), NAME_COL);
      lines.push(`${emerald("✓")} ${name} ${slate(h.detail ?? "")}`);
    } else {
      const name = padVisible(slate(h.name), NAME_COL);
      const link = h.helpLink ? `  ${sky("→")} ${sky(h.helpLink)}` : "";
      lines.push(`${darkSlate("○")} ${name} ${slate(h.detail ?? "")}${link}`);
    }
  }

  lines.push("");

  // API Keys section
  lines.push(slate("API Keys"));
  for (const k of env.apiKeys) {
    if (k.found) {
      lines.push(`${emerald("✓")} ${white(k.envVar)}`);
    } else {
      const link = k.helpLink ? `  ${sky("→")} ${sky(k.helpLink)}` : "";
      lines.push(`${darkSlate("○")} ${slate(k.envVar)}${link}`);
    }
  }

  const panel = box(lines, { title: "Your Environment", padding: 2 });
  console.log(panel);
}

// ── Menu Options ──────────────────────────────────────────────

type WizardAction = "demo" | "init" | "docs" | "github" | "learn";

const DEMO_HANK_REPO = "https://github.com/SouthBridgeAI/demo-hank";
const DOCS_URL = "https://hankweave.southbridge.ai";
const GITHUB_URL = "https://github.com/SouthBridgeAI/hankweave-runtime";
const LEARN_MORE_URL = "https://southbridge.ai/hankweave";
const API_KEYS_HELP_URL = "https://hankweave.southbridge.ai/reference/api-keys-and-models/";
const TELEMETRY_DOCS_URL = "https://hankweave.southbridge.ai/reference/telemetry";

// ── Main Wizard Function ──────────────────────────────────────

export async function runWelcomeWizard(): Promise<void> {
  // Step 1: Tesseract splash
  await showTesseractSplash();

  // If non-TTY, the splash already printed static info - we're done
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    return;
  }

  // Step 2: Environment check
  p.intro("Welcome to Hankweave");

  const s = p.spinner();
  s.start("Checking your environment");

  // The actual checks are fast, but give the spinner a moment for visual effect
  const env = checkEnvironment();
  await new Promise((resolve) => setTimeout(resolve, 800));

  s.stop(amber("Environment checked"));

  // Step 3: Display results
  console.log("");
  displayEnvironmentResults(env);
  console.log("");

  // Step 4: Telemetry disclosure
  await handleTelemetryDisclosure();

  // Step 5: Handle "nothing usable" case
  if (!env.canRunHanks) {
    p.log.warn(
      [
        warmYellow("No agent harnesses are fully configured yet."),
        "",
        slate("You need either ") +
          white("Claude Code") +
          slate(" with an Anthropic API key, or an ") +
          white("OpenAI / Google API key") +
          slate(""),
        slate("for the embedded Pi agent, to run hanks."),
        "",
        slate("The quickest path: install ") +
          amberBold("Claude Code") +
          slate(" and set your ") +
          amberBold("Anthropic API key") +
          slate("."),
        "",
        `  ${amberBold("Learn how")}  ${sky(API_KEYS_HELP_URL)}`,
        "",
        slate("Once you're set up, run ") +
          amberBold(`${detectRunner()} hankweave`) +
          slate(" again."),
      ].join("\n"),
    );

    // Still offer some navigation options
    const action = await p.select<WizardAction>({
      message: "In the meantime, would you like to:",
      options: [
        {
          value: "init",
          label: "Initialize a new hank",
          hint: "explore the structure while you set up",
        },
        { value: "docs", label: "Open the docs" },
        { value: "github", label: "Open the GitHub repo" },
        { value: "learn", label: "Learn more about Hankweave" },
      ],
    });

    if (p.isCancel(action)) {
      p.cancel("See you next time!");
      return;
    }

    await handleAction(action, env);
    return;
  }

  // Step 6: Show summary and menu for users who CAN run hanks
  // Color the provider names in the summary
  const coloredSummary = env.summary
    .replace(/Claude/g, tealBold("Claude"))
    .replace(/Codex/g, tealBold("Codex"))
    .replace(/Gemini/g, tealBold("Gemini"));
  p.log.success(coloredSummary);

  const action = await p.select<WizardAction>({
    message: "What would you like to do?",
    options: [
      {
        value: "demo",
        label: "Try the demo hank",
        hint: "recommended",
      },
      { value: "init", label: "Initialize a new hank" },
      { value: "docs", label: "Open the docs" },
      { value: "github", label: "Open the GitHub repo" },
      { value: "learn", label: "Learn more about Hankweave" },
    ],
  });

  if (p.isCancel(action)) {
    p.cancel("See you next time!");
    return;
  }

  await handleAction(action, env);
}

// ── Telemetry Disclosure ──────────────────────────────────────

/**
 * Show telemetry disclosure and let the user opt out.
 * Only shown once - if the first-run notice has already been shown
 * (from a previous non-wizard run), we skip this.
 */
async function handleTelemetryDisclosure(): Promise<void> {
  // Check if they've already seen the telemetry notice
  const alreadySeen = await hasNoticeBeenShown();
  if (alreadySeen) return;

  // Check if telemetry is already disabled via env
  if (process.env.DO_NOT_TRACK === "1" || process.env.HANKWEAVE_TELEMETRY === "0") {
    // They've already opted out - just mark as seen
    await markNoticeShown();
    return;
  }

  p.log.message(
    [
      amberBold("Telemetry"),
      "",
      slate("Hankweave collects anonymous usage statistics to help improve the tool."),
      slate("No personal information, file contents, or prompts are ever collected."),
      "",
      `${slate("Learn more")} ${sky("→")} ${sky(TELEMETRY_DOCS_URL)}`,
    ].join("\n"),
  );

  const telemetryOk = await p.confirm({
    message: "Allow anonymous telemetry?",
    initialValue: true,
  });

  if (p.isCancel(telemetryOk)) {
    // Ctrl+C during telemetry prompt - treat as opt-out, but don't exit
    process.env.DO_NOT_TRACK = "1";
    await markNoticeShown();
    return;
  }

  if (!telemetryOk) {
    // Set for this process
    process.env.DO_NOT_TRACK = "1";

    p.log.message(
      [
        slate("Telemetry disabled for this session."),
        "",
        slate("To disable permanently, add to your shell profile:"),
        `  ${amberBold("export DO_NOT_TRACK=1")}`,
      ].join("\n"),
    );
  }

  // Mark the first-run notice as shown so they don't see the separate notice later
  await markNoticeShown();
}

// ── Action Handlers ───────────────────────────────────────────

async function handleAction(action: WizardAction, env: EnvironmentResult): Promise<void> {
  switch (action) {
    case "demo":
      await handleDemo(env);
      break;
    case "init":
      await handleInit();
      break;
    case "docs":
      handleOpenUrl("Opening docs...", DOCS_URL);
      break;
    case "github":
      handleOpenUrl("Opening GitHub...", GITHUB_URL);
      break;
    case "learn":
      handleOpenUrl("Opening Hankweave page...", LEARN_MORE_URL);
      break;
  }
}

// ── Path Helpers ──────────────────────────────────────────────

/**
 * Resolve ~ to the user's home directory.
 */
function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Get the default Downloads folder for the current platform.
 * Returns the path if it exists, otherwise falls back to home directory.
 */
function getDefaultDataFolder(): string {
  const home = os.homedir();
  const downloads = path.join(home, "Downloads");

  // Check common locations - Downloads exists on macOS, Windows, and most Linux desktops
  if (fs.existsSync(downloads)) {
    return downloads;
  }

  return home;
}

/**
 * Shorten a path for display (replace home dir with ~).
 */
function shortenPath(fullPath: string): string {
  const home = os.homedir();
  if (fullPath.startsWith(home)) {
    return `~${fullPath.slice(home.length)}`;
  }
  return fullPath;
}

// ── Demo Hank Handler ─────────────────────────────────────────

async function handleDemo(env: EnvironmentResult): Promise<void> {
  // Determine which model/provider to use based on available credentials
  const modelChoice = getDemoModelChoice(env);

  if (!modelChoice) {
    // This shouldn't happen (canRunHanks should be false), but handle gracefully
    p.log.error("No configured provider available to run the demo.");
    return;
  }

  const defaultFolder = getDefaultDataFolder();
  const defaultDisplay = shortenPath(defaultFolder);

  // Describe what the demo does — adapt messaging to the provider
  const modelDisplay = modelChoice.modelOverride
    ? tealBold(modelChoice.modelOverride)
    : tealBold("Claude Haiku");
  const providerDisplay = tealBold(modelChoice.providerName);

  p.log.message(
    [
      `${white("The demo hank is a fun, multi-codon workflow that analyzes a folder")}`,
      `${white("of your choosing and builds an interactive HTML page from what it finds.")}`,
      "",
      `${white("It runs on")} ${modelDisplay} ${white("via")} ${providerDisplay} ${white("— and")}`,
      `${white("is meant as a lighthearted way to see Hankweave in action.")}`,
    ].join("\n"),
  );

  // Time and cost expectations
  const apiName = modelChoice.providerName;
  p.log.warn(
    [
      `${warmYellow("Heads up:")} ${slate(`this is a real agentic run that calls the ${apiName} API.`)}`,
      "",
      `  ${slate("Typical time:")}  ${whiteBold("5–10 minutes")}`,
      `  ${slate("Typical cost:")}  ${whiteBold("~$0.50–1.00")}`,
      "",
      `${slate("You're welcome to inspect the hank before running:")}`,
      `  ${sky(DEMO_HANK_REPO)}`,
    ].join("\n"),
  );

  // Credit validation — make a lightweight API call to catch bad keys / no credits early
  const creditSpinner = p.spinner();
  creditSpinner.start(`Verifying ${apiName} API credentials`);

  const creditResult = await validateApiCredits(modelChoice.provider);

  if (!creditResult.valid) {
    creditSpinner.stop(amber(`${apiName} API check failed`));
    p.log.error(
      [
        `${warmYellow("Your API key didn't work.")}`,
        "",
        slate(creditResult.error || "Unknown error"),
        "",
        slate("Please check your API key and billing settings, then try again."),
        `  ${sky(API_KEYS_HELP_URL)}`,
      ].join("\n"),
    );
    return;
  }

  creditSpinner.stop(emerald(`${apiName} credentials verified`));

  const dataFolder = await p.text({
    message: "Data folder to analyze?",
    placeholder: defaultDisplay,
    defaultValue: defaultDisplay,
  });

  if (p.isCancel(dataFolder)) {
    p.cancel("See you next time!");
    return;
  }

  // Resolve the path: expand ~ and make absolute
  const resolvedFolder = path.resolve(expandTilde(dataFolder));

  // Check for prior completed runs — if the user already ran the demo with this data
  // folder, the execution system will try to resume the completed run and immediately exit.
  // Detect this and offer to start fresh with -n.
  let startNew = false;
  try {
    const { hashDataSource, findExecutionDirs } = await import("../data-hasher.js");
    if (fs.existsSync(resolvedFolder)) {
      const dataHash = await hashDataSource(resolvedFolder);
      const existingDirs = await findExecutionDirs(dataHash);

      if (existingDirs.length > 0) {
        const statePath = path.join(existingDirs[0], ".hankweave", "state.json");
        if (fs.existsSync(statePath)) {
          const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
          const latestRun = state.runs?.[0];

          if (latestRun?.status === "completed") {
            const freshStart = await p.confirm({
              message: "You've run this demo before with this folder. Start fresh?",
              initialValue: true,
            });

            if (p.isCancel(freshStart)) {
              p.cancel("See you next time!");
              return;
            }
            startNew = freshStart === true;
          }
        }
      }
    }
  } catch {
    // If anything fails (missing files, permissions, etc.), just proceed normally.
    // The execution system will handle it.
  }

  // Output directory: copy results to cwd so the user can find them easily
  const outputDir = path.resolve("hankweave-demo-output");

  // Build the command — include -m flag if using a non-Claude provider, -n if starting fresh
  const runner = detectRunner();
  const newFlag = startNew ? " -n" : "";
  const modelFlag = modelChoice.modelOverride ? ` -m ${modelChoice.modelOverride}` : "";
  const displayCommand = `${runner} hankweave ${DEMO_HANK_REPO} ${dataFolder}${newFlag}${modelFlag} -o ${outputDir}`;

  p.note(
    [
      amberBold(displayCommand),
      "",
      slate("The TUI will show you progress in real-time."),
      slate("When it finishes, outputs will be copied to:"),
      `  ${whiteBold(`${outputDir}/`)}`,
    ].join("\n"),
    amber("We'll run this"),
  );

  const shouldRun = await p.confirm({
    message: "Run it now?",
    initialValue: true,
  });

  if (p.isCancel(shouldRun) || !shouldRun) {
    p.log.message(slate("No worries — copy the command above and run it whenever you're ready."));
    showSignoff();
    return;
  }

  showSignoff();

  // Build spawn args — include -m flag if using a non-Claude provider
  const spawnArgs = [process.argv[1], DEMO_HANK_REPO, resolvedFolder];
  if (startNew) {
    spawnArgs.push("-n"); // Start new execution instead of resuming completed run
  }
  if (modelChoice.modelOverride) {
    spawnArgs.push("-m", modelChoice.modelOverride);
  }
  spawnArgs.push("-o", outputDir);

  // Re-invoke ourselves with the demo hank args + output flag + model override
  // Use process.argv[0] (runtime) and process.argv[1] (script) to stay portable
  const child = spawn(process.argv[0], spawnArgs, {
    stdio: "inherit",
    env: process.env,
  });

  await waitForChild(child);
}

// ── Init Handler ──────────────────────────────────────────────

async function handleInit(): Promise<void> {
  const targetDir = await p.text({
    message: "Where should we create it?",
    placeholder: "./my-first-hank",
    defaultValue: "./my-first-hank",
  });

  if (p.isCancel(targetDir)) {
    p.cancel("See you next time!");
    return;
  }

  const resolvedDir = path.resolve(targetDir);
  const dirName = path.basename(resolvedDir);

  // Show what we'll do and confirm
  p.log.message(
    [
      `${white("We'll create a starter hank in")} ${amberBold(targetDir)} ${white("with:")}`,
      "",
      `  ${darkSlate("├─")} ${whiteBold("hank.json")}           ${slate("← your workflow definition")}`,
      `  ${darkSlate("├─")} ${whiteBold("prompts/")}            ${slate("← prompt files for each codon")}`,
      `  ${darkSlate("├─")} ${whiteBold("data/")}               ${slate("← sample data files")}`,
      `  ${darkSlate("├─")} ${whiteBold("README.md")}`,
      `  ${darkSlate("└─")} ${whiteBold(".gitignore")}`,
    ].join("\n"),
  );

  const shouldCreate = await p.confirm({
    message: `Create ${dirName}?`,
    initialValue: true,
  });

  if (p.isCancel(shouldCreate) || !shouldCreate) {
    p.cancel("See you next time!");
    return;
  }

  const s = p.spinner();
  s.start("Creating hank");

  try {
    // Suppress initProject's own console.log output
    const originalLog = console.log;
    console.log = () => {};
    await initProject(resolvedDir);
    console.log = originalLog;

    s.stop("Created!");
  } catch (error) {
    s.stop("Failed");
    p.log.error(`Init failed: ${(error as Error).message}`);
    showSignoff();
    return;
  }

  // Detect how they're running hankweave
  const runner = detectRunner();

  p.note(
    [
      tealBold(`cd ${dirName}`),
      slate("# edit hank.json and prompts to your liking, then:"),
      amberBold(`${runner} hankweave`),
    ].join("\n"),
    amber("Next steps"),
  );

  p.log.message(
    `${slate("Learn more about hanks")} ${sky("→")} ${sky("https://hankweave.southbridge.ai/guides/building-a-hank")}`,
  );

  showSignoff();
}

// ── URL Open Handler ──────────────────────────────────────────

function handleOpenUrl(message: string, url: string): void {
  const opened = openUrl(url);
  if (opened) {
    p.log.success(message);
  } else {
    p.log.message(`${sky("→")} ${sky(url)}`);
  }
  showSignoff();
}

// ── Sign-off ──────────────────────────────────────────────────

function showSignoff(): void {
  p.outro([amberBold("Happy hankweaving! Starting hankweave runtime...")].join("\n"));
}

// ── Runner Detection ──────────────────────────────────────────

/**
 * Detect whether the user is running via npx, bunx, or directly.
 * Used to suggest the right command in output.
 */
function detectRunner(): string {
  // Check if running under bun
  if (process.versions.bun) {
    return "bunx";
  }

  // Check npm_execpath for npx
  const execPath = process.env.npm_execpath || "";
  if (execPath.includes("npx") || process.env.npm_command === "exec") {
    return "npx";
  }

  // Default to npx (most common for first-time users)
  return "npx";
}

// ── Child Process Helper ──────────────────────────────────────

/**
 * Wait for a spawned child process to exit.
 * Propagates the exit code to this process.
 */
function waitForChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.on("close", (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
    child.on("error", (err) => {
      console.error(`Failed to start: ${err.message}`);
      process.exitCode = 1;
      resolve();
    });
  });
}
