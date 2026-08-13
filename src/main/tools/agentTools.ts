import type { ToolFactory } from './types'
import { runReadTool } from './helpers'
import { claimsVisualSuccess } from './visualVerification'
import { hasPostChangeVisualEvidence } from './turnProgress'

const MAX_SUMMARY_CHARS = 1000

/**
 * finish_goal — how an agent run ends itself cleanly. Only ever registered
 * (see `registry.ts`) for a restricted, non-null `enabledTools` set that
 * explicitly includes it — `AgentRunService` always does this; interactive
 * chat's `enabledTools` is always `null` (unrestricted), so the model never
 * sees this as an option to call unprompted there. Its result flows back the
 * same way every other tool's does — through `ctx.emit`/`onActivity` — so
 * `AgentRunService`'s turn loop just inspects the accumulated tool calls
 * after each generation for a successful `finish_goal`, no special plumbing
 * needed.
 */
export const finishGoalTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Call this when the goal for this run is complete, or when you cannot make further progress. Ends the run.',
    params: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'A short summary of the outcome — what was done, or why you stopped.'
        }
      },
      required: ['summary']
    } as const,
    handler: (args: { summary: string }) =>
      runReadTool(ctx, {
        name: 'finish_goal',
        kind: 'plan',
        title: 'Finish goal',
        args,
        run() {
          const summary = truncate(args.summary.trim(), MAX_SUMMARY_CHARS)
          if (!summary) throw new Error('summary was empty.')
          // Refuse to end the run on a claim alone — see
          // `ToolRuntimeContext.progress`'s doc comment. A model that never
          // took any real action this turn gets a corrective message instead
          // of a silently-accepted, possibly fabricated "done".
          if (!ctx.progress.madeChange) {
            throw new Error(
              'Nothing has been done yet this turn, so this cannot be accepted as the goal ' +
                'being complete — a claim of completion needs real action behind it. Reading ' +
                'files and writing or updating the plan do not count: they describe the work ' +
                'rather than carry it out. Do the thing the goal asks for (create or edit a ' +
                'file, run a command, send an email, and so on), then call finish_goal again. ' +
                'If the goal is already satisfied or you genuinely cannot make further ' +
                'progress, explain why in your reply instead of calling finish_goal.'
            )
          }
          // A summary asserting that something now renders is a claim about
          // pixels, and only a screenshot taken after the last change can
          // support it. See `visualVerification.ts` for the incident: an
          // inspection ran at the very start of the turn, the file was edited
          // afterwards, and success was reported off the stale screenshot.
          if (claimsVisualSuccess(summary) && !hasPostChangeVisualEvidence(ctx.progress)) {
            throw new Error(
              'This summary claims something now renders or works, but no visual inspection ' +
                'has run since the last change was made this turn — so nothing here shows the ' +
                'result of that change. Call inspect_visual on the affected page (using its ' +
                'sectionId for the specific section in question) and look at what comes back, ' +
                'then call finish_goal again. If you cannot verify it, say so plainly in the ' +
                'summary instead of reporting it as working.'
            )
          }
          return Promise.resolve({ modelResult: 'Run finished.', detail: summary })
        }
      })
  })

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
