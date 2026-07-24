import type { ImagePreview } from './useVisualPreviewImage'

export function visualRecoveryPrompt(preview: ImagePreview): string {
  return preview.source === 'assistant'
    ? `Show the workspace image at "${preview.path}" again using show_image.`
    : `Re-inspect "${preview.path}" using inspect_visual and show me the new screenshot.`
}
