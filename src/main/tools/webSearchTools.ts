import type { ToolFactory } from './types'
import { recordToolArtifact } from './types'
import { createSearchProvider } from './search'
import { runGuardedTool } from './helpers'

/**
 * web_search — turn a query into a list of web search results.
 *
 * The backend provider and API key are configured in Settings. When the
 * provider is set to "none", the tool is not registered at all.
 */
export const webSearchTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Search the web for a query and return a list of result titles, URLs, and snippets. The provider is chosen by the user in Settings.',
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        numResults: {
          type: 'number',
          description: 'Optional number of results (overrides the default for this call).'
        }
      },
      required: ['query']
    } as const,
    handler: (args: { query: string; numResults?: number }) =>
      runGuardedTool(ctx, {
        name: 'web_search',
        kind: 'web',
        title: `Search "${truncate(args.query, 40)}"`,
        args,
        confirmDetail: `Search the web for: ${args.query}`,
        risk: 'sensitive',
        forceConfirm: ctx.webSearch.requireApproval,
        async run() {
          const provider = createSearchProvider(ctx.webSearch)
          if (!provider) {
            return {
              modelResult:
                'Web search is disabled. Enable it in Settings by choosing a search provider.',
              detail: 'disabled'
            }
          }

          // Counted before the search runs, so a provider error or an empty
          // result set still records that the model tried to look. An answer
          // built after a failed search is exactly the case the reader needs
          // flagged, and it leaves no sources behind to infer it from.
          ctx.webSources?.recordAttempt()

          const resultCount =
            args.numResults !== undefined
              ? Math.max(1, Math.min(Math.floor(args.numResults), 10))
              : ctx.webSearch.resultCount

          const results = await provider.search(args.query, resultCount, { signal: ctx.signal })
          const artifact = recordToolArtifact(ctx, {
            kind: 'web-search',
            query: args.query,
            provider: ctx.webSearch.provider,
            results: results.map((result, index) => ({
              title: result.title,
              url: result.url,
              snippet: result.snippet,
              rank: index + 1
            }))
          })
          if (results.length === 0) {
            return {
              modelResult: `Search artifact: ${artifact.id}\nNo web results found.`,
              detail: '0 results'
            }
          }

          // Each result carries the id the model should cite if it uses that
          // result. The id trails the snippet rather than sitting next to the
          // URL so the leading `N. **title** — url` shape every other reader
          // of this text already expects stays byte-identical.
          const formatted = results
            .map((result, index) => {
              const line = `${index + 1}. **${result.title}** — ${result.url}\n${result.snippet}`
              const id = ctx.webSources?.register({
                title: result.title,
                url: result.url,
                snippet: result.snippet,
                verified: false
              })
              return id ? `${line}\nCite as [${id}]` : line
            })
            .join('\n\n')

          // No truncation here: `runGuardedTool`'s own MAX_MODEL_RESULT_CHARS
          // cap already applies uniformly to every guarded tool's result
          // (same reasoning as the read_file/run_command/git_diff fixes —
          // this tool's own, larger, redundant cap never actually changed
          // the truncation point, it just produced a misleading note when
          // both fired).
          return {
            modelResult: `Search artifact: ${artifact.id}\n${formatted}`,
            detail: `${results.length} results`
          }
        }
      })
  })

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
