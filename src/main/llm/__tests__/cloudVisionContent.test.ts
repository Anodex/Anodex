import { describe, expect, it } from 'vitest'
import type { ChatImageInput } from '@shared/chat.types'
import {
  anthropicUserContent,
  chatCompletionsUserContent,
  cloudCompatibleImages,
  openAiUserContent
} from '../cloudVisionContent'

const image: ChatImageInput = {
  path: 'screen.png',
  name: 'screen.png',
  mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,aGVsbG8=',
  sizeBytes: 5
}

describe('cloud vision content', () => {
  it('creates OpenAI Responses API image inputs', () => {
    expect(openAiUserContent('What is wrong?', [image])).toEqual([
      { type: 'input_text', text: 'What is wrong?' },
      {
        type: 'input_image',
        image_url: image.dataUrl,
        detail: 'auto'
      }
    ])
  })

  it('creates Anthropic base64 image blocks', () => {
    expect(anthropicUserContent('What is wrong?', [image])).toEqual([
      { type: 'text', text: 'What is wrong?' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'aGVsbG8='
        }
      }
    ])
  })

  it('creates Chat Completions image_url content parts', () => {
    expect(chatCompletionsUserContent('What is wrong?', [image])).toEqual([
      { type: 'text', text: 'What is wrong?' },
      {
        type: 'image_url',
        image_url: { url: image.dataUrl, detail: 'auto' }
      }
    ])
  })

  it('keeps text-only messages unchanged', () => {
    expect(openAiUserContent('Hello', [])).toBe('Hello')
    expect(anthropicUserContent('Hello', [])).toBe('Hello')
    expect(chatCompletionsUserContent('Hello', [])).toBe('Hello')
  })

  it('omits historical BMP images when switching to a cloud provider', () => {
    expect(
      cloudCompatibleImages([{ ...image, mimeType: 'image/bmp', name: 'old.bmp' }, image])
    ).toEqual([image])
  })
})
