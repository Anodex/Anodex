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
