import { describe, expect, it } from 'vitest'
import { OPENAI_MODELS } from '@shared/openaiModels'

/**
 * The merge rule, tested directly. `useLiveCloudModels` is a hook, but the part
 * worth pinning is what it decides, not how React runs it.
 */
function merge(
  live: string[] | null,
  catalog: readonly { id: string; label: string }[]
): { label: string; value: string }[] {
  if (live === null) return catalog.map((m) => ({ label: m.label, value: m.id }))
  const labelled = new Map(catalog.map((m) => [m.id, m.label]))
  return live.map((id) => ({ label: labelled.get(id) ?? id, value: id }))
}

describe('cloud model list', () => {
  /** The bug: a curated id outlived the model, and picking it 404'd the run. */
  it('drops a curated model the account can no longer reach', () => {
    const live = ['gpt-5.6', 'gpt-5.6-terra']
    const values = merge(live, OPENAI_MODELS).map((o) => o.value)

    expect(values).not.toContain('gpt-5.1-codex')
    expect(values).toEqual(live)
  })

  it('offers a live model the catalogue has never heard of', () => {
    const options = merge(['gpt-6-preview'], OPENAI_MODELS)

    expect(options).toEqual([{ label: 'gpt-6-preview', value: 'gpt-6-preview' }])
  })

  it('keeps the curated label when the model is both live and known', () => {
    const options = merge(['gpt-5.6'], OPENAI_MODELS)

    expect(options[0]).toEqual({ label: 'GPT-5.6', value: 'gpt-5.6' })
  })

  /** No key, offline, or a provider that cannot list: never show an empty picker. */
  it('falls back to the whole catalogue when discovery finds nothing', () => {
    const options = merge(null, OPENAI_MODELS)

    expect(options).toHaveLength(OPENAI_MODELS.length)
    expect(options.map((o) => o.value)).toContain('gpt-5.6')
  })
})
