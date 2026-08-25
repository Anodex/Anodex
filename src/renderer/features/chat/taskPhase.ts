import type { ChatMessage, MessageBlock } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import { sanitizeMessageTranscript } from '@shared/chatSanitizer'
import { activityPhrase } from './activityPhrase'
import { lowercaseFirst } from './labelText'

/** A coarse label for what the assistant is doing during a coding turn. */
export type TaskPhase = 'inspecting' | 'editing' | 'verifying' | 'responding'

export const TASK_PHASE_LABEL: Record<TaskPhase, string> = {
  inspecting: 'Inspecting',
  editing: 'Editing',
  verifying: 'Verifying',
  responding: 'Responding'
}

/** One phase and the contiguous run of tool calls made during it. */
export interface ToolCallGroup {
  phase: TaskPhase
  calls: ToolCall[]
}

/** Phase a single tool call belongs to, based on its kind and position in the run. */
function phaseForCall(call: ToolCall, editSeen: boolean): TaskPhase {
  if (call.kind === 'read' || call.kind === 'web' || call.kind === 'plan') return 'inspecting'
  // MCP tools are external, dynamically-discovered actions (fixed 'sensitive'
  // risk, same reasoning as a file write) — grouped with editing rather than
  // assumed read-only, since Anodex has no way to know which MCP tools mutate
  // something and which don't.
  if (call.kind === 'write' || call.kind === 'mcp') return 'editing'
  // A command run after at least one edit is verification (build/test/lint);
  // one run before any edit is just the model orienting itself (inspecting).
  return editSeen ? 'verifying' : 'inspecting'
}

/**
 * Tracks "has an edit happened yet" across a sequence of tool calls, so
 * `buildRenderSegments` can carry that state across text-interrupted runs
 * within one message (a `run_command` after an edit is "verifying" even if
 * prose came between the edit and the command).
 */
class PhaseGrouper {
  private editSeen = false

  next(call: ToolCall): TaskPhase {
    const phase = phaseForCall(call, this.editSeen)
    if (call.kind === 'write' || call.kind === 'mcp') this.editSeen = true
    return phase
  }
}

/**
 * Group a message's tool calls into contiguous phase runs, in call order.
 * Pure and derived entirely from existing data — no new state to persist.
 */
export function groupToolCallsByPhase(toolCalls: ToolCall[]): ToolCallGroup[] {
  const grouper = new PhaseGrouper()
  const groups: ToolCallGroup[] = []

  for (const call of toolCalls) {
    const phase = grouper.next(call)
    const last = groups[groups.length - 1]
    if (last && last.phase === phase) {
      last.calls.push(call)
    } else {
      groups.push({ phase, calls: [call] })
    }
  }

  return groups
}

export type RenderSegment =
  | { type: 'text'; text: string }
  | { type: 'toolGroup'; phase: TaskPhase; calls: ToolCall[] }
  | { type: 'thinking'; text: string }

/**
 * Walks a message's chronological blocks once, keeping text exactly where it
 * occurred and grouping consecutive same-phase tool calls into one labeled
 * run — so a multi-step turn renders as a real timeline (text, tool group,
 * text, tool group, ...) instead of every tool call clustering together
 * regardless of when it actually happened during generation.
 */
export function buildRenderSegments(blocks: MessageBlock[]): RenderSegment[] {
  const segments: RenderSegment[] = []
  const grouper = new PhaseGrouper()

  for (const block of blocks) {
    if (block.type === 'text') {
      // A stray whitespace-only token between two tool calls (a lone
      // newline the model emits between function calls, say) shouldn't
      // count as a real text segment — it would otherwise split what
      // should be one merged tool-group run into two separate ones.
      if (!block.text.trim()) continue
      segments.push({ type: 'text', text: block.text })
      continue
    }

    if (block.type === 'thinking') {
      // No merging needed here the way tool calls merge into one toolGroup —
      // `chatStore.ts`'s `appendThinkingToken` already merges genuinely
      // adjacent live tokens into a single block at the source, so distinct
      // blocks by the time they reach here really were interrupted by other
      // content and should render as separate segments.
      if (!block.text.trim()) continue
      segments.push({ type: 'thinking', text: block.text })
      continue
    }

    const phase = grouper.next(block.call)
    const last = segments[segments.length - 1]
    if (last && last.type === 'toolGroup' && last.phase === phase) {
      last.calls.push(block.call)
    } else {
      segments.push({ type: 'toolGroup', phase, calls: [block.call] })
    }
  }

  return segments
}

/**
 * A contiguous run of activity, collapsible behind one `TurnRecap`.
 *
 * A work block holds any segment kind, prose included. While a reply streams
 * it only ever collects thinking and tool calls, so the model's narration
 * stays on screen as it arrives; once the reply settles, `foldSettledTimeline`
 * folds the narration in too.
 */
export type TimelineBlock =
  { type: 'text'; text: string } | { type: 'work'; segments: RenderSegment[] }

/**
 * Regroups render segments so consecutive thinking/tool-call activity becomes
 * one collapsible run, while text stays exactly where it occurred. A message
 * is almost always [work, text] (all activity, then the final reply), but this
 * handles the general interleaved case too.
 */
export function groupSegmentsForTimeline(segments: RenderSegment[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = []

  for (const segment of segments) {
    if (segment.type === 'text') {
      blocks.push({ type: 'text', text: segment.text })
      continue
    }
    const last = blocks[blocks.length - 1]
    if (last && last.type === 'work') {
      last.segments.push(segment)
    } else {
      blocks.push({ type: 'work', segments: [segment] })
    }
  }

  return normalizeInterruptedText(blocks)
}

/**
 * Collapse a finished reply down to its answer.
 *
 * While a turn runs, watching it work is the point. Once it is done, the
 * working is history: a forty-minute turn leaves forty-five tool cards and
 * every "let me check the shader link status" the model wrote on its way
 * through, and the reader has to scroll past all of it to reach the sentence
 * that says what happened. `TurnRecap` already folded the tool calls away and
 * left the prose behind, which is the half that is actually long.
 *
 * So a settled reply becomes one collapsible run plus its closing text. What
 * stays visible is the answer and the turn outcome -- and the outcome is
 * derived from the settled tool record rather than written by the model, so
 * the collapsed view reports what happened rather than what was intended, and
 * a failure ("1 failed", "Not verified") still shows through.
 *
 * Only the *trailing* text is kept out: prose that came before more work was
 * narration, not a conclusion. A turn cut short mid-tool has no trailing text
 * at all, and correctly collapses to the outcome alone.
 *
 * Untouched when there is nothing to fold -- a plain answer with no tool calls
 * renders exactly as it always did, with no stray toggle above it.
 */
export function foldSettledTimeline(blocks: TimelineBlock[]): TimelineBlock[] {
  if (!blocks.some((block) => block.type === 'work')) return blocks

  const last = blocks[blocks.length - 1]
  const trailingText = last?.type === 'text' ? last : null
  const foldable = trailingText ? blocks.slice(0, -1) : blocks
  if (foldable.length === 0) return blocks

  const segments: RenderSegment[] = []
  for (const block of foldable) {
    if (block.type === 'text') segments.push({ type: 'text', text: block.text })
    else segments.push(...block.segments)
  }

  const folded: TimelineBlock[] = [{ type: 'work', segments }]
  if (trailingText) folded.push(trailingText)
  return folded
}

/**
 * Some OpenAI-compatible local servers can switch from visible content to
 * reasoning (or a tool call) in the middle of a sentence, then continue the
 * visible sentence afterward. Keep the work inspectable, but present the two
 * visible fragments as the sentence the model actually intended.
 */
function normalizeInterruptedText(input: TimelineBlock[]): TimelineBlock[] {
  let blocks = input
  let changed = true

  while (changed) {
    changed = false
    const next: TimelineBlock[] = []

    for (let index = 0; index < blocks.length; index += 1) {
      const left = blocks[index]
      const work = blocks[index + 1]
      const right = blocks[index + 2]
      if (
        left?.type === 'text' &&
        work?.type === 'work' &&
        right?.type === 'text' &&
        !endsVisibleSentence(left.text)
      ) {
        if (startsWithLowercaseContinuation(right.text)) {
          appendTimelineBlock(next, work)
          appendTimelineBlock(next, { type: 'text', text: joinText(left.text, right.text) })
          index += 2
          changed = true
          continue
        }

        if (isShortOrphanFragment(left.text)) {
          appendTimelineBlock(next, {
            type: 'work',
            segments: [{ type: 'thinking', text: left.text }, ...work.segments]
          })
          appendTimelineBlock(next, right)
          index += 2
          changed = true
          continue
        }
      }

      appendTimelineBlock(next, left)
    }

    blocks = next
  }

  // During live generation the continuation may not have arrived yet. Do not
  // leave an unfinished piece of process narration hanging above the active
  // work indicator; the original segments are derived again on the next
  // render, so it will reappear as joined prose as soon as its text continues.
  const trailingText = blocks[blocks.length - 2]
  const trailingWork = blocks[blocks.length - 1]
  if (
    trailingText?.type === 'text' &&
    trailingWork?.type === 'work' &&
    !endsVisibleSentence(trailingText.text)
  ) {
    blocks = [
      ...blocks.slice(0, -2),
      {
        type: 'work',
        segments: [{ type: 'thinking', text: trailingText.text }, ...trailingWork.segments]
      }
    ]
  }

  return blocks
}

function appendTimelineBlock(blocks: TimelineBlock[], block: TimelineBlock): void {
  const last = blocks[blocks.length - 1]
  if (last?.type === 'work' && block.type === 'work') {
    last.segments.push(...block.segments)
  } else if (last?.type === 'text' && block.type === 'text') {
    last.text = joinText(last.text, block.text)
  } else {
    blocks.push(block)
  }
}

function endsVisibleSentence(text: string): boolean {
  return /[.!?…:;]["')\]}]*\s*$/.test(text)
}

function startsWithLowercaseContinuation(text: string): boolean {
  const firstLetter = text.trimStart().match(/[A-Za-z]/)?.[0]
  return firstLetter !== undefined && firstLetter === firstLetter.toLowerCase()
}

function isShortOrphanFragment(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length <= 32 && trimmed.split(/\s+/).length <= 3
}

function joinText(left: string, right: string): string {
  if (/\s$/.test(left) || /^\s/.test(right)) return left + right
  return `${left} ${right}`
}

/**
 * The ordered blocks to render for a message. Messages persisted before the
 * `blocks` field existed fall back to the previous "tools first, then text"
 * layout rather than rendering nothing — every message created from here on
 * has `blocks` populated live as it streams in, so this fallback is a
 * one-time compatibility path for old conversation history, not the norm.
 */
export function messageBlocks(message: ChatMessage): MessageBlock[] {
  const normalized = sanitizeMessageTranscript(message, { preserveImageData: true }).message
  if (normalized.blocks && normalized.blocks.length > 0) return normalized.blocks
  const fallback: MessageBlock[] = (message.toolCalls ?? []).map((call) => ({
    type: 'tool',
    call
  }))
  if (normalized.content) fallback.push({ type: 'text', text: normalized.content })
  return fallback
}

/**
 * The single phase label to show while a message is still streaming, based on
 * its tool calls so far. Once no tool calls are running and text is streaming,
 * the assistant has moved on to writing its final answer.
 */
export function currentTaskPhase(toolCalls: ToolCall[], hasContent: boolean): TaskPhase | null {
  if (toolCalls.length === 0) return null
  const running = [...toolCalls].reverse().find((call) => call.status === 'running')
  if (running) {
    const editSeen = toolCalls.slice(0, toolCalls.indexOf(running)).some((c) => c.kind === 'write')
    return phaseForCall(running, editSeen)
  }
  return hasContent ? 'responding' : null
}

/**
 * A concise status for the live indicator beneath a streaming reply.
 *
 * Everything it says is drawn from tool calls Anodex emitted itself, so it
 * describes real work rather than guessing at hidden model reasoning. What it
 * adds over the raw title is tense and context: work in flight is phrased as
 * happening ("Reading camera.py", not "Read camera.py"), and the gap between
 * two calls -- where the model is deciding what to do next, and where the
 * indicator used to sit on the contentless "Preparing next step" -- is named by
 * the step that just finished, which is the one thing about that moment that is
 * actually known.
 */
export function liveActivityLabel(toolCalls: ToolCall[], hasContent: boolean): string {
  const running = [...toolCalls].reverse().find((call) => call.status === 'running')
  if (running) {
    return (
      activityPhrase(running.title) ||
      running.title.trim() ||
      TASK_PHASE_LABEL[phaseForCall(running, false)]
    )
  }
  if (hasContent) return 'Writing response'

  const settled = [...toolCalls].reverse().find((call) => call.status !== 'running')
  // Room for "Thinking after " and still fit the same one line.
  const previous = settled ? activityPhrase(settled.title, THINKING_SUBJECT_CHARS) : null
  return previous ? `Thinking after ${lowercaseFirst(previous)}` : 'Thinking'
}

const THINKING_SUBJECT_CHARS = 40
