import type { ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'

/** The response synthesized when a signal aborts before the underlying confirm resolves. */
export function cancelledConfirmResponse(): ToolConfirmResponse {
  return { approved: false, reason: 'The generation was cancelled.' }
}

/**
 * Wrap a confirm callback so it also resolves (denied) the moment `signal`
 * aborts, even if the underlying confirm — typically a round trip out to the
 * renderer waiting on the user — never settles on its own. Without this, a
 * confirm card for a call still awaiting the user can outlive the generation
 * that requested it: approving it later would run the tool for real (e.g. a
 * file write) into a turn that already ended, with no model left to see the
 * result. `signal` is read from `signalBox` at call time, not captured
 * eagerly, since the real signal (e.g. `genController.signal`) may not exist
 * yet when this wrapper itself is constructed.
 */
export function confirmRacingAbort(
  confirm: (request: ToolConfirmRequest) => Promise<ToolConfirmResponse>,
  request: ToolConfirmRequest,
  signalBox: { current: AbortSignal | null }
): Promise<ToolConfirmResponse> {
  const signal = signalBox.current
  if (!signal) return confirm(request)
  if (signal.aborted) return Promise.resolve(cancelledConfirmResponse())

  return new Promise((resolve) => {
    let settled = false
    const onAbort = (): void => {
      if (settled) return
      settled = true
      resolve(cancelledConfirmResponse())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    confirm(request).then(
      (response) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(response)
      },
      () => {
        // A rejected confirm is still a "this call doesn't proceed" outcome —
        // resolve denied rather than leaving the caller's await unsettled or
        // propagating an unhandled rejection past a wrapper that promised a
        // `ToolConfirmResponse`, never an error.
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(cancelledConfirmResponse())
      }
    )
  })
}
