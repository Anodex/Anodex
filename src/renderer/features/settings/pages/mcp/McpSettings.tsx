import { useState } from 'react'
import type { McpConnectionStatus, McpNewServerConfig, McpServerConfig } from '@shared/mcp.types'
import { useMcpStore } from '../../../../stores/mcpStore'
import { Button } from '../../../../components/ui/Button'
import { Icon } from '../../../../components/Icon'
import { StatusDot, type StatusTone } from '../../../../components/ui/StatusDot'
import { ConfirmDialog } from '../../../../components/ui/ConfirmDialog'
import { ToggleControl } from '../../controls'
import { McpServerDialog } from './McpServerDialog'
import pageStyles from '../../SettingsPage.module.css'
import styles from './McpSettings.module.css'

const STATUS_TONE: Record<McpConnectionStatus, StatusTone> = {
  connected: 'success',
  connecting: 'running',
  'auth-required': 'warning',
  error: 'danger',
  disconnected: 'neutral'
}

const STATUS_LABEL: Record<McpConnectionStatus, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  'auth-required': 'Needs authorization',
  error: 'Connection error',
  disconnected: 'Disconnected'
}

/**
 * MCP is off by default: nothing here connects to anything, spawns a
 * process, or opens a browser for OAuth until the user explicitly adds and
 * enables a server. GitHub's official server is offered as a one-click
 * preset (see `McpServerDialog`) rather than being wired in automatically.
 */
export function McpSettings(): JSX.Element {
  const allServers = useMcpStore((s) => s.servers)
  const servers = allServers.filter((server) => server.preset !== 'github')
  const statuses = useMcpStore((s) => s.statuses)
  const tools = useMcpStore((s) => s.tools)
  const addServer = useMcpStore((s) => s.add)
  const updateServer = useMcpStore((s) => s.update)
  const removeServer = useMcpStore((s) => s.remove)
  const setEnabled = useMcpStore((s) => s.setEnabled)
  const connect = useMcpStore((s) => s.connect)
  const disconnectAuth = useMcpStore((s) => s.disconnectAuth)

  const [dialogTarget, setDialogTarget] = useState<McpServerConfig | 'new' | null>(null)
  const [removeTarget, setRemoveTarget] = useState<McpServerConfig | null>(null)

  const handleSubmit = async (config: McpNewServerConfig, token: string): Promise<void> => {
    const credentials = config.type === 'remote' ? { staticToken: token } : undefined
    if (dialogTarget && dialogTarget !== 'new') {
      const patch =
        config.type === 'local'
          ? {
              name: config.name,
              enabled: config.enabled,
              preset: config.preset,
              command: config.command,
              cwd: config.cwd,
              environment: config.environment
            }
          : {
              name: config.name,
              enabled: config.enabled,
              preset: config.preset,
              url: config.url,
              headers: config.headers
            }
      await updateServer(dialogTarget.id, patch, credentials)
    } else {
      await addServer(config, credentials)
    }
    setDialogTarget(null)
  }

  return (
    <div className={pageStyles.page}>
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>AI & Connections</p>
        <h1 className={pageStyles.pageTitle}>MCP Servers</h1>
        <p className={pageStyles.pageDesc}>
          Connect custom tool servers over the Model Context Protocol. GitHub has its own guided
          connection page; this page is for other local and remote MCP servers.
        </p>
      </header>

      <section className={pageStyles.section}>
        <div className={styles.sectionHeader}>
          <div>
            <h2 className={pageStyles.sectionTitle}>Servers</h2>
            <p className={pageStyles.sectionDesc}>
              Each server&apos;s tools show up in chat like any built-in tool, gated by your
              permission mode.
            </p>
          </div>
          <Button
            variant="primary"
            size="sm"
            iconLeft={<Icon name="plus" size={14} />}
            onClick={() => setDialogTarget('new')}
          >
            Add server
          </Button>
        </div>

        {servers.length === 0 ? (
          <div className={styles.empty}>
            <Icon name="plug" size={20} />
            <p>No MCP servers configured yet.</p>
          </div>
        ) : (
          <div className={styles.list}>
            {servers.map((server) => {
              const status = statuses[server.id] ?? {
                id: server.id,
                status: 'disconnected' as const
              }
              const serverTools = tools.filter((tool) => tool.serverId === server.id)
              return (
                <div key={server.id} className={styles.card}>
                  <div className={styles.cardHeader}>
                    <span className={styles.icon}>
                      <Icon name="plug" size={16} />
                    </span>
                    <div className={styles.cardTitle}>
                      <strong>{server.name}</strong>
                      <span className={styles.typeBadge}>
                        {server.type === 'local' ? 'Local' : 'Remote'}
                      </span>
                    </div>
                    <div className={styles.statusGroup}>
                      <StatusDot tone={STATUS_TONE[status.status]} />
                      <span className={styles.statusLabel}>
                        {STATUS_LABEL[status.status]}
                        {status.status === 'connected' &&
                          status.toolCount !== undefined &&
                          ` · ${status.toolCount} tool${status.toolCount === 1 ? '' : 's'}`}
                      </span>
                    </div>
                    <ToggleControl
                      checked={server.enabled}
                      onChange={(enabled) => void setEnabled(server.id, enabled)}
                    />
                  </div>

                  {status.status === 'error' && status.error && (
                    <p className={styles.errorText}>{status.error}</p>
                  )}

                  <div className={styles.cardActions}>
                    {status.status === 'auth-required' && (
                      <Button variant="primary" size="sm" onClick={() => void connect(server.id)}>
                        Connect
                      </Button>
                    )}
                    {status.status === 'connected' || status.status === 'error' ? (
                      <Button variant="secondary" size="sm" onClick={() => void connect(server.id)}>
                        Reconnect
                      </Button>
                    ) : null}
                    {server.type === 'remote' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void disconnectAuth(server.id)}
                      >
                        Disconnect auth
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setDialogTarget(server)}>
                      Edit
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRemoveTarget(server)}>
                      Remove
                    </Button>
                  </div>

                  {serverTools.length > 0 && (
                    <details className={styles.disclosure}>
                      <summary className={styles.summary}>
                        <span>Discovered tools</span>
                        <span className={styles.summaryHint}>{serverTools.length}</span>
                      </summary>
                      <div className={styles.toolList}>
                        {serverTools.map((tool) => (
                          <div key={tool.qualifiedName} className={styles.toolItem}>
                            <code className={styles.toolName}>{tool.toolName}</code>
                            <span className={styles.toolDesc}>{tool.description}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {dialogTarget && (
        <McpServerDialog
          initial={dialogTarget === 'new' ? undefined : dialogTarget}
          onCancel={() => setDialogTarget(null)}
          onSubmit={(config, token) => void handleSubmit(config, token)}
        />
      )}

      {removeTarget && (
        <ConfirmDialog
          title="Remove MCP server?"
          message={`Disconnects "${removeTarget.name}" and clears any saved credentials.`}
          confirmLabel="Remove"
          icon="trash"
          onCancel={() => setRemoveTarget(null)}
          onConfirm={() => {
            void removeServer(removeTarget.id)
            setRemoveTarget(null)
          }}
        />
      )}
    </div>
  )
}
