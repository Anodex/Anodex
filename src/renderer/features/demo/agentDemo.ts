/**
 * Agent walkthrough. Navigates to the Agent view and starts two unattended
 * runs — one showing plan review, one showing the budget controls.
 *
 * Unlike the Scheduler script, this one actually launches work: "Start run"
 * begins a real unattended run against the loaded model. Both scripted runs are
 * therefore **read-only** — no `write_file`, no `run_command` — so a take can
 * be re-shot as often as you like without touching the project. The
 * unattended-write warning is worth narrating over the Scheduler segment
 * instead, where nothing is launched.
 *
 * Dev-only; registered in `index.ts`.
 */
import { clickElement } from './demoCursor'
import {
  FIELD_PAUSE_MS,
  PREVIEW_PAUSE_MS,
  beat,
  clickButton,
  gotoView,
  pickFirstProject,
  setControlledValue,
  tickTools,
  type,
  waitFor
} from './demoKit'

const goalField = (): HTMLTextAreaElement | null =>
  document.querySelector('textarea[placeholder^="e.g. Research what CONTRIBUTING.md"]')

/**
 * Finds a labelled switch by the text in the row that contains it. The editor's
 * toggles carry no `aria-label`, so the visible label is the only stable handle
 * — and it's the thing the viewer reads on screen anyway.
 */
function toggleByLabel(labelText: string): HTMLButtonElement | null {
  const row = [...document.querySelectorAll('label, div')].find(
    (el) =>
      el.querySelector('button[role="switch"]') !== null &&
      [...el.querySelectorAll('span')].some((s) => s.textContent?.trim() === labelText)
  )
  return row?.querySelector<HTMLButtonElement>('button[role="switch"]') ?? null
}

/** Flips a switch only if it isn't already in the wanted state. */
async function setToggle(labelText: string, on: boolean): Promise<void> {
  const toggle = toggleByLabel(labelText)
  if (!toggle) {
    console.warn(`Agent demo: toggle "${labelText}" not found, skipping`)
    return
  }
  if ((toggle.getAttribute('aria-checked') === 'true') === on) return
  await clickElement(toggle)
  await beat(500)
}

/** Sets a budget number input, found by the label sitting above it. */
async function setBudget(labelText: string, value: string): Promise<void> {
  const row = [...document.querySelectorAll('label')].find((el) =>
    [...el.querySelectorAll('span')].some((s) => s.textContent?.trim() === labelText)
  )
  const input = row?.querySelector<HTMLInputElement>('input')
  if (!input) {
    console.warn(`Agent demo: budget "${labelText}" not found, skipping`)
    return
  }
  setControlledValue(input, value)
  await beat(450)
}

export interface DemoRun {
  /** Logged as the step starts, so a take can be narrated live off the console. */
  title: string
  goal: string
  /** Read-only tools only — see the note at the top of this file. */
  tools: string[]
  requirePlan: boolean
  /** Omitted leaves "Enforce limits" off, which is the editor's default. */
  budgets?: { turns?: string; tokens?: string; minutes?: string }
}

export const DEMO_RUNS: DemoRun[] = [
  {
    title: 'Research run — shows plan review before any work starts',
    goal: 'Read the README and CONTRIBUTING files in this project and summarize how a new contributor is expected to set up and submit changes.',
    tools: ['read_file', 'list_directory', 'search_files'],
    requirePlan: true
  },
  {
    title: 'Bounded run — shows the turn, token and time budgets',
    goal: 'Survey the test files in this project and report which areas look well covered and which look thin.',
    tools: ['read_file', 'search_code', 'code_outline'],
    requirePlan: false,
    budgets: { turns: '12', tokens: '40000', minutes: '10' }
  }
]

/** Fills and starts one run, assuming the Agent view is on screen. */
export async function runAgentRun(run: DemoRun): Promise<void> {
  console.log(`%c▶ ${run.title}`, 'font-weight:bold')

  await clickButton('New run')

  await type(await waitFor(goalField, 'the goal field'), run.goal)
  await beat(FIELD_PAUSE_MS)

  await pickFirstProject()
  await beat(FIELD_PAUSE_MS)

  await setToggle('Require plan review', run.requirePlan)

  if (run.budgets) {
    await setToggle('Enforce limits', true)
    // The budget fields only mount once limits are on.
    await beat(FIELD_PAUSE_MS)
    if (run.budgets.turns) await setBudget('Turn budget', run.budgets.turns)
    if (run.budgets.tokens) await setBudget('Token budget', run.budgets.tokens)
    if (run.budgets.minutes) await setBudget('Time budget', run.budgets.minutes)
    await beat(PREVIEW_PAUSE_MS)
  }

  await tickTools(run.tools)
  await beat(FIELD_PAUSE_MS)

  await clickButton('Start run')
}

/** Navigates to Agent and starts both runs. `only` re-shoots a single one. */
export async function runAgentDemo(only?: number): Promise<void> {
  const queue = only === undefined ? DEMO_RUNS : [DEMO_RUNS[only]].filter(Boolean)

  if (only === undefined) await gotoView('Agent')

  for (const [index, run] of queue.entries()) {
    await runAgentRun(run)
    // Longer than the Scheduler's gap: the first run is live on screen and
    // worth watching start before the next form opens over it.
    if (index < queue.length - 1) await beat(6000)
  }
}
