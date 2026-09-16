/**
 * The digest checked against a real store, when there is one on this machine.
 *
 * Skipped everywhere else, CI included: it reads `%APPDATA%/anodex/conversations`
 * and there is nothing there to read. It earns its place anyway — the unit tests
 * passed while the digest was skipping chats that said "checkpoints" for a search
 * for "checkpoint", because the verbatim half of the score is a substring match
 * and a hand-written fixture never said the longer word. Four chats out of
 * twenty-five, on the machine this was written on, found in a second.
 *
 * Run it after touching either the digest or the scoring:
 *   npx vitest run src/main/conversations/__tests__/realStoreSearch.test.ts
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Conversation } from '@shared/conversation.types'
import { searchTranscripts, searchWords } from '@shared/transcriptSearch'
import { couldMatch, wordDigestOf } from '../conversationWordDigest'

const root = join(process.env.APPDATA ?? '', 'anodex', 'conversations')

function chatsUnder(dir: string): Conversation[] {
  const found: Conversation[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...chatsUnder(path))
      continue
    }
    if (!entry.name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Conversation
      if (Array.isArray(parsed.messages)) found.push(parsed)
    } catch {
      // A file being written while this runs is not what is under test.
    }
  }
  return found
}

const chats = process.env.APPDATA && existsSync(root) ? chatsUnder(root) : []

/** A spread of shapes: one word, several, a phrase, a word nothing said. */
const QUERIES = [
  'marzipan',
  'llama server',
  'context share',
  'memory',
  'phone crash report',
  'what color is red',
  'checkpoint',
  'search',
  'diagnostics warning',
  'stress test website'
]

describe.skipIf(chats.length === 0)('the digest against this machine’s own chats', () => {
  it('never skips a chat the search would have surfaced', () => {
    const digests = new Map(chats.map((chat) => [chat.id, wordDigestOf(chat)]))

    for (const query of QUERIES) {
      const words = searchWords(query)
      const fromEverything = searchTranscripts(chats, query, { maxResults: 50 })
      const opened = chats.filter((chat) => couldMatch(digests.get(chat.id) ?? '', words))
      const fromOpened = searchTranscripts(opened, query, { maxResults: 50 })

      expect(
        fromOpened.map((result) => result.conversationId),
        `"${query}" lost a hit`
      ).toEqual(fromEverything.map((result) => result.conversationId))
    }
  })
})
