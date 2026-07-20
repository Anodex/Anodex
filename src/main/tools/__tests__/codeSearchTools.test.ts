import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { CodeSearchResult } from '@shared/codeIndex.types'
import type { WorkspaceToolContext } from '../types'
import { createMockContext, createMockDefine } from './test-helpers'
import { searchCodeTool } from '../codeSearchTools'

const mocks = vi.hoisted(() => ({
  isAvailable: vi.fn(() => true),
  search: vi.fn<(projectId: string, query: string, topK: number) => Promise<CodeSearchResult[]>>()
}))

vi.mock('../../codeIndex/CodeIndexer', () => ({
  codeIndexer: { search: mocks.search }
}))

vi.mock('../../codeIndex/EmbeddingService', () => ({
  embeddingService: { isAvailable: mocks.isAvailable }
}))

type SearchHandler = (args: { query: string; limit?: number }) => Promise<string>

function context(projectId: string | null = 'proj-1'): WorkspaceToolContext {
  return { ...createMockContext('/tmp/workspace'), projectId }
}

describe('search_code', () => {
  beforeEach(() => {
    mocks.isAvailable.mockReset().mockReturnValue(true)
    mocks.search.mockReset()
  })

  it('reports that an open project is required', async () => {
    const tool = searchCodeTool(createMockDefine(), context(null)) as unknown as {
      handler: SearchHandler
    }

    const result = await tool.handler({ query: 'session check' })
    expect(result).toContain('needs an open project')
    expect(mocks.search).not.toHaveBeenCalled()
  })

  it('reports when the embedding model is unavailable', async () => {
    mocks.isAvailable.mockReturnValue(false)
    const tool = searchCodeTool(createMockDefine(), context()) as unknown as {
      handler: SearchHandler
    }

    const result = await tool.handler({ query: 'session check' })
    expect(result).toContain('unavailable')
    expect(mocks.search).not.toHaveBeenCalled()
  })

  it('reports zero results distinctly from an error', async () => {
    mocks.search.mockResolvedValue([])
    const tool = searchCodeTool(createMockDefine(), context()) as unknown as {
      handler: SearchHandler
    }

    const result = await tool.handler({ query: 'nonexistent thing' })
    expect(result).toContain('No results')
  })

  it('formats matches with file path, line range, and score', async () => {
    mocks.search.mockResolvedValue([
      {
        filePath: 'src/auth.ts',
        startLine: 10,
        endLine: 20,
        text: 'function verifySession() {}',
        score: 0.87
      }
    ])
    const tool = searchCodeTool(createMockDefine(), context()) as unknown as {
      handler: SearchHandler
    }

    const result = await tool.handler({ query: 'session check' })
    expect(result).toContain('src/auth.ts:10-20')
    expect(result).toContain('0.87')
    expect(result).toContain('verifySession')
  })

  it('clamps the requested limit to the maximum', async () => {
    mocks.search.mockResolvedValue([])
    const tool = searchCodeTool(createMockDefine(), context()) as unknown as {
      handler: SearchHandler
    }

    await tool.handler({ query: 'anything', limit: 999 })
    expect(mocks.search).toHaveBeenCalledWith('proj-1', 'anything', 20)
  })

  it('floors the requested limit at one', async () => {
    mocks.search.mockResolvedValue([])
    const tool = searchCodeTool(createMockDefine(), context()) as unknown as {
      handler: SearchHandler
    }

    await tool.handler({ query: 'anything', limit: 0 })
    expect(mocks.search).toHaveBeenCalledWith('proj-1', 'anything', 1)
  })
})
