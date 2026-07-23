import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerateParams } from '../../llama/LlamaService'

const mocks = vi.hoisted(() => ({
  openAiRequests: [] as Record<string, unknown>[],
  anthropicRequests: [] as Record<string, unknown>[],
  enableToolRound: false
}))

vi.mock('../../settings/SettingsStore', () => ({
  settingsStore: {
    get: () => ({
      provider: {
        openai: { apiKey: 'openai-key', model: 'gpt-vision' },
        anthropic: { apiKey: 'anthropic-key', model: 'claude-vision' }
      }
    })
  }
}))

vi.mock('../../tools/registry', () => ({
  buildTools: (
    _define: unknown,
    ctx: {
      visualInputs?: {
        current: Array<{
          path: string
          name: string
          mimeType: string
          dataUrl: string
          sizeBytes: number
        }>
        acceptedCount: number
      }
    }
  ) =>
    mocks.enableToolRound
      ? {
          inspect_visual: {
            description: 'Inspect visual',
            params: { type: 'object', properties: {} },
            handler: () => {
              ctx.visualInputs?.current.push({
                path: 'captured.png',
                name: 'captured.png',
                mimeType: 'image/png',
                dataUrl: 'data:image/png;base64,dmlzdWFs',
                sizeBytes: 6
              })
              if (ctx.visualInputs) ctx.visualInputs.acceptedCount += 1
              return Promise.resolve('Visual attached.')
            }
          }
        }
      : undefined
}))

vi.mock('openai', () => {
  class APIUserAbortError extends Error {}
  class OpenAI {
    static AuthenticationError = class extends Error {}
    static NotFoundError = class extends Error {}
    responses = {
      stream: (request: Record<string, unknown>) => {
        mocks.openAiRequests.push(request)
        return {
          on: vi.fn(),
          finalResponse: () =>
            Promise.resolve({
              output:
                mocks.enableToolRound && mocks.openAiRequests.length === 1
                  ? [
                      {
                        type: 'function_call',
                        call_id: 'call-1',
                        name: 'inspect_visual',
                        arguments: '{}'
                      }
                    ]
                  : [],
              usage: { output_tokens: 0 }
            })
        }
      }
    }
    models = { retrieve: vi.fn() }
  }
  return { default: OpenAI, APIUserAbortError }
})

vi.mock('@anthropic-ai/sdk', () => {
  class APIUserAbortError extends Error {}
  class Anthropic {
    static AuthenticationError = class extends Error {}
    static NotFoundError = class extends Error {}
    messages = {
      stream: (request: Record<string, unknown>) => {
        mocks.anthropicRequests.push(request)
        return {
          response: null,
          on: vi.fn(),
          once: vi.fn(),
          finalMessage: () =>
            Promise.resolve({
              content:
                mocks.enableToolRound && mocks.anthropicRequests.length === 1
                  ? [
                      {
                        type: 'tool_use',
                        id: 'tool-1',
                        name: 'inspect_visual',
                        input: {}
                      }
                    ]
                  : [],
              stop_reason:
                mocks.enableToolRound && mocks.anthropicRequests.length === 1
                  ? 'tool_use'
                  : 'end_turn',
              usage: { output_tokens: 0 }
            })
        }
      }
    }
    models = { retrieve: vi.fn() }
  }
  return { default: Anthropic, APIUserAbortError }
})

const { openAiProvider } = await import('../OpenAiProvider')
const { anthropicProvider } = await import('../AnthropicProvider')

const image = {
  path: 'screen.png',
  name: 'screen.png',
  mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,aGVsbG8=',
  sizeBytes: 5
}

function params(): GenerateParams {
  return {
    conversationId: 'conversation',
    messageId: 'message',
    history: [],
    prompt: 'Inspect this',
    images: [image],
    onToken: vi.fn()
  }
}

describe('cloud provider vision requests', () => {
  beforeEach(() => {
    mocks.openAiRequests.length = 0
    mocks.anthropicRequests.length = 0
    mocks.enableToolRound = false
  })

  it('sends image inputs through the OpenAI Responses API', async () => {
    await openAiProvider.generate(params())

    expect(mocks.openAiRequests[0].input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Inspect this' },
          { type: 'input_image', image_url: image.dataUrl, detail: 'auto' }
        ]
      }
    ])
  })

  it('sends image blocks through the Anthropic Messages API', async () => {
    await anthropicProvider.generate(params())

    expect(mocks.anthropicRequests[0].messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' }
          }
        ]
      }
    ])
  })

  it('injects a tool-produced screenshot into OpenAI next provider round', async () => {
    mocks.enableToolRound = true
    const request = params()
    request.images = undefined
    request.tools = toolParams()

    await openAiProvider.generate(request)

    expect(mocks.openAiRequests).toHaveLength(2)
    expect(JSON.stringify(mocks.openAiRequests[1].input)).toContain(
      '"image_url":"data:image/png;base64,dmlzdWFs"'
    )
  })

  it('injects a tool-produced screenshot into Anthropic next provider round', async () => {
    mocks.enableToolRound = true
    const request = params()
    request.images = undefined
    request.tools = toolParams()

    await anthropicProvider.generate(request)

    expect(mocks.anthropicRequests).toHaveLength(2)
    expect(JSON.stringify(mocks.anthropicRequests[1].messages)).toContain('"data":"dmlzdWFs"')
  })
})

function toolParams(): NonNullable<GenerateParams['tools']> {
  return {
    workspaceRoot: 'C:\\workspace',
    projectId: 'project',
    permissionMode: 'ask',
    webSearch: {
      provider: 'none',
      apiKey: '',
      searchEngineId: '',
      baseUrl: '',
      resultCount: 5,
      requireApproval: false
    },
    email: {
      provider: 'none',
      gmail: {
        enabled: false,
        address: '',
        oauthClientId: '',
        oauthClientSecret: '',
        syncMode: 'metadata',
        sendRequiresApproval: true
      }
    },
    memory: { crossChatEnabled: false, personalEnabled: false, confirmBeforeSaving: false },
    plan: null,
    disabledTools: new Set(),
    mcpTools: [],
    onActivity: vi.fn(),
    confirm: () => Promise.resolve({ approved: true })
  }
}
