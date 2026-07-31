import { beforeEach, describe, expect, it, vi } from 'vitest'
import { generateImage } from '../ImageGenerationService'

const mocks = vi.hoisted(() => ({
  imagesGenerate: vi.fn(),
  settings: {
    provider: {
      openai: { apiKey: 'openai-key' },
      google: { apiKey: 'google-key' }
    }
  }
}))

vi.mock('openai', () => ({
  default: class {
    images = { generate: mocks.imagesGenerate }
  }
}))

vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: { get: () => mocks.settings }
}))

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('pixels')])

describe('image generation service', () => {
  beforeEach(() => {
    mocks.imagesGenerate.mockReset()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('uses GPT Image 2 and returns a validated PNG preview', async () => {
    mocks.imagesGenerate.mockResolvedValue({ data: [{ b64_json: PNG.toString('base64') }] })

    const image = await generateImage({
      provider: 'openai',
      prompt: 'A lighthouse at dusk.',
      aspectRatio: '16:9',
      quality: 'draft'
    })

    expect(mocks.imagesGenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-image-2',
        prompt: 'A lighthouse at dusk.',
        size: '1792x1008',
        quality: 'low',
        output_format: 'png'
      }),
      expect.any(Object)
    )
    expect(image).toMatchObject({ mimeType: 'image/png', sizeBytes: PNG.length })
  })

  it('uses Gemini native image generation and validates its base64 result', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ output_image: { data: PNG.toString('base64') } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    )

    const image = await generateImage({
      provider: 'google',
      prompt: 'A sketch of a sunflower.',
      aspectRatio: '9:16',
      quality: 'standard'
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/interactions',
      expect.objectContaining({ method: 'POST' })
    )
    const body = fetchMock.mock.calls[0]?.[1]?.body
    expect(typeof body).toBe('string')
    if (typeof body === 'string') {
      expect(body).toContain('gemini-3.1-flash-image')
      expect(body).toContain('"image_size":"1K"')
    }
    expect(image).toMatchObject({ mimeType: 'image/png', sizeBytes: PNG.length })
  })
})
