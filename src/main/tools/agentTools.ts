import type { Plan } from '@shared/plan.types'
import type { ToolFactory } from './types'
import { runReadTool } from './helpers'
import { hasStaleVisualEvidence } from './turnProgress'

/**
 * Room a run's closing summary gets.
 *
 * This was 1,000 characters in the first agent-runs commit, when the summary
 * was a short outcome note. The open-steps guard later gave it a second job —
 * "say plainly in the summary which of them you are leaving undone and why,
 * name the step, so a run that stops early cannot read as one that succeeded"
 * — and nobody resized it for that.
 *
 * Measured: an orbit-prediction run finished with 4 of 7 steps open and wrote a
 * careful account of what it had and had not done. It was cut mid-word at
 * exactly 1,000 characters, after item 5 of 7, so the two steps it had left
 * undone were never named. The disclosure the guard exists to force was
 * destroyed by the cap on the field it forces it into.
 *
 * The summary is rendered as a paragraph in `AgentView` and stored on the run;
 * nothing about it is layout-sensitive, so the bound only needs to stop an
 * unbounded model string being persisted.
 */
const MAX_SUMMARY_CHARS = 4_000

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
          // A run that inspected something visually and then changed it again
          // has not seen the result of that change. Decided from the ledger's
          // ordering, not from whether the summary *sounds* like a success
          // claim: the old wording check let "the canvas should be fine now"
          // through while stopping "the canvas renders", which is a distinction
          // about phrasing rather than about evidence. A run that never
          // inspected anything is not a visual task and is unaffected.
          if (hasStaleVisualEvidence(ctx.progress)) {
            throw new Error(
              'The last change this turn came after the most recent visual inspection, so nothing ' +
                'gathered so far shows its result. Call inspect_visual on the affected page (using ' +
                'its sectionId for the specific section in question) and look at what comes back, ' +
                'then call finish_goal again. If you cannot verify it, say so plainly in the ' +
                'summary instead of reporting it as working.'
            )
          }
          // A run that ends with plan steps still open is ending early, and the
          // summary is the only place a reader learns which it was. Neither
          // existing guard covers this: `madeChange` asks whether anything
          // happened at all, and the visual check asks whether the last change
          // was seen -- a run can pass both having landed one step of three.
          //
          // What prompted the look was a run that called finish_goal at turn 5
          // of 44 with none of its three plan steps done. That one was honest
          // ("Stopped at the point of instrumenting drawCorona...") and so
          // would still pass here -- the case this catches is the other one,
          // where an early stop is written up as though it were a success.
          //
          // Refused rather than blocked, in the same shape as the guards above.
          // Abandoning a step is legitimate -- it may turn out unnecessary or
          // impossible -- so this only asks for it to be said out loud.
          const openSteps = openPlanSteps(ctx.plan.current)
          if (openSteps.length > 0) {
            const toldIn = openStepsToldIn.get(ctx.ledger)
            if (toldIn === undefined) {
              openStepsToldIn.set(ctx.ledger, ctx)
              throw new Error(
                `The plan for this run still has ${openSteps.length} step(s) that are not ` +
                  `complete: ${openSteps.map((step) => JSON.stringify(step)).join(', ')}. ` +
                  'Either finish them and call finish_goal again on a later turn, or say plainly ' +
                  'in the summary which of them you are leaving undone and why — name the step, ' +
                  'so a run that stops early cannot read as one that succeeded.'
              )
            }
            if (toldIn === ctx) {
              throw new Error(
                'You were already told this turn that the plan has open steps. Repeating ' +
                  'finish_goal in the same turn cannot be a reconsideration — this call was ' +
                  'composed before that answer existed. Carry on with the work; if stopping is ' +
                  'genuinely what you want, call finish_goal on your next turn and it will be ' +
                  'accepted.'
              )
            }
          }
          return Promise.resolve({ modelResult: 'Run finished.', detail: summary })
        }
      })
  })

/** Titles of the plan steps that are not yet complete. */
function openPlanSteps(plan: Plan | null): string[] {
  if (!plan) return []
  return plan.steps.filter((step) => step.status !== 'completed').map((step) => step.title)
}

/**
 * For each run, the generation in which it was last told its plan has open
 * steps. Keyed on the ledger, whose lifetime is the whole run (see
 * `TaskLedger`), so the answer survives from one turn to the next.
 *
 * Two attempts at reading the summary both failed, and the second failure is
 * the instructive one. Looking for phrases like "still outstanding" passed a
 * summary opening "The goal is complete", because "the two remaining
 * verification tasks" -- describing finished work -- contains "remaining".
 * Tightening it to require the summary to *name* an open step passed
 * "corona code verified correct" for an open step called "Star corona".
 *
 * The two cases are not separable by keyword: naming a step while claiming it
 * works looks exactly like naming it while admitting it does not. So this stops
 * guessing at prose. The model gets one unmissable prompt to reconsider, the
 * decision stays its own, and there is nothing to word around.
 *
 * ## Why the prompt has to span a turn
 *
 * It used to be one refusal per *generation*, which the model could consume
 * without ever seeing it. A model emits several tool calls in one response, and
 * every one of them is written before any of their results come back -- so a
 * second `finish_goal` sitting in the same batch is not a reconsideration, it
 * is a sibling of the call that was refused.
 *
 * Measured: 10 of the 32 stored assistant messages containing `finish_goal`
 * contain more than one, and one run ended on exactly this path. It called
 * `finish_goal` by accident, was refused, wrote in its own reply "I
 * accidentally called finish_goal -- the plan is still open, let me get back to
 * executing it", carried on working, and then had four more `finish_goal` calls
 * from the same batch accepted. The run stopped at 1 of 8 plan steps with 12 of
 * its 20 turns and 260,000 of its 300,000 tokens unspent.
 *
 * So the refusal now stands for the rest of the generation that earned it, and
 * lifts on the next one. A run that genuinely means to stop early says so on
 * its next turn and is accepted; nothing is blocked, and the one thing that
 * becomes impossible is ending a run by accident in a single batch.
 */
const openStepsToldIn = new WeakMap<object, object>()

/**
 * Say when the text was cut, rather than trailing off into an ellipsis a reader
 * cannot tell from the model's own punctuation. A summary that stops mid-word
 * with no explanation reads as a model that lost its thread, which is exactly
 * the wrong conclusion when it was this code that did the cutting.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const note = ' [cut off by Anodex]'
  return `${text.slice(0, max - note.length)}${note}`
}
