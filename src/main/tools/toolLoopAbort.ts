/**
 * Provider-neutral stop latch for explicit tool-call round loops.
 *
 * A tool guard asks to stop while its handler is running, after the provider
 * has already finished the model request for that round. Stateless transports
 * do not need to abort a network stream at that point; they need to refuse to
 * start the next provider round. Keeping that signal in a tiny shared latch
 * gives local vision and every cloud protocol the same semantics as the local
 * text engine's native-loop abort controller.
 */
export interface ToolLoopAbortState {
  readonly requested: boolean
  request(): void
}

export function createToolLoopAbortState(): ToolLoopAbortState {
  let requested = false
  return {
    get requested() {
      return requested
    },
    request() {
      requested = true
    }
  }
}
