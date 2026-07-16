import { useChatStore } from '../../stores/chatStore'
import { useUiStore } from '../../stores/uiStore'
import { useProjectStore } from '../../stores/projectStore'
import { getWorkspaceDockProjectId } from './workspaceDockAvailability'

export function useWorkspaceDockProjectId(): string | null {
  const view = useUiStore((s) => s.view)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const activeConversationProjectId = useChatStore((s) => {
    const activeConversation = s.conversations.find((c) => c.id === s.activeId)
    return activeConversation?.projectId ?? null
  })

  return getWorkspaceDockProjectId({ view, activeProjectId, activeConversationProjectId })
}
