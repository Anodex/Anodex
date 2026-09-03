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

function renderSectionWithContainer(activeId: string = ANODEX.id): { container: HTMLElement } {
  const settings: AssistantStyleSettings = {
    globalStyle: '',
    personalities: [],
    activePersonalityId: activeId
  }
  return render(<PersonalitySection value={settings} update={vi.fn()} />)
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

/**
 * Anodex is the fixed reference point: the personality you ask someone to
 * switch to when diagnosing a problem. It only means something if it is the
 * same on their machine as on yours, so nothing about it is adjustable and it
 * wears the app's own mark rather than a monogram anyone could mistake for a
 * user's picture.
 */
describe('the Anodex personality', () => {
  it('wears the app icon rather than a monogram', () => {
    const { container } = renderSectionWithContainer()

    const icon = container.querySelector('img')
    expect(icon).toBeTruthy()
    expect(icon?.getAttribute('src')).toContain('app-icon')
    expect(container.textContent).not.toContain('AN')
  })

  /** The other built-ins ship their own art; only Pip is still a monogram. */
  it('gives the named built-ins their own faces', () => {
    const { container } = renderSectionWithContainer(ROOK.id)

    expect(container.querySelector('img')?.getAttribute('src')).toContain('rook')
  })

  it('cannot have its picture, voice or backstory changed', () => {
    renderSection()

    expect(screen.getByText('Read only')).toBeTruthy()
    expect(nameField().readOnly).toBe(true)
    expect(screen.getByLabelText('Role')).toHaveProperty('readOnly', true)
    expect(screen.getByRole('button', { name: 'Built in' })).toHaveProperty('disabled', true)
    for (const box of screen.getAllByRole('textbox')) {
      expect(box).toHaveProperty('readOnly', true)
    }
  })

  /** A copy is a user personality, so it must not inherit the app's mark. */
  it('does not pass its icon on to a copy', () => {
    const { update } = renderSection()
    fireEvent.click(screen.getByText('Duplicate to edit'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const patch = update.mock.calls[0]?.[0] as AssistantStyleSettings
    expect(patch.personalities[0].id).not.toBe(ANODEX.id)
    expect(patch.personalities[0].image).toBeUndefined()
  })

  /**
   * The bug this section exists to prevent a repeat of: the editor creates a
   * personality unnamed, and the settings validator rejected a blank name, so
   * clicking New personality silently rolled back and nothing appeared.
   * `SettingsStore.test.ts` pins the store side; this pins what is written.
   */
  it('writes a personality the settings validator will accept', () => {
    const { update } = renderSection()
    fireEvent.click(screen.getByRole('button', { name: /Anodex/ }))
    fireEvent.click(screen.getByText('New personality'))
    fireEvent.change(nameField(), { target: { value: 'Halyard' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const patch = update.mock.calls[0]?.[0] as AssistantStyleSettings
    const made = patch.personalities[0]
    expect(made.name).toBe('Halyard')
    expect(made.name.length).toBeLessThanOrEqual(40)
    expect(made.image).toBeUndefined()
  })
})

describe('making one of your own', () => {
  function openPicker(): void {
    fireEvent.click(screen.getByRole('button', { name: /Anodex/ }))
  }

  /**
   * Nothing is stored and nothing is selected until Save. Editing used to write
   * on every keystroke, so a half-finished personality was already saved,
   * already active, and already changing how the assistant talked -- closing
   * Settings mid-edit left it behind.
   */
  it('stores nothing until Save is pressed', () => {
    const { update } = renderSection()
    openPicker()
    fireEvent.click(screen.getByText('New personality'))
    fireEvent.change(nameField(), { target: { value: 'Halyard' } })

    expect(update).not.toHaveBeenCalled()
    expect(screen.getByText('Halyard is not saved yet')).toBeTruthy()
  })

  it('appends and selects it only on Save', () => {
    const { update } = renderSection()
    openPicker()
    fireEvent.click(screen.getByText('New personality'))
    fireEvent.change(nameField(), { target: { value: 'Halyard' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const patch = update.mock.calls[0]?.[0] as AssistantStyleSettings
    expect(patch.personalities).toHaveLength(1)
    expect(patch.personalities[0].name).toBe('Halyard')
    expect(patch.activePersonalityId).toBe(patch.personalities[0].id)
  })

  it('leaves an existing personality alone until its edits are saved', () => {
    const { update } = renderSection({
      personalities: [{ id: 'own-1', name: 'Ada', style: 'terse', story: '' }],
      activePersonalityId: 'own-1'
    })

    fireEvent.change(screen.getByPlaceholderText(/former incident reviewer/), {
      target: { value: 'A backstory.' }
    })
    expect(update).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const patch = update.mock.calls[0]?.[0] as AssistantStyleSettings
    expect(patch.personalities[0].story).toBe('A backstory.')
    // Already active, so saving an edit must not restate the selection.
    expect(patch.activePersonalityId).toBeUndefined()
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
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const patch = update.mock.calls[0]?.[0] as AssistantStyleSettings
    expect(patch.personalities[0].name).toBe('Rook (mine)')
    expect(patch.personalities[0].story).toBe(ROOK.story)
    expect(patch.personalities[0].id).not.toBe(ROOK.id)
  })

  it('discards a draft without storing anything', () => {
    const { update } = renderSection()
    openPicker()
    fireEvent.click(screen.getByText('New personality'))
    fireEvent.change(nameField(), { target: { value: 'Halyard' } })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    expect(update).not.toHaveBeenCalled()
    // Back to whatever was active before the draft was opened.
    expect(nameField().value).toBe('Anodex')
  })

  it('reverts an edit to an existing personality on Discard', () => {
    renderSection({
      personalities: [{ id: 'own-1', name: 'Ada', style: 'terse', story: '' }],
      activePersonalityId: 'own-1'
    })

    fireEvent.change(nameField(), { target: { value: 'Adaline' } })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    expect(nameField().value).toBe('Ada')
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
