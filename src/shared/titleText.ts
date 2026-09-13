/**
 * One line of text with its markdown marks taken out, for use as a title.
 *
 * Titles are drawn as plain text in the sidebar, the agent panel, notifications
 * and on the phone. A conversation whose first message was a pasted prompt was
 * titled "Yes. Here is the **single combined master pr…" — the bold marks were
 * cut in half by the length limit and shown literally everywhere the title went.
 *
 * Only marks are removed, never the words inside them: emphasis, inline code, and
 * a heading, quote, or list prefix. A line that is nothing but marks (a rule, a
 * stray `****`) comes back empty, so a caller looking for the first real line
 * skips it.
 *
 * Shared because the same fallback title is cut in two places — the renderer's
 * composer and the agent-run service — and the phone applies the same rule.
 */
export function plainTitleLine(line: string): string {
  const stripped = line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
    // Flanked the way emphasis is, so a path like `src/**/*.ts` or a name like
    // `__init__.py` is text rather than a pair of marks.
    .replace(/(?<![\w*/])\*\*(?![\s*])(.+?)(?<![\s*])\*\*(?![\w*/])/g, '$1')
    .replace(/(?<!\w)__(?![\s_])(.+?)(?<![\s_])__(?![\w.])/g, '$1')
    .replace(/(?<![\w*/])\*(?![\s*])([^*]+?)(?<!\s)\*(?![\w*/])/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return /^[*_`#>~=-]*$/.test(stripped) ? '' : stripped
}

/** The first line of `text` that still has something in it once its marks are gone. */
export function firstPlainLine(text: string): string {
  for (const line of text.split('\n')) {
    const plain = plainTitleLine(line)
    if (plain) return plain
  }
  return ''
}
