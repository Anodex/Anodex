import type { PermissionMode } from '@shared/settings.types'
import type { ToolCatalogEntry } from '@shared/tools.types'

export type ToolHealthTone = 'ready' | 'attention' | 'blocked' | 'muted'

export interface ToolHealthInput {
  catalog: ToolCatalogEntry[]
  toolsEnabled: boolean
  disabledToolCount: number
  workspaceRoot: string | null
  permissionMode: PermissionMode
  webSearchProvider: string
}

export interface ToolAvailabilityInput {
  workspaceRoot: string | null
  webSearchProvider: string
  /** Number of linked email accounts, across every provider. */
  emailAccountCount: number
  memoryCrossChatEnabled: boolean
  memoryPersonalEnabled: boolean
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

export function buildToolAvailabilityDetails(input: ToolAvailabilityInput): ToolHealthItem[] {
  const memoryScopes = [
    input.memoryCrossChatEnabled ? 'project' : null,
    input.memoryPersonalEnabled ? 'personal' : null
  ].filter(Boolean)

  return [
    {
      label: 'Project tools',
      value: input.workspaceRoot
        ? 'File, command, git, and project-skill tools are ready.'
        : 'Open a project to enable file and command tools.',
      tone: input.workspaceRoot ? 'ready' : 'blocked'
    },
    {
      label: 'Web search',
      value:
        input.webSearchProvider === 'none'
          ? 'Choose a provider to enable web_search.'
          : `web_search uses ${input.webSearchProvider}.`,
      tone: input.webSearchProvider === 'none' ? 'muted' : 'ready'
    },
    {
      label: 'Email tools',
      value:
        input.emailAccountCount > 0
          ? `Email tools are ready across ${input.emailAccountCount} account${
              input.emailAccountCount === 1 ? '' : 's'
            }.`
          : 'Link an email account to enable email tools.',
      tone: input.emailAccountCount > 0 ? 'ready' : 'muted'
    },
    {
      label: 'Memory tool',
      value:
        memoryScopes.length > 0
          ? `Can save ${memoryScopes.join(' and ')} facts.`
          : 'Enable project or personal memory to save facts.',
      tone: memoryScopes.length > 0 ? 'ready' : 'muted'
    }
  ]
}

export function buildToolHealthSummary(input: ToolHealthInput): ToolHealthItem[] {
  const projectToolCount = input.catalog.filter((tool) => tool.requiresProject).length

  return [
    {
      label: 'Tools',
      value: input.toolsEnabled
        ? `${input.catalog.length - input.disabledToolCount}/${input.catalog.length} enabled`
        : 'Disabled',
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
