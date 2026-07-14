import { describe, expect, it, vi } from 'vitest'
import type { ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import { confirmRacingAbort } from '../confirmRacingAbort'

function request(): ToolConfirmRequest {
  return {
    id: 'req-1',
    conversationId: 'conversation',
    messageId: 'message',
    toolName: 'write_file',
    kind: 'write',
    title: 'Write foo.ts',
    detail: 'foo.ts',
    risk: 'safe'
  }
}

/** Never resolves on its own — stands in for a confirm card still awaiting the user. */
function pendingForever(): Promise<ToolConfirmResponse> {
  return new Promise(() => {})
}

describe('confirmRacingAbort', () => {
  it('passes through to the underlying confirm when there is no signal yet', async () => {
    const confirm = vi.fn(() => Promise.resolve({ approved: true }))
    const result = await confirmRacingAbort(confirm, request(), { current: null })
    expect(result).toEqual({ approved: true })
    expect(confirm).toHaveBeenCalledOnce()
  })

  it('resolves denied immediately if the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const confirm = vi.fn(pendingForever)

    const result = await confirmRacingAbort(confirm, request(), { current: controller.signal })

    expect(result.approved).toBe(false)
    expect(result.reason).toContain('cancelled')
  })

  it('resolves denied the moment the signal aborts, even if confirm never settles', async () => {
    const controller = new AbortController()
    const confirm = vi.fn(pendingForever)

    const pending = confirmRacingAbort(confirm, request(), { current: controller.signal })
    controller.abort()
    const result = await pending

    expect(result.approved).toBe(false)
    expect(result.reason).toContain('cancelled')
  })

  it('resolves with the real response when confirm settles before any abort', async () => {
    const controller = new AbortController()
    const confirm = vi.fn(() => Promise.resolve({ approved: true, remember: true }))

    const result = await confirmRacingAbort(confirm, request(), { current: controller.signal })

    expect(result).toEqual({ approved: true, remember: true })
  })

  it('ignores a late abort after confirm already resolved — the real answer wins', async () => {
    const controller = new AbortController()
    const confirm = vi.fn(() => Promise.resolve({ approved: true }))

    const result = await confirmRacingAbort(confirm, request(), { current: controller.signal })
    // The generation ends sometime after the user already answered — should
    // not retroactively change the answer this call already returned.
    controller.abort()

    expect(result).toEqual({ approved: true })
  })

  it('ignores a stale confirm resolution after the signal already aborted', async () => {
    const controller = new AbortController()
    let resolveConfirm: (response: ToolConfirmResponse) => void = () => {}
    const confirm = vi.fn(
      () =>
        new Promise<ToolConfirmResponse>((resolve) => {
          resolveConfirm = resolve
        })
    )

    const pending = confirmRacingAbort(confirm, request(), { current: controller.signal })
    controller.abort()
    const result = await pending

    expect(result.approved).toBe(false)

    // The user finally clicks Approve on the now-stale card — must not throw
    // or otherwise misbehave; the caller already moved on with the denial.
    resolveConfirm({ approved: true })
  })

  it('resolves denied, not a rejection, if the underlying confirm rejects', async () => {
    const controller = new AbortController()
    const confirm = vi.fn(() => Promise.reject(new Error('IPC channel closed')))

    const result = await confirmRacingAbort(confirm, request(), { current: controller.signal })

    expect(result.approved).toBe(false)
  })
})
