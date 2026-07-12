export interface ContextTransparencyInput {
  projectName: string | null
  toolsEnabled: boolean
  hasProjectInstructions: boolean
  pinnedSkillNames: string[]
  attachmentCount: number
  hasContextSnapshot: boolean
}

export interface ContextTransparencyItem {
  label: string
  value: string
}

export function buildContextTransparencyItems(
  input: ContextTransparencyInput
): ContextTransparencyItem[] {
  const items: ContextTransparencyItem[] = [
    { label: 'Project', value: input.projectName ?? 'General chat' }
  ]

  if (input.hasProjectInstructions) {
    items.push({ label: 'Instructions', value: 'Project rules included' })
  }

  if (input.pinnedSkillNames.length > 0) {
    const shown = input.pinnedSkillNames.slice(0, 3).join(', ')
    const extra = input.pinnedSkillNames.length > 3 ? ` +${input.pinnedSkillNames.length - 3}` : ''
    items.push({ label: 'Skills', value: `${shown}${extra}` })
  }

  if (input.attachmentCount > 0) {
    items.push({
      label: 'Files',
      value: `${input.attachmentCount} ${input.attachmentCount === 1 ? 'attached' : 'attached'}`
    })
  }

  if (input.hasContextSnapshot) {
    items.push({ label: 'Memory', value: 'Compacted summary active' })
  }

  items.push({ label: 'Tools', value: input.toolsEnabled ? 'Enabled' : 'Disabled' })

  return items
}
