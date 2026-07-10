import { useEffect, useState } from 'react'
import { useUiStore } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { Icon } from '../../components/Icon'
import { DiffView } from './DiffView'
import { DiffStat } from './ToolCallCard'
import styles from './ToolConfirmCard.module.css'

/**
 * Inline approval card shown above the composer when the AI wants to write a
 * file, run a command, or search the web (and approval is required). Replaces
 * the old full-screen modal — modeled on Claude Code's own compact
 * approve/deny/remember prompt, kept in Anodex's own visual language.
 */
export function ToolConfirmCard(): JSX.Element | null {
  const pending = useUiStore((s) => s.pendingConfirmation)
  const resolve = useUiStore((s) => s.resolveConfirmation)
  const diffViewMode = useSettingsStore((s) => s.settings?.appearance.diffView ?? 'unified')
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')

  useEffect(() => {
    setDenying(false)
    setReason('')
  }, [pending?.id])

  useEffect(() => {
    if (!pending) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (denying) setDenying(false)
      else resolve({ approved: false })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, denying, resolve])

  if (!pending) return null

  const config = KIND_CONFIG[pending.kind]

  return (
    <div className={styles.card} role="dialog" aria-label={config.title}>
      <div className={styles.header}>
        <span className={`${styles.badge} ${styles[config.style]}`}>
          <Icon name={config.icon} size={14} />
        </span>
        <span className={styles.title}>{config.title}</span>
        {pending.diff && <DiffStat before={pending.diff.before} after={pending.diff.after} />}
        {pending.risk === 'destructive' && <span className={styles.riskBadge}>Destructive</span>}
      </div>

      {pending.diff ? (
        <div className={styles.diffWrap}>
          <DiffView
            before={pending.diff.before}
            after={pending.diff.after}
            mode={diffViewMode}
            path={pending.diff.path}
          />
        </div>
      ) : (
        <pre className={styles.detail}>{pending.detail}</pre>
      )}

      {denying ? (
        <div className={styles.denyRow}>
          <input
            autoFocus
            className={styles.reasonInput}
            value={reason}
            placeholder="Optional: tell it what to do differently…"
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') resolve({ approved: false, reason })
            }}
          />
          <button className={styles.cancelDeny} onClick={() => setDenying(false)}>
            Cancel
          </button>
          <button
            className={styles.confirmDeny}
            onClick={() => resolve({ approved: false, reason })}
          >
            Deny
          </button>
        </div>
      ) : (
        <div className={styles.actions}>
          <button className={styles.deny} onClick={() => setDenying(true)}>
            Deny
          </button>
          <button
            className={styles.rememberApprove}
            onClick={() => resolve({ approved: true, remember: true })}
          >
            Always allow {pending.toolName}
          </button>
          <button className={styles.approve} onClick={() => resolve({ approved: true })}>
            <Icon name="check" size={14} />
            {config.approveLabel}
          </button>
        </div>
      )}
    </div>
  )
}

const KIND_CONFIG: Record<
  'write' | 'command' | 'web',
  {
    icon: 'copy' | 'cpu' | 'web'
    style: 'write' | 'command' | 'web'
    title: string
    approveLabel: string
  }
> = {
  write: {
    icon: 'copy',
    style: 'write',
    title: 'Apply file change?',
    approveLabel: 'Apply'
  },
  command: {
    icon: 'cpu',
    style: 'command',
    title: 'Run command?',
    approveLabel: 'Run'
  },
  web: {
    icon: 'web',
    style: 'web',
    title: 'Search the web?',
    approveLabel: 'Search'
  }
}
