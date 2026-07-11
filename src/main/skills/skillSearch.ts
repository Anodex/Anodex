import type { Skill, SkillSearchResult } from '@shared/skill.types'

/** Standard BM25 tuning constants (term-frequency saturation / length normalization). */
const BM25_K1 = 1.5
const BM25_B = 0.75

interface IndexedSkill {
  skill: Skill
  termFreq: Map<string, number>
  length: number
}

/** An in-memory BM25 index over a skill catalog. Rebuild it whenever the catalog might have changed — it's cheap and not persisted, so it never drifts from what's on disk. */
export interface SkillIndex {
  docs: IndexedSkill[]
  avgLength: number
  docFreq: Map<string, number>
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
}

function skillText(skill: Skill): string {
  return [skill.name, skill.description, ...skill.keywords].join(' ')
}

export function buildIndex(skills: Skill[]): SkillIndex {
  const docs: IndexedSkill[] = skills.map((skill) => {
    const tokens = tokenize(skillText(skill))
    const termFreq = new Map<string, number>()
    for (const token of tokens) termFreq.set(token, (termFreq.get(token) ?? 0) + 1)
    return { skill, termFreq, length: tokens.length }
  })
  const avgLength = docs.length ? docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length : 0
  const docFreq = new Map<string, number>()
  for (const doc of docs) {
    for (const term of doc.termFreq.keys()) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
    }
  }
  return { docs, avgLength, docFreq }
}

function bm25Score(doc: IndexedSkill, queryTerms: string[], index: SkillIndex): number {
  const n = index.docs.length
  let score = 0
  for (const term of queryTerms) {
    const df = index.docFreq.get(term)
    const tf = doc.termFreq.get(term) ?? 0
    if (!df || tf === 0) continue
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
    const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / index.avgLength)
    score += idf * ((tf * (BM25_K1 + 1)) / denom)
  }
  return score
}

/**
 * Ranks skills against a query via BM25, falling back to a plain
 * case-insensitive substring match (over name/description/keywords) when
 * BM25 finds nothing — e.g. a query with no token overlap but an obvious
 * literal match. Same fallback convention as `search_files`.
 */
export function search(index: SkillIndex, query: string, limit = 5): SkillSearchResult[] {
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0 || index.docs.length === 0) return []

  const scored = index.docs
    .map((doc) => ({ doc, score: bm25Score(doc, queryTerms, index) }))
    .filter((entry) => entry.score > 0)

  const ranked = scored.length > 0 ? scored : substringFallback(index, query)

  return ranked
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc, score }) => ({ name: doc.skill.name, description: doc.skill.description, score }))
}

function substringFallback(
  index: SkillIndex,
  query: string
): { doc: IndexedSkill; score: number }[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  return index.docs
    .filter((doc) => skillText(doc.skill).toLowerCase().includes(needle))
    .map((doc) => ({ doc, score: 1 }))
}
