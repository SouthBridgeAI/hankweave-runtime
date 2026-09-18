export function isNonAnthropicModel(model: string): boolean {
  const lower = model.toLowerCase();
  return (
    !lower.includes("claude") &&
    !lower.includes("sonnet") &&
    !lower.includes("opus") &&
    !lower.includes("haiku")
  );
}
