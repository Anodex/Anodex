import { describe, expect, it, vi } from 'vitest'
import type { WebSearchSettings } from '@shared/settings.types'
import { testSearchProvider } from '../testSearchProvider'

const config = { provider: 'tavily' as const, apiKey: 'tvly-test', baseUrl: '', searchEngineId: '' }

describe('testSearchProvider', () => {
  it('runs one real search with the unsaved settings and says how many came back', async () => {
    const search = vi.fn().mockResolvedValue([{ title: 'a' }, { title: 'b' }])
    const create = vi.fn((_settings: WebSearchSettings) => ({ search }))

    await expect(testSearchProvider(config, create)).resolves.toBe(2)
    expect(create.mock.calls[0][0]).toMatchObject({ provider: 'tavily', apiKey: 'tvly-test' })
    expect(search).toHaveBeenCalledTimes(1)
  })

  it("reports the provider's own error, such as a rejected key", async () => {
    const search = vi
      .fn()
      .mockRejectedValue(new Error('Tavily search failed: the API key was rejected'))
    await expect(testSearchProvider(config, () => ({ search }))).rejects.toThrow(/key was rejected/)
  })

  it('refuses to test with no service chosen', async () => {
    await expect(testSearchProvider({ ...config, provider: 'none' }, () => null)).rejects.toThrow(
      /Choose a search service/
    )
  })

  it('reports a missing key before any request is made', async () => {
    await expect(testSearchProvider({ ...config, apiKey: '  ' })).rejects.toThrow(
      /requires an API key/
    )
  })

  it('says where it looked when nothing answers, instead of "fetch failed"', async () => {
    const search = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    await expect(
      testSearchProvider(
        { ...config, provider: 'searxng', apiKey: '', baseUrl: 'http://127.0.0.1:9' },
        () => ({ search })
      )
    ).rejects.toThrow('Nothing answered at http://127.0.0.1:9.')
    await expect(testSearchProvider(config, () => ({ search }))).rejects.toThrow(/online/)
  })
})
