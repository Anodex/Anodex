import { describe, expect, it } from 'vitest'
import { orphanedConversationIds } from '../orphanedConversations'

/**
 * Which conversations lose their project on the next launch.
 *
 * This is a destructive decision — an orphan has its `projectId` nulled *and
 * persisted*, and putting the project back does not undo it. So the tests are
 * mostly about what must **not** be treated as orphaned.
 *
 * The bug that prompted them: the caller compared against the *active* project
 * list, which `projects:list` filters archived projects out of. Archiving a
 * project therefore looked exactly like deleting one, and the next launch moved
 * that project's entire history into general Chats for good.
 *
 * It also broke an invariant that is supposed to hold in both directions. A chat
 * under Chats has no project, and `buildTools` gives it no way to create or edit
 * code — read and discuss only. So a chat sitting under Chats that had edited
 * files is a contradiction, and this is how one got made.
 */
describe('orphanedConversationIds', () => {
  const chat = (id: string, projectId: string | null) => ({ id, projectId })

  it('orphans a conversation whose project is genuinely gone', () => {
    // The case this exists for: an interrupted delete, or data from an older
    // build. Settling into general chats beats retrying a dead project forever.
    const orphans = orphanedConversationIds(
      [chat('c1', 'p_deleted'), chat('c2', 'p_live')],
      new Set(['p_live'])
    )

    expect(orphans).toEqual(['c1'])
  })

  it('never orphans a conversation in an archived project', () => {
    // The whole bug. Archived projects are absent from `projects:list`, so the
    // caller must pass them in too — and when it does, nothing here moves.
    const conversations = [chat('c1', 'p_archived'), chat('c2', 'p_live')]

    expect(orphanedConversationIds(conversations, new Set(['p_live', 'p_archived']))).toEqual([])
    // And the failure mode, stated plainly: with only the active ids, the
    // archived project's history is condemned.
    expect(orphanedConversationIds(conversations, new Set(['p_live']))).toEqual(['c1'])
  })

  it('leaves general chats alone', () => {
    // A null projectId is not a dangling reference, it is the normal state of a
    // chat that was never in a project. Nothing to heal.
    expect(orphanedConversationIds([chat('c1', null), chat('c2', null)], new Set())).toEqual([])
  })

  it('orphans nothing when the machine has no projects but the chats do not either', () => {
    expect(orphanedConversationIds([chat('c1', null)], new Set())).toEqual([])
  })

  it('condemns every chat when the project list arrives empty', () => {
    // Worth pinning because it is the shape of a failure: if the caller ever
    // hands over an empty set — a failed read, a store not yet loaded — every
    // project chat on the machine is orphaned in one pass. The caller must be
    // sure it actually knows the projects before acting on this.
    const orphans = orphanedConversationIds(
      [chat('c1', 'p_a'), chat('c2', 'p_b'), chat('c3', null)],
      new Set()
    )

    expect(orphans).toEqual(['c1', 'c2'])
  })

  it('returns ids rather than conversations', () => {
    // The caller heals by id, and handing it whole objects invites it to write
    // back a stale copy of a conversation that is being streamed into.
    const orphans = orphanedConversationIds([chat('c1', 'p_gone')], new Set())

    expect(orphans).toEqual(['c1'])
  })
})
