import type { ContextEpochHandoff } from './chat.types'

/**
 * Build the system-prompt block used to seed a compacted context epoch.
 *
 * The header states, twice and plainly, that this is the same conversation.
 * It used to read "Summary of earlier conversation", and "earlier
 * conversation" reads as *a different* conversation — which is exactly how a
 * model took it. Measured: a thirteen-turn chat at an 8,192-token window
 * planted a codeword in turn one and buried it under ninety thousand
 * characters. Compaction carried the codeword through, and at turn thirteen
 * the model still answered "no codeword was given at the start of *this*
 * conversation... it comes from a summary of an earlier, separate
 * conversation."
 *
 * So the fact survived and its provenance did not, which is worse than losing
 * it: the user is told their own earlier message never happened, by a model
 * that is looking straight at it.
 */
export function buildCompactionSystemPrompt(
  systemPrompt: string | undefined,
  summary: string
): string {
  const base = systemPrompt ?? ''
  // Kept close to the length of the header it replaces. A first draft spelled
  // the point out over four lines and a budget test caught it immediately:
  // this block is charged to every compacted turn, on the windows least able
  // to afford it. Two mentions of "this conversation" and one "said to you
  // here" carry the attribution; the rest was for the reader, not the model.
  const block =
    'Earlier turns of this conversation, compacted to fit the window. The user said these to ' +
    'you here — attribute them to this conversation:\n' +
    summary
  return base ? `${base}\n\n---\n${block}` : block
}

/**
 * Render a bounded-run checkpoint into the system prompt rather than history.
 *
 * The caller applies the token cap before calling this helper. Keeping the
 * handoff in this protected system segment is important: history compaction
 * intentionally evicts old turns, while these structured facts must survive
 * exactly until the next provider cycle has resumed the work.
 */
export function buildContextEpochSystemPrompt(
  systemPrompt: string | undefined,
  handoff: ContextEpochHandoff
): string {
  const completed = handoff.completedTools
    .map((tool) => {
      // `identity` is what makes this line actionable: `run_command` alone says
      // a non-idempotent command succeeded without saying which one, so the
      // resumed model cannot tell whether repeating it is safe.
      const what = tool.identity ? `${tool.name} — ${tool.identity}` : tool.name
      const paths = tool.touchedPaths?.length ? ` (${tool.touchedPaths.join(', ')})` : ''
      const outcome = tool.outcome ? ` [${tool.outcome}]` : ''
      const hash = tool.contentHash ? ` #${tool.contentHash}` : ''
      const status = tool.madeProgress === false ? 'no-op' : tool.status
      return `- ${status}: ${what}${paths}${outcome}${hash}`
    })
    .join('\n')
  const plan = handoff.plan
    ? handoff.plan.steps
        .map((step, index) => `${index + 1}. [${step.status}] ${step.title}`)
        .join('\n')
    : ''
  const block = [
    'Context epoch handoff (Anodex-generated, authoritative for this continuation):',
    `Objective: ${handoff.objective}`,
    `Epoch: ${handoff.epoch}; cause: ${handoff.cause}.`,
    handoff.workingSummary
      ? `Prior working notes (model-authored; preserve continuity, but verify before relying on them):\n${handoff.workingSummary}`
      : '',
    completed ? `Completed tool settlements:\n${completed}` : '',
    plan ? `Current plan:\n${plan}` : '',
    handoff.verificationNote ?? '',
    handoff.evidenceIndex
      ? `Already gathered in this task — treat these as done, and re-read only the specific part a next step needs:
${handoff.evidenceIndex}`
      : '',
    'Continue from the next concrete action. Do not repeat completed mutations.'
  ]
    .filter(Boolean)
    .join('\n')
  return systemPrompt?.trim() ? `${systemPrompt}\n\n---\n${block}` : block
}

/**
 * Keep protected checkpoint cost proportional to the real provider window.
 *
 * History is already separately bounded. This cap protects reply room without
 * letting a verbose plan or tool list turn the handoff itself into the next
 * context-limit failure. The values are capacities, not product tiers.
 */
export function capContextEpochHandoff(
  handoff: ContextEpochHandoff,
  contextWindowTokens: number | undefined
): ContextEpochHandoff {
  const context = Math.max(1, contextWindowTokens ?? 16_384)
  const maxCharacters = Math.max(512, Math.min(4_000, Math.floor(context * 0.08) * 4))
  // `buildContextEpochSystemPrompt` wraps these values in headers, per-tool
  // bullet formatting and a closing instruction, none of which are field values.
  // Budgeting only the values lets the rendered block overrun the cap by several
  // hundred characters on a busy task, so hold that scaffolding back up front.
  const scaffolding = Math.min(
    Math.floor(maxCharacters / 2),
    RENDERED_HANDOFF_FIXED_CHARS + handoff.completedTools.length * RENDERED_HANDOFF_PER_TOOL_CHARS
  )
  // The verification note is the one field with a safety job, and it was last in
  // line for a shared budget — on a task with a real plan and several touched
  // paths it collapsed to a single ellipsis. Reserve it before anything else can
  // spend the room.
  const verificationNote = handoff.verificationNote
    ? truncateForHandoff(handoff.verificationNote, 240)
    : undefined
  let remaining = Math.max(0, maxCharacters - scaffolding - (verificationNote?.length ?? 0))
  const trim = (value: string, limit: number): string => {
    const result = truncateForHandoff(value, Math.min(limit, remaining))
    remaining = Math.max(0, remaining - result.length)
    return result
  }
  const objective = trim(handoff.objective, Math.max(160, Math.floor(maxCharacters / 3)))
  // Ahead of the working summary: the index names results the model can read
  // back exactly, while the summary is its own prose about them. When only one
  // fits, the addressable facts are worth more than the narration.
  const evidenceIndex = handoff.evidenceIndex
    ? trim(handoff.evidenceIndex, Math.max(200, Math.floor(maxCharacters / 3)))
    : undefined
  const workingSummary = handoff.workingSummary
    ? trim(handoff.workingSummary, Math.max(160, Math.floor(maxCharacters / 4)))
    : undefined
  // Tool identity before plan text: the plan is a restatement of intent the
  // model can re-derive, while a command line it already ran is the fact that
  // stops it running the command twice.
  //
  // Newest-first, then reversed back into chronological order. Spending the
  // budget oldest-first starves the newest settlements — and `fitRenderedHandoff`
  // then sheds the oldest, so the entries that survive would be exactly the ones
  // that were starved of their identity.
  const completedTools = handoff.completedTools
    .slice(-12)
    .reverse()
    .map((tool) => ({
      ...tool,
      identity: tool.identity ? trim(tool.identity, 200) : undefined,
      outcome: tool.outcome ? trim(tool.outcome, 120) : undefined,
      touchedPaths: tool.touchedPaths?.slice(0, 4).map((path) => trim(path, 180))
    }))
    .reverse()
  const plan = handoff.plan
    ? {
        ...handoff.plan,
        title: trim(handoff.plan.title, 160),
        steps: handoff.plan.steps.map((step) => ({
          ...step,
          title: trim(step.title, 180)
        }))
      }
    : handoff.plan
  return fitRenderedHandoff(
    {
      ...handoff,
      objective,
      evidenceIndex,
      workingSummary,
      plan,
      completedTools,
      verificationNote
    },
    maxCharacters
  )
}

/**
 * Enforce the cap against the block that is actually rendered, rather than
 * against the field values alone.
 *
 * Per-entry formatting is real prompt cost, and estimating it was how the
 * rendered block came to exceed its own budget on a busy task. Measuring it is
 * possible precisely because the cap and the renderer live together here, so
 * they cannot drift. Entries are shed oldest-first — the newest settlements and
 * the newest plan rows are the ones a resumed epoch acts on — and the objective
 * and verification note are never shed, because a handoff without them is not a
 * handoff.
 */
function fitRenderedHandoff(
  handoff: ContextEpochHandoff,
  maxCharacters: number
): ContextEpochHandoff {
  let current = handoff
  while (buildContextEpochSystemPrompt(undefined, current).length > maxCharacters) {
    if (current.completedTools.length > 0) {
      current = { ...current, completedTools: current.completedTools.slice(1) }
      continue
    }
    if (current.plan && current.plan.steps.length > 0) {
      current = { ...current, plan: { ...current.plan, steps: current.plan.steps.slice(1) } }
      continue
    }
    if (current.plan) {
      current = { ...current, plan: undefined }
      continue
    }
    break
  }
  return current
}

/** Header, epoch line, recovery-read line and closing instruction, approximately. */
const RENDERED_HANDOFF_FIXED_CHARS = 540
/** `- status: name — identity (paths) [outcome] #hash` punctuation per entry. */
const RENDERED_HANDOFF_PER_TOOL_CHARS = 36

/**
 * Truncate without ever returning a bare ellipsis: a field squeezed to nothing
 * should be dropped by its caller, not rendered as `…`, which reads to the model
 * as a value that exists and is unknowable.
 */
function truncateForHandoff(value: string, limit: number): string {
  if (limit <= 1) return ''
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}
