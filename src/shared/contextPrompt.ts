import type { ContextEpochHandoff } from './chat.types'

/** Build the system-prompt block used to seed a compacted context epoch. */
export function buildCompactionSystemPrompt(
  systemPrompt: string | undefined,
  summary: string
): string {
  const base = systemPrompt ?? ''
  const block = `Summary of earlier conversation (compacted to fit the context window):\n${summary}`
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
      const paths = tool.touchedPaths?.length ? ` (${tool.touchedPaths.join(', ')})` : ''
      return `- ${tool.status}: ${tool.name}${paths}`
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
    completed ? `Completed tool settlements:\n${completed}` : '',
    plan ? `Current plan:\n${plan}` : '',
    handoff.verificationNote ?? '',
    'Continue from the next concrete action. Do not repeat completed mutations. Reopen workspace evidence when exact detail is needed.'
  ]
    .filter(Boolean)
    .join('\n')
  return systemPrompt?.trim() ? `${systemPrompt}\n\n---\n${block}` : block
}
