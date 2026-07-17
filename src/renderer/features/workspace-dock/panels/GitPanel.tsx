import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitWorkspaceStatus } from '@shared/git.types'
import { Icon } from '../../../components/Icon'
import { Spinner } from '../../../components/ui/Spinner'
import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'
import { anodex } from '../../../lib/anodex'
import { notifyError, useUiStore } from '../../../stores/uiStore'
import { useSettingsStore } from '../../../stores/settingsStore'
import { WorkspaceDockPanel } from '../WorkspaceDockPanel'
import { useWorkspaceDockProjectId } from '../useWorkspaceDockAvailability'
import styles from './GitPanel.module.css'

export function GitPanel(): JSX.Element {
  const projectId = useWorkspaceDockProjectId()
  const notify = useUiStore((s) => s.notify)
  const confirmDestructive = useSettingsStore((s) => s.settings?.general.confirmDestructive ?? true)

  const [status, setStatus] = useState<GitWorkspaceStatus | null>(null)
  const [initializing, setInitializing] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [committing, setCommitting] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [confirmingPush, setConfirmingPush] = useState(false)

  const [menuOpen, setMenuOpen] = useState(false)
  const [branches, setBranches] = useState<string[] | null>(null)
  const [branchFilter, setBranchFilter] = useState('')
  const [switchingBranch, setSwitchingBranch] = useState<string | null>(null)
  const [creatingBranch, setCreatingBranch] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [branching, setBranching] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    if (!projectId) {
      setStatus(null)
      return
    }
    const result = await anodex.git.getStatus(projectId)
    if (!result.ok) {
      notifyError('Could not read git status', result.error.message)
      return
    }
    setStatus(result.value)
  }, [projectId])

  useEffect(() => {
    setStatus(null)
    void refresh()
    const unsubscribe = anodex.tools.onActivity((event) => {
      if (event.call.kind === 'write' && event.call.status === 'success') void refresh()
    })
    return unsubscribe
  }, [refresh])

  useEffect(() => {
    function handleClickOutside(event: MouseEvent): void {
      if (!menuRef.current?.contains(event.target as Node)) closeMenu()
    }
    if (menuOpen) document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  const closeMenu = (): void => {
    setMenuOpen(false)
    setCreatingBranch(false)
    setNewBranchName('')
    setBranchFilter('')
  }

  const openMenu = async (): Promise<void> => {
    if (!projectId) return
    setMenuOpen(true)
    setBranches(null)
    const result = await anodex.git.listBranches(projectId)
    if (!result.ok) {
      notifyError('Could not list branches', result.error.message)
      setBranches([])
      return
    }
    setBranches(result.value)
  }

  const initRepo = async (): Promise<void> => {
    if (!projectId || initializing) return
    setInitializing(true)
    try {
      const result = await anodex.git.init(projectId)
      if (!result.ok) {
        notifyError('Could not initialize repository', result.error.message)
        return
      }
      setStatus(result.value)
    } finally {
      setInitializing(false)
    }
  }

  const switchTo = async (name: string): Promise<void> => {
    if (!projectId || switchingBranch || name === status?.branch) return
    setSwitchingBranch(name)
    try {
      const result = await anodex.git.switchBranch(projectId, name)
      if (!result.ok) {
        notifyError('Could not switch branches', result.error.message)
        return
      }
      setStatus(result.value)
      closeMenu()
    } finally {
      setSwitchingBranch(null)
    }
  }

  const createBranch = async (): Promise<void> => {
    const name = newBranchName.trim()
    if (!projectId || !name || branching) return
    setBranching(true)
    try {
      const result = await anodex.git.createBranch(projectId, name)
      if (!result.ok) {
        notifyError('Could not create branch', result.error.message)
        return
      }
      setStatus(result.value)
      closeMenu()
    } finally {
      setBranching(false)
    }
  }

  const commit = async (): Promise<void> => {
    const message = commitMessage.trim()
    if (!projectId || !message || committing) return
    setCommitting(true)
    try {
      const result = await anodex.git.commit(projectId, message)
      if (!result.ok) {
        notifyError('Could not commit', result.error.message)
        return
      }
      setStatus(result.value)
      setCommitMessage('')
    } finally {
      setCommitting(false)
    }
  }

  const push = async (): Promise<void> => {
    if (!projectId || pushing) return
    setPushing(true)
    try {
      const result = await anodex.git.push(projectId)
      if (!result.ok) {
        notifyError('Could not push', result.error.message)
        return
      }
      notify({ kind: 'success', title: 'Pushed', message: status?.branch ?? undefined })
    } finally {
      setPushing(false)
    }
  }

  const requestPush = (): void => {
    if (confirmDestructive) {
      setConfirmingPush(true)
      return
    }
    void push()
  }

  if (!projectId || status === null) {
    return (
      <WorkspaceDockPanel title="Git">
        <div className={styles.loading}>
          <Spinner size={14} />
        </div>
      </WorkspaceDockPanel>
    )
  }

  if (!status.hasRepo) {
    return (
      <WorkspaceDockPanel title="Git">
        <div className={styles.empty}>
          <p>This project isn&apos;t a git repository yet.</p>
          <button
            type="button"
            className={styles.initButton}
            disabled={initializing}
            onClick={() => void initRepo()}
          >
            {initializing ? <Spinner size={13} /> : <Icon name="git-branch" size={13} />}
            Initialize repository
          </button>
        </div>
      </WorkspaceDockPanel>
    )
  }

  const filteredBranches = (branches ?? []).filter((name) =>
    name.toLowerCase().includes(branchFilter.trim().toLowerCase())
  )

  return (
    <WorkspaceDockPanel title="Git">
      <div className={styles.status}>
        <div className={styles.branchMenuWrap} ref={menuRef}>
          <button
            type="button"
            className={styles.branchButton}
            onClick={() => (menuOpen ? closeMenu() : void openMenu())}
          >
            <Icon name="git-branch" size={14} className={styles.branchIcon} />
            <span>{status.branch ?? 'detached HEAD'}</span>
            <Icon name="chevron-down" size={12} className={styles.branchChevron} />
          </button>

          {menuOpen && (
            <div className={styles.branchMenu}>
              <div className={styles.branchSearch}>
                <Icon name="search" size={13} className={styles.branchSearchIcon} />
                <input
                  type="text"
                  className={styles.branchSearchInput}
                  placeholder="Search branches"
                  value={branchFilter}
                  onChange={(e) => setBranchFilter(e.target.value)}
                  autoFocus
                />
              </div>

              <div className={styles.branchList}>
                {branches === null ? (
                  <div className={styles.branchListLoading}>
                    <Spinner size={13} />
                  </div>
                ) : filteredBranches.length === 0 ? (
                  <div className={styles.branchEmpty}>No matching branches</div>
                ) : (
                  filteredBranches.map((name) => (
                    <button
                      key={name}
                      type="button"
                      className={styles.branchItem}
                      disabled={switchingBranch !== null}
                      onClick={() => void switchTo(name)}
                    >
                      <Icon name="git-branch" size={13} className={styles.branchItemIcon} />
                      <span className={styles.branchItemName}>{name}</span>
                      {switchingBranch === name ? (
                        <Spinner size={12} />
                      ) : (
                        name === status.branch && (
                          <Icon name="check" size={13} className={styles.branchItemCheck} />
                        )
                      )}
                    </button>
                  ))
                )}
              </div>

              <div className={styles.branchMenuFooter}>
                {creatingBranch ? (
                  <div className={styles.branchForm}>
                    <input
                      type="text"
                      className={styles.input}
                      placeholder="branch-name"
                      value={newBranchName}
                      onChange={(e) => setNewBranchName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void createBranch()
                        if (e.key === 'Escape') setCreatingBranch(false)
                      }}
                      autoFocus
                    />
                    <button
                      type="button"
                      className={styles.smallButton}
                      disabled={!newBranchName.trim() || branching}
                      onClick={() => void createBranch()}
                    >
                      {branching ? <Spinner size={12} /> : 'Create'}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={styles.createBranchRow}
                    onClick={() => setCreatingBranch(true)}
                  >
                    <Icon name="plus" size={13} />
                    Create and checkout new branch...
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {status.filesChanged === 0 ? (
          <span className={styles.clean}>No uncommitted changes</span>
        ) : (
          <div className={styles.diffStat}>
            <span className={styles.filesChanged}>
              {status.filesChanged} file{status.filesChanged === 1 ? '' : 's'} changed
            </span>
            {status.insertions > 0 && (
              <span className={styles.insertions}>+{status.insertions}</span>
            )}
            {status.deletions > 0 && <span className={styles.deletions}>-{status.deletions}</span>}
          </div>
        )}

        <textarea
          className={styles.commitInput}
          placeholder="Commit message"
          rows={2}
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          disabled={status.filesChanged === 0}
        />

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!commitMessage.trim() || status.filesChanged === 0 || committing}
            onClick={() => void commit()}
          >
            {committing ? <Spinner size={13} /> : <Icon name="save" size={13} />}
            Commit all
          </button>
          <button
            type="button"
            className={styles.smallButton}
            disabled={pushing}
            onClick={requestPush}
          >
            {pushing ? <Spinner size={13} /> : <Icon name="send" size={13} />}
            Push
          </button>
        </div>
      </div>

      {confirmingPush && (
        <ConfirmDialog
          title="Push to remote?"
          message="This uploads your local commits to the remote repository."
          detail={status.branch ?? undefined}
          confirmLabel="Push"
          icon="send"
          onCancel={() => setConfirmingPush(false)}
          onConfirm={() => {
            setConfirmingPush(false)
            void push()
          }}
        />
      )}
    </WorkspaceDockPanel>
  )
}
