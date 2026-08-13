import { describe, expect, it, vi } from 'vitest'
import { WindowsDesktopControlTarget } from '../WindowsDesktopControlTarget'
import type {
  DesktopWindowTarget,
  WindowsDesktopControlBackend
} from '../WindowsDesktopControlBackend'

const desktopWindow: DesktopWindowTarget = {
  handle: '42',
  processId: 101,
  processPath: 'C:\\Apps\\Example.exe',
  title: 'Example',
  bounds: { x: 400, y: 200, width: 800, height: 600 }
}

describe('WindowsDesktopControlTarget', () => {
  it('requires a human approval for every desktop action', async () => {
    const backend = {} as WindowsDesktopControlBackend
    const target = new WindowsDesktopControlTarget(desktopWindow, backend)

    await expect(target.assessAction({ type: 'type', text: 'safe text' })).resolves.toContain(
      'Approve typing 9 characters'
    )
  })

  it('translates screenshot-relative pointer coordinates to the selected window screen bounds', async () => {
    const execute = vi.fn(() => Promise.resolve())
    const backend = { execute } as unknown as WindowsDesktopControlBackend
    const target = new WindowsDesktopControlTarget(desktopWindow, backend)

    await target.execute({ type: 'click', x: 20, y: 30 }, new AbortController().signal)

    expect(execute).toHaveBeenCalledWith(
      desktopWindow,
      { type: 'click', x: 420, y: 230 },
      expect.any(AbortSignal)
    )
  })
})
