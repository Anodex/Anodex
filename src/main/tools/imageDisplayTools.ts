import { basename } from 'node:path'
import type { WorkspaceToolFactory } from './types'
import { runReadTool } from './helpers'
import { resolveInWorkspace } from './workspace'
import { readVisionImage } from '../vision/imageInputs'
import { saveVisualPreviewAsset } from './visualPreviewAssets'

/**
 * show_image - attach an existing workspace image to the assistant's visible
 * turn without requiring the active model to understand image pixels.
 */
export const showImageTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Display a selected existing workspace PNG/JPEG/GIF/BMP image directly beside your final reply. Use when the user asks to see, show, open, or attach a visual result. Choose only current, relevant images after inspecting them; do not show every image you inspected. Images inspected with inspect_visual stay in the work log unless you select them with show_image. This tool does not provide its pixels to you. For a visual description, assessment, or comparison, call inspect_visual on the relevant files as well.',
    params: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Image file path relative to the workspace root.'
        }
      },
      required: ['path']
    } as const,
    handler: (args: { path: string }) =>
      runReadTool(ctx, {
        name: 'show_image',
        kind: 'read',
        title: `Show ${args.path}`,
        args,
        touch: { path: args.path, action: 'read' },
        async run() {
          const file = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const image = await readVisionImage(file, basename(file))
          const asset = await saveVisualPreviewAsset(ctx, image)
          return {
            modelResult: `Displayed "${args.path}" in the conversation. The user can open, copy, or save it. This call did not provide image pixels to you; use inspect_visual before describing or comparing its appearance.`,
            detail: 'image shown in conversation',
            preview: {
              kind: 'image',
              source: 'assistant',
              title: basename(args.path),
              path: args.path,
              dataUrl: image.dataUrl,
              mimeType: image.mimeType,
              asset
            }
          }
        }
      })
  })
