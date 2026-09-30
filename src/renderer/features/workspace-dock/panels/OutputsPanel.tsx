import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WorkspaceFileEntry, WorkspaceTreeNode } from '@shared/workspaceFiles.types'
import { FileTypeIcon } from '../../../components/FileTypeIcon'
import { anodex } from '../../../lib/anodex'
import { formatClock } from '../../../lib/format'
import { useChatStore } from '../../../stores/chatStore'
import { useProjectStore } from '../../../stores/projectStore'
import { useFileViewer } from '../../file-viewer/useFileViewer'
import { activityOf, outputsOf, readablePath } from '../dockActivity'
import { DockEmpty, WorkspaceDockPanel } from '../WorkspaceDockPanel'
import styles from './OutputsPanel.module.css'

function indexFiles(nodes: WorkspaceTreeNode[], into = new Map<string, WorkspaceFileEntry>()) {
  for (const node of nodes) {
    if (node.type === 'file') into.set(node.path, node)
    else indexFiles(node.children, into)
  }
  return into
}

/**
 * What this conversation made: every file Anodex created, changed, moved, or
 * deleted in it, once each, most recent first. A file that still exists opens
 * in the viewer; one that was deleted or moved away says so.
 */
export function OutputsPanel(): JSX.Element {
  const messages = useChatStore((s) => s.conversations.find((c) => c.id === s.activeId)?.messages)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const openFile = useFileViewer((s) => s.open)
  const [files, setFiles] = useState<Map<string, WorkspaceFileEntry>>(new Map())
  const outputs = useMemo(() => outputsOf(activityOf(messages)), [messages])

  const refresh = useCallback(async () => {
    const result = await anodex.workspace.listFiles()
    setFiles(result.ok ? indexFiles(result.value) : new Map())
  }, [])

  useEffect(() => {
    void refresh()
    return anodex.tools.onActivity((event) => {
      if (event.call.kind === 'write' && event.call.status === 'success') void refresh()
    })
  }, [refresh, activeProjectId])

  if (outputs.length === 0) {
    return (
      <WorkspaceDockPanel title="Outputs">
        <DockEmpty icon="file" title="Nothing made yet">
          Files Anodex creates or changes in this chat collect here, so you can open what it made
          without scrolling back through the conversation.
        </DockEmpty>
      </WorkspaceDockPanel>
    )
  }

  return (
    <WorkspaceDockPanel title="Outputs">
      <ul className={styles.list}>
        {outputs.map((output) => {
          const entry = files.get(output.path)
          const name = output.path.slice(output.path.lastIndexOf('/') + 1)
          const folder = output.path.slice(0, output.path.length - name.length).replace(/\/$/, '')
          return (
            <li key={output.path}>
              <button
                type="button"
                className={styles.row}
                disabled={!entry}
                onClick={() => entry && openFile(entry)}
                title={entry ? `Open ${output.path}` : `${output.path} is no longer in the project`}
              >
                <FileTypeIcon fileName={name} size={15} />
                <span className={styles.text}>
                  <span className={styles.name}>{name}</span>
                  <span className={styles.folder}>
                    {entry ? readablePath(folder) : 'Deleted or moved'}
                  </span>
                </span>
                <span className={styles.time}>{formatClock(output.at)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </WorkspaceDockPanel>
  )
}
