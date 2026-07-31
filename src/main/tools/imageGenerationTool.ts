import type { ToolFactory } from './types'
import { runGuardedTool } from './helpers'
import { saveVisualPreviewAsset } from './visualPreviewAssets'
import {
  generateImage,
  type ImageAspectRatio,
  type ImageQuality
} from '../imageGeneration/ImageGenerationService'

const PROVIDER_LABELS = { openai: 'OpenAI', google: 'Google AI' } as const

/** Generate an image through an explicitly supported cloud provider. */
export const generateImageTool: ToolFactory = (define, ctx) =>
  define({
    description:
      'Generate one image from a detailed prompt with the active cloud image provider. Always ask the user before calling it because it sends the prompt to a paid external image API. Use for mockups, illustrations, diagrams, or visual assets when the user asks for an image.',
    params: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed visual description for the generated image.'
        },
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '16:9', '9:16'],
          description:
            'Requested image shape. Use 1:1 unless the user asks for a wide or tall image.'
        },
        quality: {
          type: 'string',
          enum: ['draft', 'standard', 'high'],
          description: 'Draft is faster; high is for final assets. Standard is the default.'
        }
      },
      required: ['prompt', 'aspect_ratio', 'quality']
    } as const,
    handler: async (args: {
      prompt: string
      aspect_ratio?: ImageAspectRatio
      quality?: ImageQuality
    }) => {
      const prompt = args.prompt.trim()
      if (!prompt) return 'Error: Image prompt cannot be empty.'
      const provider = ctx.imageGeneration?.provider
      if (!provider) return 'Error: The active provider cannot generate images.'
      const aspectRatio = args.aspect_ratio ?? '1:1'
      const quality = args.quality ?? 'standard'
      const providerLabel = PROVIDER_LABELS[provider]

      return runGuardedTool(ctx, {
        name: 'generate_image',
        kind: 'web',
        title: `Generate image with ${providerLabel}`,
        args: { prompt, aspect_ratio: aspectRatio, quality },
        risk: 'sensitive',
        forceConfirm: true,
        requiresHumanApproval: true,
        confirmDetail: `${providerLabel} will receive this prompt and may charge your account:\n\n${prompt}\n\n${aspectRatio}, ${quality} quality, one PNG image.`,
        async run() {
          const image = await generateImage({
            provider,
            prompt,
            aspectRatio,
            quality,
            signal: ctx.signal
          })
          const asset = await saveVisualPreviewAsset(ctx, image)
          return {
            modelResult: `Generated one ${aspectRatio} image with ${providerLabel} and displayed it in the conversation.`,
            detail: `${aspectRatio} generated image`,
            preview: {
              kind: 'image',
              source: 'generated',
              title: `${providerLabel} generated image`,
              path: 'Generated in this conversation',
              prompt,
              dataUrl: image.dataUrl,
              mimeType: image.mimeType,
              asset
            }
          }
        }
      })
    }
  })
