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
    expect(html).toContain('Open Rendered page.html fullscreen')
  })

  it('labels an assistant-shown image without implying the model inspected it', () => {
    const html = renderToStaticMarkup(
      <ChatImagePreview
        preview={{
          kind: 'image',
          source: 'assistant',
          title: 'result.png',
          path: 'result.png',
          dataUrl: 'data:image/png;base64,cGl4ZWxz',
          mimeType: 'image/png'
        }}
      />
    )

    expect(html).toContain('Assistant image of result.png')
    expect(html).toContain('Open result.png fullscreen')
  })

  it('renders every section of a multi-section visual inspection', () => {
    const html = renderToStaticMarkup(
      <ChatImagePreview
        preview={{
          kind: 'image',
          title: 'Rendered page.html (4 sections)',
          path: 'page.html',
          dataUrl: 'data:image/png;base64,dG9w',
          mimeType: 'image/png',
          sections: [
            {
              title: 'Section 1 of 4',
              dataUrl: 'data:image/png;base64,dG9w',
              mimeType: 'image/png'
            },
            {
              title: 'Section 2 of 4',
              dataUrl: 'data:image/png;base64,bWlk',
              mimeType: 'image/png'
            },
            {
              title: 'Section 3 of 4',
              dataUrl: 'data:image/png;base64,bG93',
              mimeType: 'image/png'
            },
            {
              title: 'Section 4 of 4',
              dataUrl: 'data:image/png;base64,Ym90dG9t',
              mimeType: 'image/png'
            }
          ]
        }}
      />
    )

    expect(html).toContain('Section 1 of 4')
    expect(html).toContain('Section 4 of 4')
    expect(html).toContain('data:image/png;base64,Ym90dG9t')
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

  it('offers retry and re-inspection when preview pixels are unavailable', () => {
    const html = renderToStaticMarkup(
      <ChatImagePreview
        preview={{
          kind: 'image',
          source: 'inspection',
          title: 'Rendered page.html',
          path: 'page.html',
          mimeType: 'image/png'
        }}
      />
    )

    expect(html).toContain('This visual preview is no longer available.')
    expect(html).toContain('aria-label="Retry Rendered page.html"')
    expect(html).toContain('aria-label="Re-inspect page.html"')
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

  it('offers a comparison for repeated inspections of the same path', () => {
    const before = {
      id: 'tool-before',
      name: 'inspect_visual',
      kind: 'read' as const,
      title: 'First render',
      status: 'success' as const,
      preview: {
        kind: 'image' as const,
        title: 'First render',
        path: 'page.html',
        dataUrl: 'data:image/png;base64,YmVmb3Jl',
        mimeType: 'image/png'
      }
    }
    const after = {
      ...before,
      id: 'tool-after',
      title: 'Second render',
      preview: {
        ...before.preview,
        title: 'Second render',
        dataUrl: 'data:image/png;base64,YWZ0ZXI='
      }
    }
    const html = renderToStaticMarkup(
      <TurnRecap
        segments={[{ type: 'toolGroup', phase: 'inspecting', calls: [before, after] }]}
        streaming={false}
        startedAt={1}
        finalDurationMs={1000}
      />
    )

    expect(html).toContain('Compare latest inspections')
    expect(html).toContain('alt="Before: page.html"')
    expect(html).toContain('alt="After: page.html"')
  })
})
