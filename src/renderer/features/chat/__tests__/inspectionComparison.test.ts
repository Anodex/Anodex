import { describe, expect, it } from 'vitest'
import type { ToolCall } from '@shared/tools.types'
import { latestInspectionComparison } from '../inspectionComparisonPair'

function inspection(id: string, path: string, title: string): ToolCall {
  return {
    id,
    name: 'inspect_visual',
    kind: 'read',
    title,
    status: 'success',
    preview: {
      kind: 'image',
      title,
      path,
      dataUrl: `data:image/png;base64,${id}`,
      mimeType: 'image/png'
    }
  }
}

describe('latestInspectionComparison', () => {
  it('returns the two latest inspections of the same path', () => {
    const pair = latestInspectionComparison([
      inspection('first', 'page.html', 'First render'),
      inspection('second', 'page.html', 'Second render'),
      inspection('third', 'page.html', 'Third render')
    ])

    expect(pair?.before.title).toBe('Second render')
    expect(pair?.after.title).toBe('Third render')
  })

  it('does not compare unrelated workspace files', () => {
    expect(
      latestInspectionComparison([
        inspection('first', 'page.html', 'Page'),
        inspection('second', 'logo.png', 'Logo')
      ])
    ).toBeNull()
  })

  it('ignores failed and non-inspection image previews', () => {
    const failed = inspection('failed', 'page.html', 'Failed')
    failed.status = 'error'
    const attached = inspection('attached', 'page.html', 'Attached')
    attached.name = 'show_image'

    expect(
      latestInspectionComparison([inspection('first', 'page.html', 'First'), failed, attached])
    ).toBeNull()
  })
})
