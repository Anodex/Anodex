import { useEffect, useState } from 'react'
import type { AppSettings, DiagnosticEntry, DiagnosticLogFile } from '@shared/settings.types'
import { anodex } from '../../../../lib/anodex'
import { useDiagnosticsStore } from '../../../../stores/diagnosticsStore'
import { Icon } from '../../../../components/Icon'
import { Button } from '../../../../components/ui/Button'
import { SettingRow } from '../../SettingRow'
import { SelectControl, ToggleControl } from '../../controls'
import pageStyles from '../../SettingsPage.module.css'
import styles from './DiagnosticsSettings.module.css'

interface DiagnosticsSettingsProps {
  settings: AppSettings
  update: (patch: Partial<AppSettings['diagnostics']>) => void
}

const SEVERITY_FILTER: Array<{ label: string; value: DiagnosticEntry['severity'] | 'all' }> = [
  { label: 'All', value: 'all' },
  { label: 'Errors', value: 'error' },
  { label: 'Warnings', value: 'warning' },
  { label: 'Info', value: 'info' }
]

const CATEGORY_LABELS: Record<DiagnosticEntry['category'], string> = {
  model: 'Model',
  provider: 'Provider',
  integration: 'Integration',
  file: 'File',
  permission: 'Permission',
  runtime: 'Runtime',
  general: 'General'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function DiagnosticsSettings({ settings, update }: DiagnosticsSettingsProps): JSX.Element {
  const { diagnostics } = settings
  const entries = useDiagnosticsStore((s) => s.entries)
  const clear = useDiagnosticsStore((s) => s.clear)
  const remove = useDiagnosticsStore((s) => s.remove)
  const exportText = useDiagnosticsStore((s) => s.exportText)

  const [filter, setFilter] = useState<DiagnosticEntry['severity'] | 'all'>('all')
  const [logFile, setLogFile] = useState<DiagnosticLogFile | null>(null)

  // Re-read on every visit (and after each new entry) so the size shown is
  // current rather than whatever it was when the app started.
  useEffect(() => {
    void anodex.diagnostics.getLogFile().then(setLogFile)
  }, [entries.length])

  const filtered = filter === 'all' ? entries : entries.filter((entry) => entry.severity === filter)
  const errorCount = entries.filter((entry) => entry.severity === 'error').length
  const warningCount = entries.filter((entry) => entry.severity === 'warning').length
  const infoCount = entries.filter((entry) => entry.severity === 'info').length
  const status = errorCount > 0 ? 'attention' : warningCount > 0 ? 'warning' : 'healthy'

  const handleExport = (): void => {
    const blob = new Blob([exportText()], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `anodex-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className={pageStyles.page}>
      <header className={`${pageStyles.pageHeader} ${styles.pageHeader}`}>
        <div>
          <p className={pageStyles.pageKicker}>System</p>
          <h1 className={pageStyles.pageTitle}>Diagnostics</h1>
          <p className={pageStyles.pageDesc}>
            Errors and warnings from the local engine, background services, and assistant tools —
            including failures that happened before this window opened.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={entries.length === 0}
          iconLeft={<Icon name="download" size={14} />}
          onClick={handleExport}
        >
          Export log
        </Button>
      </header>

      <div className={styles.summaryGrid} aria-label="Diagnostics summary">
        <SummaryCard
          label="Status"
          value={
            status === 'attention'
              ? 'Needs attention'
              : status === 'warning'
                ? 'Warnings present'
                : 'Healthy'
          }
          detail={
            errorCount > 0
              ? `${errorCount} unresolved error${errorCount === 1 ? '' : 's'}`
              : warningCount > 0
                ? `${warningCount} warning${warningCount === 1 ? '' : 's'} to review`
                : 'No errors or warnings'
          }
          tone={status}
        />
        <SummaryCard
          label="Errors"
          value={String(errorCount)}
          detail="Require review"
          tone="error"
        />
        <SummaryCard
          label="Warnings"
          value={String(warningCount)}
          detail="May affect behavior"
          tone="warning"
        />
        <SummaryCard
          label="Stored locally"
          value={`${entries.length} / ${diagnostics.maxEntries.toLocaleString()}`}
          detail="Newest entries retained"
        />
      </div>

      <section className={`${pageStyles.section} ${styles.section}`}>
        <h2 className={pageStyles.sectionTitle}>Logging</h2>
        <p className={pageStyles.sectionDesc}>
          Control how much diagnostic information Anodex keeps locally.
        </p>

        <div className={styles.settingList}>
          <SettingRow
            label="Log file"
            description={
              logFile?.available
                ? `Every background-service line, with full stacks — the file to attach to a bug report. ${formatSize(logFile.sizeBytes)}, rotated at 2 MB.`
                : 'File logging could not be started on this machine; entries below are still recorded in the app.'
            }
            control={
              <Button
                variant="secondary"
                size="sm"
                disabled={!logFile?.available}
                iconLeft={<Icon name="folder" size={14} />}
                onClick={() => void anodex.diagnostics.revealLogFile()}
              >
                Reveal
              </Button>
            }
          />
          <SettingRow
            label="Verbose logging"
            description="Include extra debug detail in new in-app entries. Background-service errors always keep their full detail."
            control={
              <ToggleControl
                checked={diagnostics.verbose}
                onChange={(value) => update({ verbose: value })}
              />
            }
          />
          <SettingRow
            label="Clear informational entries on restart"
            description="Errors and warnings remain available for troubleshooting."
            control={
              <ToggleControl
                checked={diagnostics.clearOnRestart}
                onChange={(value) => update({ clearOnRestart: value })}
              />
            }
          />
          <SettingRow
            label="History limit"
            description="Oldest entries are removed when the log reaches this limit."
            control={
              <SelectControl
                value={String(diagnostics.maxEntries)}
                options={[
                  { label: '100 entries', value: '100' },
                  { label: '250 entries', value: '250' },
                  { label: '500 entries', value: '500' },
                  { label: '1,000 entries', value: '1000' }
                ]}
                onChange={(value) => update({ maxEntries: Number(value) })}
              />
            }
          />
        </div>

        <div className={styles.localNote}>
          <Icon name="check" size={13} />
          <span>Diagnostic entries stay on this computer unless you export the log.</span>
        </div>
      </section>

      <section className={`${pageStyles.section} ${styles.section}`}>
        <div className={styles.logHead}>
          <div>
            <h2 className={pageStyles.sectionTitle}>Recent events</h2>
            <p className={pageStyles.sectionDesc}>
              Select an event to see technical detail and a suggested next step.
            </p>
          </div>
          <Button
            className={styles.clearButton}
            variant="ghost"
            size="sm"
            disabled={entries.length === 0}
            iconLeft={<Icon name="trash" size={14} />}
            onClick={() => clear()}
          >
            Clear log
          </Button>
        </div>

        <div className={styles.filters} role="tablist" aria-label="Diagnostic severity filter">
          {SEVERITY_FILTER.map((option) => {
            const count =
              option.value === 'all'
                ? entries.length
                : option.value === 'error'
                  ? errorCount
                  : option.value === 'warning'
                    ? warningCount
                    : infoCount
            const active = filter === option.value
            return (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={active}
                className={`${styles.filterButton} ${active ? styles.filterActive : ''}`}
                onClick={() => setFilter(option.value)}
              >
                {option.label}
                <span>{count}</span>
              </button>
            )
          })}
        </div>

        {filtered.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>
              <Icon name="check" size={16} />
            </span>
            <strong>No matching diagnostic entries</strong>
            <p>New runtime events will appear here.</p>
          </div>
        ) : (
          <ul className={styles.list}>
            {filtered.map((entry, index) => (
              <li key={entry.id} className={`${styles.entry} ${styles[entry.severity]}`}>
                <details open={index === 0}>
                  <summary>
                    <span className={styles.severity}>
                      <Icon name={entry.severity === 'info' ? 'info' : 'alert'} size={11} />
                      {entry.severity}
                    </span>
                    <span className={styles.entryMain}>
                      <strong>{entry.message}</strong>
                      <small>
                        {CATEGORY_LABELS[entry.category]}
                        {entry.scope && ` · ${entry.scope}`}
                        {entry.source === 'main' && ' · background service'}
                      </small>
                    </span>
                    <time>{new Date(entry.timestamp).toLocaleString()}</time>
                    <Icon name="chevron-down" size={14} />
                  </summary>
                  <div className={styles.entryDetail}>
                    {entry.detail ? (
                      // Stacks and structured context need their own line breaks
                      // and a monospace face to be readable at all.
                      <pre className={styles.detailBlock}>{entry.detail}</pre>
                    ) : (
                      <p>No additional technical detail was recorded.</p>
                    )}
                    {entry.detail && (
                      <button
                        type="button"
                        className={styles.copyDetail}
                        onClick={() => void navigator.clipboard.writeText(detailReport(entry))}
                      >
                        <Icon name="copy" size={12} />
                        Copy report
                      </button>
                    )}
                    {entry.suggestedFix && (
                      <div className={styles.fix}>
                        <strong>Suggested fix</strong>
                        <span>{entry.suggestedFix}</span>
                      </div>
                    )}
                  </div>
                </details>
                <button
                  type="button"
                  className={styles.removeButton}
                  onClick={() => remove(entry.id)}
                  aria-label={`Remove ${entry.message}`}
                >
                  <Icon name="close" size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/** One entry as a self-contained block, for pasting into a bug report. */
function detailReport(entry: DiagnosticEntry): string {
  const lines = [
    `${entry.severity.toUpperCase()}: ${entry.message}`,
    `When: ${new Date(entry.timestamp).toISOString()}`,
    `Where: ${CATEGORY_LABELS[entry.category]}${entry.scope ? ` (${entry.scope})` : ''}${
      entry.source === 'main' ? ' — background service' : ''
    }`
  ]
  if (entry.detail) lines.push('', entry.detail)
  if (entry.suggestedFix) lines.push('', `Suggested fix: ${entry.suggestedFix}`)
  return lines.join('\n')
}

function SummaryCard({
  label,
  value,
  detail,
  tone = 'neutral'
}: {
  label: string
  value: string
  detail: string
  tone?: 'neutral' | 'attention' | 'warning' | 'healthy' | 'error'
}): JSX.Element {
  return (
    <div className={`${styles.summaryCard} ${styles[tone]}`}>
      <span>{label}</span>
      <strong>
        {(tone === 'attention' || tone === 'warning' || tone === 'healthy') && (
          <i aria-hidden="true" />
        )}
        {value}
      </strong>
      <small>{detail}</small>
    </div>
  )
}
