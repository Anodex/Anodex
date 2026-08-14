import { describe, expect, it } from 'vitest'
import { buildContextEpochSystemPrompt } from '../contextPrompt'

describe('buildContextEpochSystemPrompt', () => {
  it('renders completed facts as a protected continuation block', () => {
    const prompt = buildContextEpochSystemPrompt('Base instructions.', {
      version: 1,
      id: 'epoch-1',
      createdAt: 1,
      epoch: 2,
      cause: 'proactive',
      objective: 'Finish the dashboard',
      completedTools: [
        {
          name: 'write_file',
          kind: 'write',
          status: 'success',
          touchedPaths: ['src/dashboard.tsx']
        }
      ],
      verificationNote: 'Inspect after changing the rendered view.'
    })

    expect(prompt).toContain('Base instructions.')
    expect(prompt).toContain('Context epoch handoff')
    expect(prompt).toContain('Finish the dashboard')
    expect(prompt).toContain('write_file (src/dashboard.tsx)')
    expect(prompt).toContain('Inspect after changing the rendered view.')
  })
})
