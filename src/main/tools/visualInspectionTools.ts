import { randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import { BrowserWindow } from 'electron'
import type { ChatImageInput } from '@shared/chat.types'
import type { WorkspaceToolFactory } from './types'
import { runReadTool } from './helpers'
import { prepareHtmlPreview } from './previewTools'
import { resolveInWorkspace } from './workspace'
import { enqueueVisualInput, MAX_VISION_IMAGE_BYTES, readVisionImage } from '../vision/imageInputs'
import { saveVisualPreviewAsset } from './visualPreviewAssets'

const CAPTURE_WIDTH = 1280
const CAPTURE_HEIGHT = 800
const RENDER_SETTLE_MS = 500
const MAX_CAPTURE_HTML_CHARS = 8 * 1024 * 1024
const MAX_CAPTURE_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * inspect_visual - give a multimodal provider pixels from a workspace image or
 * a sandboxed render of an HTML page. The queued image is injected into the
 * next provider round instead of being serialized into the textual tool result.
 */
export const inspectVisualTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Inspect the actual pixels of a workspace PNG/JPEG/GIF/BMP image or render an HTML page to a screenshot. Use after creating or editing visual work, then revise any problems you see. Visual inspection is bounded per response.',
    params: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Image or HTML file path relative to the workspace root.'
        }
      },
      required: ['path']
    } as const,
    handler: (args: { path: string }) =>
      runReadTool(ctx, {
        name: 'inspect_visual',
        kind: 'read',
        title: `Inspect ${args.path}`,
        args,
        touch: { path: args.path, action: 'read' },
        async run() {
          if (!ctx.visualInputs) {
            throw new Error('The active model cannot inspect images.')
          }
          const file = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const isHtml = /\.html?$/i.test(args.path)
          const image = isHtml
            ? await captureHtmlPreview(ctx.workspaceRoot, args.path, ctx.signal)
            : await readVisionImage(file, basename(file))
          enqueueVisualInput(ctx.visualInputs, image)
          const asset = await saveVisualPreviewAsset(ctx, image)
          return {
            modelResult:
              'The visual was captured and attached to the next model round. Inspect the pixels before deciding whether the work is finished.',
            detail: isHtml ? 'HTML screenshot attached' : 'image attached',
            preview: {
              kind: 'image',
              source: 'inspection',
              title: isHtml
                ? `Rendered ${basename(args.path)}`
                : `Inspected ${basename(args.path)}`,
              path: args.path,
              dataUrl: image.dataUrl,
              mimeType: image.mimeType,
              asset
            }
          }
        }
      })
  })

/** Render the same confined HTML payload used by preview_html into a PNG. */
export async function captureHtmlPreview(
  workspaceRoot: string,
  htmlPath: string,
  signal?: AbortSignal
): Promise<ChatImageInput> {
  const { file, content } = await prepareHtmlPreview(workspaceRoot, htmlPath, {
    maxContentChars: MAX_CAPTURE_HTML_CHARS,
    maxImageBytes: MAX_CAPTURE_IMAGE_BYTES
  })
  if (signal?.aborted) throw abortError()

  const window = new BrowserWindow({
    show: false,
    width: CAPTURE_WIDTH,
    height: CAPTURE_HEIGHT,
    backgroundColor: '#ffffff',
    paintWhenInitiallyHidden: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: `visual-inspection:${randomUUID()}`
    }
  })

  window.webContents.setAudioMuted(true)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.session.webRequest.onBeforeRequest(
    {
      urls: ['http://*/*', 'https://*/*', 'file://*/*', 'ftp://*/*', 'ws://*/*', 'wss://*/*']
    },
    (_details, callback) => callback({ cancel: true })
  )

  try {
    const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(content).toString('base64')}`
    await raceAbort(window.loadURL(dataUrl), signal)
    await waitForRender(signal)
    const screenshot = await raceAbort(window.webContents.capturePage(), signal)
    const png = screenshot.toPNG()
    if (png.length <= 0 || png.length > MAX_VISION_IMAGE_BYTES) {
      throw new Error('Rendered screenshot is empty or exceeds the 15 MB vision limit.')
    }
    return {
      path: file,
      name: `${basename(file, extname(file))}.screenshot.png`,
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${png.toString('base64')}`,
      sizeBytes: png.length
    }
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}

function waitForRender(signal?: AbortSignal): Promise<void> {
  return raceAbort(
    new Promise((resolve) => {
      setTimeout(resolve, RENDER_SETTLE_MS)
    }),
    signal
  )
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

function abortError(): Error {
  return new Error('Visual inspection was stopped.')
}
