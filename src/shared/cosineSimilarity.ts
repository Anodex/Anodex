/**
 * Cosine similarity between two equal-length vectors, in [-1, 1] (1 =
 * identical direction, the standard measure of embedding relevance). Returns
 * 0 for mismatched-length or zero-magnitude input instead of throwing — a
 * corrupt/legacy index entry (e.g. from a since-changed embedding model)
 * should just score lowest, not crash a search.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0

  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0

  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
