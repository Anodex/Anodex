import { useCallback, useEffect, useMemo, useState } from 'react'
import type { WorkspaceTreeNode } from '@shared/workspaceFiles.types'
import { anodex } from '../../../lib/anodex'
import { Icon } from '../../../components/Icon'
import { Spinner } from '../../../components/ui/Spinner'
import { filterFileTree } from '../../../lib/fileTreeSearch'
import { useProjectStore } from '../../../stores/projectStore'
import { useFileViewer } from '../../file-viewer/useFileViewer'
import { WorkspaceDockPanel } from '../WorkspaceDockPanel'
import { FileTreeRow } from './FileTreeRow'
import styles from './FilesPanel.module.css'

/** Files in the active workspace, as a real folder tree, each marked with who last edited it. */
export function FilesPanel(): JSX.Element {
  const [nodes, setNodes] = useState<WorkspaceTreeNode[] | null>(null)
  const [query, setQuery] = useState('')
  // The main process scopes `workspace:list-files` to whichever project is
  // currently active; re-running the effect when it changes keeps this panel
  // in sync instead of leaving the previous project's files on screen.
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  // Bumped by the file-viewer/editor on every successful manual save, so this
  // panel's size/time/edited-by columns stay current the same way they
  // already do after an AI write.
  const saveVersion = useFileViewer((s) => s.saveVersion)

  const refresh = useCallback(async () => {
    const result = await anodex.workspace.listFiles()
    setNodes(result.ok ? result.value : [])
  }, [])

  useEffect(() => {
    // Drop the stale list immediately so a project switch never shows the
    // previous project's files while the refetch is in flight.
    setNodes(null)
    setQuery('')
    void refresh()
    // Keep the list current as the AI reads/writes files during a session.
    return anodex.tools.onActivity((event) => {
      if (event.call.kind === 'write' && event.call.status === 'success') void refresh()
    })
  }, [refresh, activeProjectId])

  // A manual save from the file-viewer/editor doesn't go through `tools:activity`
  // (it's a direct user action, not an AI tool call) — refresh separately for it.
  useEffect(() => {
    if (saveVersion > 0) void refresh()
  }, [refresh, saveVersion])

  const visibleNodes = useMemo(() => (nodes ? filterFileTree(nodes, query) : null), [nodes, query])
  const isSearching = query.trim().length > 0

  return (
    <WorkspaceDockPanel title="Files">
      {nodes !== null && nodes.length > 0 && (
        <div className={styles.search}>
          <Icon name="search" size={13} className={styles.searchIcon} />
          <input
            type="text"
            className={styles.searchInput}
            placeholder="Search files"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {isSearching && (
            <button
              type="button"
              className={styles.searchClear}
              onClick={() => setQuery('')}
              aria-label="Clear search"
              title="Clear search"
            >
              <Icon name="close" size={12} />
            </button>
          )}
        </div>
      )}
      {nodes === null ? (
        <div className={styles.loading}>
          <Spinner size={14} />
        </div>
      ) : nodes.length === 0 ? (
        'No session files yet.'
      ) : visibleNodes && visibleNodes.length === 0 ? (
        <div className={styles.noResults}>No files match &quot;{query.trim()}&quot;.</div>
      ) : (
        <ul className={styles.tree}>
          {visibleNodes?.map((node) => (
            <FileTreeRow
              key={node.path}
              node={node}
              depth={0}
              onRefresh={() => void refresh()}
              forceExpanded={isSearching}
            />
          ))}
        </ul>
      )}
    </WorkspaceDockPanel>
  )
}
