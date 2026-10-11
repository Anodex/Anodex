// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ToolConfirmRequest, ToolConfirmResponse } from '@shared/tools.types'
import { fireEvent, render, screen } from '../../../test-utils/dom'

vi.mock('../../../lib/anodex', () => ({ anodex: {} }))

const { useUiStore } = await import('../../../stores/uiStore')
const { useChatStore } = await import('../../../stores/chatStore')
const { ToolConfirmCard } = await import('../ToolConfirmCard')

const request: ToolConfirmRequest = {
  id: 'trash-1',
  conversationId: 'conv-1',
  messageId: 'm1',
  toolName: 'move_to_trash',
  kind: 'write',
  title: 'Move 2.5 GB to the Trash',
  detail: 'Untick anything you want to keep.',
  risk: 'sensitive',
  choices: [
    { id: 'npm-cache', label: 'npm cache', detail: '~/.npm/_cacache', size: '2.1 GB' },
    {
      id: 'old-downloads',
      label: 'Downloads older than a year',
      detail: '~/Downloads',
      size: '0.4 GB'
    }
  ]
}

describe('the cleanup list', () => {
  it('starts all ticked, and sends back only what stays ticked', () => {
    const resolved: ToolConfirmResponse[] = []
    useChatStore.setState({ activeId: 'conv-1' })
    useUiStore.setState({
      pendingConfirmations: [request],
      resolveConfirmation: (_id: string, response: ToolConfirmResponse) => resolved.push(response)
    })
    render(<ToolConfirmCard />)

    expect(screen.getByRole('button', { name: /Move all to Trash/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /Downloads older than a year/ }))
    fireEvent.click(screen.getByRole('button', { name: /Move 1 to Trash/ }))

    expect(resolved).toEqual([{ approved: true, chosenIds: ['npm-cache'] }])
  })
})
