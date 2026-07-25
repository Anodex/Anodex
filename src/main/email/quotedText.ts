/**
 * Trims the quoted history off a reply body.
 *
 * Every mail client answers by appending the previous message rather than
 * sending only the new words, so the body of the second message in a thread is
 * mostly a copy of the first. Feeding that to the model wasted most of a
 * preview on text it had already read: an observed `summarize_thread` result
 * spent its whole budget on `On Fri, Jul 24, 2026, 10:57 PM <...> wrote:`
 * followed by the app's own outgoing mail, cut off mid-word.
 *
 * Deliberately conservative. It cuts at the first recognized quote marker and
 * keeps everything above it, so a body it does not recognize is returned whole
 * — losing real content would be worse than leaving a quote in. The markers
 * below are the English/US-locale ones the common clients emit; a reply in
 * another locale ("El 24 jul 2026, ... escribió:") falls through and is kept
 * intact rather than being guessed at.
 */
export function stripQuotedReply(body: string): string {
  if (!body) return ''
  const normalized = body.replace(/\r\n/g, '\n')

  const cut = QUOTE_MARKERS.map((marker) => normalized.search(marker))
    .filter((index) => index >= 0)
    .reduce((lowest, index) => (index < lowest ? index : lowest), Number.POSITIVE_INFINITY)

  const kept = cut === Number.POSITIVE_INFINITY ? normalized : normalized.slice(0, cut)
  return kept.replace(/\s+$/, '')
}

/**
 * Each marker matches the *start* of a quote block. Anchored with `m` so they
 * only fire at a line start — a body that mentions "on Tuesday he wrote: ..."
 * mid-sentence is not a quote, and matching mid-line would truncate real text.
 */
const QUOTE_MARKERS: RegExp[] = [
  // Gmail/Apple Mail attribution. The date and address routinely wrap onto the
  // next line, so `[\s\S]` spans it, bounded so a stray "On" near the top
  // cannot reach a "wrote:" hundreds of characters below.
  /^[ \t]*On\b[\s\S]{0,240}?\bwrote:[ \t]*$/m,
  // Outlook, both the classic separator and the horizontal rule it draws
  // above the quoted headers.
  /^[ \t]*-{2,}[ \t]*Original Message[ \t]*-{2,}/im,
  /^[ \t]*_{10,}[ \t]*$/m,
  // Outlook inline reply: a `From:` header line followed closely by another of
  // the quoted headers. Requiring the second line is what keeps a body that
  // merely opens with "From: the desk of ..." from being cut.
  /^[ \t]*From:[ \t]*\S[\s\S]{0,200}?^[ \t]*(?:Sent|To|Subject|Date):[ \t]*\S/m,
  // Plain-text quoting: the first `>` line.
  /^[ \t]*>/m
]
