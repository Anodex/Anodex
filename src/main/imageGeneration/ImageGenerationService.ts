import OpenAI from 'openai'
import type { ChatImageInput } from '@shared/chat.types'
import { readVisionImageBuffer } from '../vision/imageInputs'
import { settingsStore } from '../settings/SettingsStore'
import type { ImageGenerationProvider } from '../tools/types'

const OPENAI_IMAGE_MODEL = 'gpt-image-2'
const GOOGLE_IMAGE_MODEL = 'gemini-3.1-flash-image'

export type ImageAspectRatio = '1:1' | '16:9' | '9:16'
export type ImageQuality = 'draft' | 'standard' | 'high'

export interface GenerateImageRequest {
  provider: ImageGenerationProvider
  prompt: string
  aspectRatio: ImageAspectRatio
  quality: ImageQuality
  signal?: AbortSignal
}

/** Generate one PNG with a first-party cloud image API, then validate it as a chat preview. */
export async function generateImage(request: GenerateImageRequest): Promise<ChatImageInput> {
  switch (request.provider) {
    case 'openai':
      return generateOpenAiImage(request)
    case 'google':
      return generateGoogleImage(request)
  }
}

async function generateOpenAiImage(request: GenerateImageRequest): Promise<ChatImageInput> {
  const apiKey = settingsStore.get().provider.openai.apiKey.trim()
  if (!apiKey) throw new Error('No OpenAI API key configured for image generation.')

  const client = new OpenAI({ apiKey })
  // The installed SDK predates GPT Image 2's type declaration. The documented
  // Image API accepts these fields, and the narrow cast keeps the rest of this
  // integration fully typed without pinning Anodex to an older image model.
  const response = await client.images.generate(
    {
      model: OPENAI_IMAGE_MODEL,
      prompt: request.prompt,
      size: openAiSize(request.aspectRatio),
      quality: openAiQuality(request.quality),
      output_format: 'png'
    } as never,
    { signal: request.signal }
  )
  const encoded = response.data?.[0]?.b64_json
  if (!encoded) throw new Error('OpenAI did not return image data.')
  return toPreviewImage(Buffer.from(encoded, 'base64'), 'OpenAI generated image')
}

async function generateGoogleImage(request: GenerateImageRequest): Promise<ChatImageInput> {
  const apiKey = settingsStore.get().provider.google.apiKey.trim()
  if (!apiKey) throw new Error('No Google AI API key configured for image generation.')

  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      model: GOOGLE_IMAGE_MODEL,
      input: request.prompt,
      response_format: {
        type: 'image',
        mime_type: 'image/png',
        aspect_ratio: request.aspectRatio,
        image_size: googleImageSize(request.quality)
      }
    }),
    signal: request.signal
  })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(googleErrorMessage(payload, response.status))
  const encoded = googleImageData(payload)
  if (!encoded) throw new Error('Google AI did not return image data.')
  return toPreviewImage(Buffer.from(encoded, 'base64'), 'Google generated image')
}

function toPreviewImage(data: Buffer, name: string): ChatImageInput {
  return readVisionImageBuffer(data, {
    name,
    mimeType: 'image/png',
    reference: 'Generated in this conversation'
  })
}

function openAiSize(aspectRatio: ImageAspectRatio): string {
  switch (aspectRatio) {
    case '16:9':
      return '1792x1008'
    case '9:16':
      return '1008x1792'
    default:
      return '1024x1024'
  }
}

function openAiQuality(quality: ImageQuality): 'low' | 'medium' | 'high' {
  switch (quality) {
    case 'draft':
      return 'low'
    case 'high':
      return 'high'
    default:
      return 'medium'
  }
}

function googleImageSize(quality: ImageQuality): '1K' | '2K' {
  return quality === 'high' ? '2K' : '1K'
}

function googleImageData(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const direct = (payload as { output_image?: { data?: unknown } }).output_image?.data
  if (typeof direct === 'string') return direct

  const steps = (payload as { steps?: unknown }).steps
  if (!Array.isArray(steps)) return null
  for (const step of steps) {
    const content = (step as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const item of content) {
      const data = (item as { type?: unknown; data?: unknown }).data
      if ((item as { type?: unknown }).type === 'image' && typeof data === 'string') return data
    }
  }
  return null
}

function googleErrorMessage(payload: unknown, status: number): string {
  const message =
    payload && typeof payload === 'object'
      ? (payload as { error?: { message?: unknown } }).error?.message
      : undefined
  return typeof message === 'string' && message.trim()
    ? `Google AI image generation failed: ${message}`
    : `Google AI image generation failed (HTTP ${status}).`
}
