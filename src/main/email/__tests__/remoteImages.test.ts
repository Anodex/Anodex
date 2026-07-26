import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadRemoteImages } from '../remoteImages'

const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

describe('loadRemoteImages', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('inlines an image with a declared image content type', async () => {
    stubFetch(
      new Response(pngBytes, {
        status: 200,
        headers: { 'content-type': 'image/png' }
      })
    )

    const images = await loadRemoteImages(['https://images.example/logo.png'])

    expect(images['https://images.example/logo.png']).toBe(
      `data:image/png;base64,${pngBytes.toString('base64')}`
    )
  })

  it('sniffs generic image responses that email senders commonly use', async () => {
    stubFetch(
      new Response(pngBytes, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' }
      })
    )

    const images = await loadRemoteImages(['https://images.example/logo'])

    expect(images['https://images.example/logo']).toBe(
      `data:image/png;base64,${pngBytes.toString('base64')}`
    )
  })

  it('loads protocol-relative image URLs over https', async () => {
    const fetchMock = stubFetch(
      new Response(pngBytes, {
        status: 200,
        headers: { 'content-type': 'image/png' }
      })
    )

    const images = await loadRemoteImages(['//images.example/logo.png'])

    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://images.example/logo.png'),
      expect.objectContaining({ redirect: 'follow' })
    )
    expect(images['//images.example/logo.png']).toContain('data:image/png;base64,')
  })

  it('does not inline generic non-image responses', async () => {
    stubFetch(
      new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' }
      })
    )

    await expect(loadRemoteImages(['https://images.example/not-image'])).resolves.toEqual({})
  })
})

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
