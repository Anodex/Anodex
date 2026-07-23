import type Anthropic from '@anthropic-ai/sdk'
import type { ResponseInputContent } from 'openai/resources/responses/responses'
import type { ChatImageInput } from '@shared/chat.types'

/** Build a Responses API user content list while keeping image bytes out of prompt text. */
export function openAiUserContent(
  text: string,
  images: readonly ChatImageInput[]
): string | ResponseInputContent[] {
  if (images.length === 0) return text
  return [
    { type: 'input_text', text: text || 'Describe the attached content.' },
    ...images.map((image) => ({
      type: 'input_image' as const,
      image_url: image.dataUrl,
      detail: 'auto' as const
    }))
  ]
}

/** Build Anthropic image blocks from bounded data URLs without embedding bytes in text. */
export function anthropicUserContent(
  text: string,
  images: readonly ChatImageInput[]
): string | Anthropic.ContentBlockParam[] {
  if (images.length === 0) return text
  return [
    { type: 'text', text: text || 'Describe the attached content.' },
    ...images.map((image): Anthropic.ImageBlockParam => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: anthropicImageMimeType(image.mimeType),
        data: base64Payload(image.dataUrl)
      }
    }))
  ]
}

/** Historical BMPs are omitted instead of breaking a later conversation after a provider switch. */
export function cloudCompatibleImages(images: readonly ChatImageInput[]): ChatImageInput[] {
  return images.filter((image) => image.mimeType.toLowerCase() !== 'image/bmp')
}

function anthropicImageMimeType(mimeType: string): Anthropic.Base64ImageSource['media_type'] {
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
      return 'image/jpeg'
    case 'image/gif':
      return 'image/gif'
    case 'image/webp':
      return 'image/webp'
    default:
      return 'image/png'
  }
}

function base64Payload(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
}
