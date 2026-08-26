/**
 * A refusal written for the model, not a fault in Anodex.
 *
 * Some tool "failures" are the design working: the deferred-tool gateway
 * rejecting arguments that do not match a schema, or a name that does not
 * exist. The model reads the message, corrects itself and carries on — nothing
 * is broken and nobody needs to investigate.
 *
 * Logging those at `error` with a full stack made the level meaningless. In one
 * sweep of a live log, five of the eighteen entries were this exact case and
 * every one was benign; finding the two that mattered meant reading all
 * eighteen. Twice.
 *
 * Marking them lets the transport log them quietly (see `LlamaVisionService`'s
 * `runTool`) while a genuine throw — a bug, a missing file, a provider outage —
 * keeps its stack and its `error` level.
 */
export class ToolGuidanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolGuidanceError'
  }
}
