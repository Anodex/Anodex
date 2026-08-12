import { useRef, useState, type DragEvent } from 'react'
import { notifyError } from '../../../stores/uiStore'
import { anodex } from '../../../lib/anodex'
import {
  ANODEX_FILE_DRAG_TYPE,
  intakeAttachments,
  type ComposerAttachment
} from '../../../lib/attachments'

interface UseComposerAttachmentsOptions {
  ready: boolean
  visionAvailable: boolean
}

interface ComposerAttachmentsController {
  attachments: ComposerAttachment[]
  dragActive: boolean
  clearAttachments: () => void
  removeAttachment: (path: string) => void
  handleAttachClick: () => Promise<void>
  handleDragEnter: (event: DragEvent<HTMLDivElement>) => void
  handleDragOver: (event: DragEvent<HTMLDivElement>) => void
  handleDragLeave: (event: DragEvent<HTMLDivElement>) => void
  handleDrop: (event: DragEvent<HTMLDivElement>) => void
}

/**
 * Owns attachment intake and drag-and-drop state for the composer.
 *
 * The synchronous ref prevents overlapping asynchronous intake passes from
 * accepting the same file twice before React has committed an update.
 */
export function useComposerAttachments({
  ready,
  visionAvailable
}: UseComposerAttachmentsOptions): ComposerAttachmentsController {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [dragActive, setDragActive] = useState(false)
  const dragCounter = useRef(0)
  const attachmentsRef = useRef<ComposerAttachment[]>([])

  const setAttachmentList = (
    update: (current: ComposerAttachment[]) => ComposerAttachment[]
  ): void => {
    attachmentsRef.current = update(attachmentsRef.current)
    setAttachments(attachmentsRef.current)
  }

  const attachFiles = (candidates: { path: string; name: string }[]): Promise<void> =>
    intakeAttachments(candidates, {
      getAttachments: () => attachmentsRef.current,
      commit: setAttachmentList,
      readFile: (path) => anodex.attachments.readFile(path),
      notifyError,
      visionAvailable
    })

  const removeAttachment = (path: string): void => {
    setAttachmentList((current) => current.filter((attachment) => attachment.path !== path))
  }

  const handleDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragCounter.current += 1
    setDragActive(true)
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
  }

  const handleDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragCounter.current = Math.max(0, dragCounter.current - 1)
    if (dragCounter.current === 0) setDragActive(false)
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    dragCounter.current = 0
    setDragActive(false)
    if (!ready) return

    const internalPayload = event.dataTransfer.getData(ANODEX_FILE_DRAG_TYPE)
    if (internalPayload) {
      try {
        const { path, name } = JSON.parse(internalPayload) as { path: string; name: string }
        void anodex.workspace.getAbsolutePath(path).then((resolved) => {
          if (resolved.ok) void attachFiles([{ path: resolved.value, name }])
          else notifyError('Could not attach file', resolved.error.message)
        })
      } catch {
        // Ignore a malformed drag payload from outside the trusted file list.
      }
      return
    }

    const dropped = Array.from(event.dataTransfer.files)
      .map((file) => ({ path: anodex.system.getPathForFile(file), name: file.name }))
      .filter((candidate) => candidate.path)
    if (dropped.length > 0) void attachFiles(dropped)
  }

  const handleAttachClick = async (): Promise<void> => {
    if (!ready) return
    const picked = await anodex.attachments.pickFiles()
    if (picked.length > 0) void attachFiles(picked)
  }

  return {
    attachments,
    dragActive,
    clearAttachments: () => setAttachmentList(() => []),
    removeAttachment,
    handleAttachClick,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop
  }
}
