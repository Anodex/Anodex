// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import { fireEvent, render, screen } from '../../../test-utils/dom'

vi.mock('../../../lib/anodex', () => ({ anodex: {} }))

const { useUiStore } = await import('../../../stores/uiStore')
const { useChatStore } = await import('../../../stores/chatStore')
const { ToolConfirmCard } = await import('../ToolConfirmCard')

const resolved: Array<{ id: string; response: ToolConfirmResponse }> = []

function request(overrides: Partial<ToolConfirmRequest> = {}): ToolConfirmRequest {
  return {
    id: 'key-1',
    conversationId: 'conv-1',
    messageId: 'm1',
    toolName: 'request_key',
    kind: 'write',
    title: 'Add your Tavily key',
    detail: 'Get one at https://app.tavily.com/',
    risk: 'sensitive',
    requiresHumanApproval: true,
    secret: { service: 'Tavily', getUrl: 'https://app.tavily.com/', placeholder: 'tvly-…' },
    ...overrides
  }
}

beforeEach(() => {
  resolved.length = 0
  useChatStore.setState({ activeId: 'conv-1' })
  useUiStore.setState({
    pendingConfirmations: [request()],
    resolveConfirmation: (id: string, response: ToolConfirmResponse) =>
      resolved.push({ id, response })
  })
})

describe('the key box', () => {
  it('takes the key in a hidden field and sends it back with the answer', () => {
    render(<ToolConfirmCard />)
    const input = screen.getByLabelText('Tavily key')
    expect(input.getAttribute('type')).toBe('password')
    expect(screen.getByRole('link', { name: /app\.tavily\.com/ }).getAttribute('href')).toBe(
      'https://app.tavily.com/'
    )

    const save = screen.getByRole('button', { name: /Save key/ })
    expect(save.hasAttribute('disabled')).toBe(true)
    fireEvent.change(input, { target: { value: '  tvly-secret  ' } })
    fireEvent.click(save)

    expect(resolved).toEqual([
      { id: 'key-1', response: { approved: true, secretValue: 'tvly-secret' } }
    ])
  })

  it('is left out of approve-all, which can only send it back empty', () => {
    useUiStore.setState({
      pendingConfirmations: [
        request(),
        request({ id: 'write-1', toolName: 'write_file', title: 'Write a.ts', secret: undefined })
      ]
    })
    render(<ToolConfirmCard />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve all' }))
    expect(resolved.map((entry) => entry.id)).toEqual(['write-1'])
  })
})

describe('redactSecret', () => {
  it("replaces a stored key in the person's messages and nowhere else", () => {
    useChatStore.setState({
      conversations: [
        {
          id: 'conv-1',
          projectId: null,
          title: 'Search setup',
          createdAt: 1,
          updatedAt: 1,
          messages: [
            { id: 'u1', role: 'user', content: 'my key is tvly-secret, set it up', createdAt: 1 },
            { id: 'a1', role: 'assistant', content: 'Saving it.', createdAt: 2, streaming: true }
          ]
        }
      ]
    })
    useChatStore.getState().redactSecret('conv-1', 'tvly-secret')
    const [user, reply] = useChatStore.getState().conversations[0].messages
    expect(user.content).toBe('my key is •••• (saved), set it up')
    expect(reply.content).toBe('Saving it.')
  })
})
