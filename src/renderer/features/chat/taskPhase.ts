import type { ChatMessage, MessageBlock } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import { sanitizeMessageTranscript } from '@shared/chatSanitizer'

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
  { type: 'text'; text: string } | { type: 'toolGroup'; phase: TaskPhase; calls: ToolCall[] }

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
 * The ordered blocks to render for a message. Messages persisted before the
 * `blocks` field existed fall back to the previous "tools first, then text"
 * layout rather than rendering nothing — every message created from here on
 * has `blocks` populated live as it streams in, so this fallback is a
 * one-time compatibility path for old conversation history, not the norm.
 */
export function messageBlocks(message: ChatMessage): MessageBlock[] {
  const normalized = sanitizeMessageTranscript(message).message
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
