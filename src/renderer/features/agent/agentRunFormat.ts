/**
 * Presentation helpers shared by the Agent list (`AgentView`) and a single
 * run's drill-in log (`AgentRunConversation`), so both label a run's status,
 * provider and budgets the exact same way.
 */
import { activeElapsedMs, type AgentRun, type AgentRunStatus } from '@shared/agentRun.types'
import type { Plan } from '@shared/plan.types'
import { agentRunModelLabel, agentRunProviderVendor } from '@shared/agentRunProviders'
import type { IconName } from '../../components/Icon'

/** A run that has stopped moving on its own — done, stopped, or errored. */
export function isTerminalStatus(status: AgentRunStatus): boolean {
  return status === 'done' || status === 'stopped' || status === 'error'
}

/**
 * Short "backend used" label for a run, e.g. "Local", "Claude · Claude Sonnet 5".
 *
 * Reads the vendor and model name from the shared provider registry rather than
 * branching per provider. The branching version tested for local, then
 * Anthropic, and fell through to OpenAI — so once agent runs accepted all
 * twelve providers it rendered a DeepSeek run as "OpenAI · deepseek-v4-flash",
 * naming the wrong vendor on the one row whose job is to say what did the work.
 */
export function providerLabel(run: AgentRun): string {
  const vendor = agentRunProviderVendor(run.provider)
  const model = agentRunModelLabel(run.provider, run.model)
  return model ? `${vendor} · ${model}` : vendor
}

/** Local runs use the engine icon; every cloud run shares a generic cloud-model icon. */
export function providerIcon(run: AgentRun): IconName {
  return run.provider === 'local' ? 'cpu' : 'sparkle'
}

/** Compact token count for a status badge, e.g. 12400 -> "12.4k". */
export function formatCompactTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** How long a span of work took, e.g. "0.8s", "18.6s", "2m 04s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/** Markdown punctuation that reads as noise once a goal is squeezed onto one line. */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|>\s*)/, '')
    .replace(/(\*\*|__|`)/g, '')
    .trim()
}

/**
 * A goal as one line — for a header or a list card, where the goal has to be
 * named rather than read.
 *
 * Goals are written, not typed into a single-line field: a long one arrives as
 * paragraphs, headings and fenced blocks. Squashing all of that into one run of
 * text put a thousand lines of specification into a page title, with its
 * markdown markers showing. The first line that says something is the name.
 */
export function goalHeadline(goal: string): string {
  for (const raw of goal.split(/\r?\n/)) {
    // Fences and rules are structure, not words.
    if (/^\s*(`{3,}|~{3,}|[=\-_*]{3,}\s*$)/.test(raw)) continue
    const line = stripInlineMarkdown(raw)
    if (line.length > 0) return line
  }
  return goal.trim()
}

/**
 * Past this, the goal on a run's page starts folded. A goal is shown above the
 * run's turns, and a specification-length one pushed every turn off screen.
 */
export const LONG_GOAL_CHARS = 900
export const LONG_GOAL_LINES = 14

export function isLongGoal(goal: string): boolean {
  return goal.length > LONG_GOAL_CHARS || goal.split(/\r?\n/).length > LONG_GOAL_LINES
}

export const STATUS_ICON: Record<AgentRunStatus, IconName> = {
  running: 'activity',
  'needs-review': 'eye',
  done: 'check',
  stopped: 'stop',
  error: 'alert'
}

export const STATUS_LABEL: Record<AgentRunStatus, string> = {
  running: 'Running',
  'needs-review': 'Needs review',
  done: 'Done',
  stopped: 'Stopped',
  error: 'Error'
}

/**
 * What a run's result box says: why it stopped when it stopped for a reason, and
 * its summary otherwise.
 *
 * It was always the summary when there was one. A run that stopped at its turn limit
 * still has a summary — its last reply — so the card was drawn in the warning colour
 * around text reading "all 2 steps complete", and the reason it stopped was only
 * visible after opening it.
 */
export function runOutcomeText(run: Pick<AgentRun, 'status' | 'summary' | 'lastError'>): string {
  const reasonFirst = (run.status === 'error' || run.status === 'stopped') && run.lastError
  return (reasonFirst ? run.lastError : (run.summary ?? run.lastError)) ?? ''
}

/** Which of its limits a stopped run ran into, if that is why it stopped. */
export type RanOut = 'turns' | 'tokens' | 'time'

type BudgetFields = Pick<
  AgentRun,
  | 'status'
  | 'limitsEnabled'
  | 'maxTurns'
  | 'turnsUsed'
  | 'maxTokens'
  | 'tokensUsed'
  | 'maxDurationMinutes'
  | 'activeMs'
  | 'activeSinceAt'
>

/**
 * Why a stopped run stopped, when the reason was one of its limits.
 *
 * Read from the numbers rather than from `lastError`, whose wording has changed
 * and will again, so a run recorded before either change still reads right. In
 * the order the service checks them: tokens and time each turn, turns at the end.
 * The phone's `AgentRun.ranOut` makes the same call.
 */
export function ranOut(run: BudgetFields): RanOut | null {
  if (run.status !== 'stopped' || !run.limitsEnabled) return null
  if (run.maxTokens > 0 && run.tokensUsed >= run.maxTokens) return 'tokens'
  if (run.maxDurationMinutes > 0 && activeElapsedMs(run) >= run.maxDurationMinutes * 60_000) {
    return 'time'
  }
  if (run.maxTurns > 0 && run.turnsUsed >= run.maxTurns) return 'turns'
  return null
}

const RAN_OUT_LABEL: Record<RanOut, string> = {
  turns: 'Ran out of turns',
  tokens: 'Ran out of tokens',
  time: 'Ran out of time'
}

/** "Ran out of turns" where "Stopped" would leave the reader to work out why. */
export function runStatusLabel(run: BudgetFields): string {
  const why = ranOut(run)
  return why ? RAN_OUT_LABEL[why] : STATUS_LABEL[run.status]
}

/**
 * What happened, and what to do about it, for a run that ran out. Null otherwise.
 *
 * The phone's wording, word for word: the budget figures that used to be the
 * explanation sit on the line under it instead ({@link spentLine}).
 */
export function plainStopReason(run: BudgetFields): string | null {
  switch (ranOut(run)) {
    case 'turns':
      return `It used all ${run.maxTurns} of its turns before finishing. Continue it to carry on.`
    case 'tokens':
      return (
        `It used its whole budget of ${formatCompactTokens(run.maxTokens)} tokens before ` +
        'finishing. Continue it to carry on.'
      )
    case 'time':
      return (
        `It reached its ${run.maxDurationMinutes}-minute limit before finishing. ` +
        'Continue it to carry on.'
      )
    default:
      return null
  }
}

/** "Continue for 25 more turns", naming the budget the next run gets. */
export function continueLabel(run: BudgetFields): string {
  return ranOut(run) === 'turns' ? `Continue for ${run.maxTurns} more turns` : 'Continue'
}

/** "433 tokens · under a minute": what a run spent, for anyone weighing whether to give it more. */
export function spentLine(run: BudgetFields): string {
  const minutes = Math.floor(activeElapsedMs(run) / 60_000)
  const time = minutes < 1 ? 'under a minute' : minutes === 1 ? '1 minute' : `${minutes} minutes`
  return `${formatCompactTokens(run.tokensUsed)} tokens · ${time}`
}

/**
 * The run page's longer account of a run that ran out: the same sentence, with
 * the figures folded in, because the page is where someone weighs whether to
 * give it more. Null for a run that stopped any other way.
 */
export function ranOutDetail(run: BudgetFields): string | null {
  const minutes = Math.floor(activeElapsedMs(run) / 60_000)
  const time = minutes < 1 ? 'under a minute' : minutes === 1 ? 'a minute' : `${minutes} minutes`
  const tokens = `${run.tokensUsed.toLocaleString()} of ${run.maxTokens.toLocaleString()} tokens`
  switch (ranOut(run)) {
    case 'turns':
      return (
        `It used all ${run.maxTurns} of its turns before finishing. It used ${tokens} and ` +
        `${time}, so the turn limit is what stopped it. Continue it if it was making progress.`
      )
    case 'tokens':
      return (
        `It used its whole budget of ${run.maxTokens.toLocaleString()} tokens before finishing, ` +
        `in ${time}. Continue it if it was making progress.`
      )
    case 'time':
      return (
        `It reached its ${run.maxDurationMinutes}-minute limit before finishing, having used ` +
        `${tokens}. Continue it if it was making progress.`
      )
    default:
      return null
  }
}

/**
 * The "What changed:" line from the short report a run's turn ends with, or null.
 *
 * A turn's reply ends "What changed: … / Is it done: … / What would I do next: …".
 * Squashed onto one line beside the reply, the labels ran into each other; this
 * is the part of it worth reading at a glance. Tolerates markdown bold.
 */
export function whatChanged(content: string): string | null {
  const line = /^\s*\**what changed\**\s*:\s*\**\s*(.+)$/im.exec(content)?.[1]
  return line?.replace(/\*\*/g, '').trim() || null
}

/** "3 of 3 ticked off": the model's own tally, said as the model's. */
export function planTally(plan: Plan): string {
  const ticked = plan.steps.filter((step) => step.status === 'completed').length
  return `${ticked} of ${plan.steps.length} ticked off`
}

/**
 * A run that stopped short with every step of its plan ticked off.
 *
 * The model ticks its own steps; the service decides whether the run finished.
 * When the two disagree, the page says so instead of showing both as fact.
 */
export function planOutranResult(run: Pick<AgentRun, 'status' | 'plan'>): boolean {
  if (run.status !== 'stopped' && run.status !== 'error') return false
  const steps = run.plan?.steps ?? []
  return steps.length > 0 && steps.every((step) => step.status === 'completed')
}
