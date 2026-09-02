import { formatAgo, formatNextRun } from './relativeTime'

/**
 * Anodex describing its own state back to the user, in words.
 *
 * Chat could always explain what the Scheduler *is* and where it lives, but not
 * what was actually in it — so "what have I got scheduled?" got a description of
 * a feature instead of an answer, with the real list one page away. This is the
 * data behind that answer.
 *
 * Strictly read-only, and that is a structural property rather than a promise:
 * the tool built on this reads stores and renders text, and there is no write
 * path in the module to reach. A prompt asking a model not to change things is
 * a suggestion; having nothing to call is a guarantee.
 *
 * Rendering lives here, apart from the stores, so the whole thing is testable
 * as a pure function — the alternative is proving output shape through Electron.
 */

/** Which part of Anodex to report on. */
export type AnodexStatusSection =
  'overview' | 'scheduler' | 'agents' | 'critical-thinking' | 'projects' | 'email'

export const ANODEX_STATUS_SECTIONS: readonly AnodexStatusSection[] = [
  'overview',
  'scheduler',
  'agents',
  'critical-thinking',
  'projects',
  'email'
]

export interface ScheduledTaskStatus {
  name: string
  enabled: boolean
  /** Human phrasing of the recurrence, from `describeRecurrence`. */
  schedule: string
  nextRunAt: number | null
  lastRunAt: number | null
  lastRunStatus: string | null
}

export interface AgentRunStatus {
  goal: string
  status: string
  turnsUsed: number
  maxTurns: number
  updatedAt: number
  projectName: string | null
}

export interface CriticalThinkingRunStatus {
  question: string
  status: string
  sourceCount: number
  updatedAt: number
}

export interface ProjectStatus {
  name: string
  isActive: boolean
}

export interface EmailAccountStatus {
  address: string
  provider: string
}

/** Everything the status tool can report, gathered from the stores. */
export interface AnodexStatusSnapshot {
  now: number
  scheduler: ScheduledTaskStatus[]
  agents: AgentRunStatus[]
  criticalThinking: CriticalThinkingRunStatus[]
  projects: ProjectStatus[]
  email: EmailAccountStatus[]
}

/**
 * How many rows a detail section prints.
 *
 * This output lands in a chat context that is routinely 8,192 tokens, where the
 * whole working set is about 4,750. A hundred scheduled tasks rendered in full
 * would evict the conversation that asked for them, so the list is capped and
 * says how many it left out — a truncation the reader can see beats a context
 * blowout they cannot.
 */
const DETAIL_LIMIT = 8

/** Long enough to recognise a goal or question, short enough to stay one line. */
const TEXT_LIMIT = 80

export function renderAnodexStatus(
  snapshot: AnodexStatusSnapshot,
  section: AnodexStatusSection = 'overview'
): string {
  switch (section) {
    case 'scheduler':
      return renderScheduler(snapshot)
    case 'agents':
      return renderAgents(snapshot)
    case 'critical-thinking':
      return renderCriticalThinking(snapshot)
    case 'projects':
      return renderProjects(snapshot)
    case 'email':
      return renderEmail(snapshot)
    default:
      return renderOverview(snapshot)
  }
}

/**
 * One line per area, so a "what's going on?" answer costs a handful of lines
 * rather than five full listings. Each line names the section that would show
 * more, because the model otherwise has no way to know a second call exists.
 */
function renderOverview(snapshot: AnodexStatusSnapshot): string {
  const active = snapshot.projects.find((project) => project.isActive)
  const enabled = snapshot.scheduler.filter((task) => task.enabled)
  const nextUp = [...enabled]
    .filter((task) => task.nextRunAt !== null)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0]
  const running = snapshot.agents.filter((run) => run.status === 'running')
  const thinking = snapshot.criticalThinking.filter((run) => run.status === 'running')

  const lines = [
    'Anodex status (read-only — this reports state, it cannot change it).',
    '',
    `Projects: ${snapshot.projects.length}${active ? `, active: ${active.name}` : ', none open'}`,
    `Scheduler: ${count(snapshot.scheduler, 'task')}, ${enabled.length} enabled` +
      (nextUp
        ? ` — next is "${clip(nextUp.name)}" ${formatNextRun(nextUp.nextRunAt, snapshot.now).toLowerCase()}`
        : ''),
    `Agent runs: ${count(snapshot.agents, 'run')}` +
      (running.length > 0 ? `, ${running.length} running now` : ''),
    `Critical Thinking: ${count(snapshot.criticalThinking, 'run')}` +
      (thinking.length > 0 ? `, ${thinking.length} running now` : ''),
    `Email accounts linked: ${snapshot.email.length}`,
    '',
    'Ask for a section (scheduler, agents, critical-thinking, projects, email) for the detail.'
  ]
  return lines.join('\n')
}

function renderScheduler(snapshot: AnodexStatusSnapshot): string {
  if (snapshot.scheduler.length === 0) {
    return 'No scheduled tasks. The Scheduler view is where they are created.'
  }
  // Soonest first: "what is about to happen" is the question a schedule is
  // usually asked, and a paused task has no next run to sort by.
  const sorted = [...snapshot.scheduler].sort(
    (a, b) => (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER)
  )
  return withHeader(`${count(snapshot.scheduler, 'scheduled task')}:`, sorted, (task) => {
    const when = task.enabled ? formatNextRun(task.nextRunAt, snapshot.now) : 'Paused'
    const last =
      task.lastRunAt === null
        ? 'never run'
        : `last run ${formatAgo(task.lastRunAt, snapshot.now)}${task.lastRunStatus ? ` (${task.lastRunStatus})` : ''}`
    return `- "${clip(task.name)}" — ${task.schedule}. ${when}; ${last}.`
  })
}

function renderAgents(snapshot: AnodexStatusSnapshot): string {
  if (snapshot.agents.length === 0) {
    return 'No agent runs yet. The Agent view is where one is started.'
  }
  const sorted = [...snapshot.agents].sort((a, b) => b.updatedAt - a.updatedAt)
  return withHeader(`${count(snapshot.agents, 'agent run')}, most recent first:`, sorted, (run) => {
    const where = run.projectName ? ` in ${run.projectName}` : ''
    return (
      `- "${clip(run.goal)}"${where} — ${run.status}, ` +
      `${run.turnsUsed}/${run.maxTurns} turns, updated ${formatAgo(run.updatedAt, snapshot.now)}.`
    )
  })
}

function renderCriticalThinking(snapshot: AnodexStatusSnapshot): string {
  if (snapshot.criticalThinking.length === 0) {
    return 'No Critical Thinking runs yet. The Critical Thinking view is where one is started.'
  }
  const sorted = [...snapshot.criticalThinking].sort((a, b) => b.updatedAt - a.updatedAt)
  return withHeader(
    `${count(snapshot.criticalThinking, 'Critical Thinking run')}, most recent first:`,
    sorted,
    (run) =>
      `- "${clip(run.question)}" — ${run.status}, ${count(run.sourceCount, 'source')}, ` +
      `updated ${formatAgo(run.updatedAt, snapshot.now)}.`
  )
}

function renderProjects(snapshot: AnodexStatusSnapshot): string {
  if (snapshot.projects.length === 0) {
    return 'No projects. Opening a folder as a Project is what unlocks file and command tools.'
  }
  return withHeader(
    `${count(snapshot.projects, 'project')}:`,
    snapshot.projects,
    (project) => `- ${project.name}${project.isActive ? ' (open now)' : ''}`
  )
}

/**
 * Accounts only — never messages.
 *
 * Whether an account is linked is configuration; what is in it is
 * correspondence. Reading mail has its own tools, gated separately, and folding
 * message content into a general "how are things?" answer would put the inbox
 * into any chat that asked a vague question.
 */
function renderEmail(snapshot: AnodexStatusSnapshot): string {
  if (snapshot.email.length === 0) {
    return 'No email accounts linked. Settings is where one is added.'
  }
  return withHeader(
    `${count(snapshot.email, 'linked email account')} (accounts only — this does not read mail):`,
    snapshot.email,
    (account) => `- ${account.address} (${account.provider})`
  )
}

/** A capped list under a heading, with an honest note about what was cut. */
function withHeader<T>(header: string, items: T[], render: (item: T) => string): string {
  const shown = items.slice(0, DETAIL_LIMIT).map(render)
  const omitted = items.length - shown.length
  const lines = [header, ...shown]
  if (omitted > 0) lines.push(`- …and ${omitted} more not shown.`)
  return lines.join('\n')
}

/** "3 tasks" / "1 task", from a list or a number. */
function count(value: unknown[] | number, noun: string): string {
  const total = typeof value === 'number' ? value : value.length
  return `${total} ${noun}${total === 1 ? '' : 's'}`
}

/** Keep a goal, question or task name to one readable line. */
function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > TEXT_LIMIT ? `${flat.slice(0, TEXT_LIMIT - 1)}…` : flat
}
