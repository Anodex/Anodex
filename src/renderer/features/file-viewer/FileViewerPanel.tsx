import { useEffect, useState } from 'react'
import type { WorkspaceFileContent } from '@shared/workspaceFileContent.types'
import { anodex } from '../../lib/anodex'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/ui/IconButton'
import { Spinner } from '../../components/ui/Spinner'
import { FileTypeIcon } from '../../components/FileTypeIcon'
import { formatBytes } from '../../lib/format'
import { languageForFileName } from '../../lib/highlight'
import { notifyError, useUiStore } from '../../stores/uiStore'
import { useFileViewer } from './useFileViewer'
import { CodeEditor } from './CodeEditor'
import { ImageViewer } from './ImageViewer'
import { HtmlPreview } from './HtmlPreview'
import { UnsavedChangesDialog } from './UnsavedChangesDialog'
import styles from './FileViewerPanel.module.css'

function isHtmlFile(name: string): boolean {
  return /\.html?$/i.test(name)
}

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

  const [result, setResult] = useState<WorkspaceFileContent | null>(null)
  const [loading, setLoading] = useState(false)
  const [value, setValue] = useState('')
  const [originalValue, setOriginalValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmingClose, setConfirmingClose] = useState(false)
  const [mode, setMode] = useState<'preview' | 'code'>('preview')
  // True when the AI wrote to this file while the buffer had unsaved edits —
  // shown as a non-blocking banner instead of silently clobbering those edits.
  const [externalChangePending, setExternalChangePending] = useState(false)

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
          <div className={styles.modeToggle}>
            <button
              type="button"
              className={mode === 'preview' ? styles.modeActive : styles.modeButton}
              onClick={() => setMode('preview')}
            >
              Preview
            </button>
            <button
              type="button"
              className={mode === 'code' ? styles.modeActive : styles.modeButton}
              onClick={() => setMode('code')}
            >
              Code
            </button>
          </div>
        )}
        {result?.kind === 'text' && (
          <IconButton
            label="Save file"
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
            <HtmlPreview content={value} fileName={node.name} />
          ) : (
            <CodeEditor value={value} onChange={setValue} language={languageForFileName(node.name)} />
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
    </div>
  )
}
