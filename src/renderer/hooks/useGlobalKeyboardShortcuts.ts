import { useEffect } from 'react'
import { DEFAULT_KEYBOARD_SHORTCUTS, matchesShortcut } from '@shared/keyboardShortcuts'
import type { KeyboardShortcutMap } from '@shared/settings.types'
import { useChatStore } from '../stores/chatStore'
import { useProjectStore } from '../stores/projectStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSidebarCollapse } from '../stores/sidebarCollapseStore'
import { useUiStore, type AppView } from '../stores/uiStore'
import { useWorkspaceDock } from '../features/workspace-dock/useWorkspaceDock'
import { useCreateProject } from './useCreateProject'

/** Marks the chat composer's textarea so `focusComposer` can find it from anywhere. */
export const COMPOSER_INPUT_ATTR = 'data-composer-input'
/** Marks the terminal's xterm surface, which owns its own Ctrl-key bindings. */
export const TERMINAL_SURFACE_ATTR = 'data-terminal-surface'

const NAVIGATION: Array<[keyof KeyboardShortcutMap, AppView]> = [
  ['goChat', 'chat'],
  ['goScheduler', 'scheduler'],
  ['goAgent', 'agent'],
  ['goCriticalThinking', 'critical-thinking'],
  ['goEmail', 'email']
]

/** Registers user-editable app-level shortcuts that are not owned by a focused control. */
export function useGlobalKeyboardShortcuts(): void {
  const shortcuts = useSettingsStore((s) => s.settings?.keyboard.shortcuts)
  const openSettings = useUiStore((s) => s.openSettings)
  const setView = useUiStore((s) => s.setView)
  const setShortcutHelpOpen = useUiStore((s) => s.setShortcutHelpOpen)
  const newConversation = useChatStore((s) => s.newConversation)
  const toggleSidebar = useSidebarCollapse((s) => s.toggle)
  const setDockOpen = useWorkspaceDock((s) => s.setOpen)
  const createProject = useCreateProject()

  useEffect(() => {
    const activeShortcuts: KeyboardShortcutMap = shortcuts ?? DEFAULT_KEYBOARD_SHORTCUTS

    const handleKeyDown = (event: KeyboardEvent): void => {
      // A focused control that already claimed this key (slash suggestions in
      // the composer, an open menu) calls preventDefault — never double-fire.
      if (event.defaultPrevented) return

      // --- Shortcuts that stay live even while typing ---------------------

      if (matchesShortcut(event, activeShortcuts.openSettings)) {
        event.preventDefault()
        openSettings()
        return
      }

      if (matchesShortcut(event, activeShortcuts.showShortcutHelp)) {
        event.preventDefault()
        setShortcutHelpOpen(true)
        return
      }

      // Esc-to-stop has to work from the composer — that is where the user's
      // hands are mid-reply. It only acts while something is actually
      // streaming, so Esc stays free for everything else.
      if (matchesShortcut(event, activeShortcuts.stopGeneration) && isGenerating()) {
        // Esc also closes the temporary sidebar overlay; that reading wins
        // while the overlay is up, since it is the more recent intent.
        if (!useSidebarCollapse.getState().overlayOpen) {
          event.preventDefault()
          void useChatStore.getState().stopGeneration()
          return
        }
      }

      if (matchesShortcut(event, activeShortcuts.focusComposer)) {
        // The terminal owns Ctrl+L as "clear screen"; don't steal it there.
        if (!isTerminalTarget(event.target)) {
          event.preventDefault()
          setView('chat')
          // The chat view may still need to mount before the textarea exists.
          requestAnimationFrame(() => {
            document.querySelector<HTMLTextAreaElement>(`[${COMPOSER_INPUT_ATTR}]`)?.focus()
          })
          return
        }
      }

      // --- Shortcuts suppressed while a text field has focus ---------------

      if (isEditableTarget(event.target)) return

      if (matchesShortcut(event, activeShortcuts.newChat)) {
        event.preventDefault()
        newConversation(useProjectStore.getState().activeProjectId ?? null)
        setView('chat')
        return
      }

      if (matchesShortcut(event, activeShortcuts.newProject)) {
        event.preventDefault()
        void createProject()
        return
      }

      if (matchesShortcut(event, activeShortcuts.toggleSidebar)) {
        event.preventDefault()
        toggleSidebar()
        return
      }

      if (matchesShortcut(event, activeShortcuts.toggleWorkspaceDock)) {
        event.preventDefault()
        setDockOpen(!useWorkspaceDock.getState().open)
        return
      }

      for (const [id, view] of NAVIGATION) {
        if (matchesShortcut(event, activeShortcuts[id])) {
          event.preventDefault()
          setView(view)
          return
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    createProject,
    newConversation,
    openSettings,
    setDockOpen,
    setShortcutHelpOpen,
    setView,
    shortcuts,
    toggleSidebar
  ])
}

/** Read imperatively: this flips on every streamed token, and a reactive read
 *  would re-register the listener continuously. */
function isGenerating(): boolean {
  const state = useChatStore.getState()
  const conversation = state.conversations.find((c) => c.id === state.activeId)
  return conversation?.messages.some((message) => message.streaming) ?? false
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable
}

function isTerminalTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest(`[${TERMINAL_SURFACE_ATTR}]`))
}
