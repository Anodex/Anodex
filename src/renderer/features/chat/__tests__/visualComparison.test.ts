import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import { latestVisualComparison, visualComparisonsByMessage } from '../visualComparisonPair'

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

describe('latestVisualComparison', () => {
  it('returns the two latest inspections of the same path', () => {
    const pair = latestVisualComparison(
      [],
      [
        inspection('first', 'page.html', 'First render'),
        inspection('second', 'page.html', 'Second render'),
        inspection('third', 'page.html', 'Third render')
      ]
    )

    expect(pair?.before.title).toBe('Second render')
    expect(pair?.after.title).toBe('Third render')
  })

  it('compares an inspection with the prior turn for the same path', () => {
    const pair = latestVisualComparison(
      [inspection('first', 'page.html', 'First render')],
      [inspection('second', 'page.html', 'Second render')]
    )

    expect(pair).toMatchObject({
      kind: 'image',
      afterCallId: 'second',
      before: { title: 'First render' },
      after: { title: 'Second render' }
    })
  })

  it('does not compare unrelated workspace files', () => {
    expect(
      latestVisualComparison(
        [inspection('first', 'page.html', 'Page')],
        [inspection('second', 'logo.png', 'Logo')]
      )
    ).toBeNull()
  })

  it('ignores failed and non-inspection image previews', () => {
    const failed = inspection('failed', 'page.html', 'Failed')
    failed.status = 'error'
    const attached = inspection('attached', 'page.html', 'Attached')
    attached.name = 'show_image'

    expect(
      latestVisualComparison([inspection('first', 'page.html', 'First')], [failed, attached])
    ).toBeNull()
  })

  it('compares explicitly labelled before and after HTML previews', () => {
    const pair = latestVisualComparison(
      [],
      [
        htmlPreview('before', 'before.html', 'Before — original header'),
        htmlPreview('after', 'index.html', 'After — improved header')
      ]
    )

    expect(pair).toMatchObject({
      kind: 'html',
      afterCallId: 'after',
      before: { path: 'before.html' },
      after: { path: 'index.html' }
    })
  })

  it('does not compare unrelated, unlabelled HTML previews', () => {
    expect(
      latestVisualComparison(
        [],
        [htmlPreview('one', 'home.html', 'Home'), htmlPreview('two', 'about.html', 'About')]
      )
    ).toBeNull()
  })
})

describe('visualComparisonsByMessage', () => {
  it('places a cross-turn comparison on the message containing the newer inspection', () => {
    const messages: ChatMessage[] = [
      assistantMessage('message-before', [inspection('before', 'page.html', 'Before')]),
      {
        id: 'request',
        role: 'user',
        content: 'Change the title bar and inspect it again.',
        createdAt: 2
      },
      assistantMessage('message-after', [inspection('after', 'page.html', 'After')])
    ]

    const comparisons = visualComparisonsByMessage(messages)

    expect(comparisons.has('message-before')).toBe(false)
    expect(comparisons.get('message-after')).toMatchObject({
      kind: 'image',
      afterCallId: 'after'
    })
  })
})

function htmlPreview(id: string, path: string, title: string): ToolCall {
  return {
    id,
    name: 'preview_html',
    kind: 'read',
    title: `Preview ${path}`,
    status: 'success',
    preview: {
      kind: 'html',
      title,
      path,
      content: `<h1>${title}</h1>`
    }
  }
}

function assistantMessage(id: string, toolCalls: ToolCall[]): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    createdAt: 1,
    toolCalls
  }
}
