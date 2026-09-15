import type { EngineState } from '@shared/model.types'

/**
 * What a streaming reply's status adds while it shares the local model.
 *
 * With parallel jobs on, two replies run at once and each writes more slowly — seen
 * in a stress test, where a build in a chat and an agent run together each took far
 * longer than either alone, with nothing on screen to say why. Null when nothing is
 * shared, or the reply is not running on the local model at all.
 */
export function modelSharingNote(
  engine: Pick<EngineState, 'activeReplies'>,
  replyIsLocal: boolean
): string | null {
  const others = (engine.activeReplies ?? 0) - 1
  if (!replyIsLocal || others < 1) return null
  return others === 1
    ? 'sharing the model with another job'
    : `sharing the model with ${others} other jobs`
}
