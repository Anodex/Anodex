import { useCallback, useEffect, useMemo, useState } from 'react'
import type { GitWorkspaceStatus } from '@shared/git.types'
import { anodex } from '../../lib/anodex'
import { useChatStore } from '../../stores/chatStore'
import { useProjectStore } from '../../stores/projectStore'
import { activityOf, isWorking, outputsOf, planProgress } from './dockActivity'
import { useWorkspaceDockProjectId } from './useWorkspaceDockAvailability'

const CHANGE_TOOLS = new Set(['propose_change', 'update_change_task', 'archive_change'])

/** Sent by the Git panel with each status it reads, so the dock's summary keeps up with it. */
export const GIT_STATUS_EVENT = 'anodex:git-status'

export interface DockStatus {
  plan: { done: number; total: number } | null
  working: boolean
  activityCount: number
  outputCount: number
  changeCount: number | null
  checkpointCount: number | null
  git: GitWorkspaceStatus | null
}

/**
 * What the dock's tabs, header, and footer say about the project at a glance.
 *
 * The plan, activity, and outputs come from the active conversation already in
 * memory. Change proposals, checkpoints, and git status are asked of the main
 * process when the project changes and again after any tool that could have
 * moved them, the same triggers their panels refresh on.
 */
export function useDockStatus(): DockStatus {
  const projectId = useWorkspaceDockProjectId()
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const conversation = useChatStore((s) => s.conversations.find((c) => c.id === s.activeId))
  const [changeCount, setChangeCount] = useState<number | null>(null)
  const [checkpointCount, setCheckpointCount] = useState<number | null>(null)
  const [git, setGit] = useState<GitWorkspaceStatus | null>(null)

  const refreshChanges = useCallback(async () => {
    const changes = await anodex.changes.list(activeProjectId)
    setChangeCount(changes.filter((change) => change.status !== 'archived').length)
  }, [activeProjectId])

  const refreshProject = useCallback(async () => {
    if (!projectId) {
      setCheckpointCount(null)
      setGit(null)
      return
    }
    const [checkpoints, status] = await Promise.all([
      anodex.checkpoints.list(projectId),
      anodex.git.getStatus(projectId)
    ])
    setCheckpointCount(checkpoints.ok ? checkpoints.value.length : null)
    setGit(status.ok ? status.value : null)
  }, [projectId])

  useEffect(() => {
    void refreshChanges()
    void refreshProject()
    const onCheckpoints = (): void => void refreshProject()
    const onGitStatus = (event: Event): void =>
      setGit((event as CustomEvent<GitWorkspaceStatus>).detail)
    window.addEventListener('anodex:checkpoints-changed', onCheckpoints)
    window.addEventListener(GIT_STATUS_EVENT, onGitStatus)
    const unsubscribe = anodex.tools.onActivity((event) => {
      if (event.call.status !== 'success') return
      if (CHANGE_TOOLS.has(event.call.name)) void refreshChanges()
      if (event.call.kind === 'write' || event.call.kind === 'command') void refreshProject()
    })
    return () => {
      unsubscribe()
      window.removeEventListener('anodex:checkpoints-changed', onCheckpoints)
      window.removeEventListener(GIT_STATUS_EVENT, onGitStatus)
    }
  }, [refreshChanges, refreshProject])

  return useMemo(() => {
    const activity = activityOf(conversation?.messages)
    return {
      plan: planProgress(conversation?.plan),
      working: isWorking(conversation?.messages),
      activityCount: activity.length,
      outputCount: outputsOf(activity).length,
      changeCount,
      checkpointCount,
      git
    }
  }, [conversation, changeCount, checkpointCount, git])
}
