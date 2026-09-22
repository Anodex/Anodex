/**
 * Framing text for an agent run's turns. Kept in the prompt itself rather
 * than `ChatRequest.systemPrompt` (which `runGeneration` doesn't read — it
 * composes its own system prompt) — the framing ends up visible in the run's
 * transcript, which is fine: it's useful context for whoever reads the
 * journal, not a secret.
 */

/** Turn 1's prompt: the goal, prefixed with autonomous-mode framing. */
export function buildKickoffPrompt(goal: string, journal?: string | null): string {
  const base =
    "You're operating autonomously toward a goal — no one is available to answer " +
    'follow-up questions, so make reasonable judgment calls yourself. Use find_skill ' +
    "to check for relevant instructions if you're unsure how to approach something. " +
    'When the goal is complete, or you cannot make further progress, call finish_goal ' +
    'with a short summary of the outcome.'

  if (!journal?.trim()) return `${base}\n\nGoal: ${goal}`

  // A continuing run is a different situation from a first one and has to be
  // told so plainly. Without this it reads the goal as new work and starts
  // over, which for an ongoing goal — grow this portfolio, keep this thing
  // up to date — undoes the entire point of running it again.
  //
  // The journal is what the run *said* it did. The files are what exists.
  // Those come apart, and when they do the files are right, so the framing
  // says which to trust rather than leaving the model to guess.
  return (
    `${base}\n\n` +
    'You have worked on this goal before. Below is the journal of your previous runs, ' +
    'oldest first. Continue from where it leaves off rather than starting again, and ' +
    'check the files you kept in the project folder before assuming anything about ' +
    'their contents — the journal says what you reported doing, the files are what ' +
    'actually exists.\n\n' +
    `--- JOURNAL ---\n${journal.trim()}\n--- END JOURNAL ---\n\n` +
    `Goal: ${goal}`
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

/** A text file handed to a run, as read for the turn that carries it. */
export interface RunAttachmentText {
  name: string
  content: string
  truncated: boolean
  sizeBytes: number
}

/**
 * Append a run's attachments to a turn's prompt: a list naming every file, then
 * each text file's content in the same delimited form a chat attachment uses.
 *
 * Images are named but not described. They travel as real image parts beside
 * this message, and a model that can see them needs only to know they are
 * material supplied for the goal.
 */
export function withRunAttachments(
  prompt: string,
  imageNames: readonly string[],
  texts: readonly RunAttachmentText[]
): string {
  if (imageNames.length === 0 && texts.length === 0) return prompt
  const listed = [
    ...imageNames.map((name) => `- ${name} (image, attached to this message)`),
    ...texts.map((text) => `- ${text.name} (text, included below)`)
  ].join('\n')
  const blocks = texts.map((text) => {
    const note = text.truncated
      ? ` (truncated, showing first ${text.content.length} of ${text.sizeBytes} bytes)`
      : ''
    return `--- Attached file: ${text.name}${note} ---\n${text.content}`
  })
  return [prompt, `Files supplied with this goal:\n${listed}`, ...blocks].join('\n\n')
}
