export class CommandAnalyzer {
  private static readonly PATTERNS = {
    mkdir: /(?:mkdir|md)\s+(?:-[pm]\s+)?(.+)/,
    touch: /touch\s+(.+)/,
    npm: /npm\s+(install|init|create)/,
    yarn: /yarn\s+(install|init|create)/,
    pnpm: /pnpm\s+(install|init|create)/,
    bun: /bun\s+(install|init|create)/,
    git: /git\s+(init|clone)/,
    echo: /echo\s+.+\s*>\s*(.+)/,
    tee: /tee\s+(.+)/,
  };

  static analyze(command: string): string[] {
    const effects: string[] = [];
    const normalizedCmd = command.trim().toLowerCase();

    // Check for directory creation
    if (CommandAnalyzer.PATTERNS.mkdir.test(normalizedCmd)) {
      const match = normalizedCmd.match(CommandAnalyzer.PATTERNS.mkdir);
      if (match?.[1]) {
        effects.push(`May have created directory: ${match[1].trim()}`);
      }
    }

    // Check for file creation
    if (CommandAnalyzer.PATTERNS.touch.test(normalizedCmd)) {
      const match = normalizedCmd.match(CommandAnalyzer.PATTERNS.touch);
      if (match?.[1]) {
        effects.push(`May have created file: ${match[1].trim()}`);
      }
    }

    // Check for package managers
    if (CommandAnalyzer.PATTERNS.npm.test(normalizedCmd)) {
      effects.push("May have created node_modules/ and modified package-lock.json");
    }
    if (CommandAnalyzer.PATTERNS.yarn.test(normalizedCmd)) {
      effects.push("May have created node_modules/ and modified yarn.lock");
    }
    if (CommandAnalyzer.PATTERNS.pnpm.test(normalizedCmd)) {
      effects.push("May have created node_modules/ and modified pnpm-lock.yaml");
    }
    if (CommandAnalyzer.PATTERNS.bun.test(normalizedCmd)) {
      effects.push("May have created node_modules/ and modified bun.lockb");
    }

    // Check for git operations
    if (CommandAnalyzer.PATTERNS.git.test(normalizedCmd)) {
      effects.push("May have created .git/ directory");
    }

    // Check for file redirection
    if (
      CommandAnalyzer.PATTERNS.echo.test(normalizedCmd) ||
      CommandAnalyzer.PATTERNS.tee.test(normalizedCmd)
    ) {
      effects.push("May have created or modified files");
    }

    // Generic warning for complex commands
    if (
      normalizedCmd.includes("&&") ||
      normalizedCmd.includes("||") ||
      normalizedCmd.includes("|") ||
      normalizedCmd.includes(";")
    ) {
      effects.push("Complex command with multiple operations");
    }

    if (effects.length === 0) {
      effects.push("Unknown side effects");
    }

    return effects;
  }
}
