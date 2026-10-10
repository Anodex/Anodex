// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '../../../test-utils/dom'

const test = vi.fn()
const update = vi.fn()
vi.mock('../../../lib/anodex', () => ({ anodex: { webSearch: { test } } }))
vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({
      settings: { webSearch: { provider: 'none', apiKey: '', baseUrl: '', searchEngineId: '' } },
      update
    })
}))

const { WebSearchSetupDialog } = await import('../WebSearchSetupDialog')

beforeEach(() => {
  test.mockReset()
  update.mockReset()
})

function pasteKey(key: string): void {
  fireEvent.change(screen.getByLabelText(/Paste the key/), { target: { value: key } })
  fireEvent.click(screen.getByRole('button', { name: 'Test and save' }))
}

describe('WebSearchSetupDialog', () => {
  it('starts on the free service, with the key box masked', () => {
    render(<WebSearchSetupDialog onClose={() => {}} />)
    expect(screen.getByRole('radio', { name: /Tavily/ })).toHaveProperty('checked', true)
    expect(screen.getByLabelText(/Paste the key/).getAttribute('type')).toBe('password')
  })

  it('saves nothing when the test search fails, and says why', async () => {
    test.mockResolvedValue({ ok: false, error: { code: 'x', message: 'the API key was rejected' } })
    render(<WebSearchSetupDialog onClose={() => {}} />)
    pasteKey('tvly-wrong')

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'the API key was rejected'
    )
    expect(update).not.toHaveBeenCalled()
  })

  it('saves the service and key once a real search worked', async () => {
    test.mockResolvedValue({ ok: true, value: { resultCount: 3 } })
    const onSaved = vi.fn()
    render(<WebSearchSetupDialog onClose={() => {}} onSaved={onSaved} />)
    pasteKey('  tvly-good  ')

    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(test).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'tavily', apiKey: 'tvly-good' })
    )
    expect(update).toHaveBeenCalledWith({
      webSearch: { provider: 'tavily', apiKey: 'tvly-good', baseUrl: '' }
    })
    expect(screen.getByRole('status').textContent).toMatch(/Web search is ready/)
  })

  it('asks for an address, not a key, for a self-hosted SearXNG', () => {
    render(<WebSearchSetupDialog onClose={() => {}} />)
    fireEvent.click(screen.getByRole('radio', { name: /SearXNG/ }))
    expect(screen.getByLabelText(/Its address/).getAttribute('type')).toBe('url')
  })
})
