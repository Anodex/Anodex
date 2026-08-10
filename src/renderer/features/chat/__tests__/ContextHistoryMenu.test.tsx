// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { ConversationContextSnapshot } from '@shared/context.types'
import { fireEvent, render, screen } from '../../../test-utils/dom'
import { ContextHistoryMenu } from '../ContextHistoryMenu'

const snapshots: ConversationContextSnapshot[] = [
  {
    id: 'revision-1',
    createdAt: 1,
    reason: 'proactive',
    throughMessageId: 'message-8',
    removedTurns: 8,
    summary: 'The first eight turns were condensed.'
  },
  {
    id: 'revision-2',
    createdAt: 2,
    reason: 'manual',
    throughMessageId: 'message-16',
    removedTurns: 16,
    summary: 'The first sixteen turns were condensed.'
  }
]

describe('ContextHistoryMenu', () => {
  it('lists saved revisions newest first and selects the requested summary', () => {
    const onSelect = vi.fn()
    render(<ContextHistoryMenu snapshots={snapshots} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole('button', { name: /Context condensed/i }))

    expect(screen.getByRole('dialog', { name: 'Context revision history' })).toBeDefined()
    expect(screen.getByText('Current context')).toBeDefined()
    expect(screen.getByText('Revision 1')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: /Current context/i }))

    expect(onSelect).toHaveBeenCalledWith(snapshots[1])
    expect(screen.queryByRole('dialog', { name: 'Context revision history' })).toBeNull()
  })
})
