// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AppSettings } from '@shared/settings.types'
import { createDefaultSettings } from '@shared/settings.defaults'
import { fireEvent, render, screen } from '../../../test-utils/dom'

/**
 * The reported defect: with a cloud provider linked in Settings, the sidebar
 * model menu did not offer it. Eleven providers are configurable and this menu
 * hardcoded two sections, Claude and OpenAI, so linking DeepSeek left no way to
 * switch to it from the place you switch models.
 *
 * The footer label was already correct for all eleven, which is what made this
 * easy to miss: the menu named the active provider properly while being unable
 * to select it.
 */

vi.mock('../../../lib/anodex', () => ({
  anodex: { provider: { listModels: vi.fn().mockResolvedValue([]) } }
}))

const loadModel = vi.fn()
const update = vi.fn<(patch: unknown) => Promise<void>>().mockResolvedValue(undefined)
const openSettings = vi.fn()

let settings: AppSettings

vi.mock('../../../stores/modelStore', () => ({
  useModelStore: (select: (state: unknown) => unknown) =>
    select({
      engine: { status: 'idle', model: null },
      models: [],
      pendingPath: null,
      loadModel
    })
}))

vi.mock('../../../stores/providerUsageStore', () => ({
  useProviderUsageStore: (select: (state: unknown) => unknown) => select({ snapshots: {} })
}))

vi.mock('../../../stores/settingsStore', () => ({
  useSettingsStore: (select: (state: unknown) => unknown) => select({ settings, update })
}))

vi.mock('../../../stores/uiStore', () => ({
  useUiStore: (select: (state: unknown) => unknown) => select({ openSettings })
}))

const { ModelStatusMenu } = await import('../ModelStatusMenu')

function openMenu(): void {
  render(<ModelStatusMenu />)
  // The trigger takes its accessible name from the active model label, which
  // varies per test, so it is addressed by position: it is the only control
  // rendered before the dropdown opens.
  fireEvent.click(screen.getAllByRole('button')[0])
}

beforeEach(() => {
  vi.clearAllMocks()
  settings = createDefaultSettings('/models')
})

describe('the sidebar model menu', () => {
  it('offers a linked provider that is not Claude or OpenAI', () => {
    settings.provider.active = 'deepseek'
    settings.provider.deepseek.apiKey = 'sk-test'
    settings.provider.deepseek.model = 'deepseek-chat'

    openMenu()

    expect(screen.getByText('DeepSeek')).toBeTruthy()
    // Its catalog, not just its name: the section has to be selectable.
    expect(screen.getAllByRole('button').length).toBeGreaterThan(2)
  })

  it('switches provider and model together when one is picked', () => {
    settings.provider.active = 'local'
    settings.provider.mistral.apiKey = 'key'

    openMenu()
    const option = screen
      .getAllByRole('button')
      .find((node) => /mistral/i.test(node.textContent ?? ''))
    expect(option).toBeTruthy()
    fireEvent.click(option as HTMLElement)

    const patch = update.mock.calls[0]?.[0] as {
      provider?: { active?: string; mistral?: { model?: string } }
    }
    expect(patch.provider?.active).toBe('mistral')
    expect(patch.provider?.mistral?.model).toBeTruthy()
  })

  it('leaves out providers with no key, so the menu lists what is usable', () => {
    settings.provider.active = 'local'
    settings.provider.groq.apiKey = 'key'

    openMenu()

    expect(screen.getByText('Groq')).toBeTruthy()
    expect(screen.queryByText('Google AI')).toBeNull()
    expect(screen.queryByText('Claude')).toBeNull()
  })

  /**
   * Azure's "model" is the deployment name the user typed in Settings, so it
   * has no catalog to choose from. Selecting it must switch provider without
   * rewriting that field to something from a list that does not exist.
   */
  it('treats Azure as a single configured deployment', () => {
    settings.provider.active = 'local'
    settings.provider.azure.apiKey = 'key'
    settings.provider.azure.resourceName = 'contoso'
    settings.provider.azure.deploymentName = 'gpt-4o-prod'

    openMenu()
    const option = screen.getAllByRole('button').find((node) => node.textContent === 'gpt-4o-prod')
    expect(option).toBeTruthy()
    fireEvent.click(option as HTMLElement)

    expect(update).toHaveBeenCalledWith({ provider: { active: 'azure' } })
  })

  it('puts the active provider first so it is visible without scrolling', () => {
    settings.provider.active = 'qwen'
    settings.provider.qwen.apiKey = 'key'
    settings.provider.anthropic.apiKey = 'key'

    openMenu()

    const labels = screen.getAllByText(/^(Qwen|Claude)$/).map((node) => node.textContent)
    expect(labels[0]).toBe('Qwen')
  })
})
