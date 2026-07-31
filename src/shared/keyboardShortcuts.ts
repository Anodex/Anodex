import type { KeyboardShortcutId, KeyboardShortcutMap } from './settings.types'

export interface KeyboardShortcutDefinition {
  id: KeyboardShortcutId
  label: string
  description: string
  category: 'General' | 'Navigation' | 'Layout' | 'Chat' | 'Workspace Dock'
}

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcutMap = {
  newChat: 'Ctrl+N',
  newProject: 'Ctrl+Shift+N',
  // Ctrl+1..5 follow the sidebar's own nav order (see Sidebar.tsx), so the
  // number matches what the user counts down the rail.
  goChat: 'Ctrl+1',
  goScheduler: 'Ctrl+2',
  goAgent: 'Ctrl+3',
  goCriticalThinking: 'Ctrl+4',
  goEmail: 'Ctrl+5',
  searchSidebar: 'Ctrl+K',
  openSettings: 'Ctrl+,',
  toggleSidebar: 'Ctrl+B',
  toggleWorkspaceDock: 'Ctrl+J',
  focusComposer: 'Ctrl+L',
  // Esc is what every chat app trains people to press to stop a reply. It is
  // safe as a global default because the handler only acts while a reply is
  // actually streaming, and controls that own Esc themselves (slash
  // suggestions, the sidebar overlay) get it first — see
  // useGlobalKeyboardShortcuts.
  stopGeneration: 'Escape',
  showShortcutHelp: 'Ctrl+/',
  // Deliberately NOT Ctrl+Shift+P: that is the near-universal command-palette
  // binding, and a palette is the planned home for "everything else". Leaving
  // it unclaimed avoids retraining muscle memory later.
  toggleDockPlan: 'Ctrl+Shift+L',
  toggleDockFiles: 'Ctrl+Shift+F',
  toggleDockTerminal: 'Ctrl+Shift+T'
}

export const KEYBOARD_SHORTCUT_DEFINITIONS: KeyboardShortcutDefinition[] = [
  {
    id: 'newChat',
    label: 'New chat',
    description: 'Start a fresh chat in the current scope.',
    category: 'General'
  },
  {
    id: 'newProject',
    label: 'New project',
    description: 'Choose a folder and add it as a project.',
    category: 'General'
  },
  {
    id: 'goChat',
    label: 'Go to Chat',
    description: 'Return to the main chat view.',
    category: 'Navigation'
  },
  {
    id: 'goScheduler',
    label: 'Go to Scheduler',
    description: 'Open scheduled tasks.',
    category: 'Navigation'
  },
  {
    id: 'goAgent',
    label: 'Go to Agent',
    description: 'Open agent runs.',
    category: 'Navigation'
  },
  {
    id: 'goCriticalThinking',
    label: 'Go to Critical Thinking',
    description: 'Open deep research runs.',
    category: 'Navigation'
  },
  {
    id: 'goEmail',
    label: 'Go to Email',
    description: 'Open the email workspace.',
    category: 'Navigation'
  },
  {
    id: 'searchSidebar',
    label: 'Search sidebar',
    description: 'Focus the sidebar search field.',
    category: 'General'
  },
  {
    id: 'openSettings',
    label: 'Open settings',
    description: 'Open the Settings window.',
    category: 'General'
  },
  {
    id: 'toggleSidebar',
    label: 'Toggle sidebar',
    description: 'Collapse, expand, or show the sidebar overlay.',
    category: 'Layout'
  },
  {
    id: 'toggleWorkspaceDock',
    label: 'Toggle workspace dock',
    description: 'Open or close the right-side workspace dock.',
    category: 'Layout'
  },
  {
    id: 'focusComposer',
    label: 'Focus composer',
    description: 'Move focus back to the chat composer.',
    category: 'Chat'
  },
  {
    id: 'stopGeneration',
    label: 'Stop current reply',
    description: 'Stop the active assistant reply.',
    category: 'Chat'
  },
  {
    id: 'showShortcutHelp',
    label: 'Show all shortcuts',
    description: 'Open the shortcut cheat sheet over the current view.',
    category: 'General'
  },
  {
    id: 'toggleDockPlan',
    label: 'Toggle Plan panel',
    description: 'Open or close the workspace Plan panel.',
    category: 'Workspace Dock'
  },
  {
    id: 'toggleDockFiles',
    label: 'Toggle Files panel',
    description: 'Open or close the workspace Files panel.',
    category: 'Workspace Dock'
  },
  {
    id: 'toggleDockTerminal',
    label: 'Toggle Terminal panel',
    description: 'Open or close the workspace Terminal panel.',
    category: 'Workspace Dock'
  }
]

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const

interface ShortcutEvent {
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  key: string
  /**
   * Physical key. Needed because `key` reports the *shifted glyph* for digits
   * and punctuation — with Shift held, `Ctrl+Shift+1` arrives as `key: '!'`,
   * so a binding stored as "Ctrl+Shift+1" could never match. `code` is
   * layout-dependent for letters, so it is only consulted for digits.
   */
  code?: string
}

export function normalizeShortcut(value: string): string {
  const rawParts = value
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (rawParts.length === 0) return ''

  const modifiers = new Set<string>()
  let key = ''
  for (const part of rawParts) {
    const canonical = canonicalPart(part)
    if (MODIFIER_ORDER.includes(canonical as (typeof MODIFIER_ORDER)[number])) {
      modifiers.add(canonical)
    } else {
      key = canonical
    }
  }
  if (!key) return ''
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), key].join('+')
}

export function shortcutFromEvent(event: ShortcutEvent): string {
  const digit = /^Digit([0-9])$/.exec(event.code ?? '')
  const key = digit ? digit[1] : canonicalKey(event.key)
  if (!key || isModifierKey(key)) return ''

  const parts: string[] = []
  if (event.ctrlKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  parts.push(key)
  return parts.join('+')
}

export function matchesShortcut(event: ShortcutEvent, shortcut: string): boolean {
  const normalized = normalizeShortcut(shortcut)
  if (!normalized) return false
  return shortcutFromEvent(event) === normalized
}

/**
 * Keys that may stand alone as a global binding. Anything else without a
 * Ctrl/Alt/Meta modifier would swallow ordinary typing the moment focus sits
 * outside a text field.
 */
const STANDALONE_KEYS = new Set(['Escape'])

/** Whether a shortcut is safe to register globally. */
export function isBindableShortcut(shortcut: string): boolean {
  const normalized = normalizeShortcut(shortcut)
  if (!normalized) return false
  const parts = normalized.split('+')
  if (parts.some((part) => part === 'Ctrl' || part === 'Alt' || part === 'Meta')) return true
  const key = parts[parts.length - 1] ?? ''
  return STANDALONE_KEYS.has(key) || /^F([1-9]|1[0-2])$/.test(key)
}

function canonicalPart(part: string): string {
  const lower = part.toLowerCase()
  if (lower === 'control' || lower === 'ctrl') return 'Ctrl'
  if (lower === 'option' || lower === 'alt') return 'Alt'
  if (lower === 'shift') return 'Shift'
  if (lower === 'cmd' || lower === 'command' || lower === 'meta' || lower === 'super') return 'Meta'
  return canonicalKey(part)
}

function canonicalKey(key: string): string {
  if (key.length === 1) return key.toUpperCase()
  if (key === ' ') return 'Space'
  if (key.startsWith('Arrow')) return key
  return key[0]?.toUpperCase() + key.slice(1)
}

function isModifierKey(key: string): boolean {
  return key === 'Ctrl' || key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta'
}
