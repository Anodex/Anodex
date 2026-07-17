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
      await refresh()
    } finally {
      setPushing(false)
    }
  }

  const requestPush = (): void => {
    if (!status?.canPush) {
      notifyError(
        'Cannot push yet',
        !status?.branch
          ? 'Check out a branch first.'
          : !status.headSha
            ? 'Create a commit first.'
            : 'Add a remote first.'
      )
      return
    }
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
  const hasChanges = status.filesChanged > 0
  const hasTrackedStats = status.insertions > 0 || status.deletions > 0
  const pushDisabledReason = !status.branch
    ? 'Check out a branch before pushing.'
    : !status.headSha
      ? 'Create a commit before pushing.'
      : !status.remote
        ? 'Add a remote before pushing.'
        : undefined
  const syncLabel = status.upstream
    ? status.ahead > 0 || status.behind > 0
      ? `${status.ahead} ahead / ${status.behind} behind`
      : 'up to date'
    : status.remote
      ? 'no upstream'
      : 'local only'
  const remoteLabel = status.upstream ?? status.remote ?? 'no remote'
  const headLabel = status.headSha ? `HEAD ${status.headSha}` : 'no commits yet'
  const pushLabel = status.upstream ? 'Push' : status.remote ? 'Publish' : 'Push'

  return (
    <WorkspaceDockPanel title="Git">
      <div className={styles.statusCard}>
        <div className={styles.commandHeader}>
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
                      Create and checkout branch
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className={styles.commandActions}>
            <span className={styles.syncPill}>
              <span className={status.upstream ? styles.syncDotReady : styles.syncDotMuted} />
              {syncLabel}
            </span>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Refresh git status"
              onClick={() => void refresh()}
            >
              <Icon name="refresh" size={13} />
            </button>
          </div>
        </div>

        <div className={styles.repoContext}>
          <span>{remoteLabel}</span>
          <span>{headLabel}</span>
        </div>

        <div className={hasChanges ? styles.changeBarDirty : styles.changeBarClean}>
          <div className={styles.changeText}>
            <strong>
              {hasChanges
                ? `${status.filesChanged} file${status.filesChanged === 1 ? '' : 's'} changed`
                : 'Working tree clean'}
            </strong>
            {hasChanges ? (
              <span>
                {status.staged > 0 && `${status.staged} staged`}
                {status.staged > 0 && (status.unstaged > 0 || status.untracked > 0) && ' · '}
                {status.unstaged > 0 && `${status.unstaged} unstaged`}
                {status.unstaged > 0 && status.untracked > 0 && ' · '}
                {status.untracked > 0 && `${status.untracked} untracked`}
              </span>
            ) : (
              <span>No uncommitted changes</span>
            )}
          </div>
          {hasTrackedStats && (
            <span className={styles.deltaStat}>
              {status.insertions > 0 && (
                <strong className={styles.insertions}>+{status.insertions}</strong>
              )}
              {status.deletions > 0 && (
                <strong className={styles.deletions}>-{status.deletions}</strong>
              )}
            </span>
          )}
        </div>

        <div className={styles.commitBox}>
          <textarea
            className={styles.commitInput}
            placeholder="Commit message"
            rows={2}
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            disabled={!hasChanges}
          />
          <span className={styles.commitHint}>
            {hasChanges
              ? 'Commit all stages tracked and untracked files before committing.'
              : 'No changes to commit.'}
          </span>
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!commitMessage.trim() || !hasChanges || committing}
            onClick={() => void commit()}
          >
            {committing ? <Spinner size={13} /> : <Icon name="save" size={13} />}
            Commit all
          </button>
          <button
            type="button"
            className={styles.smallButton}
            disabled={pushing || !status.canPush}
            title={pushDisabledReason}
            onClick={requestPush}
          >
            {pushing ? <Spinner size={13} /> : <Icon name="send" size={13} />}
            {pushLabel}
          </button>
        </div>
      </div>

      {confirmingPush && (
        <ConfirmDialog
          title="Push to remote?"
          message="This uploads your local commits to the remote repository."
          detail={status.upstream ?? `${status.remote ?? 'remote'}/${status.branch ?? 'HEAD'}`}
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
