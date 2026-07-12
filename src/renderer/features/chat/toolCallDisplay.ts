import type { ToolCall } from '@shared/tools.types'
import { diffStats } from '../../lib/diffRows'

export interface ToolCallDisplay {
  action: string
  target: string
  meta: string | null
}

/** Split a one-line tool title into fixed scan columns: action, target, metadata. */
export function getToolCallDisplay(call: ToolCall): ToolCallDisplay {
  const title = call.title.trim()
  const colonMatch = /^([^:]+):\s*(.+)$/.exec(title)
  const spaceMatch = /^(\S+)\s+([\s\S]+)$/.exec(title)
  const action = (colonMatch?.[1] ?? spaceMatch?.[1] ?? title).trim()
  const target = (colonMatch?.[2] ?? spaceMatch?.[2] ?? '').trim()

  return {
    action,
    target,
    meta: call.detail ?? diffMeta(call) ?? null
  }
}

function diffMeta(call: ToolCall): string | null {
  if (!call.diff) return null
  const { added, removed } = diffStats(call.diff.before, call.diff.after)
  return `+${added} -${removed}`
}
