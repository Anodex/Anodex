import type { AgentRun } from './agentRun.types'

/**
 * A parent agent handing parts of its work to smaller agents.
 *
 * The shape this exists for: "find the bugs in this code" is one goal and
 * several independent readings of it. A single run walks the codebase in one
 * long sequence, spending its whole context on the walk; three sub-agents
 * each read a slice with a fresh context and report what they found. The work
 * divides, and so does the context pressure, which is the part that actually
 * limits a local run.
 *
 * ## Why one tool call carrying several tasks
 *
 * The obvious design is one `delegate` call per sub-agent, several emitted in
 * one turn. That depends on the model reliably issuing parallel tool calls,
 * and this project's own findings say local models are the least reliable at
 * exactly that — multi-step tool use is where the weaker ones fall down. A
 * single call taking a list is deterministic: the fan-out either happens or
 * the call did not happen, with no half-fanned-out state to reason about.
 *
 * ## Why the ceiling is three
 *
 * Because that is what the machine can actually do. The local engine's
 * `parallelJobs` setting offers 1, 2 or 3 and says so plainly; beyond that
 * they queue behind each other and "parallel" becomes a word rather than a
 * behaviour. A cloud provider could take more, but a limit that changes
 * meaning depending on the provider is worse than one number that is always
 * honest.
 */

/** Most sub-agents one delegation may start. See the note above on why three. */
export const MAX_SUB_AGENTS = 3

/** Longest a single delegated task description may be, in characters. */
export const MAX_TASK_LENGTH = 2_000

/** What came back from one sub-agent. */
export interface SubAgentReport {
  task: string
  /** The sub-run, so a caller can link to its transcript. */
  runId: string
  status: AgentRun['status']
  /** What it said it found, or why it could not say. */
  report: string
}

/**
 * Trim a delegation request to something startable, or explain why it is not.
 *
 * Returns the tasks to run, or a message for the model. Deliberately strict
 * about emptiness: a sub-agent given a blank task burns a whole run's budget
 * discovering it has nothing to do, and reports back noise the parent then
 * has to interpret.
 */
export function validateDelegation(tasks: unknown): { tasks: string[] } | { error: string } {
  if (!Array.isArray(tasks)) {
    return { error: 'tasks must be a list of strings, one per sub-agent.' }
  }
  const cleaned = tasks
    .map((task) => (typeof task === 'string' ? task.trim() : ''))
    .filter((task) => task.length > 0)
    .map((task) => (task.length > MAX_TASK_LENGTH ? task.slice(0, MAX_TASK_LENGTH) : task))

  if (cleaned.length === 0) {
    return {
      error: 'No usable tasks: every entry was empty. Describe what each sub-agent should do.'
    }
  }
  if (cleaned.length > MAX_SUB_AGENTS) {
    return {
      error:
        `Too many sub-agents: ${cleaned.length} requested, ${MAX_SUB_AGENTS} is the most that can ` +
        'run at once. Combine the work into fewer tasks, or delegate again once these finish.'
    }
  }
  return { tasks: cleaned }
}

/**
 * The tools a sub-agent is allowed, given what its parent has.
 *
 * The parent's own set is a ceiling, never a starting point to add to: a
 * delegated agent that can reach something its parent could not is an
 * escalation, and the whole safety model here is structural rather than
 * instructional — what a run can do is what was wired up for it.
 *
 * `finish_goal` is added because that is how any run ends, and `delegate` is
 * removed because a sub-agent that can delegate can fan out without bound;
 * one level is a feature, recursion is a fork bomb with an API bill.
 */
export function subAgentTools(parentTools: Iterable<string>): string[] {
  const tools = new Set(parentTools)
  tools.delete('delegate')
  tools.add('finish_goal')
  return [...tools].sort()
}

/**
 * How the parent is told what came back.
 *
 * Each report is labelled with the task it answers, because the parent issued
 * several at once and the order they finish in is not the order it asked. A
 * sub-agent that produced nothing says so rather than contributing an empty
 * section the parent might read as "nothing found".
 */
export function renderReports(reports: readonly SubAgentReport[]): string {
  if (reports.length === 0) return 'No sub-agents ran.'
  return reports
    .map((entry, index) => {
      const body =
        entry.report.trim() ||
        `_Reported nothing. The run ended as "${entry.status}" — open it to see what happened._`
      return `### Sub-agent ${index + 1} — ${entry.status}\nTask: ${entry.task}\n\n${body}`
    })
    .join('\n\n')
}

/** The part of a run's limits a delegation has to divide up. */
export interface RunBudget {
  limitsEnabled: boolean
  maxTurns: number
  maxTokens: number
  maxDurationMinutes: number
}

/** What each sub-agent is allowed, as `CreateAgentRunRequest` takes it. */
export interface SubAgentBudget {
  limitsEnabled: boolean
  maxTurns: number
  maxTokens: number
  maxDurationMinutes: number
}

/**
 * The least a sub-agent can be given and still be worth starting.
 *
 * A run with a few hundred tokens spends them on its own system prompt and
 * reports nothing, which costs real money and returns an empty section the
 * parent then has to interpret. Refusing is the honest outcome.
 */
export const MIN_SUB_AGENT_TOKENS = 1_000

/**
 * Divide what is left of a parent's budget among its sub-agents.
 *
 * The property this exists for: **a delegation cannot exceed the limit the
 * user set on the run.** Sub-agents are separate `AgentRun` records with
 * their own budgets, so without this, turning the feature on would silently
 * multiply every configured limit by up to four — the parent plus three
 * children, each with a full allowance. A limit a feature can quietly triple
 * is not a limit.
 *
 * Turns and tokens are *consumed*, so they divide: three agents with a third
 * each add up to the one budget that was left. Duration does not, because the
 * sub-agents run at the same time — dividing wall-clock time between
 * concurrent runs would charge each of them for the others' waiting, and the
 * total elapsed time is already bounded by the parent's own remaining
 * minutes.
 *
 * An unlimited parent has nothing to divide, and its children are unlimited
 * too. That is the setting doing what it says rather than a gap.
 */
export function splitRunBudget(
  parent: RunBudget,
  used: { turns: number; tokens: number; minutes: number },
  count: number
): { budget: SubAgentBudget } | { error: string } {
  if (count < 1) return { error: 'No sub-agents to start.' }
  if (!parent.limitsEnabled) {
    return {
      budget: {
        limitsEnabled: false,
        maxTurns: parent.maxTurns,
        maxTokens: parent.maxTokens,
        maxDurationMinutes: parent.maxDurationMinutes
      }
    }
  }

  const turnsLeft = Math.max(0, parent.maxTurns - used.turns)
  const tokensLeft = Math.max(0, parent.maxTokens - used.tokens)
  const minutesLeft = Math.max(0, parent.maxDurationMinutes - used.minutes)

  const maxTurns = Math.floor(turnsLeft / count)
  const maxTokens = Math.floor(tokensLeft / count)

  // Each refusal names the budget that ran out and what would fix it, because
  // the model reads this and its only lever is asking for fewer sub-agents.
  if (maxTurns < 1) {
    return {
      error:
        `Not enough turns left to delegate: ${turnsLeft} remaining, shared between ${count} ` +
        'sub-agents. Delegate fewer tasks, or raise this run’s turn limit.'
    }
  }
  if (maxTokens < MIN_SUB_AGENT_TOKENS) {
    return {
      error:
        `Not enough tokens left to delegate: ${tokensLeft} remaining, shared between ${count} ` +
        `sub-agents, and each needs at least ${MIN_SUB_AGENT_TOKENS}. Delegate fewer tasks, or ` +
        'raise this run’s token limit.'
    }
  }
  if (minutesLeft < 1) {
    return {
      error: 'Not enough time left to delegate: this run’s duration limit is nearly spent.'
    }
  }

  return {
    budget: {
      limitsEnabled: true,
      maxTurns,
      maxTokens,
      // Not divided: they run concurrently. See the note above.
      maxDurationMinutes: minutesLeft
    }
  }
}
