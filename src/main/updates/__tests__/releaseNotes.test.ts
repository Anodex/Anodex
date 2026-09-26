import { describe, expect, it } from 'vitest'
import { fetchReleaseNotes } from '../releaseNotes'

describe('release notes', () => {
  it('loads the release matching the installed version', async () => {
    let requestedUrl = ''
    let requestedSignal: AbortSignal | null | undefined
    const fetcher: typeof fetch = (input, init) => {
      requestedUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requestedSignal = init?.signal
      return Promise.resolve(
        Response.json({
          tag_name: 'v0.14.0',
          name: 'Anodex 0.14.0',
          body: '## Changed\n- A useful change',
          published_at: '2026-09-20T12:00:00Z'
        })
      )
    }

    const result = await fetchReleaseNotes('0.14.0', fetcher)

    expect(requestedUrl).toBe('https://api.github.com/repos/Anodex/Anodex/releases/tags/v0.14.0')
    expect(requestedSignal).toBeInstanceOf(AbortSignal)
    expect(result).toEqual({
      ok: true,
      value: {
        version: '0.14.0',
        title: 'Anodex 0.14.0',
        body: '## Changed\n- A useful change',
        publishedAt: '2026-09-20T12:00:00Z',
        url: 'https://github.com/Anodex/Anodex/releases/tag/v0.14.0'
      }
    })
  })

  it('keeps the prompt available when that release is missing', async () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response(null, { status: 404 }))
    const result = await fetchReleaseNotes('0.14.1', fetcher)
    expect(result).toMatchObject({ ok: false, error: { code: 'updates.release-not-found' } })
  })

  it('rejects notes for a different version', async () => {
    const fetcher: typeof fetch = () =>
      Promise.resolve(Response.json({ tag_name: 'v0.15.0', body: 'Wrong release' }))
    const result = await fetchReleaseNotes('0.14.0', fetcher)
    expect(result).toMatchObject({ ok: false, error: { code: 'updates.release-invalid' } })
  })

  it('rejects oversized responses', async () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response('x'.repeat(256 * 1024 + 1)))
    const result = await fetchReleaseNotes('0.14.0', fetcher)
    expect(result).toMatchObject({ ok: false, error: { code: 'updates.release-unavailable' } })
  })
})
