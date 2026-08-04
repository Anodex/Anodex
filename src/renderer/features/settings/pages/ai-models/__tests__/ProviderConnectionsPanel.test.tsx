import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/settings.types'
import { createDefaultSettings } from '@shared/settings.defaults'

// `ApiKeyField` reaches the preload bridge through `lib/anodex`, which reads
// `window` at module load. Nothing here renders past the first paint, so the
// verify call is never made — the mock only has to exist.
vi.mock('../../../../../lib/anodex', () => ({
  anodex: { provider: { verifyKey: vi.fn() } }
}))

const { ProviderConnectionsPanel } = await import('../ProviderConnectionsPanel')

function settingsWith(patch: (base: AppSettings) => void): AppSettings {
  const settings = createDefaultSettings('/models')
  patch(settings)
  return settings
}

function render(settings: AppSettings): string {
  return renderToStaticMarkup(
    <ProviderConnectionsPanel
      settings={settings}
      activeModelName="test-model"
      onUpdate={vi.fn()}
      onOpenModels={vi.fn()}
    />
  )
}

/**
 * The "Active provider" card's badge, which sits just after its identity
 * block. Tags are stripped first: the badge's own CSS class is
 * `providerReady`, so matching against raw markup finds the word "Ready"
 * inside the class attribute no matter what the badge actually says.
 */
function activeBadge(html: string): string {
  const text = html.slice(html.indexOf('Active provider')).replace(/<[^>]*>/g, ' ')
  const match = text.match(/\b(Not connected|Ready)\b/)
  return match?.[1] ?? '(no badge found)'
}

describe('ProviderConnectionsPanel', () => {
  it('calls the local provider ready', () => {
    expect(activeBadge(render(settingsWith(() => {})))).toBe('Ready')
  })

  it('calls a cloud provider with a key ready', () => {
    const html = render(
      settingsWith((s) => {
        s.provider.active = 'anthropic'
        s.provider.anthropic.apiKey = 'sk-ant-test'
      })
    )
    expect(activeBadge(html)).toBe('Ready')
  })

  // The badge used to be the literal word "Ready" — a claim it never checked.
  // Clearing the active provider's key is doable from this same panel without
  // changing which provider is active, and left the card contradicting the
  // composer, which disables itself and asks for a key.
  it('does not claim the active provider is ready when its key is missing', () => {
    const html = render(
      settingsWith((s) => {
        s.provider.active = 'anthropic'
        s.provider.anthropic.apiKey = ''
      })
    )
    expect(activeBadge(html)).toBe('Not connected')
  })

  it('treats a whitespace-only key as missing', () => {
    const html = render(
      settingsWith((s) => {
        s.provider.active = 'openai'
        s.provider.openai.apiKey = '   '
      })
    )
    expect(activeBadge(html)).toBe('Not connected')
  })

  // Azure needs three fields, and `providerConnected` is the only place that
  // knows it — a key alone is not a working connection.
  it('does not call Azure ready with a key but no deployment', () => {
    const html = render(
      settingsWith((s) => {
        s.provider.active = 'azure'
        s.provider.azure.apiKey = 'azure-key'
        s.provider.azure.resourceName = 'my-resource'
        s.provider.azure.deploymentName = ''
      })
    )
    expect(activeBadge(html)).toBe('Not connected')
  })

  it('calls Azure ready once all three fields are set', () => {
    const html = render(
      settingsWith((s) => {
        s.provider.active = 'azure'
        s.provider.azure.apiKey = 'azure-key'
        s.provider.azure.resourceName = 'my-resource'
        s.provider.azure.deploymentName = 'my-deployment'
      })
    )
    expect(activeBadge(html)).toBe('Ready')
  })

  /**
   * The eight simple cloud providers share one conditional slot, so React
   * reconciles their fields as the same subtree and preserves component state
   * across a switch unless the slot is keyed. The key is what stops one
   * provider's daily-cap text and API-key verification state being shown under
   * the next one's name. Asserted on the rendered structure because this
   * project's renderer tests have no DOM — `renderToStaticMarkup` does one
   * render, so the state reuse itself cannot be driven here.
   */
  it('renders each simple cloud provider through the same single slot', () => {
    const fieldsBlocks = (id: 'google' | 'xai'): number => {
      const settings = settingsWith((s) => {
        s.provider.active = id
      })
      // Both render one provider-fields block, which is why they collide.
      return render(settings).split('providerFields').length - 1
    }
    expect(fieldsBlocks('google')).toBeGreaterThan(0)
    expect(fieldsBlocks('google')).toBe(fieldsBlocks('xai'))
  })
})
