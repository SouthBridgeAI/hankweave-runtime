export function buildGeminiPrompt(prompt: string, appendSystemPrompt?: string): string {
  const internalInstructions = [
    "You are running behind a machine-oriented shim.",
    "Answer directly from the conversation context and tool results whenever possible.",
    "If the user explicitly asks you to create, update, or maintain a file, do that with tools before ending the turn.",
    "When the user gives a numbered or ordered task list, complete every requested step in sequence before finishing.",
    "Do not stop after an intermediate answer if additional requested steps remain.",
    "If the user asks for ongoing research notes or a progress file, keep that file updated as you work.",
    "If the user asks for research, use the available search/web/file tools rather than answering from memory alone whenever the request calls for current sources.",
    "When creating machine-readable files such as JSON, ensure the final file contents are syntactically valid before ending the turn.",
    "Do not delegate to CLI help, documentation helpers, or other subagents unless the user explicitly asks about Gemini CLI usage or external documentation.",
    "If the user asks what they told you earlier in this same conversation, answer from the conversation history directly.",
  ].join(" ");

  if (!appendSystemPrompt?.trim()) {
    return [
      "SYSTEM INSTRUCTIONS (highest priority for this run):",
      internalInstructions,
      "",
      "USER PROMPT:",
      prompt,
    ].join("\n");
  }

  return [
    "SYSTEM INSTRUCTIONS (highest priority for this run):",
    internalInstructions,
    "",
    "ADDITIONAL CALLER SYSTEM INSTRUCTIONS:",
    appendSystemPrompt.trim(),
    "",
    "USER PROMPT:",
    prompt,
  ].join("\n");
}

export function buildSilentTurnRecoveryPrompt(): string {
  return [
    "System: Your previous turn produced no assistant-visible text, tool calls, or tool results.",
    "Continue the pending user request now.",
    "You must either produce assistant text or use tools to complete the requested work before ending the turn.",
    "Do not end with an empty response.",
  ].join(" ");
}

export function buildRemainingStepsPrompt(): string {
  return [
    "System: Re-check the user's original numbered task list.",
    "If any requested numbered steps are still incomplete, complete them now before you finish.",
    "If everything is already complete, briefly confirm that all requested steps are done.",
  ].join(" ");
}

export function buildInvalidJsonRepairPrompt(invalidFiles: string[]): string {
  return [
    "System: Re-check the machine-readable files you created or modified.",
    `These files are currently invalid JSON: ${invalidFiles.join("; ")}.`,
    "Use tools to read the current file contents, repair them, and verify the final on-disk files parse as valid JSON before you end the turn.",
    "If a previous repair introduced extra escaping, remove the extra escaping so the file itself is valid JSON.",
    "After repairing them, briefly confirm which files were fixed.",
  ].join(" ");
}
