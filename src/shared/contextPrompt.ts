/** Build the system-prompt block used to seed a compacted context epoch. */
export function buildCompactionSystemPrompt(
  systemPrompt: string | undefined,
  summary: string
): string {
  const base = systemPrompt ?? ''
  const block = `Summary of earlier conversation (compacted to fit the context window):\n${summary}`
  return base ? `${base}\n\n---\n${block}` : block
}
