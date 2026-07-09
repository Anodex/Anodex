import type { Conversation } from '@shared/conversation.types'

/**
 * Equality check for a `conversations` array subscription, comparing only
 * commonly-rendered summary fields (title, recency, project, message count,
 * and whether anything is mid-stream) instead of full reference equality.
 *
 * Immer gives every mutated draft path a new reference all the way up to the
 * root, so appending a single streamed token deep inside one conversation's
 * message content produces a brand-new top-level `conversations` array —
 * hundreds of times per second during generation. Subscribing to that array
 * with default reference equality re-renders every consumer (and re-runs any
 * `useMemo`/`useEffect` keyed on it) on every token, which was directly
 * observed to starve window-resize repaints and a sidebar hover-card's
 * dismiss timer badly enough that the UI looked frozen — while app state
 * kept updating correctly underneath the whole time.
 *
 * Pass this to `useStoreWithEqualityFn(useChatStore, (s) => s.conversations, conversationsRelevantlyEqual)`
 * in any component that only reads these summary fields, not live message
 * content, from the conversation list.
 */
export function conversationsRelevantlyEqual(a: Conversation[], b: Conversation[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if (
      x.id !== y.id ||
      x.title !== y.title ||
      x.updatedAt !== y.updatedAt ||
      x.projectId !== y.projectId ||
      x.messages.length !== y.messages.length ||
      x.messages.some((m) => m.streaming) !== y.messages.some((m) => m.streaming)
    ) {
      return false
    }
  }
  return true
}
