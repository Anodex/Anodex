import type { WorkspaceToolFactory } from './types'
import { runReadTool } from './helpers'
import { codeIndexer } from '../codeIndex/CodeIndexer'
import { embeddingService } from '../codeIndex/EmbeddingService'

const DEFAULT_TOP_K = 8
const MAX_TOP_K = 20

/**
 * search_code — semantic (meaning-based) search across the workspace,
 * complementing `search_files`' exact-substring matching. Only registered
 * for a project (see `registry.ts`), since the underlying index is
 * project-scoped, persisted, and kept fresh in the background by
 * `CodeIndexer.ensureFresh()` (called from `workspaceContext.ts`) — this
 * tool only ever reads whatever index already exists, it never indexes
 * on demand.
 */
export const searchCodeTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Search the workspace by meaning, not exact text — finds relevant code even when the query ' +
      'words don\'t literally appear in it (e.g. "where the user session is checked" can find ' +
      '`verifySession()`). Complements search_files, which only matches exact substrings.',
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, described in plain language.' },
        limit: {
          type: 'number',
          description: `Max results to return (default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}).`
        }
      },
      required: ['query']
    } as const,
    handler: (args: { query: string; limit?: number }) =>
      runReadTool(ctx, {
        name: 'search_code',
        kind: 'read',
        title: `Semantic search "${args.query}"`,
        args,
        async run() {
          if (!ctx.projectId) {
            return {
              modelResult: 'Semantic code search needs an open project.',
              detail: 'no project'
            }
          }
          if (!embeddingService.isAvailable()) {
            return {
              modelResult:
                'Semantic code search is unavailable on this install — the embedding model is missing.',
              detail: 'unavailable'
            }
          }

          const topK = Math.min(MAX_TOP_K, Math.max(1, Math.round(args.limit ?? DEFAULT_TOP_K)))
          const results = await codeIndexer.search(ctx.projectId, args.query, topK)
          if (results.length === 0) {
            return {
              modelResult:
                'No results. The project may not be indexed yet (indexing runs in the background ' +
                'and can take a moment on a large codebase) or nothing matched closely enough.',
              detail: '0 results'
            }
          }

          const body = results
            .map(
              (result) =>
                `${result.filePath}:${result.startLine}-${result.endLine} (score ${result.score.toFixed(2)})\n${result.text}`
            )
            .join('\n\n---\n\n')

          return { modelResult: body, detail: `${results.length} result(s)` }
        }
      })
  })
