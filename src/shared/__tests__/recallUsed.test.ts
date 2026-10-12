import { describe, expect, it } from 'vitest'
import type { TranscriptRecallResult } from '../transcriptRecall.types'
import { recallTheReplyUsed } from '../recallUsed'

function past(title: string, text: string): TranscriptRecallResult {
  return {
    conversationId: title,
    projectId: null,
    title,
    updatedAt: 0,
    excerpts: [{ messageId: 'm', role: 'assistant', text, score: 1 }]
  }
}

describe('recallTheReplyUsed', () => {
  const garden = past(
    'Plan the garden',
    'Lettuce, spinach and kale all manage with a few hours of sun.'
  )
  const shell = past('Run Shell Commands', 'I ran echo toolrow and it printed toolrow.')

  it('keeps a past chat whose details the reply repeats', () => {
    const used = recallTheReplyUsed(
      [garden],
      'Last week we settled on spinach and kale for the shady bed.',
      'What did we pick for the shady bed?'
    )
    expect(used).toEqual([garden])
  })

  it('drops a past chat that only shares the words of the question', () => {
    expect(recallTheReplyUsed([shell], 'Done: echo printed toolrow.', 'run echo toolrow')).toEqual(
      []
    )
  })

  it('drops a past chat the reply never mentions', () => {
    expect(
      recallTheReplyUsed([garden, shell], 'Two plus two is four.', 'What is 2 plus 2?')
    ).toEqual([])
  })

  it('needs more than one shared word, so a coincidence does not count', () => {
    expect(recallTheReplyUsed([garden], 'A few hours should be plenty.', 'How long?')).toEqual([])
  })

  it('keeps only the chats that were used, in their order', () => {
    const used = recallTheReplyUsed(
      [shell, garden],
      'Plant spinach and lettuce there.',
      'What grows in shade?'
    )
    expect(used).toEqual([garden])
  })

  it('has nothing to keep without results or a reply', () => {
    expect(recallTheReplyUsed(undefined, 'anything', 'q')).toEqual([])
    expect(recallTheReplyUsed([garden], '   ', 'q')).toEqual([])
  })
})
