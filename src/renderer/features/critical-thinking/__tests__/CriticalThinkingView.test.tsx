// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CriticalThinkingRun } from '@shared/criticalThinking.types'
import { createDefaultSettings } from '@shared/settings.defaults'
import { fireEvent, render, screen, waitFor } from '../../../test-utils/dom'

/**
 * First coverage for the view that drives long unattended investigations. The
 * defect it had lives entirely in a re-render — a store broadcast arriving
 * while a plan is being edited — so it needs a real document and could not have
 * been caught before the DOM environment landed.
 */

const approve = vi.fn<(id: string, plan: unknown) => Promise<void>>()
const create = vi.fn()
const notify = vi.fn()
const writeText = vi.fn<(text: string) => Promise<void>>()

const settings = createDefaultSettings('/models')
settings.webSearch.provider = 'brave'

let storeState: Record<string, unknown>

vi.mock('../../../stores/criticalThinkingStore', () => ({
  useCriticalThinkingStore: (select: (state: unknown) => unknown) => select(storeState)
}))
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) => select({ settings })
}))
vi.mock('../../../stores/modelStore', () => ({
  useModelStore: (select: (state: unknown) => unknown) =>
    select({ engine: { status: 'ready', generating: false, vision: false } })
}))
vi.mock('../../../stores/uiStore', () => ({
  useUiStore: (select: (state: unknown) => unknown) => select({ openSettings: vi.fn(), notify })
}))
vi.mock('../../../lib/anodex', () => ({
  anodex: { criticalThinking: { exportPdf: vi.fn() } }
}))
// Both render the run's own content and pull in their own helpers; neither is
// what these tests are about.
vi.mock('../CriticalThinkingReport', () => ({
  CriticalThinkingReport: ({ report }: { report: string }) => <div>{report}</div>
}))
vi.mock('../CriticalThinkingProgress', () => ({ CriticalThinkingProgress: () => null }))

const { CriticalThinkingView } = await import('../CriticalThinkingView')

function run(overrides: Partial<CriticalThinkingRun> = {}): CriticalThinkingRun {
  return {
    id: 'run-1',
    question: 'Does a four-day week work?',
    status: 'needs-review',
    provider: 'local',
    model: null,
    researchPolicy: {} as CriticalThinkingRun['researchPolicy'],
    plan: {
      title: 'Investigation plan',
      updatedAt: 1,
      steps: [{ id: 'step-1', title: 'Find productivity studies', status: 'pending' }]
    },
    report: '',
    sources: [],
    steps: [],
    currentStep: 0,
    evidenceCount: 0,
    activities: [],
    stats: null,
    synthesisDiagnostics: null,
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

/** Re-broadcast the same runs as freshly deserialized objects, as IPC does. */
function rebroadcast(): CriticalThinkingRun[] {
  return (storeState.runs as CriticalThinkingRun[]).map((item) => ({
    ...item,
    plan: item.plan ? { ...item.plan, steps: item.plan.steps.map((s) => ({ ...s })) } : null
  }))
}

function setRuns(runs: CriticalThinkingRun[]): void {
  storeState = { ...storeState, runs }
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState = {
    runs: [run()],
    selectedId: 'run-1',
    create,
    approve,
    stop: vi.fn(),
    resume: vi.fn(),
    delete: vi.fn(),
    select: vi.fn()
  }
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText },
    configurable: true
  })
  writeText.mockResolvedValue(undefined)
})

describe('editing a plan before approving it', () => {
  it('seeds the editor from the run being reviewed', () => {
    render(<CriticalThinkingView />)

    expect(screen.getByLabelText('Research step 1')).toHaveProperty(
      'value',
      'Find productivity studies'
    )
  })

  /**
   * The regression. Every `runsChanged` broadcast replaces the whole run array
   * with freshly deserialized objects, and the seeding effect depended on
   * `selected.plan` — so it reseeded on identity alone. A second investigation
   * running underneath broadcasts roughly seven times a second, and each one
   * threw away whatever the reviewer had typed.
   */
  it('keeps edits made by the reviewer when a store broadcast arrives', () => {
    const { rerender } = render(<CriticalThinkingView />)

    fireEvent.change(screen.getByLabelText('Research step 1'), {
      target: { value: 'Find retention studies instead' }
    })
    setRuns(rebroadcast())
    rerender(<CriticalThinkingView />)

    expect(screen.getByLabelText('Research step 1')).toHaveProperty(
      'value',
      'Find retention studies instead'
    )
  })

  it('keeps an added step through a broadcast', () => {
    const { rerender } = render(<CriticalThinkingView />)

    fireEvent.click(screen.getByText('Add step'))
    setRuns(rebroadcast())
    rerender(<CriticalThinkingView />)

    expect(screen.getByLabelText('Research step 2')).toBeDefined()
  })

  it('still reseeds when the plan first arrives for a run being watched', () => {
    setRuns([run({ status: 'planning', plan: null })])
    const { rerender } = render(<CriticalThinkingView />)
    expect(screen.queryByLabelText('Research step 1')).toBeNull()

    setRuns([run()])
    rerender(<CriticalThinkingView />)

    expect(screen.getByLabelText('Research step 1')).toHaveProperty(
      'value',
      'Find productivity studies'
    )
  })

  it('reseeds when a different run is selected', () => {
    const other = run({
      id: 'run-2',
      question: 'Second question',
      plan: {
        title: 'Other plan',
        updatedAt: 1,
        steps: [{ id: 'step-9', title: 'A different step', status: 'pending' }]
      }
    })
    setRuns([run(), other])
    const { rerender } = render(<CriticalThinkingView />)

    storeState = { ...storeState, selectedId: 'run-2' }
    rerender(<CriticalThinkingView />)

    expect(screen.getByLabelText('Research step 1')).toHaveProperty('value', 'A different step')
  })

  it('approves the edited plan, not the one the server sent', async () => {
    render(<CriticalThinkingView />)

    fireEvent.change(screen.getByLabelText('Research step 1'), {
      target: { value: 'Edited before approval' }
    })
    fireEvent.click(screen.getByText('Start research'))

    await waitFor(() => expect(approve).toHaveBeenCalled())
    const [, plan] = approve.mock.calls[0] as [string, { steps: { title: string }[] }]
    expect(plan.steps[0].title).toBe('Edited before approval')
  })
})

describe('copying a finished report', () => {
  beforeEach(() => {
    setRuns([run({ status: 'completed', report: '# Findings\n\nThe answer.' })])
  })

  it('copies the report and says so', async () => {
    render(<CriticalThinkingView />)

    fireEvent.click(screen.getByLabelText('Copy report'))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Findings\n\nThe answer.'))
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Report copied' }))
  })

  // The clipboard can refuse — a denied permission, an unfocused window. This
  // was an unhandled rejection and a button that did nothing, after a run that
  // may have taken an hour to produce the text.
  it('reports a clipboard the browser refused', async () => {
    writeText.mockRejectedValue(new Error('Document is not focused'))
    render(<CriticalThinkingView />)

    fireEvent.click(screen.getByLabelText('Copy report'))

    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'error', title: 'Could not copy the report' })
      )
    )
  })
})
