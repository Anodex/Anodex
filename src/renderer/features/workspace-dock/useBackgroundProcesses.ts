import { useEffect, useState } from 'react'
import type { BackgroundProcessInfo } from '@shared/process.types'
import { anodex } from '../../lib/anodex'

/**
 * The background processes Anodex started for `projectId`, newest first, kept
 * current as they start, end, or announce the address they serve.
 */
export function useBackgroundProcesses(projectId: string | null): BackgroundProcessInfo[] {
  const [processes, setProcesses] = useState<BackgroundProcessInfo[]>([])

  useEffect(() => {
    let alive = true
    void anodex.processes.list(projectId).then((list) => {
      if (alive) setProcesses(list)
    })
    const unsubscribe = anodex.processes.onChanged((info) => {
      if (info.projectId !== projectId) return
      setProcesses((current) => {
        const rest = current.filter((item) => item.id !== info.id)
        return [info, ...rest].sort((a, b) => b.startedAt - a.startedAt)
      })
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [projectId])

  return processes
}
