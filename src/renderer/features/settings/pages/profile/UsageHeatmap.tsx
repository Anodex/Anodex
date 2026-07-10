import { useMemo } from 'react'
import type { DailyUsageBucket } from '@shared/stats.types'
import styles from './UsageHeatmap.module.css'

/** ~6 months of columns — enough to see real patterns without the grid getting unwieldy. */
const WEEKS_SHOWN = 26

/** Discrete color-intensity buckets, on top of "no activity". */
const INTENSITY_LEVELS = 4

interface HeatmapCell {
  date: string
  tokens: number
  /** False for days after today that fall inside the current (partial) week's column. */
  inRange: boolean
}

interface HeatmapColumn {
  cells: HeatmapCell[]
  monthLabel: string | null
}

function toLocalDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildColumns(tokensByDate: Map<string, number>, weeks: number): HeatmapColumn[] {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const todayString = toLocalDateString(today)

  // Align the grid to the Sunday on/before today, then walk back `weeks - 1`
  // more full weeks so today's column is the last one.
  const gridEnd = new Date(today)
  gridEnd.setDate(gridEnd.getDate() - gridEnd.getDay())
  const gridStart = new Date(gridEnd)
  gridStart.setDate(gridStart.getDate() - (weeks - 1) * 7)

  const columns: HeatmapColumn[] = []
  let previousMonth = -1
  for (let week = 0; week < weeks; week++) {
    const cells: HeatmapCell[] = []
    let monthLabel: string | null = null
    for (let day = 0; day < 7; day++) {
      const cellDate = new Date(gridStart)
      cellDate.setDate(cellDate.getDate() + week * 7 + day)
      const dateString = toLocalDateString(cellDate)
      if (day === 0 && cellDate.getMonth() !== previousMonth) {
        previousMonth = cellDate.getMonth()
        monthLabel = cellDate.toLocaleDateString(undefined, { month: 'short' })
      }
      cells.push({
        date: dateString,
        tokens: tokensByDate.get(dateString) ?? 0,
        inRange: dateString <= todayString
      })
    }
    columns.push({ cells, monthLabel })
  }
  return columns
}

function intensityLevel(tokens: number, maxTokens: number): number {
  if (tokens <= 0 || maxTokens <= 0) return 0
  return Math.min(INTENSITY_LEVELS, Math.max(1, Math.ceil((tokens / maxTokens) * INTENSITY_LEVELS)))
}

interface UsageHeatmapProps {
  dailyActivity: DailyUsageBucket[]
}

/** GitHub-contribution-style activity grid — pure/presentational, no data fetching. */
export function UsageHeatmap({ dailyActivity }: UsageHeatmapProps): JSX.Element {
  const { columns, maxTokens } = useMemo(() => {
    const tokensByDate = new Map(dailyActivity.map((day) => [day.date, day.tokens]))
    return {
      columns: buildColumns(tokensByDate, WEEKS_SHOWN),
      maxTokens: dailyActivity.reduce((max, day) => Math.max(max, day.tokens), 0)
    }
  }, [dailyActivity])

  return (
    <div className={styles.heatmap}>
      <div className={styles.grid}>
        {columns.map((column, index) => (
          <div key={index} className={styles.column}>
            <div className={styles.monthLabel}>{column.monthLabel}</div>
            <div className={styles.days}>
              {column.cells.map((cell) => (
                <div
                  key={cell.date}
                  className={styles.cell}
                  data-level={cell.inRange ? intensityLevel(cell.tokens, maxTokens) : 'none'}
                  title={
                    cell.inRange
                      ? `${cell.date}: ${cell.tokens.toLocaleString()} tokens`
                      : undefined
                  }
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
