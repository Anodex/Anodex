import type { UsageInsight } from '@shared/stats.types'
import { Icon, type IconName } from '../../../../components/Icon'
import { Button } from '../../../../components/ui/Button'
import { Spinner } from '../../../../components/ui/Spinner'
import { UsageHeatmap } from './UsageHeatmap'
import { useUsageProfile } from './useUsageProfile'
import styles from './UsageActivitySection.module.css'

const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1
})

function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(value)
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/**
 * `dateString` is a plain `YYYY-MM-DD` local calendar day, not a UTC
 * instant — parse its parts directly instead of `new Date(dateString)`,
 * which reads bare date strings as UTC midnight and can print the wrong day
 * for users west of UTC.
 */
function formatDay(dateString: string): string {
  const [year, month, day] = dateString.split('-').map(Number)
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric'
  })
}

function describeInsight(insight: UsageInsight): string {
  switch (insight.kind) {
    case 'streak':
      return `Longest streak: ${insight.days} day${insight.days === 1 ? '' : 's'}`
    case 'busiestDay':
      return `Busiest day: ${formatDay(insight.date)} with ${formatCompactNumber(insight.tokens)} tokens`
    case 'favoriteTool':
      return `Favorite tool: ${insight.name} (used ${insight.count.toLocaleString()} times)`
    case 'longestTask':
      return `Longest task: ${formatDuration(insight.durationMs)}`
  }
}

interface StatCardProps {
  icon: IconName
  label: string
  value: string
  hint?: string
}

function StatCard({ icon, label, value, hint }: StatCardProps): JSX.Element {
  return (
    <div className={styles.statCard}>
      <div className={styles.statChip}>
        <Icon name={icon} size={18} />
      </div>
      <div className={styles.statText}>
        <div className={styles.statLabel}>{label}</div>
        <div className={styles.statValue}>{value}</div>
        {hint && <div className={styles.statHint}>{hint}</div>}
      </div>
    </div>
  )
}

export function UsageActivitySection(): JSX.Element {
  const { profile, loading, refresh } = useUsageProfile()

  return (
    <section className={styles.section}>
      <div className={styles.headerRow}>
        <div>
          <h2 className={styles.sectionTitle}>Token Activity</h2>
          <p className={styles.sectionDesc}>Your all-time usage across every conversation.</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<Icon name="refresh" size={14} />}
          onClick={refresh}
        >
          Refresh
        </Button>
      </div>

      {loading && !profile ? (
        <div className={styles.loading}>
          <Spinner size={20} />
        </div>
      ) : profile ? (
        <>
          <div className={styles.statGrid}>
            <StatCard
              icon="sparkle"
              label="Lifetime tokens"
              value={formatCompactNumber(profile.lifetimeTokens)}
            />
            <StatCard
              icon="activity"
              label="Peak day"
              value={profile.peakDay ? formatCompactNumber(profile.peakDay.tokens) : '—'}
              hint={profile.peakDay ? formatDay(profile.peakDay.date) : undefined}
            />
            <StatCard
              icon="flame"
              label="Streak"
              value={`${profile.currentStreakDays}d`}
              hint={`Longest: ${profile.longestStreakDays}d`}
            />
            <StatCard
              icon="chevrons-up"
              label="Longest task"
              value={
                profile.longestGenerationDurationMs > 0
                  ? formatDuration(profile.longestGenerationDurationMs)
                  : '—'
              }
            />
          </div>

          <div className={styles.heatmapPanel}>
            <UsageHeatmap dailyActivity={profile.dailyActivity} />
          </div>

          <div className={styles.lowerGrid}>
            <div className={styles.panel}>
              <h3 className={styles.panelTitle}>Most used tools</h3>
              {profile.mostUsedTools.length === 0 ? (
                <p className={styles.emptyHint}>No tool activity yet.</p>
              ) : (
                <ul className={styles.toolList}>
                  {profile.mostUsedTools.map((tool) => (
                    <li key={tool.name} className={styles.toolRow}>
                      <span className={styles.toolName}>{tool.name}</span>
                      <span className={styles.toolCount}>{tool.count.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className={styles.panel}>
              <h3 className={styles.panelTitle}>Activity insights</h3>
              {profile.insights.length === 0 ? (
                <p className={styles.emptyHint}>Keep chatting to see insights here.</p>
              ) : (
                <ul className={styles.insightList}>
                  {profile.insights.map((insight, index) => (
                    <li key={index} className={styles.insightRow}>
                      <Icon name="sparkle" size={14} />
                      <span>{describeInsight(insight)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      ) : (
        <p className={styles.emptyHint}>Could not load usage data.</p>
      )}
    </section>
  )
}
