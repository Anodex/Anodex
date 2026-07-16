import type { AppView } from '../../stores/uiStore'

interface WorkspaceDockProjectInput {
  view: AppView
  activeProjectId: string | null
  activeConversationProjectId: string | null
}

export function getWorkspaceDockProjectId({
  view,
  activeProjectId,
  activeConversationProjectId
}: WorkspaceDockProjectInput): string | null {
  if (view !== 'chat') return null
  if (!activeConversationProjectId) return null
  if (activeProjectId !== activeConversationProjectId) return null
  return activeConversationProjectId
}
