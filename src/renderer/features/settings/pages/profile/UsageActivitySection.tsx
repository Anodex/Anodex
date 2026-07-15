import type { UsageInsight } from '@shared/stats.types'
import { Icon, type IconName } from '../../../../components/Icon'
import { Button } from '../../../../components/ui/Button'
import { Spinner } from '../../../../components/ui/Spinner'
import { formatCompactNumber, formatDay, formatDuration, formatHourRange } from './formatters'
import { TokenActivityChartSection } from './TokenActivityChartSection'
import { UsageHeatmap } from './UsageHeatmap'
import { useUsageProfile } from './useUsageProfile'
import pageStyles from '../../SettingsPage.module.css'
import styles from './UsageActivitySection.module.css'

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
    case 'referenceBook':
      return `You've used about ${insight.multiplier}x more tokens than ${insight.bookTitle}`
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
    <section className={pageStyles.section}>
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
            <StatCard
              icon="layers"
              label="Sessions"
              value={profile.sessionCount.toLocaleString()}
            />
            <StatCard
              icon="chat"
              label="Messages"
              value={(profile.lifetimeGenerations * 2).toLocaleString()}
            />
            <StatCard
              icon="activity"
              label="Active days"
              value={profile.dailyActivity.length.toLocaleString()}
            />
            <StatCard
              icon="clock"
              label="Peak hour"
              value={profile.peakHour !== null ? formatHourRange(profile.peakHour) : '—'}
            />
            <StatCard
              icon="cpu"
              label="Favorite model"
              value={profile.favoriteModel?.modelName ?? '—'}
            />
          </div>

          <div className={styles.heatmapPanel}>
            <UsageHeatmap dailyActivity={profile.dailyActivity} />
          </div>

          <TokenActivityChartSection />

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
