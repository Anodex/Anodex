import { describe, expect, it } from 'vitest'
import {
  DEFAULT_KEYBOARD_SHORTCUTS,
  KEYBOARD_SHORTCUT_DEFINITIONS,
  isBindableShortcut,
  matchesShortcut,
  normalizeShortcut,
  shortcutFromEvent
} from '../keyboardShortcuts'

function event(
  key: string,
  modifiers: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {},
  code?: string
): Parameters<typeof shortcutFromEvent>[0] {
  return {
    key,
    code,
    ctrlKey: modifiers.ctrl ?? false,
    altKey: modifiers.alt ?? false,
    shiftKey: modifiers.shift ?? false,
    metaKey: modifiers.meta ?? false
  }
}

describe('shortcutFromEvent', () => {
  it('orders modifiers canonically', () => {
    expect(shortcutFromEvent(event('p', { ctrl: true, shift: true }))).toBe('Ctrl+Shift+P')
  })

  it('ignores a bare modifier press', () => {
    expect(shortcutFromEvent(event('Control', { ctrl: true }))).toBe('')
  })

  it('reads digits from the physical key, not the shifted glyph', () => {
    // Without the `code` fallback this arrives as "Ctrl+Shift+!" and could
    // never match a stored "Ctrl+Shift+1".
    expect(shortcutFromEvent(event('!', { ctrl: true, shift: true }, 'Digit1'))).toBe(
      'Ctrl+Shift+1'
    )
    expect(shortcutFromEvent(event('1', { ctrl: true }, 'Digit1'))).toBe('Ctrl+1')
  })
})

describe('normalizeShortcut', () => {
  it('canonicalizes aliases and ordering', () => {
    expect(normalizeShortcut('shift + control + k')).toBe('Ctrl+Shift+K')
    expect(normalizeShortcut('cmd+,')).toBe('Meta+,')
  })

  it('rejects a modifier with no key', () => {
    expect(normalizeShortcut('Ctrl+Shift')).toBe('')
  })
})

describe('matchesShortcut', () => {
  it('matches a stored digit binding pressed with Shift', () => {
    expect(matchesShortcut(event('!', { ctrl: true, shift: true }, 'Digit1'), 'Ctrl+Shift+1')).toBe(
      true
    )
  })

  it('does not match when an extra modifier is held', () => {
    expect(matchesShortcut(event('n', { ctrl: true, shift: true }), 'Ctrl+N')).toBe(false)
  })

  it('never matches a disabled (empty) binding', () => {
    expect(matchesShortcut(event('n', { ctrl: true }), '')).toBe(false)
  })
})

describe('isBindableShortcut', () => {
  it('accepts anything carrying Ctrl, Alt, or Meta', () => {
    expect(isBindableShortcut('Ctrl+N')).toBe(true)
    expect(isBindableShortcut('Alt+Shift+P')).toBe(true)
  })

  it('rejects bare keys that would swallow typing', () => {
    expect(isBindableShortcut('A')).toBe(false)
    expect(isBindableShortcut('Shift+A')).toBe(false)
  })

  it('allows the dedicated standalone keys', () => {
    expect(isBindableShortcut('Escape')).toBe(true)
    expect(isBindableShortcut('F5')).toBe(true)
  })
})

describe('DEFAULT_KEYBOARD_SHORTCUTS', () => {
  it('assigns every declared shortcut exactly once', () => {
    const values = Object.values(DEFAULT_KEYBOARD_SHORTCUTS)
    expect(new Set(values).size).toBe(values.length)
  })

  it('only uses bindings that survive normalization and are safe to register', () => {
    for (const [id, value] of Object.entries(DEFAULT_KEYBOARD_SHORTCUTS)) {
      expect(normalizeShortcut(value), id).toBe(value)
      expect(isBindableShortcut(value), id).toBe(true)
    }
  })

  it('leaves Ctrl+Shift+P unclaimed for a future command palette', () => {
    expect(Object.values(DEFAULT_KEYBOARD_SHORTCUTS)).not.toContain('Ctrl+Shift+P')
  })

  it('describes every default in the settings list, and nothing extra', () => {
    const documented = KEYBOARD_SHORTCUT_DEFINITIONS.map((definition) => definition.id).sort()
    expect(documented).toEqual(Object.keys(DEFAULT_KEYBOARD_SHORTCUTS).sort())
  })
})
