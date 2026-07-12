import { describe, expect, it } from 'vitest'
import type { ToolCatalogEntry } from '@shared/tools.types'
import { buildToolHealthSummary, filterToolCatalog } from '../toolHealth'

const CATALOG: ToolCatalogEntry[] = [
  { name: 'read_file', kind: 'read', description: 'Read files.', requiresProject: true },
  { name: 'write_file', kind: 'write', description: 'Write files.', requiresProject: true },
  { name: 'web_search', kind: 'web', description: 'Search web.' },
  { name: 'load_skill', kind: 'read', description: 'Load skill.' }
]

describe('buildToolHealthSummary', () => {
  it('summarizes enabled tools with a project workspace', () => {
    expect(
      buildToolHealthSummary({
        catalog: CATALOG,
        toolsEnabled: true,
        workspaceRoot: 'C:/repo',
        permissionMode: 'ask',
        webSearchProvider: 'brave'
      })
    ).toEqual([
      { label: 'Tools', value: '4 available', tone: 'ready' },
      { label: 'Project tools', value: '2 ready', tone: 'ready' },
      { label: 'Web search', value: 'brave', tone: 'ready' },
      { label: 'Approvals', value: 'Ask every time', tone: 'attention' }
    ])
  })

  it('calls out disabled tools and missing project workspace', () => {
    expect(
      buildToolHealthSummary({
        catalog: CATALOG,
        toolsEnabled: false,
        workspaceRoot: null,
        permissionMode: 'full',
        webSearchProvider: 'none'
      })
    ).toEqual([
      { label: 'Tools', value: 'Disabled', tone: 'blocked' },
      { label: 'Project tools', value: '2 waiting for project', tone: 'blocked' },
      { label: 'Web search', value: 'Disabled', tone: 'muted' },
      { label: 'Approvals', value: 'Full access', tone: 'ready' }
    ])
  })
})

describe('filterToolCatalog', () => {
  it('matches by name, kind, description, and project requirement', () => {
    expect(filterToolCatalog(CATALOG, 'write').map((tool) => tool.name)).toEqual(['write_file'])
    expect(filterToolCatalog(CATALOG, 'web').map((tool) => tool.name)).toEqual(['web_search'])
    expect(filterToolCatalog(CATALOG, 'project').map((tool) => tool.name)).toEqual([
      'read_file',
      'write_file'
    ])
  })

  it('returns the full catalog for an empty query', () => {
    expect(filterToolCatalog(CATALOG, '').map((tool) => tool.name)).toEqual(
      CATALOG.map((tool) => tool.name)
    )
  })
})
