import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ChatImagePreview } from '../ChatImagePreview'
import { ToolCallCard } from '../ToolCallCard'
import { TurnRecap } from '../TurnRecap'
import { messageBlocks } from '../taskPhase'

const anodexMocks = vi.hoisted(() => ({
  readVisualPreview: vi.fn()
}))

vi.mock('../../../lib/anodex', () => ({
  anodex: {
    conversations: {
      readVisualPreview: anodexMocks.readVisualPreview
    }
  }
}))

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { settings: null }) => unknown) =>
    selector({ settings: null })
}))

describe('ChatImagePreview', () => {
  it('renders the inspected image and workspace path', () => {
    const html = renderToStaticMarkup(
      <ChatImagePreview
        preview={{
          kind: 'image',
          title: 'Rendered page.html',
          path: 'page.html',
          dataUrl: 'data:image/png;base64,cGl4ZWxz',
          mimeType: 'image/png'
        }}
      />
    )

    expect(html).toContain('Rendered page.html')
    expect(html).toContain('data:image/png;base64,cGl4ZWxz')
    expect(html).toContain('Visual inspection of page.html')
  })

  it('shows a successful inspected screenshot without requiring expansion', () => {
    const html = renderToStaticMarkup(
      <ToolCallCard
        call={{
          id: 'tool-1',
          name: 'inspect_visual',
          kind: 'read',
          title: 'Inspect page.html',
          status: 'success',
          preview: {
            kind: 'image',
            title: 'Rendered page.html',
            path: 'page.html',
            dataUrl: 'data:image/png;base64,cGl4ZWxz',
            mimeType: 'image/png'
          }
        }}
      />
    )

    expect(html).toContain('data:image/png;base64,cGl4ZWxz')
  })

  it('keeps live image bytes in the message render pipeline', () => {
    const call = {
      id: 'tool-1',
      name: 'inspect_visual',
      kind: 'read' as const,
      title: 'Inspect page.html',
      status: 'success' as const,
      preview: {
        kind: 'image' as const,
        title: 'Rendered page.html',
        path: 'page.html',
        dataUrl: 'data:image/png;base64,cGl4ZWxz',
        mimeType: 'image/png'
      }
    }
    const blocks = messageBlocks({
      id: 'message-1',
      role: 'assistant',
      content: 'Done.',
      createdAt: 1,
      toolCalls: [call],
      blocks: [{ type: 'tool', call }]
    })

    expect(blocks[0]).toMatchObject({
      type: 'tool',
      call: {
        preview: {
          dataUrl: 'data:image/png;base64,cGl4ZWxz'
        }
      }
    })
  })

  it('shows a loading state for a persisted screenshot reference', () => {
    const html = renderToStaticMarkup(
      <ChatImagePreview
        preview={{
          kind: 'image',
          title: 'Rendered page.html',
          path: 'page.html',
          mimeType: 'image/png',
          asset: {
            conversationId: 'conversation-1',
            id: 'message-1-preview.png'
          }
        }}
      />
    )

    expect(html).toContain('Loading screenshot')
  })

  it('keeps the finished turn recap open when it contains an inspected image', () => {
    const call = {
      id: 'tool-1',
      name: 'inspect_visual',
      kind: 'read' as const,
      title: 'Inspect page.html',
      status: 'success' as const,
      preview: {
        kind: 'image' as const,
        title: 'Rendered page.html',
        path: 'page.html',
        dataUrl: 'data:image/png;base64,cGl4ZWxz',
        mimeType: 'image/png'
      }
    }
    const html = renderToStaticMarkup(
      <TurnRecap
        segments={[{ type: 'toolGroup', phase: 'inspecting', calls: [call] }]}
        streaming={false}
        startedAt={1}
        finalDurationMs={1000}
      />
    )

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('data:image/png;base64,cGl4ZWxz')
  })
})
