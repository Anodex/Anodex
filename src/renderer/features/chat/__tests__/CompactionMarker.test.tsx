// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { ConversationContextSnapshot } from '@shared/context.types'
import { fireEvent, render, screen } from '../../../test-utils/dom'
import { CompactionMarker } from '../CompactionMarker'

const snapshot: ConversationContextSnapshot = {
  id: 'snapshot-1',
  createdAt: 1,
  reason: 'proactive',
  throughMessageId: 'message-16',
  removedTurns: 16,
  summary: 'The family prefers short driving days, easy hikes, and an indoor backup plan.'
}

describe('CompactionMarker', () => {
  it('reveals the carried-forward context without hiding the original transcript', () => {
    render(<CompactionMarker snapshot={snapshot} />)

    expect(screen.queryByText(snapshot.summary)).toBeNull()

    fireEvent.click(
      screen.getByRole('button', { name: 'Show context condensed from 16 earlier turns' })
    )

    expect(screen.getByText(snapshot.summary)).toBeDefined()
    expect(screen.getByText('Context carried forward')).toBeDefined()
    expect(screen.getByText('Original messages remain available above.')).toBeDefined()
  })

  it('opens when the persistent header sends a reveal request', () => {
    const { rerender } = render(<CompactionMarker snapshot={snapshot} />)

    rerender(<CompactionMarker snapshot={snapshot} revealRequest={1} />)

    expect(screen.getByText(snapshot.summary)).toBeDefined()
  })
})
