import type { ImagePreview } from './useVisualPreviewImage'

export function visualRecoveryPrompt(preview: ImagePreview): string {
  switch (preview.source) {
    case 'assistant':
      return `Show the workspace image at "${preview.path}" again using show_image.`
    // Named rather than given ids: an email preview carries the filename, and
    // the message/attachment ids it was fetched with are long provider strings
    // that never reach the UI. find_attachments recovers them from the thread
    // this chat is already about.
    case 'email':
      return `Find the email attachment "${preview.path}" again with find_attachments and look at it with view_email_attachment.`
    default:
      return `Re-inspect "${preview.path}" using inspect_visual and show me the new screenshot.`
  }
}
