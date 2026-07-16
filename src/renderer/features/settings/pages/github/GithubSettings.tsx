import { useEffect, useState } from 'react'
import type { GithubConnectionState, GithubToolset } from '@shared/github.types'
import { GITHUB_TOOLSETS } from '@shared/github.types'
import { anodex } from '../../../../lib/anodex'
import { useMcpStore } from '../../../../stores/mcpStore'
import { getActiveProject, useProjectStore } from '../../../../stores/projectStore'
import { useUiStore } from '../../../../stores/uiStore'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { SettingRow } from '../../SettingRow'
import { TextControl, ToggleControl } from '../../controls'
import pageStyles from '../../SettingsPage.module.css'
import styles from './GithubSettings.module.css'

const TOOLSET_LABELS: Record<GithubToolset, { label: string; description: string }> = {
  repos: { label: 'Repositories', description: 'Code, branches, commits, and releases' },
  issues: { label: 'Issues', description: 'Search, read, create, and update issues' },
  pull_requests: { label: 'Pull requests', description: 'Review and manage pull requests' },
  actions: { label: 'Actions', description: 'Inspect workflow runs and CI failures' }
}

export function GithubSettings(): JSX.Element {
  const notify = useUiStore((state) => state.notify)
  const projects = useProjectStore((state) => state.projects)
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const updateProject = useProjectStore((state) => state.update)
  const statuses = useMcpStore((state) => state.statuses)
  const activeProject = getActiveProject(projects, activeProjectId)

  const [connection, setConnection] = useState<GithubConnectionState | null>(null)
  const [token, setToken] = useState('')
  const [readOnly, setReadOnly] = useState(true)
  const [toolsets, setToolsets] = useState<GithubToolset[]>(['repos', 'issues', 'pull_requests'])
  const [repository, setRepository] = useState('')
  const [busy, setBusy] = useState(false)
  const liveStatus = connection?.serverId ? statuses[connection.serverId]?.status : undefined

  useEffect(() => {
    let cancelled = false
    void anodex.github.getState(activeProjectId).then((result) => {
      if (cancelled || !result.ok) return
      setConnection(result.value)
      setReadOnly(result.value.readOnly)
      setToolsets(result.value.toolsets)
      setRepository(result.value.linkedRepository ?? result.value.detectedRepository ?? '')
    })
    return () => {
      cancelled = true
    }
  }, [activeProjectId])

  useEffect(() => {
    if (!connection?.serverId || !liveStatus) return
    let cancelled = false
    void anodex.github.getState(activeProjectId).then((result) => {
      if (!cancelled && result.ok) setConnection(result.value)
    })
    return () => {
      cancelled = true
    }
  }, [activeProjectId, connection?.serverId, liveStatus])

  const handleConnect = async (): Promise<void> => {
    if (!token.trim() && !connection?.hasCredential) {
      notify({
        kind: 'error',
        title: 'GitHub token required',
        message: 'Paste a fine-grained personal access token before connecting.'
      })
      return
    }
    setBusy(true)
    const result = await anodex.github.connect(
      { token: token.trim() || undefined, readOnly, toolsets },
      activeProjectId
    )
    await useMcpStore.getState().load()
    setBusy(false)
    if (!result.ok) {
      const latest = await anodex.github.getState(activeProjectId)
      if (latest.ok) setConnection(latest.value)
      notify({
        kind: 'error',
        title: 'Could not connect GitHub',
        message: result.error.detail ?? result.error.message
      })
      return
    }
    setConnection(result.value)
    setToken('')
    notify({
      kind: 'success',
      title: 'GitHub connected',
      message: result.value.account?.login ?? `${result.value.toolCount} tools are ready.`
    })
  }

  const handleDisconnect = async (): Promise<void> => {
    setBusy(true)
    const result = await anodex.github.disconnect(activeProjectId)
    await useMcpStore.getState().load()
    setBusy(false)
    if (result.ok) {
      setConnection(result.value)
      setToken('')
    } else {
      notify({
        kind: 'error',
        title: 'Could not disconnect GitHub',
        message: result.error.detail ?? result.error.message
      })
    }
  }

  const handleDetectRepository = async (): Promise<void> => {
    if (!activeProject) return
    const result = await anodex.github.detectRepository(activeProject.id)
    if (result.ok && result.value) {
      setRepository(result.value)
      return
    }
    notify({
      kind: 'error',
      title: 'No GitHub remote found',
      message: 'Add a GitHub origin remote or enter owner/repository manually.'
    })
  }

  const handleLinkRepository = async (): Promise<void> => {
    if (!activeProject) return
    const value = repository.trim()
    if (value && !/^[\w.-]+\/[\w.-]+$/.test(value)) {
      notify({
        kind: 'error',
        title: 'Invalid repository',
        message: 'Use the owner/repository format, for example openai/codex.'
      })
      return
    }
    await updateProject(activeProject.id, { githubRepository: value })
    const result = await anodex.github.getState(activeProject.id)
    if (result.ok) setConnection(result.value)
    notify({
      kind: 'success',
      title: value ? 'Repository linked' : 'Repository link cleared',
      message: value || activeProject.name
    })
  }

  const toggleToolset = (toolset: GithubToolset): void => {
    setToolsets((current) =>
      current.includes(toolset)
        ? current.filter((candidate) => candidate !== toolset)
        : [...current, toolset]
    )
  }

  const statusLabel = connection?.connected
    ? connection.account
      ? `Connected as @${connection.account.login}`
      : 'GitHub connected'
    : connection?.configured
      ? statusDescription(connection)
      : 'GitHub not connected'

  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>AI & Connections</p>
        <h1 className={pageStyles.pageTitle}>GitHub</h1>
        <p className={pageStyles.pageDesc}>
          Give Anodex controlled access to repositories, issues, pull requests, and Actions through
          GitHub&apos;s official hosted MCP server.
        </p>
      </header>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Connection</h2>
        <p className={pageStyles.sectionDesc}>
          Credentials are encrypted with your operating system&apos;s secure storage and never sent
          to the renderer after saving.
        </p>

        <div className={styles.statusCard}>
          <div className={styles.statusIcon}>
            <Icon name="git-branch" size={18} />
          </div>
          <div className={styles.statusText}>
            <strong>{statusLabel}</strong>
            <span>
              {connection?.connected
                ? `${connection.toolCount} tool${connection.toolCount === 1 ? '' : 's'} available · ${connection.readOnly ? 'Read only' : 'Writes require approval'}`
                : (connection?.error ?? 'Connect with a fine-grained personal access token.')}
            </span>
          </div>
          {connection?.configured && (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void handleDisconnect()}
            >
              Disconnect
            </Button>
          )}
        </div>

        <SettingRow
          label="Personal access token"
          description={
            connection?.hasCredential
              ? 'A token is saved. Leave this blank to keep it, or paste a replacement.'
              : 'Use a fine-grained token limited to the repositories and permissions you need.'
          }
          control={
            <div className={styles.tokenControl}>
              <TextControl
                type="password"
                value={token}
                placeholder={connection?.hasCredential ? 'Saved securely' : 'github_pat_…'}
                onChange={setToken}
              />
              <a
                className={styles.helpLink}
                href="https://github.com/settings/personal-access-tokens/new"
                target="_blank"
                rel="noreferrer"
              >
                Create token
              </a>
            </div>
          }
        />
        <SettingRow
          label="Read-only mode"
          description="Recommended. GitHub removes mutating tools at the server before Anodex sees them."
          control={<ToggleControl checked={readOnly} onChange={setReadOnly} />}
        />

        <div className={styles.toolsets}>
          {GITHUB_TOOLSETS.map((toolset) => {
            const selected = toolsets.includes(toolset)
            return (
              <button
                key={toolset}
                type="button"
                className={`${styles.toolset} ${selected ? styles.toolsetSelected : ''}`}
                onClick={() => toggleToolset(toolset)}
              >
                <span className={styles.check}>{selected && <Icon name="check" size={13} />}</span>
                <span>
                  <strong>{TOOLSET_LABELS[toolset].label}</strong>
                  <small>{TOOLSET_LABELS[toolset].description}</small>
                </span>
              </button>
            )
          })}
        </div>

        <div className={styles.primaryAction}>
          <Button
            variant="primary"
            loading={busy}
            disabled={toolsets.length === 0}
            iconLeft={<Icon name="git-branch" size={14} />}
            onClick={() => void handleConnect()}
          >
            {connection?.configured ? 'Save and reconnect' : 'Connect GitHub'}
          </Button>
        </div>
      </section>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Project repository</h2>
        <p className={pageStyles.sectionDesc}>
          Linking a project gives GitHub tools a default owner/repository target.
        </p>
        {activeProject ? (
          <div className={styles.repositoryCard}>
            <div className={styles.repositoryHeading}>
              <div>
                <strong>{activeProject.name}</strong>
                <span>{activeProject.folderPath}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void handleDetectRepository()}>
                Detect origin
              </Button>
            </div>
            <div className={styles.repositoryControls}>
              <TextControl
                value={repository}
                placeholder="owner/repository"
                onChange={setRepository}
              />
              <Button variant="secondary" size="sm" onClick={() => void handleLinkRepository()}>
                Save link
              </Button>
            </div>
            {connection?.detectedRepository && (
              <small>Detected from origin: {connection.detectedRepository}</small>
            )}
          </div>
        ) : (
          <div className={styles.emptyProject}>Open a project to link its GitHub repository.</div>
        )}
      </section>
    </div>
  )
}

function statusDescription(connection: GithubConnectionState): string {
  if (connection.status === 'connecting') return 'Connecting to GitHub…'
  if (connection.status === 'auth-required') return 'GitHub needs a valid token'
  if (connection.status === 'error') return 'GitHub connection error'
  return 'GitHub is configured but disconnected'
}
