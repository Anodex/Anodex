import { useState } from 'react'
import type { AppSettings, DiagnosticEntry } from '@shared/settings.types'
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
  file: 'File',
  permission: 'Permission',
  runtime: 'Runtime',
  general: 'General'
}

export function DiagnosticsSettings({ settings, update }: DiagnosticsSettingsProps): JSX.Element {
  const { diagnostics } = settings
  const entries = useDiagnosticsStore((s) => s.entries)
  const clear = useDiagnosticsStore((s) => s.clear)
  const remove = useDiagnosticsStore((s) => s.remove)
  const exportText = useDiagnosticsStore((s) => s.exportText)

  const [filter, setFilter] = useState<DiagnosticEntry['severity'] | 'all'>('all')
  const filtered = filter === 'all' ? entries : entries.filter((entry) => entry.severity === filter)

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
      <header className={pageStyles.pageHeader}>
        <p className={pageStyles.pageKicker}>System</p>
        <h1 className={pageStyles.pageTitle}>Diagnostics</h1>
        <p className={pageStyles.pageDesc}>
          Runtime events, errors, and warnings from the local engine and tools.
        </p>
      </header>

      <section className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Logging</h2>
        <p className={pageStyles.sectionDesc}>Control local diagnostic detail and retention.</p>

        <SettingRow
          label="Verbose logging"
          description="Include extra debug detail in the diagnostics log."
          control={
            <ToggleControl
              checked={diagnostics.verbose}
              onChange={(value) => update({ verbose: value })}
            />
          }
        />
        <SettingRow
          label="Clear on restart"
          description="Remove info-level entries when the app starts."
          control={
            <ToggleControl
              checked={diagnostics.clearOnRestart}
              onChange={(value) => update({ clearOnRestart: value })}
            />
          }
        />
        <SettingRow
          label="Max entries"
          description="Maximum number of recent entries to keep locally."
          control={
            <SelectControl
              value={String(diagnostics.maxEntries)}
              options={[
                { label: '100', value: '100' },
                { label: '250', value: '250' },
                { label: '500', value: '500' },
                { label: '1,000', value: '1000' }
              ]}
              onChange={(value) => update({ maxEntries: Number(value) })}
            />
          }
        />
      </section>

      <section className={pageStyles.section}>
        <div className={styles.logHead}>
          <div className={styles.logFilters}>
            <SelectControl
              value={filter}
              options={SEVERITY_FILTER}
              onChange={(value) => setFilter(value as DiagnosticEntry['severity'] | 'all')}
            />
            <span className={styles.count}>{filtered.length} entries</span>
          </div>
          <div className={styles.logActions}>
            <Button variant="ghost" size="sm" onClick={() => clear()}>
              Clear
            </Button>
            <Button variant="secondary" size="sm" onClick={handleExport}>
              Export
            </Button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className={styles.empty}>
            <Icon name="check" size={24} />
            <p>No diagnostics entries match the current filter.</p>
          </div>
        ) : (
          <ul className={styles.list}>
            {filtered.map((entry) => (
              <li key={entry.id} className={`${styles.entry} ${styles[entry.severity]}`}>
                <div className={styles.entryTop}>
                  <span className={styles.severity}>{entry.severity.toUpperCase()}</span>
                  <span className={styles.category}>{CATEGORY_LABELS[entry.category]}</span>
                  <span className={styles.time}>{new Date(entry.timestamp).toLocaleString()}</span>
                  <button
                    type="button"
                    className={styles.removeButton}
                    onClick={() => remove(entry.id)}
                    aria-label="Remove entry"
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
                <p className={styles.message}>{entry.message}</p>
                {entry.detail && <p className={styles.detail}>{entry.detail}</p>}
                {entry.suggestedFix && (
                  <p className={styles.fix}>Suggested fix: {entry.suggestedFix}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
