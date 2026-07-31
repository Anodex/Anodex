import type { ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'

/**
 * The approval policy for runs with nobody watching — scheduled tasks, agent
 * runs, and critical-thinking research. Each of those used to inline its own
 * `confirm: (r) => ({ approved: r.risk !== 'destructive' })`, three copies of
 * one rule that then had to be found and changed three times.
 *
 * A headless confirm is not a person saying yes, so it is deliberately not
 * allowed to answer for one:
 *
 * - `requiresHumanApproval` calls are refused outright. `send_email` is typed
 *   as always confirmation-gated and `EmailSettings.sendRequiresApproval` is
 *   the literal `true`; auto-approving here made both claims false, and a
 *   scheduled task with `send_email` ticked would put mail in someone's inbox
 *   with no one having read it.
 * - `destructive` calls are refused, as before, so an unattended run can't be
 *   talked into `rm -rf`.
 * - everything else auto-runs. These runs exist to get work done unwatched,
 *   and the tool set was already narrowed to what the user opted in.
 *
 * Refusing rather than hanging matters: `ctx.confirm` is awaited, so a promise
 * that never settles would strand the run until its budget expired.
 */
export function headlessConfirm(request: ToolConfirmRequest): Promise<ToolConfirmResponse> {
  if (request.requiresHumanApproval) {
    return Promise.resolve({
      approved: false,
      // Names the strongest available fallback: `save_email_draft` puts the
      // work in the user's real Drafts folder, where they will find it in their
      // normal mail app, rather than in a draft that dies with this process.
      reason: `${request.toolName} needs a person to approve the specific action, and this run is unattended. Prepare the work instead — save_email_draft leaves it in the user's Drafts folder for them to review and send themselves — and say plainly in your reply that it still needs sending.`
    })
  }
  if (request.risk === 'destructive') {
    return Promise.resolve({
      approved: false,
      reason: 'Destructive actions are not approved in an unattended run.'
    })
  }
  return Promise.resolve({ approved: true })
}
