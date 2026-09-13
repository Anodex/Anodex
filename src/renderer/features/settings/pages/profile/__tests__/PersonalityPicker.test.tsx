// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { BUILT_IN_CHAT_PERSONALITIES } from '@shared/chatPersonality'
import { fireEvent, render, screen } from '../../../../../test-utils/dom'
import { PersonalityPicker } from '../PersonalityPicker'

/**
 * The list says when there is more of it.
 *
 * Its height cap once fell exactly between two rows, so the seventh built-in and
 * every personality of the user's own sat below the fold with nothing to show it.
 * They looked deleted, and were reported as deleted.
 */

const TREVOR = { id: 'own-trevor', name: 'Trevor', style: 'plain' }

function openWith(sizes: { scrollHeight: number; clientHeight: number }): HTMLElement {
  render(
    <PersonalityPicker
      builtIns={BUILT_IN_CHAT_PERSONALITIES}
      saved={[TREVOR]}
      activeId={BUILT_IN_CHAT_PERSONALITIES[0].id}
      atLimit={false}
      onSelect={vi.fn()}
      onCreate={vi.fn()}
    />
  )
  // jsdom lays nothing out, so the list's measurements are given to it.
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => sizes.scrollHeight
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => sizes.clientHeight
  })
  fireEvent.click(screen.getByRole('button', { name: /Anodex/ }))
  return screen.getByRole('listbox')
}

describe('the personality list', () => {
  it('fades its last row when options are hidden below', () => {
    const list = openWith({ scrollHeight: 520, clientHeight: 280 })
    expect(list.className).toMatch(/listboxMore/)
  })

  it('stops fading once scrolled to the end', () => {
    const list = openWith({ scrollHeight: 520, clientHeight: 280 })
    list.scrollTop = 240
    fireEvent.scroll(list)
    expect(list.className).not.toMatch(/listboxMore/)
  })

  it('does not fade a list that fits', () => {
    const list = openWith({ scrollHeight: 280, clientHeight: 280 })
    expect(list.className).not.toMatch(/listboxMore/)
  })

  it('still lists your own personalities', () => {
    openWith({ scrollHeight: 520, clientHeight: 280 })
    expect(screen.getByRole('option', { name: /Trevor/ })).toBeTruthy()
  })
})
