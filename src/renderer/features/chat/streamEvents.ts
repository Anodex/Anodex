import type { ToolCall } from '@shared/tools.types'

/** One renderer-visible event in the exact order emitted by the generation runtime. */
export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'activity'; calls: ToolCall[] }
