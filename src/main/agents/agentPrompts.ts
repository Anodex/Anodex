/**
 * Framing text for an agent run's turns. Kept in the prompt itself rather
 * than `ChatRequest.systemPrompt` (which `runGeneration` doesn't read — it
 * composes its own system prompt) — the framing ends up visible in the run's
 * transcript, which is fine: it's useful context for whoever reads the
 * journal, not a secret.
 */

/** Turn 1's prompt: the goal, prefixed with autonomous-mode framing. */
export function buildKickoffPrompt(goal: string): string {
  return (
    "You're operating autonomously toward a goal — no one is available to answer " +
    'follow-up questions, so make reasonable judgment calls yourself. Use find_skill ' +
    "to check for relevant instructions if you're unsure how to approach something. " +
    'When the goal is complete, or you cannot make further progress, call finish_goal ' +
    `with a short summary of the outcome.\n\nGoal: ${goal}`
  )
}

/** Every subsequent turn's prompt, if the model didn't call finish_goal yet. */
export const CONTINUE_PROMPT =
  'Continue working toward the goal stated at the start of this conversation. If the ' +
  'goal is complete, or you cannot make further progress, call finish_goal with a short ' +
  'summary of the outcome.'

/**
 * The planning turn's prompt, used instead of `buildKickoffPrompt` when a run
 * has `requirePlan: true` — only `write_plan` (plus skill discovery) is
 * enabled for this turn, so the framing just asks for a plan, not action.
 */
export function buildPlanningPrompt(goal: string): string {
  return (
    'Before doing anything else, propose a plan for this goal by calling write_plan with a short ' +
    "ordered list of concrete steps. Don't take any other action yet — you'll get a chance to " +
    `execute the plan once it's reviewed.\n\nGoal: ${goal}`
  )
}

/** First turn after a human approves the plan — replaces `buildKickoffPrompt` for that turn. */
export const PLAN_APPROVED_PROMPT =
  'Your plan was approved. Start executing it now, calling update_plan_step as you complete or ' +
  'start each step.'

/** One bounded retry if the planning turn didn't call write_plan the first time. */
export const PLAN_RETRY_PROMPT =
  "You didn't call write_plan. Call it now with a short ordered list of concrete steps toward the " +
  'goal stated above — no other action yet.'
