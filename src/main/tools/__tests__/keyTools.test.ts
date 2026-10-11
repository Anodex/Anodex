import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import { mayPushToRemote } from '../../remote/channelPolicy'

const h = vi.hoisted(() => ({ saved: [] as string[], refuse: null as string | null }))

vi.mock('../../secrets/keyTargets', () => ({
  KEY_TARGETS: [{ id: 'tavily' }],
  maskKey: (key: string) => `${key.slice(0, 4)}…${key.slice(-4)}`,
  findKeyTarget: (id: string) =>
    id.toLowerCase() === 'tavily'
      ? {
          id: 'tavily',
          name: 'Tavily',
          getUrl: 'https://app.tavily.com/',
          placeholder: 'tvly-…',
          checkAndSave: (key: string) => {
            if (h.refuse) return Promise.reject(new Error(h.refuse))
            h.saved.push(key)
            return Promise.resolve('Tavily key saved and working.')
          }
        }
      : undefined
}))

const { requestKeyTool, saveKeyTool } = await import('../keyTools')
const { createMockContext, createMockDefine } = await import('./test-helpers')

const KEY = 'tvly-abcdef1234567890'

beforeEach(() => {
  h.saved = []
  h.refuse = null
})

function context(
  mode: 'ask' | 'full' | 'untethered',
  typed: string,
  answer: ToolConfirmResponse = { approved: true }
) {
  const prompts: ToolConfirmRequest[] = []
  const onSecretSaved = vi.fn()
  const ctx = {
    ...createMockContext('/workspace'),
    permissionMode: mode,
    userProvided: (text: string) => typed.includes(text),
    onSecretSaved,
    confirm: (request: ToolConfirmRequest) => {
      prompts.push(request)
      return Promise.resolve(answer)
    }
  }
  return { ctx, prompts, onSecretSaved }
}

type Save = { handler: (args: { service: string; key: string }) => Promise<string> }
type Request = { handler: (args: { service: string }) => Promise<string> }

describe('save_key', () => {
  it('refuses a key the person did not type, without asking', async () => {
    const { ctx, prompts } = context('untethered', 'set up web search please')
    const tool = saveKeyTool(createMockDefine(), ctx) as unknown as Save
    const result = await tool.handler({ service: 'tavily', key: KEY })
    expect(result).toContain('Refused')
    expect(prompts).toHaveLength(0)
    expect(h.saved).toEqual([])
  })

  it('saves a pasted key without asking in Untethered, and has the chat scrub it', async () => {
    const { ctx, prompts, onSecretSaved } = context('untethered', `here is my key ${KEY}`)
    const tool = saveKeyTool(createMockDefine(), ctx) as unknown as Save
    const result = await tool.handler({ service: 'tavily', key: KEY })
    expect(prompts).toHaveLength(0)
    expect(h.saved).toEqual([KEY])
    expect(onSecretSaved).toHaveBeenCalledWith(KEY)
    expect(result).not.toContain(KEY)
  })

  it('asks in Ask and Edits mode, showing only a masked key', async () => {
    for (const mode of ['ask', 'full'] as const) {
      h.saved = []
      const { ctx, prompts } = context(mode, `key: ${KEY}`)
      const tool = saveKeyTool(createMockDefine(), ctx) as unknown as Save
      await tool.handler({ service: 'tavily', key: KEY })
      expect(prompts).toHaveLength(1)
      expect(prompts[0].detail).toContain('tvly…7890')
      expect(prompts[0].detail).not.toContain(KEY)
      expect(h.saved).toEqual([KEY])
    }
  })

  it("passes on the service's own refusal and does not scrub anything", async () => {
    h.refuse = 'Tavily search failed: the API key was rejected'
    const { ctx, onSecretSaved } = context('untethered', KEY)
    const tool = saveKeyTool(createMockDefine(), ctx) as unknown as Save
    expect(await tool.handler({ service: 'tavily', key: KEY })).toContain('key was rejected')
    expect(onSecretSaved).not.toHaveBeenCalled()
  })
})

describe('request_key', () => {
  it('shows a key box even in Untethered, and checks what was pasted into it', async () => {
    const { ctx, prompts } = context('untethered', '', { approved: true, secretValue: ` ${KEY} ` })
    const tool = requestKeyTool(createMockDefine(), ctx) as unknown as Request
    const result = await tool.handler({ service: 'Tavily' })
    expect(prompts).toHaveLength(1)
    expect(prompts[0].secret).toMatchObject({
      service: 'Tavily',
      getUrl: 'https://app.tavily.com/'
    })
    expect(prompts[0].requiresHumanApproval).toBe(true)
    expect(h.saved).toEqual([KEY])
    expect(result).not.toContain(KEY)
  })

  it('says so when the box is closed without a key', async () => {
    const { ctx } = context('ask', '', { approved: false })
    const tool = requestKeyTool(createMockDefine(), ctx) as unknown as Request
    expect(await tool.handler({ service: 'tavily' })).toMatch(/denied/i)
    expect(h.saved).toEqual([])
  })

  it('names the services it can keep keys for', async () => {
    const { ctx } = context('ask', '')
    const tool = requestKeyTool(createMockDefine(), ctx) as unknown as Request
    expect(await tool.handler({ service: 'myspace' })).toContain('does not keep keys for "myspace"')
  })
})

describe('the key never reaches a phone', () => {
  it('keeps the secret-saved event off the wire', () => {
    expect(mayPushToRemote('chat:secret-saved')).toBe(false)
  })

  // Listed for the dock since 0.16, but the entry had landed in the request
  // list, so process updates went to the phone anyway.
  it('keeps process updates, which have no screen on the phone, off it too', () => {
    expect(mayPushToRemote('processes:changed')).toBe(false)
  })
})
