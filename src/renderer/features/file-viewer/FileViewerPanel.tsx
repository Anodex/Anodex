import { useEffect, useState } from 'react'
import type { WorkspaceFileContent } from '@shared/workspaceFileContent.types'
import { anodex } from '../../lib/anodex'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/ui/IconButton'
import { Spinner } from '../../components/ui/Spinner'
import { SegmentedToggle } from '../../components/ui/SegmentedToggle'
import { FileTypeIcon } from '../../components/FileTypeIcon'
import { formatBytes } from '../../lib/format'
import { languageForFileName } from '../../lib/highlight'
import { notifyError, useUiStore } from '../../stores/uiStore'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type {
  ComputerControlSession,
  DesktopControlWindowInfo
} from '@shared/computerControl.types'
import { useFileViewer } from './useFileViewer'
import { CodeEditor } from './CodeEditor'
import { ImageViewer } from './ImageViewer'
import { HtmlPreview } from './HtmlPreview'
import { UnsavedChangesDialog } from './UnsavedChangesDialog'
import styles from './FileViewerPanel.module.css'

function isHtmlFile(name: string): boolean {
  return /\.html?$/i.test(name)
}

type ViewerMode = 'preview' | 'code'

const MODE_OPTIONS: { label: string; value: ViewerMode }[] = [
  { label: 'Preview', value: 'preview' },
  { label: 'Code', value: 'code' }
]

/**
 * Takes over the Workspace Dock body (in place of the Plan/Files/Activity/
 * Outputs panel stack) while a file is open — the code/image/HTML
 * viewer-editor itself.
 */
export function FileViewerPanel(): JSX.Element | null {
  const node = useFileViewer((s) => s.node)
  const close = useFileViewer((s) => s.close)
  const notifySaved = useFileViewer((s) => s.notifySaved)
  const notify = useUiStore((s) => s.notify)
  const activeConversationId = useChatStore((s) => s.activeId)
  const desktopControlEnabled = useSettingsStore(
    (state) => state.settings?.computerControl.desktopControlEnabled ?? false
  )

  const [result, setResult] = useState<WorkspaceFileContent | null>(null)
  const [loading, setLoading] = useState(false)
  const [value, setValue] = useState('')
  const [originalValue, setOriginalValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const [mode, setMode] = useState<ViewerMode>('preview')
  // True when the AI wrote to this file while the buffer had unsaved edits —
  // shown as a non-blocking banner instead of silently clobbering those edits.
  const [externalChangePending, setExternalChangePending] = useState(false)
  const [controlSession, setControlSession] = useState<ComputerControlSession | null>(null)
  const [completedControlSession, setCompletedControlSession] =
    useState<ComputerControlSession | null>(null)
  const [allowProjectNavigation, setAllowProjectNavigation] = useState(false)
  const [desktopTargets, setDesktopTargets] = useState<DesktopControlWindowInfo[] | null>(null)
  const [loadingDesktopTargets, setLoadingDesktopTargets] = useState(false)

  const path = node?.path ?? null
  const isDirty = result?.kind === 'text' && value !== originalValue

  useEffect(() => {
    if (!path) return
    let cancelled = false
    setLoading(true)
    setResult(null)
    setMode('preview')
    setExternalChangePending(false)
    void anodex.workspace.readFileContent(path).then((res) => {
      if (cancelled) return
      setLoading(false)
      if (!res.ok) {
        notifyError('Could not open that file', res.error.message)
        close()
        return
      }
      setResult(res.value)
      if (res.value.kind === 'text') {
        setValue(res.value.content)
        setOriginalValue(res.value.content)
      }
    })
    return () => {
      cancelled = true
    }
  }, [path, close])

  // Live updates: when the AI writes/edits this same file, reflect it without
  // requiring the user to close and reopen. Auto-reloads only while the buffer
  // is clean — if the user has unsaved edits, silently swapping content out
  // from under them would discard those edits, so a banner offers Reload
  // instead. Only `write_file`/`edit_file` produce a `diff.path` to match on;
  // moves/deletes of the open file aren't covered here.
  useEffect(() => {
    if (!path) return
    return anodex.tools.onActivity((event) => {
      if (event.call.kind !== 'write' || event.call.status !== 'success') return
      if (event.call.diff?.path !== path) return
      if (isDirty) setExternalChangePending(true)
      else void reload()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, isDirty])

  async function reload(): Promise<void> {
    if (!path) return
    const res = await anodex.workspace.readFileContent(path)
    setExternalChangePending(false)
    if (!res.ok) {
      notifyError('Could not reload that file', res.error.message)
      close()
      return
    }
    setResult(res.value)
    if (res.value.kind === 'text') {
      setValue(res.value.content)
      setOriginalValue(res.value.content)
    }
  }

  // Keep an open pop-out preview current as the content changes — whether from
  // the user's own editing or an AI write that triggered the reload above.
  // `refreshHtmlPreviewWindow` is a no-op when no window is open for this
  // file, so this never resurrects one the user deliberately closed. Debounced
  // so a burst of keystrokes in Code mode doesn't reload the window per
  // character.
  useEffect(() => {
    if (!path || !isHtmlFile(path)) return
    const timer = setTimeout(() => {
      void anodex.workspace.refreshHtmlPreviewWindow(path, value)
    }, 400)
    return () => clearTimeout(timer)
  }, [path, value])

  useEffect(() => {
    return anodex.computerControl.onChanged((session) => {
      if (
        session?.target.scope !== 'anodex-file-viewer' &&
        session?.target.scope !== 'desktop' &&
        session?.target.path !== path
      )
        return
      if (session.status === 'ended') {
        setControlSession(null)
        setCompletedControlSession(session)
      } else {
        setControlSession(session)
      }
    })
  }, [path])

  useEffect(() => {
    if (!node) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (isDirty && !saving) void handleSave()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, isDirty, saving, value])

  if (!node) return null

  const fileName = node.name

  async function handleSave(): Promise<boolean> {
    if (!path || saving) return false
    setSaving(true)
    const res = await anodex.workspace.writeFileContent(path, value)
    setSaving(false)
    if (!res.ok) {
      notifyError('Could not save file', res.error.message)
      return false
    }
    setOriginalValue(value)
    notifySaved()
    notify({ kind: 'success', title: 'Saved', message: fileName })
    return true
  }

  function requestClose(): void {
    if (isDirty) setConfirmingClose(true)
    else close()
  }

  async function handleOpenPreviewWindow(): Promise<void> {
    if (!path) return
    const res = await anodex.workspace.openHtmlPreviewWindow(path, fileName, value)
    if (!res.ok) notifyError('Could not open a preview window', res.error.message)
  }

  async function handleEnableAiControl(): Promise<void> {
    if (!path) return
    const opened = await anodex.workspace.openHtmlPreviewWindow(path, fileName, value)
    if (!opened.ok) {
      notifyError('Could not open a preview window', opened.error.message)
      return
    }
    const conversationId = activeConversationId ?? useChatStore.getState().newConversation()
    const result = await anodex.computerControl.start({
      conversationId,
      previewPath: path,
      scope: allowProjectNavigation ? 'project-preview' : 'single-preview'
    })
    if (!result.ok) {
      notifyError('Could not enable AI control', result.error.message)
      return
    }
    setCompletedControlSession(null)
    setControlSession(result.value)
  }

  async function handleEnableFileViewerControl(): Promise<void> {
    const conversationId = activeConversationId ?? useChatStore.getState().newConversation()
    const result = await anodex.computerControl.start({
      conversationId,
      target: 'file-viewer'
    })
    if (!result.ok) {
      notifyError('Could not enable Anodex UI control', result.error.message)
      return
    }
    setCompletedControlSession(null)
    setControlSession(result.value)
  }

  async function handleChooseDesktopTarget(): Promise<void> {
    setLoadingDesktopTargets(true)
    const result = await anodex.computerControl.listDesktopTargets()
    setLoadingDesktopTargets(false)
    if (!result.ok) {
      notifyError('Desktop control is unavailable', result.error.message)
      return
    }
    setDesktopTargets(result.value)
  }

  async function handleEnableDesktopControl(target: DesktopControlWindowInfo): Promise<void> {
    const conversationId = activeConversationId ?? useChatStore.getState().newConversation()
    const result = await anodex.computerControl.start({
      conversationId,
      target: 'desktop',
      desktopWindowHandle: target.handle
    })
    if (!result.ok) {
      notifyError('Could not enable desktop control', result.error.message)
      return
    }
    setDesktopTargets(null)
    setCompletedControlSession(null)
    setControlSession(result.value)
  }

  async function handleControl(action: 'pause' | 'resume' | 'stop'): Promise<void> {
    if (!controlSession) return
    const result = await anodex.computerControl[action](controlSession.conversationId)
    if (!result.ok) {
      notifyError('Could not update AI control', result.error.message)
      return
    }
    setControlSession(result.value)
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.header}>
        <span className={styles.fileIcon}>
          <FileTypeIcon fileName={node.name} size={14} />
        </span>
        <span className={styles.name} title={node.path}>
          {node.name}
        </span>
        {isDirty && <span className={styles.dirtyDot} title="Unsaved changes" />}
        <span className={styles.spacer} />
        {result?.kind === 'text' && isHtmlFile(node.name) && (
          <SegmentedToggle
            value={mode}
            options={MODE_OPTIONS}
            onChange={setMode}
            computerControlTarget="file-viewer-mode"
          />
        )}
        {result?.kind === 'text' && isHtmlFile(node.name) && !controlSession && (
          <>
            <label className={styles.navigationOption}>
              <input
                type="checkbox"
                checked={allowProjectNavigation}
                onChange={(event) => setAllowProjectNavigation(event.target.checked)}
              />
              Follow project page links
            </label>
            <button
              type="button"
              className={styles.controlButton}
              onClick={() => void handleEnableAiControl()}
            >
              Enable AI control
            </button>
            <button
              type="button"
              className={styles.surfaceControlButton}
              onClick={() => void handleEnableFileViewerControl()}
            >
              Control this panel
            </button>
            {desktopControlEnabled && (
              <button
                type="button"
                className={styles.surfaceControlButton}
                onClick={() => void handleChooseDesktopTarget()}
                disabled={loadingDesktopTargets}
              >
                {loadingDesktopTargets ? 'Finding windows…' : 'Control desktop'}
              </button>
            )}
          </>
        )}
        {result?.kind === 'text' && isHtmlFile(node.name) && (
          <IconButton
            label="Open preview in its own window"
            icon={<Icon name="external-link" size={14} />}
            size="sm"
            onClick={() => void handleOpenPreviewWindow()}
          />
        )}
        {result?.kind === 'text' && (
          <IconButton
            label="Save file"
            data-computer-control-target="file-viewer-save"
            icon={<Icon name="save" size={14} />}
            size="sm"
            onClick={() => void handleSave()}
            disabled={!isDirty || saving}
          />
        )}
        <IconButton
          label="Close file"
          icon={<Icon name="close" size={14} />}
          size="sm"
          onClick={requestClose}
        />
      </div>

      {controlSession && (
        <div className={styles.controlStrip} role="status">
          <span>AI control {controlSession.status === 'paused' ? 'paused' : 'active'}</span>
          <span>
            {controlSession.target.scope === 'anodex-file-viewer'
              ? 'Anodex File Viewer'
              : controlSession.target.scope === 'desktop'
                ? controlSession.target.title
                : fileName}
          </span>
          {controlSession.target.scope === 'project-preview' && <span>Project links allowed</span>}
          <span className={styles.controlBudget}>
            {controlSession.budget.actionsUsed} / {controlSession.budget.actionLimit} actions
          </span>
          {controlSession.status === 'paused' ? (
            <button type="button" onClick={() => void handleControl('resume')}>
              Resume
            </button>
          ) : (
            <button type="button" onClick={() => void handleControl('pause')}>
              Pause
            </button>
          )}
          <button type="button" onClick={() => void handleControl('stop')}>
            Stop
          </button>
        </div>
      )}

      {(controlSession ?? completedControlSession) && (
        <ControlAudit session={controlSession ?? completedControlSession!} />
      )}

      {externalChangePending && (
        <div className={styles.externalChangeBanner}>
          <Icon name="alert" size={13} />
          <span className={styles.externalChangeText}>
            Anodex just edited this file while you had unsaved changes.
          </span>
          <button
            type="button"
            className={styles.externalChangeDismiss}
            onClick={() => setExternalChangePending(false)}
          >
            Keep my version
          </button>
          <button
            type="button"
            className={styles.externalChangeReload}
            onClick={() => void reload()}
          >
            Reload
          </button>
        </div>
      )}

      <div className={styles.body}>
        {loading || !result ? (
          <div className={styles.status}>
            <Spinner size={20} />
          </div>
        ) : result.kind === 'text' ? (
          isHtmlFile(node.name) && mode === 'preview' ? (
            <HtmlPreview content={value} path={node.path} fileName={node.name} />
          ) : (
            <CodeEditor
              value={value}
              onChange={setValue}
              language={languageForFileName(node.name)}
            />
          )
        ) : result.kind === 'image' ? (
          <ImageViewer dataUrl={result.dataUrl} fileName={node.name} />
        ) : (
          <div className={styles.status}>
            <div className={styles.statusMessage}>
              {result.kind === 'too-large'
                ? `This file is ${formatBytes(result.sizeBytes)} — too large to open here.`
                : "This looks like a binary file — Anodex can't display it here."}
            </div>
            <button
              type="button"
              className={styles.openExternal}
              onClick={() => void anodex.workspace.openPath(node.path)}
            >
              Open with default app
            </button>
          </div>
        )}
      </div>

      {confirmingClose && (
        <UnsavedChangesDialog
          name={node.name}
          onCancel={() => setConfirmingClose(false)}
          onDiscard={() => {
            setConfirmingClose(false)
            close()
          }}
          onSave={() => {
            setConfirmingClose(false)
            void handleSave().then((ok) => {
              if (ok) close()
            })
          }}
        />
      )}

      {desktopTargets && (
        <div className={styles.desktopPickerBackdrop} role="presentation">
          <section
            className={styles.desktopPicker}
            role="dialog"
            aria-modal="true"
            aria-label="Choose a desktop window"
          >
            <div>
              <h2>Choose a desktop window</h2>
              <p>
                The AI can act only in the window you choose. Every desktop action needs approval.
              </p>
            </div>
            <div className={styles.desktopTargetList}>
              {desktopTargets.length === 0 ? (
                <p>No eligible visible windows were found.</p>
              ) : (
                desktopTargets.map((target) => (
                  <button
                    key={target.handle}
                    type="button"
                    className={styles.desktopTarget}
                    onClick={() => void handleEnableDesktopControl(target)}
                  >
                    <span>{target.title}</span>
                    <small>{target.processPath.split(/[\\/]/).at(-1)}</small>
                  </button>
                ))
              )}
            </div>
            <button
              type="button"
              className={styles.desktopPickerCancel}
              onClick={() => setDesktopTargets(null)}
            >
              Cancel
            </button>
          </section>
        </div>
      )}
    </div>
  )
}

function ControlAudit({ session }: { session: ComputerControlSession }): JSX.Element {
  const isComplete = session.status === 'ended'
  return (
    <section className={styles.controlAudit} aria-label="AI control activity">
      <div className={styles.controlAuditTitle}>
        {isComplete
          ? `AI control ended: ${session.endReason?.replace(/-/g, ' ') ?? 'finished'}`
          : 'AI control activity'}
      </div>
      {session.audit.length === 0 ? (
        <div className={styles.controlAuditEmpty}>Waiting for the model’s first action.</div>
      ) : (
        <ol className={styles.controlAuditList}>
          {session.audit.map((entry) => (
            <li key={entry.id} className={styles[`controlAudit${entry.status}`]}>
              {entry.detail}
              {entry.screenshot && <span>Screenshot saved</span>}
            </li>
          ))}
        </ol>
      )}
      {isComplete && (
        <div className={styles.controlAuditHint}>
          Screenshots and action cards remain available in this conversation’s chat timeline.
        </div>
      )}
    </section>
  )
}
