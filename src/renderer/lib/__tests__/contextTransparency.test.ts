import { describe, expect, it } from 'vitest'
import { buildContextTransparencyItems } from '../contextTransparency'

describe('buildContextTransparencyItems', () => {
  it('summarizes active project context without noisy empty fields', () => {
    expect(
      buildContextTransparencyItems({
        projectName: 'Anodex',
        toolsEnabled: true,
        hasProjectInstructions: true,
        pinnedSkillNames: ['code-review', 'tdd'],
        attachmentCount: 2,
        hasContextSnapshot: true
      })
    ).toEqual([
      { label: 'Project', value: 'Anodex' },
      { label: 'Instructions', value: 'Project rules included' },
      { label: 'Skills', value: 'code-review, tdd' },
      { label: 'Files', value: '2 attached' },
      { label: 'Memory', value: 'Compacted summary active' },
      { label: 'Tools', value: 'Enabled' }
    ])
  })

  it('keeps the compact summary clear for a general chat', () => {
    expect(
      buildContextTransparencyItems({
        projectName: null,
        toolsEnabled: false,
        hasProjectInstructions: false,
        pinnedSkillNames: [],
        attachmentCount: 0,
        hasContextSnapshot: false
      })
    ).toEqual([
      { label: 'Project', value: 'General chat' },
      { label: 'Tools', value: 'Disabled' }
    ])
  })
})
