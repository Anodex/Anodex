// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AssistantStyleSettings } from '@shared/settings.types'
import { BUILT_IN_CHAT_PERSONALITIES } from '@shared/chatPersonality'
import { fireEvent, render, screen } from '../../../../../test-utils/dom'

/**
 * The behaviours the redesign exists for, per docs/ANODEX_PERSONALITY_SPEC.md.
 *
 * The old screen could only be *read*; these are the things that were either
 * missing (no way to make one from scratch) or invisible (a built-in refusing
 * edits only by silently swallowing keystrokes).
 */

vi.mock('../../../../../lib/anodex', () => ({
  anodex: {
    settings: {
      pickPersonalityImage: vi.fn().mockResolvedValue(null),
      forgetPersonalityImage: vi.fn().mockResolvedValue(undefined)
    },
    workspace: { getAbsolutePath: vi.fn() },
    attachments: { readFile: vi.fn().mockResolvedValue({ ok: false, error: {} }) }
  }
}))

const { PersonalitySection } = await import('../PersonalitySection')

const ANODEX = BUILT_IN_CHAT_PERSONALITIES[0]
const ROOK = BUILT_IN_CHAT_PERSONALITIES.find((item) => item.name === 'Rook')!

function renderSection(value: Partial<AssistantStyleSettings> = {}): {
  update: ReturnType<typeof vi.fn>
} {
  const update = vi.fn()
  const settings: AssistantStyleSettings = {
    globalStyle: '',
    personalities: [],
    activePersonalityId: ANODEX.id,
    ...value
  }
  render(<PersonalitySection value={settings} update={update} />)
  return { update }
}

function nameField(): HTMLInputElement {
  return screen.getByLabelText('Personality name')
}

beforeEach(() => vi.clearAllMocks())

describe('the personality card', () => {
  it('shows the active personality with its name, role and chat preview', () => {
    renderSection({ activePersonalityId: ROOK.id })

    expect(nameField().value).toBe('Rook')
    expect(screen.getByLabelText('Role')).toHaveProperty('value', ROOK.role)
    // The byline preview: what selecting this actually buys.
    expect(screen.getByText('in chat')).toBeTruthy()
  })

  it('marks a built-in read-only rather than silently refusing keystrokes', () => {
    renderSection({ activePersonalityId: ROOK.id })

    expect(screen.getByText('Read only')).toBeTruthy()
    expect(nameField().readOnly).toBe(true)
    expect(screen.getByRole('button', { name: 'Built in' })).toHaveProperty('disabled', true)
    expect(screen.getByText('Duplicate to edit')).toBeTruthy()
  })

  it('states the prompt cost in tokens, because both fields ride every turn', () => {
    renderSection({ activePersonalityId: ROOK.id })

    expect(screen.getByText(/tokens in every conversation/)).toBeTruthy()
  })
})

describe('making one of your own', () => {
  function openPicker(): void {
    fireEvent.click(screen.getByRole('button', { name: /Anodex/ }))
  }

  it('offers New personality, and creates it unnamed and ready to name', () => {
    const { update } = renderSection()
    openPicker()
    fireEvent.click(screen.getByText('New personality'))

    const patch = update.mock.calls[0]?.[0] as AssistantStyleSettings
    expect(patch.personalities).toHaveLength(1)
    expect(patch.personalities[0].name).toBe('')
    // Selected immediately: you are editing the thing you just made.
    expect(patch.activePersonalityId).toBe(patch.personalities[0].id)
  })

  it('will not save something unnamed, and says why', () => {
    renderSection({
      personalities: [{ id: 'own-1', name: '', style: 'terse', story: '' }],
      activePersonalityId: 'own-1'
    })

    // Typing is what marks it dirty and reveals the save bar.
    fireEvent.change(screen.getByPlaceholderText(/former incident reviewer/), {
      target: { value: 'A backstory.' }
    })

    expect(screen.getByText('Give it a name on the card to save it')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true)
  })

  it('duplicating a built-in carries its backstory across', () => {
    const { update } = renderSection({ activePersonalityId: ROOK.id })
    fireEvent.click(screen.getByText('Duplicate to edit'))

    const patch = update.mock.calls[0]?.[0] as AssistantStyleSettings
    expect(patch.personalities[0].name).toBe('Rook (mine)')
    expect(patch.personalities[0].story).toBe(ROOK.story)
    expect(patch.personalities[0].id).not.toBe(ROOK.id)
  })

  /**
   * Discarding something never named discards the whole personality: leaving
   * an unnamed orphan in the list gives no way to tell what it was for.
   */
  it('discards an unnamed personality entirely', () => {
    const { update } = renderSection({
      personalities: [{ id: 'own-1', name: '', style: '', story: '' }],
      activePersonalityId: 'own-1'
    })

    fireEvent.change(screen.getByPlaceholderText(/former incident reviewer/), {
      target: { value: 'x' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    const patch = update.mock.calls.at(-1)?.[0] as AssistantStyleSettings
    expect(patch.personalities).toHaveLength(0)
    expect(patch.activePersonalityId).toBe(ANODEX.id)
  })
})

describe('the prompt preview', () => {
  it('renders backstory and voice as separate sections', () => {
    renderSection({ activePersonalityId: ROOK.id })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

    const preview = screen.getByText(/# Who you are/)
    expect(preview.textContent).toContain('Answer to that name')
    expect(preview.textContent).toContain(ROOK.story)
    expect(preview.textContent).toContain('# Assistant style')
  })
})
