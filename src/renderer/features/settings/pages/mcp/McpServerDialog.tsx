import { useState, type FormEvent } from 'react'
import type { McpNewServerConfig, McpServerConfig } from '@shared/mcp.types'
import { Overlay } from '../../../../components/ui/Overlay'
import { Icon } from '../../../../components/Icon'
import { TextControl } from '../../controls'
import {
  draftFromConfig,
  parseCommandLine,
  parseEnvironment,
  type McpServerDraft
} from './mcpServerDraft'
import styles from './McpServerDialog.module.css'

interface McpServerDialogProps {
  /** When set, edits this server instead of creating a new one. */
  initial?: McpServerConfig
  onCancel: () => void
  /** `token` is only meaningful for a new/edited remote server — the caller stores it separately (McpAuthStore), never as part of the config. */
  onSubmit: (config: McpNewServerConfig, token: string) => void
}

/** Add/edit modal for one MCP server — local (stdio command) or remote (URL, optional token/OAuth). */
export function McpServerDialog({
  initial,
  onCancel,
  onSubmit
}: McpServerDialogProps): JSX.Element {
  const [draft, setDraft] = useState<McpServerDraft>(() => draftFromConfig(initial))
  const isEdit = Boolean(initial)

  const canSubmit = Boolean(
    draft.name.trim() && (draft.type === 'local' ? draft.command.trim() : draft.url.trim())
  )

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canSubmit) return
    if (draft.type === 'local') {
      onSubmit(
        {
          name: draft.name.trim(),
          enabled: initial?.enabled ?? true,
          type: 'local',
          command: parseCommandLine(draft.command.trim()),
          environment: parseEnvironment(draft.environmentText)
        },
        ''
      )
    } else {
      onSubmit(
        {
          name: draft.name.trim(),
          enabled: initial?.enabled ?? true,
          type: 'remote',
          url: draft.url.trim()
        },
        draft.token.trim()
      )
    }
  }

  return (
    <Overlay
      onClose={onCancel}
      ariaLabel={isEdit ? 'Edit MCP server' : 'Add MCP server'}
      cardClassName={styles.modal}
    >
      <form onSubmit={handleSubmit}>
        <div className={styles.header}>
          <span className={styles.badge}>
            <Icon name="plug" size={16} />
          </span>
          <div className={styles.title}>{isEdit ? 'Edit MCP server' : 'Add MCP server'}</div>
        </div>

        <div className={styles.body}>
          <label className={styles.field}>
            <span>Name</span>
            <TextControl
              value={draft.name}
              onChange={(name) => setDraft((d) => ({ ...d, name }))}
              placeholder="GitHub"
            />
          </label>

          {!isEdit && (
            <div className={styles.typeToggle}>
              <button
                type="button"
                className={draft.type === 'local' ? styles.typeActive : ''}
                onClick={() => setDraft((d) => ({ ...d, type: 'local' }))}
              >
                Local
              </button>
              <button
                type="button"
                className={draft.type === 'remote' ? styles.typeActive : ''}
                onClick={() => setDraft((d) => ({ ...d, type: 'remote' }))}
              >
                Remote
              </button>
            </div>
          )}

          {draft.type === 'local' ? (
            <>
              <label className={styles.field}>
                <span>Command</span>
                <TextControl
                  value={draft.command}
                  onChange={(command) => setDraft((d) => ({ ...d, command }))}
                  placeholder="npx -y @modelcontextprotocol/server-everything"
                />
              </label>
              <label className={styles.field}>
                <span>Environment variables (encrypted; one KEY=value per line)</span>
                <textarea
                  className={styles.textarea}
                  value={draft.environmentText}
                  onChange={(event) =>
                    setDraft((d) => ({ ...d, environmentText: event.target.value }))
                  }
                  placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=ghp_..."
                  rows={3}
                />
                {isEdit && <small>Leave an existing key blank to keep its saved value.</small>}
              </label>
            </>
          ) : (
            <>
              <label className={styles.field}>
                <span>Server URL</span>
                <TextControl
                  value={draft.url}
                  onChange={(url) => setDraft((d) => ({ ...d, url }))}
                  placeholder="https://example.com/mcp"
                />
              </label>
              <label className={styles.field}>
                <span>Access token (optional — leave blank to use OAuth instead)</span>
                <TextControl
                  type="password"
                  value={draft.token}
                  onChange={(token) => setDraft((d) => ({ ...d, token }))}
                  placeholder="Paste a bearer token, or leave blank"
                />
              </label>
            </>
          )}
        </div>

        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={styles.confirm} disabled={!canSubmit}>
            {isEdit ? 'Save' : 'Add server'}
          </button>
        </div>
      </form>
    </Overlay>
  )
}
