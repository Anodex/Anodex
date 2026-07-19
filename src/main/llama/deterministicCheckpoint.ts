const MAX_CHECKPOINT_CHARS = 6_000
const HEADER = 'Deterministic context checkpoint (exact tool identifiers retained):'

/**
 * Cheap replacement-style fold for emergency mid-turn context shifts. It does
 * not call a model, so a context shift cannot recursively contend for GPU time
 * or spend minutes summarizing evidence that may immediately be shifted again.
 */
export function buildDeterministicCheckpoint(
  transcript: string,
  previousSummary?: string
): Promise<string> {
  const previousLines = checkpointLines(previousSummary)
  const incomingLines = transcript.split(/\r?\n/).map(compactLine).filter(Boolean)
  const deduped = [...new Set([...previousLines, ...incomingLines])]
  const retained: string[] = []
  let used = HEADER.length
  for (let index = deduped.length - 1; index >= 0; index--) {
    const line = deduped[index]
    if (used + line.length + 1 > MAX_CHECKPOINT_CHARS) break
    retained.unshift(line)
    used += line.length + 1
  }
  const omitted = Math.max(0, deduped.length - retained.length)
  const omission = omitted > 0 ? `(${omitted} older checkpoint entries omitted)` : ''
  return Promise.resolve([HEADER, omission, ...retained].filter(Boolean).join('\n'))
}

function checkpointLines(summary: string | undefined): string[] {
  if (!summary) return []
  return summary
    .split(/\r?\n/)
    .filter((line) => line !== HEADER && !/^\(\d+ older checkpoint entries omitted\)$/.test(line))
}

function compactLine(line: string): string {
  return line.replace(/\s+/g, ' ').trim().slice(0, 700)
}
