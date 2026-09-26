import { describe, expect, it } from 'vitest'
import { boundAssistantHistoryReplay } from '../historyReplay'

describe('boundAssistantHistoryReplay', () => {
  it('does not split an emoji at either excerpt boundary', () => {
    const content = `${'a'.repeat(1_499)}😀${'b'.repeat(39_999)}😀${'c'.repeat(5_999)}`
    const projected = boundAssistantHistoryReplay({ role: 'assistant', content })

    expect(projected.content).not.toContain('\ud83d\n')
    expect(projected.content).not.toContain('\n\ude00')
    expect(projected.content).not.toContain('\ufffd')
    expect(projected.content).toContain('older reply omitted')
    expect(content).toContain('😀')
  })
})
