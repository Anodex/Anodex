/**
 * Joins the visible text of one provider round onto the turn's reply so far.
 *
 * A turn that calls tools produces text in several bursts: a model narrates
 * before a call and answers after it. Concatenating those directly — which is
 * what `content += delta` across rounds amounts to — runs the last word of one
 * burst into the first word of the next: `Let me search.Found 3 results.`
 *
 * Empty rounds contribute nothing rather than a blank gap, which matters
 * because a round that only called a tool is the common case.
 *
 * Shared because the same accumulation exists in five transports and only one
 * of them got it right; a rule about how Anodex assembles a reply belongs in
 * one place rather than five.
 */
export function appendRoundText(existing: string, next: string): string {
  const trimmed = next.trim()
  if (!trimmed) return existing
  return existing ? `${existing}\n\n${trimmed}` : trimmed
}

/**
 * Appends one streamed chunk of visible text, putting a paragraph break where a
 * tool ran in between.
 *
 * The local engine runs its own tool loop inside one generation, so text from
 * before a call and after it arrive as one stream with no round boundary for
 * {@link appendRoundText} to see. Whitespace-only chunks pass through, so the
 * break lands before the first words after the tool rather than before a space.
 */
export function joinAfterTool(existing: string, chunk: string, toolBetween: boolean): string {
  if (!toolBetween || !existing.trim() || !chunk.trim()) return existing + chunk
  return `${existing.trimEnd()}\n\n${chunk.trimStart()}`
}
