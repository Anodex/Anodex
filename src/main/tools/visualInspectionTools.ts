import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { BrowserWindow } from 'electron'
import type { ChatImageInput } from '@shared/chat.types'
import type { VisualPreviewSection } from '@shared/tools.types'
import type { WorkspaceToolFactory } from './types'
import { runReadTool } from './helpers'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { enqueueVisualInput, MAX_VISION_IMAGE_BYTES, readVisionImage } from '../vision/imageInputs'
import { saveVisualPreviewAsset } from './visualPreviewAssets'
import { createExternalAssetPolicy } from './externalAssetPolicy'
import { startInspectionServer } from './inspectionServer'
import {
  collectConsoleMessages,
  DIAGNOSTICS_COLLECTOR_SCRIPT,
  formatPageDiagnostics,
  readCollectedDiagnostics,
  type BlockedRequest,
  type PageDiagnostics
} from './pageDiagnostics'

const CAPTURE_WIDTH = 1280
const CAPTURE_HEIGHT = 800
const RENDER_SETTLE_MS = 500
const SCROLL_SETTLE_MS = 200

interface PageMetrics {
  scrollHeight: number
  viewportHeight: number
  sections?: PageSection[]
}

interface PageSection {
  id: string
  offset: number
}

interface ScrollPosition {
  scrollY: number
}

interface HtmlCaptureResult {
  images: ChatImageInput[]
  sectionIds: string[]
  /** Runtime evidence gathered while the page rendered — see `pageDiagnostics.ts`. */
  diagnostics: PageDiagnostics
}

interface CaptureTarget {
  offset: number
  sectionId?: string
}

/**
 * inspect_visual - give a multimodal provider pixels from a workspace image or
 * a sandboxed render of an HTML page. The queued image is injected into the
 * next provider round instead of being serialized into the textual tool result.
 */
export const inspectVisualTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Capture and inspect the actual pixels of a workspace PNG/JPEG/GIF/BMP image or HTML page. An initial HTML inspection captures up to three primary named page sections and leaves capacity for one focused follow-up. If a specific section needs another look, call inspect_visual again with its HTML sectionId (for example, "solar-system") so its full viewport is captured. For a visual before/after comparison, call inspect_visual on a path, edit that same file in place, then call inspect_visual on the same path again — those two screenshots of one unchanged path form the comparison. "Before" and "after" are the same file at two moments, not two files: never rename, copy, or duplicate it to keep a separate "before" version, or the comparison will not appear. Do not substitute preview_html. Visual inspection is bounded per response.',
    params: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Image or HTML file path relative to the workspace root.'
        },
        sectionId: {
          type: 'string',
          description:
            'Optional HTML section id to inspect precisely, such as "solar-system". Use after an initial page inspection when a specific section needs another look.'
        }
      },
      required: ['path']
    } as const,
    handler: (args: { path: string; sectionId?: string }) =>
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
          const sectionId = normalizeSectionId(args.sectionId)
          const remainingImageSlots = ctx.visualInputs.limit - ctx.visualInputs.acceptedCount
          if (remainingImageSlots <= 0) {
            throw new Error(
              `Visual inspection limit reached (${ctx.visualInputs.limit} images per response). Summarize what you saw before continuing in a new message.`
            )
          }

          const htmlCapture = isHtml
            ? await captureHtmlPreviews(
                ctx.workspaceRoot,
                args.path,
                sectionId ? 1 : Math.min(remainingImageSlots, MAX_INITIAL_VISION_IMAGE_SECTIONS),
                ctx.signal,
                sectionId
              )
            : null
          const images = htmlCapture?.images ?? [await readVisionImage(file, basename(file))]
          for (const image of images) enqueueVisualInput(ctx.visualInputs, image)

          const assets = await Promise.all(
            images.map((image) => saveVisualPreviewAsset(ctx, image))
          )
          const previewImage = images[0]
          const sections = createPreviewSections(images, assets, htmlCapture?.sectionIds)
          const htmlCoverage = isHtml
            ? sectionId
              ? ` Captured the "${sectionId}" section.`
              : ` Captured ${images.length} primary viewport ${images.length === 1 ? 'section' : 'sections'}. Available section ids for a focused follow-up: ${htmlCapture?.sectionIds.join(', ') || 'none detected'}.`
            : ''
          // Runtime evidence, when there is any, is what actually explains a
          // broken render — a screenshot can only show that something is wrong.
          const diagnostics = htmlCapture ? formatPageDiagnostics(htmlCapture.diagnostics) : ''
          return {
            modelResult: `The visual was captured and attached to the next model round.${htmlCoverage} Inspect every attached section before deciding whether the work is finished.${diagnostics}`,
            detail: isHtml
              ? `${images.length} HTML ${images.length === 1 ? 'screenshot' : 'screenshots'} attached`
              : 'image attached',
            preview: {
              kind: 'image',
              source: 'inspection',
              title: isHtml
                ? `Rendered ${basename(args.path)}${sectionId ? ` (${sectionId})` : images.length > 1 ? ` (${images.length} sections)` : ''}`
                : `Inspected ${basename(args.path)}`,
              path: args.path,
              dataUrl: previewImage.dataUrl,
              mimeType: previewImage.mimeType,
              asset: assets[0],
              sections: sections.length > 1 ? sections : undefined
            }
          }
        }
      })
  })

/**
 * Render semantic page sections and collect runtime evidence.
 *
 * The page is served over a short-lived loopback HTTP server rather than
 * encoded into a `data:` URL, so ES modules, import maps, `fetch`, and relative
 * asset paths all behave exactly as they do in the user's own browser. The
 * previous `data:` URL approach gave the document an opaque origin and no base
 * URL, which made a module-driven page impossible to render — and Anodex
 * reported the resulting blank screenshot to the model as fact. See
 * `docs/REVIEW_LOG_VISUAL_RUNTIME_EVIDENCE.md`.
 *
 * When the page identifies sections, their starts make better inspection
 * targets than evenly spaced page offsets.
 */
export async function captureHtmlPreviews(
  workspaceRoot: string,
  htmlPath: string,
  maxSections: number,
  signal?: AbortSignal,
  sectionId?: string
): Promise<HtmlCaptureResult> {
  const file = resolveInWorkspace(workspaceRoot, htmlPath)
  const relativePath = toWorkspaceRelative(workspaceRoot, file)
  const source = await readFile(file, 'utf-8')
  if (signal?.aborted) throw abortError()

  const server = await startInspectionServer(workspaceRoot, {
    transformHtml: (html) => injectDiagnostics(html)
  })
  // Built from the page's real declarations, and aware of the origin serving
  // the page so its own assets are never mistaken for a remote request.
  const policy = createExternalAssetPolicy(source, { serverOrigin: server.origin })
  const blockedRequests: BlockedRequest[] = []

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
    (details, callback) => {
      const decision = policy.decide(details.url)
      // Recorded rather than silently dropped: a cancelled request that says
      // nothing is what made the original failure undiagnosable.
      if (!decision.allowed && decision.reason) {
        blockedRequests.push({ url: details.url, reason: decision.reason })
      }
      callback({ cancel: !decision.allowed })
    }
  )
  const consoleEntries = collectConsoleMessages(window.webContents)

  try {
    await raceAbort(window.loadURL(server.urlFor(relativePath)), signal)
    await waitForRender(signal)
    await waitForAnimationFrames(window, signal)
    const metrics = await readPageMetrics(window, signal)
    const targets = captureTargets(metrics, maxSections, sectionId)
    const images: ChatImageInput[] = []

    for (const [index, target] of targets.entries()) {
      const { offset } = target
      if (offset > 0) {
        await scrollDocumentTo(window, offset, signal)
        await waitForRender(signal, SCROLL_SETTLE_MS)
        await waitForAnimationFrames(window, signal)
      }
      const screenshot = await raceAbort(window.webContents.capturePage(), signal)
      const png = screenshot.toPNG()
      if (png.length <= 0 || png.length > MAX_VISION_IMAGE_BYTES) {
        throw new Error('Rendered screenshot is empty or exceeds the 15 MB vision limit.')
      }
      images.push({
        path: file,
        name: screenshotName(file, index, targets.length),
        mimeType: 'image/png',
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        sizeBytes: png.length
      })
    }

    // Read after the captures so the measurements describe the frames that
    // were actually screenshotted.
    const collected = await readCollectedDiagnostics(window.webContents)

    return {
      images,
      sectionIds: targets.flatMap((target) => (target.sectionId ? [target.sectionId] : [])),
      diagnostics: { ...collected, console: consoleEntries, blockedRequests }
    }
  } finally {
    if (!window.isDestroyed()) window.destroy()
    await server.close()
  }
}

/**
 * Inject the diagnostics collector and Anodex's preview scrollbars into a
 * served document.
 *
 * The collector goes as early as possible — immediately after `<head>`, before
 * any page script — so an exception thrown while the page's own modules
 * evaluate is captured rather than missed. Everything else about the document
 * is served byte-for-byte from disk.
 */
function injectDiagnostics(html: string): string {
  const collector = `<script data-anodex-inspection="diagnostics">${DIAGNOSTICS_COLLECTOR_SCRIPT}</script>`
  const payload = `${collector}\n${INSPECTION_SCROLLBAR_CSS}`

  const headMatch = /<head\b[^>]*>/i.exec(html)
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length
    return `${html.slice(0, at)}\n${payload}${html.slice(at)}`
  }
  const htmlMatch = /<html\b[^>]*>/i.exec(html)
  if (htmlMatch) {
    const at = htmlMatch.index + htmlMatch[0].length
    return `${html.slice(0, at)}\n${payload}${html.slice(at)}`
  }
  return `${payload}\n${html}`
}

/**
 * Thin scrollbars for captured pages, matching `global.css`. Kept in sync with
 * `previewTools.ts`'s `PREVIEW_SCROLLBAR_CSS` in appearance, but defined here
 * because inspection no longer routes through the inlining preview pipeline.
 * Injected first so a page that styles its own scrollbars still wins on
 * equal-specificity source order.
 */
const INSPECTION_SCROLLBAR_CSS = `<style data-anodex-inspection="scrollbars">
* { scrollbar-width: thin; scrollbar-color: rgba(136, 136, 136, 0.45) transparent; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgba(136, 136, 136, 0.45);
  border-radius: 4px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
::-webkit-scrollbar-corner { background: transparent; }
</style>`

/** Initial page inspection leaves one of the four vision slots for a focused re-inspection. */
const MAX_INITIAL_VISION_IMAGE_SECTIONS = 3

function createPreviewSections(
  images: ChatImageInput[],
  assets: Array<Awaited<ReturnType<typeof saveVisualPreviewAsset>>>,
  sectionIds?: string[]
): VisualPreviewSection[] {
  return images.map((image, index) => ({
    title:
      sectionIds?.[index] ??
      (images.length === 1 ? 'Screenshot' : `Section ${index + 1} of ${images.length}`),
    dataUrl: image.dataUrl,
    mimeType: image.mimeType,
    asset: assets[index]
  }))
}

async function scrollDocumentTo(
  window: BrowserWindow,
  offset: number,
  signal?: AbortSignal
): Promise<void> {
  const position: unknown = await raceAbort<unknown>(
    window.webContents.executeJavaScript(`
      (() => {
        const root = document.scrollingElement || document.documentElement
        document.documentElement.style.scrollBehavior = 'auto'
        if (document.body) document.body.style.scrollBehavior = 'auto'
        window.scrollTo(0, ${offset})
        return { scrollY: Math.max(window.scrollY, root.scrollTop, document.body?.scrollTop || 0) }
      })()
    `),
    signal
  )
  if (!isScrollPosition(position) || Math.abs(position.scrollY - offset) > 2) {
    throw new Error('Rendered page did not scroll to the requested inspection section.')
  }
}

function isScrollPosition(value: unknown): value is ScrollPosition {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as Partial<ScrollPosition>).scrollY === 'number' &&
    Number.isFinite((value as ScrollPosition).scrollY)
  )
}

function normalizeSectionId(sectionId: string | undefined): string | undefined {
  if (!sectionId?.trim()) return undefined
  const normalized = sectionId.trim()
  if (!/^[A-Za-z][A-Za-z0-9_:-]{0,127}$/.test(normalized)) {
    throw new Error('sectionId must be a simple HTML id, such as "solar-system".')
  }
  return normalized
}

async function readPageMetrics(window: BrowserWindow, signal?: AbortSignal): Promise<PageMetrics> {
  const metrics: unknown = await raceAbort<unknown>(
    window.webContents.executeJavaScript(`
      (() => {
        const root = document.documentElement
        const body = document.body
        return {
          scrollHeight: Math.max(
            root?.scrollHeight ?? 0,
            body?.scrollHeight ?? 0,
            root?.offsetHeight ?? 0,
            body?.offsetHeight ?? 0
          ),
          viewportHeight: window.innerHeight,
          sections: Array.from(document.querySelectorAll('section, footer'))
            .map((element) => ({
              id: element.id,
              offset: Math.max(0, Math.round(element.getBoundingClientRect().top + window.scrollY))
            }))
            .filter((section) => section.id)
        }
      })()
    `),
    signal
  )
  if (!isPageMetrics(metrics)) {
    throw new Error('Rendered page did not report valid viewport dimensions.')
  }
  return metrics
}

function isPageMetrics(value: unknown): value is PageMetrics {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PageMetrics>
  return (
    typeof candidate.scrollHeight === 'number' &&
    Number.isFinite(candidate.scrollHeight) &&
    candidate.scrollHeight > 0 &&
    typeof candidate.viewportHeight === 'number' &&
    Number.isFinite(candidate.viewportHeight) &&
    candidate.viewportHeight > 0 &&
    (candidate.sections === undefined ||
      (Array.isArray(candidate.sections) &&
        candidate.sections.every(
          (section) =>
            Boolean(section) &&
            typeof section.id === 'string' &&
            typeof section.offset === 'number' &&
            Number.isFinite(section.offset)
        )))
  )
}

function captureTargets(
  metrics: PageMetrics,
  maxSections: number,
  sectionId?: string
): CaptureTarget[] {
  const viewportHeight = Math.max(1, Math.round(metrics.viewportHeight))
  const maxScroll = Math.max(0, Math.round(metrics.scrollHeight - viewportHeight))
  const semanticTargets = uniqueTargets(
    (metrics.sections ?? []).map((section) => ({
      sectionId: section.id,
      offset: Math.min(maxScroll, Math.max(0, Math.round(section.offset)))
    }))
  )
  if (sectionId) {
    const section = metrics.sections?.find((candidate) => candidate.id === sectionId)
    if (!section) throw new Error(`No HTML section with id "${sectionId}" was found.`)
    return [
      {
        sectionId: section.id,
        offset: Math.min(maxScroll, Math.max(0, Math.round(section.offset)))
      }
    ]
  }
  if (semanticTargets.length > 0) return semanticTargets.slice(0, Math.max(1, maxSections))
  const sectionCount = Math.max(
    1,
    Math.min(maxSections, Math.ceil(metrics.scrollHeight / viewportHeight))
  )
  if (sectionCount === 1 || maxScroll === 0) return [{ offset: 0 }]
  return Array.from({ length: sectionCount }, (_, index) => ({
    offset: Math.round((maxScroll * index) / (sectionCount - 1))
  }))
}

function uniqueTargets(targets: CaptureTarget[]): CaptureTarget[] {
  const targetsByOffset = new Map<number, CaptureTarget>()
  for (const target of targets) {
    if (!targetsByOffset.has(target.offset)) targetsByOffset.set(target.offset, target)
  }
  return [...targetsByOffset.values()].sort((left, right) => left.offset - right.offset)
}

function screenshotName(file: string, index: number, count: number): string {
  const name = basename(file, extname(file))
  return count === 1 ? `${name}.screenshot.png` : `${name}.section-${index + 1}-of-${count}.png`
}

function waitForRender(signal?: AbortSignal, delayMs = RENDER_SETTLE_MS): Promise<void> {
  return raceAbort(
    new Promise((resolve) => {
      setTimeout(resolve, delayMs)
    }),
    signal
  )
}

/** Give canvas/WebGL work a pair of paint frames after loading or scrolling. */
async function waitForAnimationFrames(window: BrowserWindow, signal?: AbortSignal): Promise<void> {
  await raceAbort<unknown>(
    window.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    ),
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
