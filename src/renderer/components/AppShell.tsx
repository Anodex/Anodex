import { useCallback, useEffect, useRef, useState } from 'react'
import { useStoreWithEqualityFn } from 'zustand/traditional'
import { useUiStore } from '../stores/uiStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useProjectStore } from '../stores/projectStore'
import { useChatStore } from '../stores/chatStore'
import { conversationsRelevantlyEqual } from '../lib/conversationEquality'
import { useWorkspaceDock } from '../features/workspace-dock/useWorkspaceDock'
import { useTheme } from '../hooks/useTheme'
import { Sidebar } from './Sidebar'
import { TitleBar } from './TitleBar'
import { Toasts } from './Toasts'
import { ChatView } from '../features/chat/ChatView'
import { SchedulerView } from '../features/scheduler/SchedulerView'
import { AgentView } from '../features/agent/AgentView'
import { PlaceholderView } from '../features/placeholder/PlaceholderView'
import { SettingsModal } from './SettingsModal'
import { WorkspaceDock } from '../features/workspace-dock/WorkspaceDock'
import { ContextMenu } from './ContextMenu'
import { ErrorBoundary } from './ErrorBoundary'
import styles from './AppShell.module.css'

const MIN_SIDEBAR = 200
const MAX_SIDEBAR = 400
const MIN_DOCK = 280
const MAX_DOCK = 800
const MIN_MAIN = 360
const SIDEBAR_KEY = 'anodex:sidebarWidth'
const DOCK_KEY = 'anodex:dockWidth'

function getMainLabel(view: ReturnType<typeof useUiStore.getState>['view']): string {
  if (view === 'scheduler') return 'Scheduled tasks'
  if (view === 'agent') return 'Agent'
  if (view === 'critical-thinking') return 'Critical Thinking'
  return 'Chat'
}

function renderMainView(view: ReturnType<typeof useUiStore.getState>['view']): JSX.Element {
  if (view === 'scheduler') return <SchedulerView />
  if (view === 'agent') return <AgentView />
  if (view === 'critical-thinking') {
    return <PlaceholderView icon="globe" title="Critical Thinking" />
  }
  return <ChatView />
}

export function AppShell(): JSX.Element {
  const view = useUiStore((s) => s.view)
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
  useTheme({ appearance })

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
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [dockWidth]
  )

  const clampSidebarWidth = useCallback(
    (value: number, currentDockWidth = dockWidth): number => {
      const reservedDock = dockOpen ? currentDockWidth : 0
      const dynamicMax = Math.max(
        MIN_SIDEBAR,
        Math.min(MAX_SIDEBAR, window.innerWidth - reservedDock - MIN_MAIN)
      )
      return Math.min(dynamicMax, Math.max(MIN_SIDEBAR, value))
    },
    [dockOpen, dockWidth]
  )

  const clampDockWidth = useCallback(
    (value: number, currentSidebarWidth = sidebarWidth): number => {
      const dynamicMax = Math.max(
        MIN_DOCK,
        Math.min(MAX_DOCK, window.innerWidth - currentSidebarWidth - MIN_MAIN)
      )
      return Math.min(dynamicMax, Math.max(MIN_DOCK, value))
    },
    [sidebarWidth]
  )

  useEffect(() => {
    const handleResize = (): void => {
      setSidebarWidth((width) => clampSidebarWidth(width))
      setDockWidth((width) => clampDockWidth(width))
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [clampDockWidth, clampSidebarWidth])

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

  return (
    <div
      className={`${styles.shell} ${dockOpen ? styles.shellDockOpen : ''}`}
      style={
        {
          '--sidebar-width': `${sidebarWidth}px`,
          '--dock-width': `${dockWidth}px`
        } as React.CSSProperties
      }
    >
      <div className={styles.titleBar}>
        <ErrorBoundary label="Title bar">
          <TitleBar />
        </ErrorBoundary>
      </div>
      <div className={styles.sidebar}>
        <ErrorBoundary label="Sidebar">
          <Sidebar />
        </ErrorBoundary>
        <div className={styles.resizeHandle} onPointerDown={handleSidebarDown} />
      </div>
      <main className={styles.main}>
        <ErrorBoundary label={getMainLabel(view)}>{renderMainView(view)}</ErrorBoundary>
      </main>
      {dockOpen && (
        <div className={styles.dockWrap}>
          <div className={styles.dockHandle} onPointerDown={handleDockDown} />
          <ErrorBoundary label="Workspace Dock">
            <WorkspaceDock />
          </ErrorBoundary>
        </div>
      )}
      <Toasts />
      <ContextMenu />
      {view === 'settings' && (
        <ErrorBoundary label="Settings">
          <SettingsModal />
        </ErrorBoundary>
      )}
    </div>
  )
}
