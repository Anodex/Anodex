import type { TranscriptRecallResult } from './transcriptRecall.types'
import { searchWords } from './transcriptSearch'

/** How many of a past chat's own words a reply has to repeat before it counts as drawing on it. */
const WORDS_THAT_SHOW_USE = 2

/**
 * The past chats a reply actually drew on, out of those it was given.
 *
 * Recall runs on every turn and hands the model whatever matches the question,
 * so being given a past chat says nothing about whether the reply used it. A
 * reply to "run echo toolrow" was credited with three past chats because they
 * also said "toolrow". The test here: the reply repeats words from that chat
 * which the question did not already contain. Words shared with the question
 * prove only that both were about the same thing, which is why they matched.
 */
export function recallTheReplyUsed(
  results: TranscriptRecallResult[] | undefined,
  reply: string,
  question: string
): TranscriptRecallResult[] {
  if (!results?.length || !reply.trim()) return []
  const asked = searchWords(question)
  const said = searchWords(reply)
  return results.filter((result) => {
    const recalled = searchWords(
      [result.title, ...result.excerpts.map((excerpt) => excerpt.text)].join(' ')
    )
    let shared = 0
    for (const word of recalled) {
      if (said.has(word) && !asked.has(word) && ++shared >= WORDS_THAT_SHOW_USE) return true
    }
    return false
  })
}
