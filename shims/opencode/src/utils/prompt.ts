const INTERNAL_INSTRUCTIONS = [
  "Operate headlessly and do not ask the user for confirmation.",
  "Finish all explicit user-requested steps before ending the turn unless a real error prevents completion.",
  "If the user requested multiple ordered actions, do not stop after only a partial subset.",
  "Only use files and absolute paths inside the current working directory unless the user explicitly asks for an external path.",
];

export function buildInstructionFileContents(params: {
  cwd: string;
  appendSystemPrompt?: string;
}): string {
  const sections = [
    "# Instructions injected by opencode-shim",
    "",
    "## Internal runtime requirements",
    "",
    ...INTERNAL_INSTRUCTIONS.map((line) => `- ${line}`),
    `- Current working directory: ${params.cwd}`,
  ];

  if (params.appendSystemPrompt?.trim()) {
    sections.push(
      "",
      "## Additional caller-provided instruction",
      "",
      params.appendSystemPrompt.trim(),
      "",
      "Treat the caller-provided instruction above as higher priority than the user message.",
    );
  }

  return sections.join("\n");
}
