import type { WebSearchSettings, WebSearchTestConfig } from '@shared/settings.types'
import { createSearchProvider } from './index'

/** Something every engine has results for, so an empty answer means a broken one. */
const TEST_QUERY = 'open source software'

/**
 * Run one real search with settings that have not been saved yet, and say how
 * many results came back.
 *
 * A key pasted into Settings used to be saved as typed and found to be wrong
 * only when a chat or a Critical Thinking run reached for search, minutes into
 * something else. The setup tries it first, so a rejected key or an unreachable
 * SearXNG is reported where it was entered, by the provider's own error.
 */
export async function testSearchProvider(
  config: WebSearchTestConfig,
  create: (
    settings: WebSearchSettings
  ) => ReturnType<typeof createSearchProvider> = createSearchProvider
): Promise<number> {
  const provider = create({
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    searchEngineId: config.searchEngineId,
    resultCount: 3,
    requireApproval: false
  })
  if (!provider) throw new Error('Choose a search service first.')
  try {
    const results = await provider.search(TEST_QUERY, 3)
    return results.length
  } catch (error) {
    throw unreachable(error) ? new Error(unreachableMessage(config)) : error
  }
}

/**
 * Node reports a refused connection, an unknown host and a dropped network all
 * as a bare "fetch failed", which tells the person typing an address nothing
 * about what to fix.
 */
function unreachable(error: unknown): boolean {
  return error instanceof TypeError && /fetch failed/i.test(error.message)
}

function unreachableMessage(config: WebSearchTestConfig): string {
  if (config.provider === 'searxng') {
    const address = config.baseUrl.trim() || 'http://localhost:8080'
    return `Nothing answered at ${address}. Check that SearXNG is running there and the address is right.`
  }
  return 'Could not reach the search service. Check this computer is online, then try again.'
}
