import type { PermissionMode } from '@shared/settings.types'
import type { ToolCatalogEntry } from '@shared/tools.types'

export type ToolHealthTone = 'ready' | 'attention' | 'blocked' | 'muted'

export interface ToolHealthInput {
  catalog: ToolCatalogEntry[]
  toolsEnabled: boolean
  workspaceRoot: string | null
  permissionMode: PermissionMode
  webSearchProvider: string
}

export interface ToolHealthItem {
  label: string
  value: string
  tone: ToolHealthTone
}

export function filterToolCatalog(catalog: ToolCatalogEntry[], query: string): ToolCatalogEntry[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return catalog

  return catalog.filter((tool) =>
    [
      tool.name,
      tool.kind,
      tool.description,
      tool.requiresProject ? 'project workspace required' : 'general chat'
    ]
      .join(' ')
      .toLowerCase()
      .includes(normalized)
  )
}

export function buildToolHealthSummary(input: ToolHealthInput): ToolHealthItem[] {
  const projectToolCount = input.catalog.filter((tool) => tool.requiresProject).length

  return [
    {
      label: 'Tools',
      value: input.toolsEnabled ? `${input.catalog.length} available` : 'Disabled',
      tone: input.toolsEnabled ? 'ready' : 'blocked'
    },
    {
      label: 'Project tools',
      value: input.workspaceRoot
        ? `${projectToolCount} ready`
        : `${projectToolCount} waiting for project`,
      tone: input.workspaceRoot ? 'ready' : 'blocked'
    },
    {
      label: 'Web search',
      value: input.webSearchProvider === 'none' ? 'Disabled' : input.webSearchProvider,
      tone: input.webSearchProvider === 'none' ? 'muted' : 'ready'
    },
    {
      label: 'Approvals',
      value: describePermissionMode(input.permissionMode),
      tone: input.permissionMode === 'ask' ? 'attention' : 'ready'
    }
  ]
}

function describePermissionMode(mode: PermissionMode): string {
  switch (mode) {
    case 'ask':
      return 'Ask every time'
    case 'full':
      return 'Full access'
    case 'untethered':
      return 'Untethered'
  }
}
