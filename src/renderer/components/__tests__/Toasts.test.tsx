import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Toast } from '../../stores/uiStore'

const state: { toasts: Toast[]; dismissToast: () => void; holdToasts: () => void } = {
  toasts: [],
  dismissToast: vi.fn(),
  holdToasts: vi.fn()
}

vi.mock('../../stores/uiStore', () => ({
  useUiStore: (select: (s: typeof state) => unknown) => select(state)
}))

const { Toasts } = await import('../Toasts')

describe('Toasts', () => {
  beforeEach(() => {
    state.toasts = []
  })

  it('shows how many times a repeated toast was raised', () => {
    state.toasts = [
      { id: 'a', kind: 'error', title: 'Offline', count: 3, duration: 7000, shownAt: 1 }
    ]
    const html = renderToStaticMarkup(<Toasts />)
    expect(html).toContain('×3')
  })

  it('runs its countdown bar for as long as the toast stays', () => {
    state.toasts = [{ id: 'a', kind: 'success', title: 'Saved', duration: 4000, shownAt: 1 }]
    expect(renderToStaticMarkup(<Toasts />)).toContain('animation-duration:4000ms')
  })

  it('gives a pending toast no countdown, because it has none', () => {
    state.toasts = [{ id: 'a', kind: 'pending', title: 'Running task' }]
    expect(renderToStaticMarkup(<Toasts />)).not.toContain('animation-duration')
  })

  it('keeps only the front toast readable while the stack is collapsed', () => {
    state.toasts = [
      { id: 'old', kind: 'info', title: 'Older', duration: 4000, shownAt: 1 },
      { id: 'new', kind: 'info', title: 'Newer', duration: 4000, shownAt: 2 }
    ]
    const html = renderToStaticMarkup(<Toasts />)
    const hidden = html.match(/aria-hidden="true"[^>]*>(?:(?!aria-hidden).)*?Older/s)
    expect(hidden).not.toBeNull()
    expect(html.indexOf('Newer')).toBeLessThan(html.indexOf('Older'))
  })
})
