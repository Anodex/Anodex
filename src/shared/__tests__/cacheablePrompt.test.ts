import { describe, expect, it } from 'vitest'
import {
  appendTurnContext,
  composeCacheablePrompt,
  composeSystemPrompt,
  withTurnContext,
  type SystemPromptParts
} from '../prompts'

const base: SystemPromptParts = {
  hasWorkspaceTools: true,
  hasProject: true,
  runtime: { kind: 'local' },
  assistantStyle: 'Be brief.',
  projectRules: 'Use tabs.',
  timeZone: 'UTC'
}

/**
 * A local model skips only the prompt it has already read, up to the first
 * difference. These pin the system prompt as the part that must not change between
 * messages, and the date, workspace, memory and past chats as what travels with the
 * latest message instead.
 */
describe('composeCacheablePrompt', () => {
  it('keeps the system prompt identical when the time, memory and recall change', () => {
    const first = composeCacheablePrompt({
      ...base,
      now: new Date('2026-09-14T08:41:00Z'),
      memoryContext: 'The user is called Merlin.',
      transcriptRecallContext: 'Yesterday: the moon.'
    })
    const second = composeCacheablePrompt({
      ...base,
      now: new Date('2026-09-14T09:07:00Z'),
      memoryContext: 'The user likes tabs.',
      workspaceContext: 'src/ changed 3 files.'
    })

    expect(first.system).toBe(second.system)
    expect(first.turnContext).not.toBe(second.turnContext)
  })

  it('moves the environment and reference data out of the system prompt, and keeps the rest', () => {
    const { system, turnContext } = composeCacheablePrompt({
      ...base,
      now: new Date('2026-09-14T08:41:00Z'),
      workspaceContext: 'src/ changed 3 files.',
      memoryContext: 'The user is called Merlin.',
      transcriptRecallContext: 'Yesterday: the moon.'
    })

    expect(system).not.toContain("Today's date")
    expect(system).not.toContain('Merlin')
    expect(system).toContain('Use tabs.')
    expect(system).toContain('Be brief.')
    expect(system).toContain('[Anodex context for this message]')

    expect(turnContext).toContain("Today's date is Monday, September 14, 2026")
    expect(turnContext).toContain('# Workspace')
    expect(turnContext).toContain('# Memory')
    expect(turnContext).toContain('Merlin')
    expect(turnContext).toContain('Yesterday: the moon.')
  })

  it('carries the same sections the full system prompt did, nothing lost', () => {
    const parts: SystemPromptParts = {
      ...base,
      now: new Date('2026-09-14T08:41:00Z'),
      memoryContext: 'The user is called Merlin.'
    }
    const full = composeSystemPrompt(parts)
    const { system, turnContext } = composeCacheablePrompt(parts)

    for (const heading of full.match(/^# .+$/gm) ?? []) {
      expect(`${system}\n${turnContext}`).toContain(heading)
    }
  })

  it('leaves an isolated writing phase exactly as it was', () => {
    const parts: SystemPromptParts = { ...base, isolatedWriting: true, now: new Date(0) }
    expect(composeCacheablePrompt(parts)).toEqual({
      system: composeSystemPrompt(parts),
      turnContext: null
    })
  })
})

describe('withTurnContext', () => {
  it('puts the context first, marked, then the words', () => {
    expect(withTurnContext('Hi there', '# Environment\nNow.')).toBe(
      '[Anodex context for this message]\n# Environment\nNow.\n[End of Anodex context]\n\nHi there'
    )
  })

  it('leaves a message with no context untouched', () => {
    expect(withTurnContext('Hi there', null)).toBe('Hi there')
    expect(withTurnContext('Hi there', '  ')).toBe('Hi there')
  })

  it('appends a plan or a brief, skipping what is empty', () => {
    expect(appendTurnContext('A', null, 'B', '')).toBe('A\n\nB')
    expect(appendTurnContext(null, undefined)).toBeNull()
  })
})
