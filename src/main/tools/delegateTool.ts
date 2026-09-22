import type { ToolFactory } from './types'
import { runReadTool } from './helpers'
import { MAX_SUB_AGENTS, renderReports, validateDelegation } from '@shared/subAgents'

/**
 * delegate — hand parts of this run's work to sub-agents and wait for them.
 *
 * Registered only when `ctx.delegate` is present, which is `AgentRunService`'s
 * way of saying this run is allowed to have sub-agents: the setting is on,
 * and this run is not itself a sub-run. A chat turn never sees it, and
 * neither does a delegated run, so one level of fan-out cannot become
 * recursion.
 *
 * It blocks until every sub-agent has finished. That is the point — the
 * parent asked a question it cannot answer alone, and a tool that returned
 * "started three agents, check back later" would leave the parent to invent
 * a way of waiting, which is exactly the kind of improvisation unattended
 * runs get wrong.
 *
 * Classed as a read tool because delegating is not itself a change. What the
 * sub-agents do is bounded by their own tool sets, which can never exceed
 * the parent's — see `subAgentTools`.
 */
export const delegateTool: ToolFactory = (define, ctx) => {
  // What this run can actually start, not the product-wide maximum. On a
  // local engine the parent holds a generation slot for the whole of its
  // turn, so the honest answer is often one — and a model told three asks
  // for three, is refused, and spends a turn of an unattended run learning
  // something that was knowable before it started.
  const ceiling = ctx.delegate?.ceiling ?? MAX_SUB_AGENTS
  return define({
    description:
      `Split this run's work across up to ${ceiling} sub-agent${ceiling === 1 ? '' : 's'} ` +
      'that run at the same time and report back. Use it when a goal divides into parts that ' +
      'can be investigated independently — for example, searching different areas of a ' +
      'codebase for the same kind of problem. Each task should be self-contained: a sub-agent ' +
      'cannot see this conversation, only the task you give it. Waits for every sub-agent and ' +
      'returns what each one found.' +
      (ceiling > 1
        ? // Measured, not a guess: on a 12-bug hunt one sub-agent found every
          // defect in the same wall-clock as delegating nothing, while two and
          // three found no more and cost four to seven times the tokens,
          // because each one re-reads the workspace from nothing. The model is
          // the one choosing how many, so it is the one that needs this.
          ' Prefer one sub-agent unless the parts genuinely do not overlap: each extra one ' +
          're-reads the workspace from scratch, which on measurement cost several times as ' +
          'much for the same findings.'
        : ''),
    params: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: { type: 'string' },
          description:
            'One self-contained task per sub-agent, each describing what to investigate and ' +
            'what to report back.'
        }
      },
      required: ['tasks']
    } as const,
    handler: (args: { tasks: string[] }) =>
      runReadTool(ctx, {
        name: 'delegate',
        kind: 'plan',
        title: 'Delegate to sub-agents',
        args,
        async run() {
          const delegate = ctx.delegate
          // Defensive: registration already depends on this. A tool that
          // could be called without its capability would fail deep inside a
          // run with nothing useful to say.
          if (!delegate) throw new Error('This run cannot use sub-agents.')

          const validated = validateDelegation(args.tasks, ceiling)
          if ('error' in validated) throw new Error(validated.error)

          const reports = await delegate(validated.tasks)
          const finished = reports.filter((entry) => entry.status === 'done').length
          return {
            modelResult: renderReports(reports),
            // What the transcript shows at a glance. "3 sub-agents" alone
            // would read as success even when every one of them failed.
            detail: `${finished}/${reports.length} sub-agent${reports.length === 1 ? '' : 's'} finished`
          }
        }
      })
  })
}
