/**
 * Framing text for an agent run's turns. Kept in the prompt itself rather
 * than `ChatRequest.systemPrompt` (which `runGeneration` doesn't read — it
 * composes its own system prompt) — the framing ends up visible in the run's
 * transcript, which is fine: it's useful context for whoever reads the
 * journal, not a secret.
 */

/**
 * How much of the journal a continuing run is told about, in characters.
 *
 * The file is append-only and never trimmed, which is the right choice for a
 * record somebody may need to audit — but the whole of it goes into the first
 * prompt of every continuing run, and that is a different problem. A series
 * that has run thirty times would open its thirty-first run with thousands of
 * tokens of its own history before the goal is even stated, on a local engine
 * whose window may be 8k.
 *
 * Characters rather than tokens because there is no tokenizer here and a
 * rough bound honestly named beats a precise one that needs the model loaded.
 * Four thousand is on the order of a thousand tokens — around a tenth of the
 * smallest window this app runs against, and ten to twenty ordinary entries.
 */
export const JOURNAL_PROMPT_BUDGET = 4_000

/**
 * The part of a journal worth putting in a prompt: the most recent runs.
 *
 * Recent rather than a summary, because the last thing that happened is what
 * a continuing run has to continue from, and because summarising the history
 * would mean a model rewriting the record of what a model did — a second
 * place for it to drift from the files.
 *
 * What is dropped is stated rather than silently absent. A run told "you have
 * worked on this before" and shown three entries would otherwise conclude
 * three is all there was, and an agent that believes it is on run 3 of an
 * ongoing job behaves differently from one that knows it is on run 31.
 */
export function journalForPrompt(
  journal: string | null,
  budget: number = JOURNAL_PROMPT_BUDGET
): string | null {
  const text = journal?.trim()
  if (!text) return null
  if (text.length <= budget) return text

  // Entries are the sections `renderJournalEntry` writes. Splitting on the
  // heading keeps each one whole: half an entry is worse than none, because
  // its status line and its summary can end up on opposite sides of the cut.
  const entries = text.split(/\n(?=## )/).filter((entry) => entry.trim().length > 0)

  const kept: string[] = []
  let used = 0
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index].trim()
    if (kept.length > 0 && used + entry.length > budget) break
    kept.unshift(entry)
    used += entry.length
  }

  const dropped = entries.length - kept.length
  // The newest entry alone can exceed the budget — a run whose summary ran
  // long. Cut inside it rather than returning nothing, and say where.
  if (kept.length === 1 && kept[0].length > budget) {
    kept[0] = `${kept[0].slice(0, budget)}\n\n_(entry truncated)_`
  }
  if (dropped === 0) return kept.join(`\n\n`)

  const preface =
    `_The ${dropped} earlier run${dropped === 1 ? '' : 's'} of this work ` +
    `${dropped === 1 ? 'is' : 'are'} not shown here. Only the most recent are, so treat ` +
    `this as the end of a longer history rather than the whole of it._`
  return [preface, ...kept].join(`\n\n`)
}

/** Turn 1's prompt: the goal, prefixed with autonomous-mode framing. */
export function buildKickoffPrompt(goal: string, journal?: string | null): string {
  const base =
    "You're operating autonomously toward a goal — no one is available to answer " +
    'follow-up questions, so make reasonable judgment calls yourself. Use find_skill ' +
    "to check for relevant instructions if you're unsure how to approach something. " +
    'When the goal is complete, or you cannot make further progress, call finish_goal ' +
    'with a short summary of the outcome.'

  // Bounded here rather than at the call site, so no caller can hand a
  // thirty-run history straight into a first turn by forgetting to.
  const history = journalForPrompt(journal ?? null)
  if (!history) return `${base}\n\nGoal: ${goal}`

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
    `--- JOURNAL ---\n${history}\n--- END JOURNAL ---\n\n` +
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
