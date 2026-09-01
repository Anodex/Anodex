import { describe, expect, it } from 'vitest'
import { createDefaultSettings } from '../settings.defaults'
import { cloudContextWindowTokens } from '../contextBudget'
import {
  AGENT_RUN_PROVIDER_IDS,
  agentRunModelCatalog,
  agentRunProviderVendor,
  configuredProviderModel,
  isProviderConfigured
} from '../agentRunProviders'

/**
 * Every provider, wired the same way everywhere.
 *
 * Anodex has grown twelve providers, and each was added by editing the places
 * its author happened to think of. Six separate defects came from that: agent
 * runs offering three of them, two run-list labels naming the wrong vendor, the
 * chat context meter reporting the local window, the agent turn budget sized
 * from the local model, and the composer's readiness gate blocking chat on a
 * local model nine providers do not use.
 *
 * Each was found one at a time, by hand. These tests are the cheaper version:
 * they walk the provider union itself, so a thirteenth provider wired into chat
 * and forgotten elsewhere fails here rather than in a user's run.
 */

/** A pristine install, which is what "correctly set up" has to mean here. */
const defaultSettings = createDefaultSettings('C:/models')

const providers = AGENT_RUN_PROVIDER_IDS
const cloudProviders = providers.filter((id) => id !== 'local')

/** Providers that intentionally have no bundled model catalog. */
const NO_CATALOG = new Set(['local', 'azure'])

describe('provider wiring', () => {
  it('covers every provider the settings type allows', () => {
    // `defaultSettings` is built against `ProviderSettings`, so its provider
    // keys are the authoritative list of what the app claims to support.
    const settingsKeys = Object.keys(defaultSettings.provider).filter((key) => key !== 'active')
    expect([...providers].sort()).toEqual(settingsKeys.sort())
  })

  it('gives every provider a default settings block', () => {
    for (const id of providers) {
      expect(defaultSettings.provider[id], `${id} has no default settings`).toBeDefined()
    }
  })

  it('gives every provider a vendor name that is not just its id', () => {
    for (const id of providers) {
      const vendor = agentRunProviderVendor(id)
      expect(vendor, `${id} has no vendor name`).toBeTruthy()
      // A row reading "deepseek" rather than "DeepSeek" means the registry was
      // missed and the raw id fell through.
      expect(vendor, `${id} fell through to its raw id`).not.toBe(id)
    }
  })

  it('starts with no cloud provider configured', () => {
    // A default install has no keys, so nothing but local may report usable.
    for (const id of cloudProviders) {
      expect(isProviderConfigured(defaultSettings.provider, id), `${id} usable by default`).toBe(
        false
      )
    }
    expect(isProviderConfigured(defaultSettings.provider, 'local')).toBe(true)
  })

  it('gives every cloud provider a non-empty model catalog, or none by design', () => {
    for (const id of cloudProviders) {
      const catalog = agentRunModelCatalog(id)
      if (NO_CATALOG.has(id)) {
        expect(catalog, `${id} should have no catalog`).toBeNull()
        continue
      }
      expect(catalog, `${id} has no catalog`).not.toBeNull()
      expect(catalog?.length, `${id} catalog is empty`).toBeGreaterThan(0)
    }
  })

  it('names a default model that exists in its own catalog', () => {
    // A default model id absent from the catalog is invisible until a request
    // is rejected by the provider.
    for (const id of cloudProviders) {
      if (NO_CATALOG.has(id)) continue
      const catalog = agentRunModelCatalog(id) ?? []
      const configured = configuredProviderModel(defaultSettings.provider, id)
      expect(
        catalog.some((model) => model.id === configured),
        `${id} default model "${configured}" is not in its catalog`
      ).toBe(true)
    }
  })

  it('declares a context window on every catalogued model', () => {
    // Checked on the catalog entry, not on the resolved value: a model whose
    // real window happens to equal `DEFAULT_CLOUD_CONTEXT_WINDOW_TOKENS` is
    // indistinguishable from one that declared nothing and fell back to it.
    for (const id of cloudProviders) {
      if (NO_CATALOG.has(id)) continue
      for (const model of agentRunModelCatalog(id) ?? []) {
        expect(
          model.contextWindowTokens,
          `${id}/${model.id} declares no context window`
        ).toBeGreaterThan(0)
        expect(cloudContextWindowTokens(id, model.id)).toBe(model.contextWindowTokens)
      }
    }
  })

  it('treats a keyed cloud provider as configured', () => {
    for (const id of cloudProviders) {
      if (id === 'azure') continue
      const settings = {
        ...defaultSettings.provider,
        [id]: { ...defaultSettings.provider[id], apiKey: 'sk-test' }
      }
      expect(isProviderConfigured(settings, id), `${id} not usable with a key`).toBe(true)
    }
  })
})
