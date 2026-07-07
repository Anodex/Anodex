/** Small, dependency-free text similarity helpers shared by retrieval and dedup. */

const MIN_WORD_LENGTH = 4

/** Lowercased, punctuation-stripped word set, ignoring very short/common words. */
export function wordSet(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length >= MIN_WORD_LENGTH)
  return new Set(words)
}

/** Jaccard similarity (intersection over union) between two texts' word sets. */
export function jaccardSimilarity(a: string, b: string): number {
  const wa = wordSet(a)
  const wb = wordSet(b)
  if (wa.size === 0 || wb.size === 0) return 0
  let intersection = 0
  for (const word of wa) {
    if (wb.has(word)) intersection++
  }
  const union = wa.size + wb.size - intersection
  return union === 0 ? 0 : intersection / union
}
