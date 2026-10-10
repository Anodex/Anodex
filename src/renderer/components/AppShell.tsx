import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { useUiStore } from '../stores/uiStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useProjectStore } from '../stores/projectStore'
import { useChatStore } from '../stores/chatStore'
import { conversationsRelevantlyEqual } from '../lib/conversationEquality'
import { useWorkspaceDock } from '../features/workspace-dock/useWorkspaceDock'
import {
  useSidebarCollapse,
  SIDEBAR_COLLAPSE_BREAKPOINT,
  SIDEBAR_RAIL_WIDTH
} from '../stores/sidebarCollapseStore'
import { useTheme } from '../hooks/useTheme'
import { useNavigationBadgeCounts } from '../hooks/useNavigationBadgeCounts'
import { useGlobalKeyboardShortcuts } from '../hooks/useGlobalKeyboardShortcuts'
import { Sidebar } from './Sidebar'
import { SidebarRail } from './sidebar/SidebarRail'
import { TitleBar } from './TitleBar'
import { Toasts } from './Toasts'
import { ChatView } from '../features/chat/ChatView'
import { ScreenLoading } from './ui/ScreenLoading'
import { SettingsModal } from './SettingsModal'
import { WorkspaceDock } from '../features/workspace-dock/WorkspaceDock'
import { useWorkspaceDockProjectId } from '../features/workspace-dock/useWorkspaceDockAvailability'
import { ShortcutHelpOverlay } from '../features/shortcuts/ShortcutHelpOverlay'
import { SafeModeDialog } from '../features/startup/SafeModeDialog'
import { ContextMenu } from './ContextMenu'
import { ErrorBoundary } from './ErrorBoundary'
import styles from './AppShell.module.css'

// Screens a launch mostly never opens are read when first opened, rather than
// parsed with the chat at startup. Chat stays in the startup bundle: it is the
// screen every launch shows first.
const SchedulerView = lazy(() =>
  import('../features/scheduler/SchedulerView').then((m) => ({ default: m.SchedulerView }))
)
const AgentView = lazy(() =>
  import('../features/agent/AgentView').then((m) => ({ default: m.AgentView }))
)
const EmailView = lazy(() =>
  import('../features/email/EmailView').then((m) => ({ default: m.EmailView }))
)
const CriticalThinkingView = lazy(() =>
  import('../features/critical-thinking/CriticalThinkingView').then((m) => ({
    default: m.CriticalThinkingView
  }))
)

const MIN_SIDEBAR = 200
const MAX_SIDEBAR = 400
const MIN_DOCK = 280
const MAX_DOCK = 800
const MIN_MAIN = 360
const SIDEBAR_KEY = 'anodex:sidebarWidth'
const DOCK_KEY = 'anodex:dockWidth'
const RESIZE_STEP = 16
const RESIZE_STEP_LARGE = 48
// Below this window width there isn't room for sidebar + main + dock side by
// side without crushing the chat, so the dock floats over main instead.
const NARROW_BREAKPOINT = 1012

function getMainLabel(view: ReturnType<typeof useUiStore.getState>['view']): string {
  if (view === 'scheduler') return 'Scheduled tasks'
  if (view === 'agent') return 'Agent'
  if (view === 'critical-thinking') return 'Critical Thinking'
  if (view === 'email') return 'Email'
  return 'Chat'
}

function renderMainView(view: ReturnType<typeof useUiStore.getState>['view']): JSX.Element {
  if (view === 'scheduler') return <SchedulerView />
  if (view === 'agent') return <AgentView />
  if (view === 'critical-thinking') return <CriticalThinkingView />
  if (view === 'email') return <EmailView />
  return <ChatView />
}

export function AppShell(): JSX.Element {
  const view = useUiStore((s) => s.view)
  const navigationBadges = useNavigationBadgeCounts()
  const appearance = useSettingsStore((s) => s.settings?.appearance)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const conversations = useStoreWithEqualityFn(
    useChatStore,
    (s) => s.conversations,
    conversationsRelevantlyEqual
  )
  const chatsLoaded = useChatStore((s) => s.loaded)
  const newConversation = useChatStore((s) => s.newConversation)
  const dockOpen = useWorkspaceDock((s) => s.open)
  const setDockOpen = useWorkspaceDock((s) => s.setOpen)
  const dockProjectId = useWorkspaceDockProjectId()
  const dockVisible = dockOpen && Boolean(dockProjectId)
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < NARROW_BREAKPOINT)
  const isAutoCollapsed = useSidebarCollapse((s) => s.autoCollapsed)
  const isManuallyCollapsed = useSidebarCollapse((s) => s.manuallyCollapsed)
  const sidebarOverlayOpen = useSidebarCollapse((s) => s.overlayOpen)
  const setAutoCollapsed = useSidebarCollapse((s) => s.setAutoCollapsed)
  const setSidebarOverlayOpen = useSidebarCollapse((s) => s.setOverlayOpen)
  const isSidebarCollapsed = isAutoCollapsed || isManuallyCollapsed
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      return Number(localStorage.getItem(SIDEBAR_KEY)) || 248
    } catch {
      return 248
    }
  })
  const [dockWidth, setDockWidth] = useState(() => {
    try {
      return Number(localStorage.getItem(DOCK_KEY)) || 380
    } catch {
      return 380
    }
  })
  const resizing = useRef<'sidebar' | 'dock' | null>(null)
  const startX = useRef(0)
  const startWidth = useRef(0)
  // `.shell`'s grid-template-columns transition is meant to animate the
  // sidebar/dock *toggling* open and closed — but grid-template-columns is
  // also what a live resize drag changes every pointermove, so without this
  // it fights the drag: the column visibly lags behind the cursor and
  // rubber-bands into place instead of tracking it 1:1.
  const [isResizingLive, setIsResizingLive] = useState(false)
  useTheme({ appearance })
  useGlobalKeyboardShortcuts()

  useEffect(() => {
    if (!activeProjectId || !chatsLoaded) return
    const hasChats = conversations.some((c) => c.projectId === activeProjectId)
    if (!hasChats) newConversation(activeProjectId)
  }, [activeProjectId, chatsLoaded, conversations, newConversation])

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, String(sidebarWidth))
    } catch {
      /* noop */
    }
  }, [sidebarWidth])

  useEffect(() => {
    try {
      localStorage.setItem(DOCK_KEY, String(dockWidth))
    } catch {
      /* noop */
    }
  }, [dockWidth])

  const handleSidebarDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      resizing.current = 'sidebar'
      startX.current = e.clientX
      startWidth.current = sidebarWidth
      setIsResizingLive(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [sidebarWidth]
  )

  const handleDockDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      resizing.current = 'dock'
      startX.current = e.clientX
      startWidth.current = dockWidth
      setIsResizingLive(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [dockWidth]
  )

  const clampSidebarWidth = useCallback(
    (value: number, currentDockWidth = dockWidth): number => {
      const reservedDock = dockVisible && !isNarrow ? currentDockWidth : 0
      const dynamicMax = Math.max(
        MIN_SIDEBAR,
        Math.min(MAX_SIDEBAR, window.innerWidth - SIDEBAR_RAIL_WIDTH - reservedDock - MIN_MAIN)
      )
      return Math.min(dynamicMax, Math.max(MIN_SIDEBAR, value))
    },
    [dockVisible, dockWidth, isNarrow]
  )

  const clampDockWidth = useCallback(
    (value: number, currentSidebarWidth = isSidebarCollapsed ? 0 : sidebarWidth): number => {
      const dynamicMax = Math.max(
        MIN_DOCK,
        Math.min(MAX_DOCK, window.innerWidth - SIDEBAR_RAIL_WIDTH - currentSidebarWidth - MIN_MAIN)
      )
      return Math.min(dynamicMax, Math.max(MIN_DOCK, value))
    },
    [isSidebarCollapsed, sidebarWidth]
  )

  const sidebarDynamicMax = Math.max(
    MIN_SIDEBAR,
    Math.min(
      MAX_SIDEBAR,
      window.innerWidth - SIDEBAR_RAIL_WIDTH - (dockVisible && !isNarrow ? dockWidth : 0) - MIN_MAIN
    )
  )
  const dockDynamicMax = Math.max(
    MIN_DOCK,
    Math.min(
      MAX_DOCK,
      window.innerWidth - SIDEBAR_RAIL_WIDTH - (isSidebarCollapsed ? 0 : sidebarWidth) - MIN_MAIN
    )
  )

  const handleSidebarKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        setSidebarWidth((width) => clampSidebarWidth(width + step))
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setSidebarWidth((width) => clampSidebarWidth(width - step))
      } else if (e.key === 'Home') {
        e.preventDefault()
        setSidebarWidth(MIN_SIDEBAR)
      } else if (e.key === 'End') {
        e.preventDefault()
        setSidebarWidth(clampSidebarWidth(MAX_SIDEBAR))
      }
    },
    [clampSidebarWidth]
  )

  const handleDockKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? RESIZE_STEP_LARGE : RESIZE_STEP
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setDockWidth((width) => clampDockWidth(width + step))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setDockWidth((width) => clampDockWidth(width - step))
      } else if (e.key === 'Home') {
        e.preventDefault()
        setDockWidth(MIN_DOCK)
      } else if (e.key === 'End') {
        e.preventDefault()
        setDockWidth(clampDockWidth(MAX_DOCK))
      }
    },
    [clampDockWidth]
  )

  useEffect(() => {
    const handleResize = (): void => {
      setIsNarrow(window.innerWidth < NARROW_BREAKPOINT)
      setAutoCollapsed(window.innerWidth < SIDEBAR_COLLAPSE_BREAKPOINT)
      setSidebarWidth((width) => clampSidebarWidth(width))
      setDockWidth((width) => clampDockWidth(width))
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [clampDockWidth, clampSidebarWidth, setAutoCollapsed])

  useEffect(() => {
    if (!sidebarOverlayOpen) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSidebarOverlayOpen(false)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [sidebarOverlayOpen, setSidebarOverlayOpen])

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const edge = resizing.current
      if (!edge) return
      const delta = e.clientX - startX.current
      if (edge === 'sidebar') {
        setSidebarWidth(clampSidebarWidth(startWidth.current + delta))
      } else {
        setDockWidth(clampDockWidth(startWidth.current - delta))
      }
    }
    const handleUp = () => {
      if (!resizing.current) return
      resizing.current = null
      setIsResizingLive(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
    return () => {
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
    }
  }, [clampDockWidth, clampSidebarWidth])

  // The dock's grid column only reserves real width when it's actually
  // docked (open and not floating over a narrow window) — otherwise it
  // collapses to 0 so the always-3-column template (see AppShell.module.css)
  // reads as "no dock" without needing a separate 2-column template.
  const dockColumnWidth = dockVisible && !isNarrow ? dockWidth : 0

  return (
    <div
      className={`${styles.shell} ${isResizingLive ? styles.shellResizing : ''}`}
      style={
        {
          '--sidebar-rail-width': `${SIDEBAR_RAIL_WIDTH}px`,
          '--sidebar-width': `${SIDEBAR_RAIL_WIDTH + (isSidebarCollapsed ? 0 : sidebarWidth)}px`,
          '--sidebar-panel-width': `${isSidebarCollapsed ? 0 : sidebarWidth}px`,
          '--sidebar-expanded-width': `${sidebarWidth}px`,
          '--dock-width': `${dockColumnWidth}px`
        } as React.CSSProperties
      }
    >
      <div className={styles.titleBar}>
        <ErrorBoundary label="Title bar">
          <TitleBar />
        </ErrorBoundary>
      </div>
      <div className={styles.sidebarRail}>
        <ErrorBoundary label="Sidebar rail">
          <SidebarRail counts={navigationBadges} />
        </ErrorBoundary>
      </div>
      <div className={styles.sidebarPanel} id="project-chat-sidebar">
        {!isSidebarCollapsed && (
          <>
            <ErrorBoundary label="Project and chat sidebar">
              <Sidebar />
            </ErrorBoundary>
            <div
              className={styles.resizeHandle}
              onPointerDown={handleSidebarDown}
              onKeyDown={handleSidebarKeyDown}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              aria-valuenow={sidebarWidth}
              aria-valuemin={MIN_SIDEBAR}
              aria-valuemax={sidebarDynamicMax}
              tabIndex={0}
            />
          </>
        )}
      </div>
      <main className={styles.main}>
        <ErrorBoundary label={getMainLabel(view)}>
          <Suspense fallback={<ScreenLoading />}>{renderMainView(view)}</Suspense>
        </ErrorBoundary>
      </main>
      {isSidebarCollapsed && sidebarOverlayOpen && (
        <div
          className={`${styles.dockBackdrop} ${styles.sidebarBackdrop}`}
          onClick={() => setSidebarOverlayOpen(false)}
        />
      )}
      {isSidebarCollapsed && sidebarOverlayOpen && (
        <div className={styles.sidebarOverlay} id="project-chat-sidebar-overlay">
          <ErrorBoundary label="Project and chat sidebar">
            <Sidebar />
          </ErrorBoundary>
        </div>
      )}
      {dockVisible && isNarrow && (
        <div className={styles.dockBackdrop} onClick={() => setDockOpen(false)} />
      )}
      {dockVisible && (
        <div className={`${styles.dockWrap} ${isNarrow ? styles.dockWrapFloating : ''}`}>
          <div
            className={styles.dockHandle}
            onPointerDown={handleDockDown}
            onKeyDown={handleDockKeyDown}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize workspace dock"
            aria-valuenow={dockWidth}
            aria-valuemin={MIN_DOCK}
            aria-valuemax={dockDynamicMax}
            tabIndex={0}
          />
          <ErrorBoundary label="Workspace Dock">
            <WorkspaceDock />
          </ErrorBoundary>
        </div>
      )}
      <Toasts />
      <ContextMenu />
      <ShortcutHelpOverlay />
      <ErrorBoundary label="Model recovery">
        <SafeModeDialog />
      </ErrorBoundary>
      {view === 'settings' && (
        <ErrorBoundary label="Settings">
          <SettingsModal />
        </ErrorBoundary>
      )}
    </div>
  )
}
