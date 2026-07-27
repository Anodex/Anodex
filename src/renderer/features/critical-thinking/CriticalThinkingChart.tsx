import type { ReactNode } from 'react'
import type { CriticalThinkingChartSpec } from './criticalThinkingCharts'
import styles from './CriticalThinkingChart.module.css'

/**
 * Categorical series colours, in fixed order, read from the theme rather than
 * baked in — the previous hardcoded set was one palette painted onto two very
 * different surfaces, too light against near-black and under 3:1 against cream.
 * Each mode now supplies its own steps; see the note in `themes/midnight.css`.
 *
 * Applied through `style` rather than the `fill`/`stroke` presentation
 * attributes, which don't resolve `var()`.
 *
 * KNOWN GAP: callers below still wrap with `% COLORS.length` for pie charts, so
 * a fifth slice repeats the first slice's colour. Cycling a categorical palette
 * makes two categories indistinguishable; the fix is to fold the tail into an
 * "Other" slice rather than to invent a fifth hue, which is a change to what
 * the chart *says* and wants its own decision.
 */
const COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)']
const WIDTH = 720
const HEIGHT = 350
const LEFT = 66
const RIGHT = 24
const TOP = 42
const BOTTOM = 62

function formatValue(value: number, unit?: string): string {
  const formatted = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: Math.abs(value) < 10 ? 2 : 1,
    notation: Math.abs(value) >= 1_000_000 ? 'compact' : 'standard'
  }).format(value)
  if (!unit) return formatted
  if (unit === '$') return `$${formatted}`
  if (unit === '%') return `${formatted}%`
  return `${formatted} ${unit}`
}

function shortLabel(label: string): string {
  return label.length > 16 ? `${label.slice(0, 15)}…` : label
}

function renderCitation(source: string): ReactNode {
  const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(source)
  return link ? (
    <a href={link[2]} target="_blank" rel="noreferrer">
      {link[1]}
    </a>
  ) : (
    source
  )
}

function Legend({ spec }: { spec: CriticalThinkingChartSpec }): JSX.Element | null {
  if (spec.datasets.length < 2) return null
  return (
    <g aria-hidden="true">
      {spec.datasets.map((dataset, index) => (
        <g key={dataset.label} transform={`translate(${LEFT + index * 150}, 16)`}>
          <rect width="11" height="11" rx="2" style={{ fill: COLORS[index] }} />
          <text x="17" y="10" className={styles.legendText}>
            {shortLabel(dataset.label)}
          </text>
        </g>
      ))}
    </g>
  )
}

function CartesianChart({ spec }: { spec: CriticalThinkingChartSpec }): JSX.Element {
  const plotWidth = WIDTH - LEFT - RIGHT
  const plotHeight = HEIGHT - TOP - BOTTOM
  const values = spec.datasets.flatMap((dataset) => dataset.values)
  const minimum = Math.min(0, ...values)
  let maximum = Math.max(0, ...values)
  if (minimum === maximum) maximum = minimum + 1
  const range = maximum - minimum
  const y = (value: number): number => TOP + ((maximum - value) / range) * plotHeight
  const zeroY = y(0)
  const tickCount = 4
  const groupWidth = plotWidth / spec.labels.length

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={spec.title}>
      <title>{spec.title}</title>
      <Legend spec={spec} />
      {Array.from({ length: tickCount + 1 }, (_, index) => {
        const value = maximum - (range * index) / tickCount
        const tickY = y(value)
        return (
          <g key={index} aria-hidden="true">
            <line x1={LEFT} y1={tickY} x2={WIDTH - RIGHT} y2={tickY} className={styles.gridLine} />
            <text x={LEFT - 9} y={tickY + 4} textAnchor="end" className={styles.axisText}>
              {formatValue(value, spec.unit)}
            </text>
          </g>
        )
      })}
      <line x1={LEFT} y1={zeroY} x2={WIDTH - RIGHT} y2={zeroY} className={styles.zeroLine} />
      {spec.labels.map((label, index) => (
        <text
          key={label}
          x={LEFT + groupWidth * (index + 0.5)}
          y={TOP + plotHeight + 25}
          textAnchor="middle"
          className={styles.axisText}
        >
          {shortLabel(label)}
        </text>
      ))}
      {spec.type === 'bar'
        ? spec.datasets.flatMap((dataset, datasetIndex) => {
            const availableWidth = groupWidth * 0.72
            const barWidth = Math.max(3, availableWidth / spec.datasets.length)
            return dataset.values.map((value, valueIndex) => {
              const valueY = y(value)
              const x =
                LEFT +
                groupWidth * valueIndex +
                (groupWidth - availableWidth) / 2 +
                datasetIndex * barWidth
              return (
                <rect
                  key={`${dataset.label}-${valueIndex}`}
                  x={x}
                  y={Math.min(valueY, zeroY)}
                  width={Math.max(2, barWidth - 2)}
                  height={Math.max(1, Math.abs(zeroY - valueY))}
                  rx="2"
                  style={{ fill: COLORS[datasetIndex] }}
                >
                  <title>{`${dataset.label}, ${spec.labels[valueIndex]}: ${formatValue(value, spec.unit)}`}</title>
                </rect>
              )
            })
          })
        : spec.datasets.map((dataset, datasetIndex) => {
            const points = dataset.values.map((value, valueIndex) => ({
              x: LEFT + groupWidth * (valueIndex + 0.5),
              y: y(value),
              value,
              label: spec.labels[valueIndex]
            }))
            return (
              <g key={dataset.label}>
                <polyline
                  points={points.map((point) => `${point.x},${point.y}`).join(' ')}
                  fill="none"
                  style={{ stroke: COLORS[datasetIndex] }}
                  strokeWidth="3"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                {points.map((point) => (
                  <circle
                    key={point.label}
                    cx={point.x}
                    cy={point.y}
                    r="4"
                    style={{ fill: COLORS[datasetIndex] }}
                  >
                    <title>{`${dataset.label}, ${point.label}: ${formatValue(point.value, spec.unit)}`}</title>
                  </circle>
                ))}
              </g>
            )
          })}
    </svg>
  )
}

function pointOnCircle(centerX: number, centerY: number, radius: number, angle: number): string {
  return `${centerX + Math.cos(angle) * radius} ${centerY + Math.sin(angle) * radius}`
}

function PieChart({ spec }: { spec: CriticalThinkingChartSpec }): JSX.Element {
  const values = spec.datasets[0].values
  const total = values.reduce((sum, value) => sum + value, 0)
  const centerX = 215
  const centerY = 160
  const radius = 112
  let angle = -Math.PI / 2

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={spec.title}>
      <title>{spec.title}</title>
      {values.map((value, index) => {
        const slice = (value / total) * Math.PI * 2
        const start = angle
        const end = angle + slice
        angle = end
        const path =
          value === total
            ? null
            : `M ${centerX} ${centerY} L ${pointOnCircle(centerX, centerY, radius, start)} A ${radius} ${radius} 0 ${slice > Math.PI ? 1 : 0} 1 ${pointOnCircle(centerX, centerY, radius, end)} Z`
        const label = `${spec.labels[index]}: ${formatValue(value, spec.unit)} (${Math.round((value / total) * 100)}%)`
        return path ? (
          <path key={spec.labels[index]} d={path} style={{ fill: COLORS[index % COLORS.length] }}>
            <title>{label}</title>
          </path>
        ) : (
          <circle
            key={spec.labels[index]}
            cx={centerX}
            cy={centerY}
            r={radius}
            style={{ fill: COLORS[index % COLORS.length] }}
          >
            <title>{label}</title>
          </circle>
        )
      })}
      {spec.labels.map((label, index) => (
        <g key={label} transform={`translate(390, ${55 + index * 31})`}>
          <rect width="12" height="12" rx="2" style={{ fill: COLORS[index % COLORS.length] }} />
          <text x="20" y="11" className={styles.legendText}>
            {`${shortLabel(label)} - ${Math.round((values[index] / total) * 100)}%`}
          </text>
        </g>
      ))}
    </svg>
  )
}

export function CriticalThinkingChart({ spec }: { spec: CriticalThinkingChartSpec }): JSX.Element {
  return (
    <figure className={styles.chart} data-critical-thinking-chart>
      <h3 data-chart-title>{spec.title}</h3>
      {spec.type === 'pie' ? <PieChart spec={spec} /> : <CartesianChart spec={spec} />}
      <figcaption data-chart-caption>
        {spec.note && <span>{spec.note} </span>}
        <span>Source: {renderCitation(spec.source)}</span>
      </figcaption>
    </figure>
  )
}
