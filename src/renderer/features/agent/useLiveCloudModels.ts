import { useEffect, useState } from 'react'
import { anodex } from '../../lib/anodex'
import type { OpenAiModelOption } from '@shared/openaiModels'

/**
 * The models a cloud picker should offer: what the key can actually reach,
 * labelled from the curated catalogue wherever Anodex knows the model.
 *
 * A hardcoded catalogue goes stale. `gpt-5.1-codex` outlived the model itself,
 * so a run chose it and died on "404 Model not found" with nothing in the UI
 * hinting which ids would have worked. Two accounts can also see different
 * models, so no fixed list is right for everyone.
 *
 * Discovery decides *what is offered*; the catalogue still supplies labels and,
 * through `cloudContextWindowTokens`, the real context window. A live model the
 * catalogue does not know is still offered — it just runs on the conservative
 * `DEFAULT_CLOUD_CONTEXT_WINDOW_TOKENS` rather than a guessed one, because
 * `models.list` does not report context length and guessing high would
 * silently truncate conversations.
 *
 * Falls back to the full catalogue whenever discovery returns nothing — no key,
 * offline, or a provider that cannot list — so the picker never goes empty.
 */
export function useLiveCloudModels(
  provider: string,
  catalog: readonly OpenAiModelOption[]
): { label: string; value: string }[] {
  const [live, setLive] = useState<string[] | null>(null)

  useEffect(() => {
    if (provider !== 'openai') {
      setLive(null)
      return undefined
    }
    // The preload bridge is only rebuilt when the app restarts, so a renderer
    // hot-reloaded onto an older preload does not have this method yet. A
    // synchronous "not a function" throw is caught here for the same reason an
    // empty result falls back: the curated list still works, and throwing took
    // out the whole editor rather than one dropdown.
    let cancelled = false
    try {
      void Promise.resolve(anodex.provider.listModels('openai'))
        .then((ids) => {
          if (!cancelled) setLive(ids.length > 0 ? ids : null)
        })
        .catch(() => {
          if (!cancelled) setLive(null)
        })
    } catch {
      setLive(null)
    }
    return () => {
      cancelled = true
    }
  }, [provider])

  if (live === null) return catalog.map((m) => ({ label: m.label, value: m.id }))
  const labelled = new Map(catalog.map((m) => [m.id, m.label]))
  return live.map((id) => ({ label: labelled.get(id) ?? id, value: id }))
}
