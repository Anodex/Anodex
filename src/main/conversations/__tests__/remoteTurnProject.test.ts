import { describe, expect, it } from 'vitest'
import { projectForRemoteTurn } from '../remoteTurn'
import type { ChatRequest } from '@shared/chat.types'

/**
 * Which project a phone's turn is filed under.
 *
 * Two places answered this and they did not agree. `boundedChatRunner` has always
 * distinguished an absent `projectId` from a null one — absent means "whatever is
 * open at the computer", null means "none" — and that is what decides the
 * workspace the turn actually runs against. The conversation record was written
 * with `request.projectId ?? null`, which collapses the two.
 *
 * So a turn from a client that omits the key ran inside the active project and
 * was filed under no project at all: the work happened in one place and the record
 * of it went to another, with nothing failing anywhere. The same shape as every
 * other defect in this repo worth its own test — one rule, written twice, wrong in
 * the copy nobody re-read.
 */
describe('the project a remote turn belongs to', () => {
  const base = { conversationId: 'c1', messageId: 'm1', prompt: 'hello' }

  it('takes the named project when the request names one', () => {
    const request = { ...base, projectId: 'p-sandbox' } as ChatRequest
    expect(projectForRemoteTurn(request, 'p-active')).toBe('p-sandbox')
  })

  it('means "no project" when the request says null', () => {
    // An explicit null is a decision, not an omission. A plain chat started on the
    // phone says null so it is filed under Chats rather than into whichever project
    // the desk happens to be sitting in.
    const request = { ...base, projectId: null } as ChatRequest
    expect(projectForRemoteTurn(request, 'p-active')).toBeNull()
  })

  it('falls back to the open project when the key is absent', () => {
    // The case that was wrong. An older client omits the key entirely; the turn
    // runs in the active project, so that is where its record belongs.
    const request = { ...base } as ChatRequest
    expect(projectForRemoteTurn(request, 'p-active')).toBe('p-active')
  })

  it('is still null when nothing is open and nothing was named', () => {
    const request = { ...base } as ChatRequest
    expect(projectForRemoteTurn(request, null)).toBeNull()
  })
})
