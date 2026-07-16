export type CriticalThinkingChartType = 'bar' | 'line' | 'pie'

export interface CriticalThinkingChartDataset {
  label: string
  values: number[]
}

export interface CriticalThinkingChartSpec {
  type: CriticalThinkingChartType
  title: string
  labels: string[]
  datasets: CriticalThinkingChartDataset[]
  unit?: string
  source: string
  note?: string
}

const MAX_LABELS = 12
const MAX_DATASETS = 4
const MAX_TEXT_LENGTH = 120

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedText(value: unknown, maxLength = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= maxLength ? text : null
}

function isSourceCitation(value: string): boolean {
  return /^\[[^\]]+\]\(https?:\/\/[^\s)]+\)$/.test(value)
}

/** Parse the deliberately small, evidence-cited chart grammar emitted in report fences. */
export function parseCriticalThinkingChart(raw: string): CriticalThinkingChartSpec | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const type = parsed.type
  if (type !== 'bar' && type !== 'line' && type !== 'pie') return null
  const title = boundedText(parsed.title)
  const source = boundedText(parsed.source, 500)
  if (!title || !source || !isSourceCitation(source)) return null

  if (!Array.isArray(parsed.labels) || parsed.labels.length < 2) return null
  if (parsed.labels.length > (type === 'pie' ? 8 : MAX_LABELS)) return null
  const labels = parsed.labels.map((label) => boundedText(label, 60))
  if (labels.some((label) => !label)) return null

  if (
    !Array.isArray(parsed.datasets) ||
    parsed.datasets.length < 1 ||
    parsed.datasets.length > MAX_DATASETS ||
    (type === 'pie' && parsed.datasets.length !== 1)
  ) {
    return null
  }

  const datasets: CriticalThinkingChartDataset[] = []
  for (const value of parsed.datasets) {
    if (!isRecord(value)) return null
    const label = boundedText(value.label, 60)
    if (!label || !Array.isArray(value.values) || value.values.length !== labels.length) return null
    if (
      value.values.some(
        (point) => typeof point !== 'number' || !Number.isFinite(point) || Math.abs(point) > 1e15
      )
    ) {
      return null
    }
    datasets.push({ label, values: value.values as number[] })
  }

  if (type === 'pie') {
    const values = datasets[0].values
    if (values.some((value) => value < 0) || values.every((value) => value === 0)) return null
  }

  const unit = parsed.unit === undefined ? undefined : boundedText(parsed.unit, 20)
  const note = parsed.note === undefined ? undefined : boundedText(parsed.note, 300)
  if (parsed.unit !== undefined && !unit) return null
  if (parsed.note !== undefined && !note) return null

  return {
    type,
    title,
    labels: labels as string[],
    datasets,
    ...(unit ? { unit } : {}),
    source,
    ...(note ? { note } : {})
  }
}
