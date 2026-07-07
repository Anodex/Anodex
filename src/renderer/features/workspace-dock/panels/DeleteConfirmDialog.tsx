import { ConfirmDialog } from '../../../components/ui/ConfirmDialog'

interface DeleteConfirmDialogProps {
  name: string
  isFolder: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Blocking confirmation before deleting a file/folder from the Files panel —
 * the one destructive action in that menu, so it gets its own dialog rather
 * than a plain `window.confirm()`. Thin wrapper around the generic
 * `ConfirmDialog` with file/folder-specific wording (Recycle Bin, not a
 * permanent delete).
 */
export function DeleteConfirmDialog({
  name,
  isFolder,
  onCancel,
  onConfirm
}: DeleteConfirmDialogProps): JSX.Element {
  return (
    <ConfirmDialog
      title={`Delete ${isFolder ? 'folder' : 'file'}?`}
      message={
        isFolder
          ? 'This moves the folder and everything inside it to the Recycle Bin.'
          : 'This moves the file to the Recycle Bin.'
      }
      detail={name}
      confirmLabel="Move to Recycle Bin"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
