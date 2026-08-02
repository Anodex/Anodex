/**
 * Scheduler walkthrough. Opens on a fresh chat, navigates to the Scheduler, and
 * builds five tasks — enough to show the natural-language When field, the
 * unattended-tools warning, the repeat floor, and a populated Today strip.
 *
 * See `demoKit` for the shared plumbing and `demoCursor` for the drawn-on
 * pointer. Dev-only; registered in `index.ts`.
 */
import {
  FIELD_PAUSE_MS,
  PREVIEW_PAUSE_MS,
  beat,
  clearByBackspace,
  clickButton,
  gotoNewChat,
  gotoView,
  pickFirstProject,
  tickTools,
  type,
  waitFor
} from './demoKit'

const promptField = (): HTMLTextAreaElement | null =>
  document.querySelector('textarea[placeholder^="e.g. Summarize what changed"]')
const nameField = (): HTMLInputElement | null =>
  document.querySelector('input[placeholder^="Named after the prompt"]')
const whenField = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>('#when-input')

export interface DemoTask {
  /** Logged as each step starts, so a take can be narrated live off the console. */
  title: string
  prompt: string
  name: string
  /**
   * Typed into the When field. Two entries means type the first, hold on it,
   * backspace it out and type the second — used to show the interval floor
   * warning and then the correction.
   */
  when: string[]
  /** Tool names to tick, e.g. `read_file`. Ticked in order, with a beat between. */
  tools: string[]
  /** Picked before the tools, since file/command tools need a project. */
  needsProject?: boolean
}

/**
 * The recording script.
 *
 * Ordered for pacing, and for what the Today strip does as each one lands: the
 * task that fires during the video comes first, then the 30-minute interval —
 * which is the only entry that contributes a whole row of marks — so the strip
 * visibly fills early instead of staying near-empty until the end. The
 * recurring schedules and the weekly edge case follow.
 */
export const DEMO_TASKS: DemoTask[] = [
  {
    title: 'Quick project pulse — fires during the recording',
    prompt:
      'List the three most recently changed files in this project and say in one sentence what each change was about.',
    name: 'Quick project pulse',
    when: ['in 2 minutes'],
    tools: ['read_file', 'list_directory'],
    needsProject: true
  },
  {
    title: 'Dev server watch — the repeat floor, then the correction (fills the Today strip)',
    prompt: 'Check whether the dev server is still running and report just OK or the error.',
    name: 'Dev server watch',
    when: ['every 2 minutes', 'every 30 minutes'],
    tools: ['run_command'],
    needsProject: true
  },
  {
    title: 'Morning standup — daily recurrence',
    prompt:
      'Summarize what changed in this project since yesterday, then list anything left unfinished.',
    name: 'Morning standup',
    when: ['every day at 9am'],
    tools: ['git_status', 'read_file'],
    needsProject: true
  },
  {
    title: 'End of day log — weekday rule, and the unattended-write warning',
    prompt:
      'Write a short end-of-day log: what I worked on today, and the first thing to pick up tomorrow.',
    name: 'End of day log',
    when: ['weekdays at 5pm'],
    tools: ['read_file', 'write_file'],
    needsProject: true
  },
  {
    title: 'Weekly wrap-up — the long horizon',
    prompt: "Write a short summary of this week's work in this project, grouped by feature.",
    name: 'Weekly wrap-up',
    when: ['every Friday at 4pm'],
    tools: ['read_file', 'web_search'],
    needsProject: true
  }
]

/** Fills and saves one task, assuming the Scheduler view is on screen. */
export async function runSchedulerTask(task: DemoTask): Promise<void> {
  console.log(`%c▶ ${task.title}`, 'font-weight:bold')

  await clickButton('New task')

  await type(await waitFor(promptField, 'the prompt field'), task.prompt)
  await beat(FIELD_PAUSE_MS)

  await type(await waitFor(nameField, 'the name field'), task.name)
  await beat(FIELD_PAUSE_MS)

  if (task.needsProject) {
    await pickFirstProject()
    await beat(FIELD_PAUSE_MS)
  }

  const when = await waitFor(whenField, 'the When field')
  for (const [index, phrase] of task.when.entries()) {
    if (index > 0) {
      // Hold on the rejected phrase long enough for the warning to be read,
      // then walk it back on camera rather than clearing it instantly.
      await beat(PREVIEW_PAUSE_MS + 900)
      await clearByBackspace(when)
      await beat(400)
    }
    await type(when, phrase)
  }
  await beat(PREVIEW_PAUSE_MS)

  await tickTools(task.tools)
  await beat(FIELD_PAUSE_MS)

  await clickButton('Create task')
}

/**
 * How much of today has to be left for the Today strip to look populated. The
 * strip only draws marks falling inside the current day, so a take started at
 * 11:50 PM produces a nearly empty track no matter what gets scheduled — the
 * schedules are fine, the day is just over. Warned about rather than blocked:
 * a take that isn't showing the strip is still a valid take.
 */
const GOOD_TAKE_HOURS_LEFT = 4

function warnIfLateInDay(): void {
  const now = new Date()
  const hoursLeft = 24 - now.getHours() - now.getMinutes() / 60
  if (hoursLeft >= GOOD_TAKE_HOURS_LEFT) return
  console.warn(
    `Scheduler demo: only ${hoursLeft.toFixed(1)}h of today left — the Today strip will look ` +
      'nearly empty, since it only shows marks inside the current day. Record mid-morning for a ' +
      'full track (the 9am, 5pm and 30-minute schedules all land inside the day then).'
  )
}

/** The opening shot plus all five tasks. `only` re-shoots a single task. */
export async function runSchedulerDemo(only?: number): Promise<void> {
  warnIfLateInDay()
  const queue = only === undefined ? DEMO_TASKS : [DEMO_TASKS[only]].filter(Boolean)

  // Re-shoots of a single task skip the intro: you're already on the view.
  if (only === undefined) {
    await gotoNewChat()
    await gotoView('Scheduler')
  }

  for (const [index, task] of queue.entries()) {
    await runSchedulerTask(task)
    if (index < queue.length - 1) await beat(2600)
  }
}
