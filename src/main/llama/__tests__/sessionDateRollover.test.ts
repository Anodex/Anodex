import { afterEach, describe, expect, it, vi } from 'vitest'
import { llamaService } from '../LlamaService'
import { composeSystemPrompt } from '@shared/prompts'

/**
 * `ensureSession` bakes the system prompt into the native chat session and
 * reuses that session for every later turn of the same conversation, so the
 * Environment section's date is fixed at session-construction time. A chat
 * left open past midnight would therefore keep telling the model it is
 * yesterday — a stale-but-confident date being precisely the failure the
 * Environment section was added to stop (observed: the assistant answered
 * "It's 2024" and dismissed correctly dated web results as fictional).
 *
 * These tests pin the reuse *decision* rather than the rebuild itself: the
 * rebuild path needs a real native context, but whether the fast path is
 * taken is fully observable without one, because a missed fast path reaches
 * the `No model loaded.` guard with no model present.
 *
 * Reaches into private fields the same way `generateContextShiftRecovery.test.ts`
 * does — the singleton has no injection seam for its native session.
 */
interface LlamaServiceTestAccess {
  context: unknown
  contextSequence: unknown
  session: unknown
  activeConversationId: string | undefined
  activeEnvironmentDate: string | null
  ensureSession: (
    conversationId: string,
    systemPrompt: string | undefined,
    history: unknown[],
    context: unknown,
    toolSchemaReserveTokens: number,
    compactionReason?: string,
    forceRebuild?: boolean
  ) => Promise<unknown>
}

function asTestAccess(): LlamaServiceTestAccess {
  return llamaService as unknown as LlamaServiceTestAccess
}

const CONVERSATION_ID = 'overnight-conversation'
const fakeSession = { id: 'live-session' }

function promptForDate(iso: string): string {
  return composeSystemPrompt({
    hasWorkspaceTools: true,
    hasProject: true,
    now: new Date(`${iso}T22:00:00-06:00`),
    timeZone: 'America/Denver'
  })
}

/** A live session mid-conversation, with no native model behind it. */
function seedLiveSession(access: LlamaServiceTestAccess, environmentDate: string | null): void {
  access.context = undefined
  access.contextSequence = undefined
  access.session = fakeSession
  access.activeConversationId = CONVERSATION_ID
  access.activeEnvironmentDate = environmentDate
}

afterEach(() => {
  vi.restoreAllMocks()
  const access = asTestAccess()
  access.context = undefined
  access.contextSequence = undefined
  access.session = undefined
  access.activeConversationId = undefined
  access.activeEnvironmentDate = null
})

describe('LlamaService session reuse across a date change', () => {
  it('reuses the session for another turn on the same day', async () => {
    const access = asTestAccess()
    seedLiveSession(access, '2026-07-29')

    await expect(
      access.ensureSession(CONVERSATION_ID, promptForDate('2026-07-29'), [], null, 0)
    ).resolves.toBe(fakeSession)
  })

  it('rebuilds the session once the date has rolled over', async () => {
    const access = asTestAccess()
    seedLiveSession(access, '2026-07-29')

    // Reaching the "no model" guard is the proof it declined to reuse: the
    // fast path returns before that check.
    await expect(
      access.ensureSession(CONVERSATION_ID, promptForDate('2026-07-30'), [], null, 0)
    ).rejects.toThrow('No model loaded.')
  })

  it('still reuses the session when only the reference sections change', async () => {
    const access = asTestAccess()
    seedLiveSession(access, '2026-07-29')

    // Memory and workspace context are rebuilt per turn from the user's
    // message, so the composed prompt differs almost every turn. Only the date
    // may force a rebuild — comparing whole prompts would rebuild constantly.
    const prompt = composeSystemPrompt({
      hasWorkspaceTools: true,
      hasProject: true,
      now: new Date('2026-07-29T23:59:00-06:00'),
      timeZone: 'America/Denver',
      memoryContext: '- [identity] The user is Merlin. (global)',
      workspaceContext: 'Name: anodex'
    })

    await expect(access.ensureSession(CONVERSATION_ID, prompt, [], null, 0)).resolves.toBe(
      fakeSession
    )
  })

  it('reuses a prompt-less session, which has no date to go stale', async () => {
    const access = asTestAccess()
    seedLiveSession(access, null)

    await expect(access.ensureSession(CONVERSATION_ID, undefined, [], null, 0)).resolves.toBe(
      fakeSession
    )
  })
})
