// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/settings.types'
import { createDefaultSettings } from '@shared/settings.defaults'
import { fireEvent, render, screen } from '../../../../../test-utils/dom'

/**
 * Closes the gap round two §12 shipped with.
 *
 * That review found the eight "simple" cloud providers sharing one conditional
 * slot, so React reconciled their fields as the same subtree and carried
 * component state across a provider switch. The fix — keying the block — could
 * not be tested at the time: renderer tests ran with no DOM, and
 * `renderToStaticMarkup` performs a single render with no state and no
 * re-render, which is precisely what the defect lives in.
 *
 * These are the first tests in the project to use a real document. Everything
 * that can be proven without one still is, in the sibling file.
 */

vi.mock('../../../../../lib/anodex', () => ({
  anodex: { provider: { verifyKey: vi.fn().mockResolvedValue({ ok: true, value: undefined }) } }
}))

const { ProviderConnectionsPanel } = await import('../ProviderConnectionsPanel')

function settingsWith(patch: (base: AppSettings) => void): AppSettings {
  const settings = createDefaultSettings('/models')
  patch(settings)
  return settings
}

function renderPanel(settings: AppSettings): { onUpdate: ReturnType<typeof vi.fn> } {
  const onUpdate = vi.fn().mockResolvedValue(undefined)
  render(
    <ProviderConnectionsPanel
      settings={settings}
      activeModelName="test-model"
      onUpdate={onUpdate}
      onOpenModels={vi.fn()}
    />
  )
  return { onUpdate }
}

/** Click a provider in the catalog list by its display name. */
function selectProvider(name: string): void {
  fireEvent.click(screen.getByText(name))
}

function dailyCapField(): HTMLInputElement {
  return screen.getByPlaceholderText('No cap')
}

describe('switching between the simple cloud providers', () => {
  /**
   * The defect. Google and xAI render through the same conditional slot, so
   * without a key `DailyCapInput` — which seeds its text once, at mount —
   * kept showing the previous provider's cap under the next provider's name.
   */
  it('does not carry a daily cap from one provider into the next', () => {
    renderPanel(
      settingsWith((s) => {
        s.provider.google.dailyTokenCap = 50_000
        s.provider.xai.dailyTokenCap = null
      })
    )

    selectProvider('Google AI')
    expect(dailyCapField().value).toBe('50000')

    selectProvider('xAI')
    expect(dailyCapField().value).toBe('')
  })

  it('shows each provider its own cap, not just an empty field', () => {
    renderPanel(
      settingsWith((s) => {
        s.provider.google.dailyTokenCap = 50_000
        s.provider.deepseek.dailyTokenCap = 900
      })
    )

    selectProvider('Google AI')
    expect(dailyCapField().value).toBe('50000')

    selectProvider('DeepSeek')
    expect(dailyCapField().value).toBe('900')

    // And back again — the first provider's value is still its own.
    selectProvider('Google AI')
    expect(dailyCapField().value).toBe('50000')
  })

  it('writes an edited cap to the provider actually on screen', () => {
    const { onUpdate } = renderPanel(
      settingsWith((s) => {
        s.provider.google.dailyTokenCap = 50_000
      })
    )

    selectProvider('xAI')
    fireEvent.change(dailyCapField(), { target: { value: '1234' } })

    expect(onUpdate).toHaveBeenCalledWith({ provider: { xai: { dailyTokenCap: 1234 } } })
  })

  it('keeps the model dropdown on the selected provider', () => {
    renderPanel(
      settingsWith((s) => {
        s.provider.active = 'local'
      })
    )

    selectProvider('Groq')
    const heading = screen.getByRole('heading', { level: 3 })
    expect(heading.textContent).toBe('Groq')
  })

  // The four providers with their own slots already remounted correctly; this
  // holds that while the keyed block changes underneath them.
  it('still switches cleanly between providers that have their own slots', () => {
    renderPanel(
      settingsWith((s) => {
        s.provider.openai.dailyTokenCap = 7_000
        s.provider.anthropic.dailyTokenCap = 3_000
      })
    )

    selectProvider('OpenAI')
    expect(dailyCapField().value).toBe('7000')

    selectProvider('Anthropic')
    expect(dailyCapField().value).toBe('3000')
  })
})
