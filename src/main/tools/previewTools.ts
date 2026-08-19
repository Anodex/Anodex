import { readFile, stat } from 'node:fs/promises'
import { posix } from 'node:path'
import type { WorkspaceToolFactory } from './types'
import { runReadTool } from './helpers'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'

const MAX_PREVIEW_SOURCE_BYTES = 200 * 1024
const MAX_PREVIEW_CONTENT_CHARS = 120 * 1024
const MAX_PREVIEW_IMAGE_BYTES = 60 * 1024
const PREVIEW_IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
}

/**
 * preview_html - render a workspace HTML file inside the chat transcript.
 *
 * The renderer still sandboxes the iframe. This tool only prepares a self-contained
 * `srcDoc`: local relative CSS and JS references are inlined so small browser
 * games/pages preview as they do from disk, while external URLs remain untouched.
 */
export const previewHtmlTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Render an HTML file as an interactive inline preview card. Use this to show a web page, game, or animation, but not for a before/after screenshot comparison; for that, use inspect_visual on the same path, editing the file in place between screenshots — never rename or copy it to make a separate "before".',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'HTML file path relative to the workspace root.' },
        title: { type: 'string', description: 'Optional short preview title.' }
      },
      required: ['path']
    } as const,
    handler: (args: { path: string; title?: string }) =>
      runReadTool(ctx, {
        name: 'preview_html',
        kind: 'read',
        title: `Preview ${args.path}`,
        args,
        touch: { path: args.path, action: 'read' },
        async run() {
          const { file, content, skipped } = await prepareHtmlPreview(ctx.workspaceRoot, args.path)
          const dropped = describeSkippedPreviewAssets(skipped)

          return {
            modelResult: dropped
              ? `Rendered an inline chat preview for ${args.path}, but ${dropped}`
              : `Rendered an inline chat preview for ${args.path}.`,
            detail: dropped ? 'inline preview — assets dropped' : 'inline preview',
            preview: {
              kind: 'html',
              title: args.title?.trim() || args.path,
              path: toWorkspaceRelative(ctx.workspaceRoot, file),
              content
            }
          }
        }
      })
  })

/**
 * A local asset that could not be inlined because it is too big.
 *
 * Worth reporting rather than swallowing: a `srcDoc` preview cannot fetch a
 * relative path, so a skipped script does not merely go missing — the page runs
 * without it and usually renders blank. A vendored library is exactly the kind
 * of file that trips this (a Three.js build is around 600 KB), and a blank
 * preview with no stated cause is what a model then reports as fact.
 */
export interface SkippedPreviewAsset {
  url: string
  bytes: number
}

/** Prepare the same sandboxed, self-contained HTML used by chat and visual inspection. */
export async function prepareHtmlPreview(
  workspaceRoot: string,
  htmlPath: string,
  options: { maxContentChars?: number; maxImageBytes?: number } = {}
): Promise<{ file: string; content: string; skipped: SkippedPreviewAsset[] }> {
  const file = resolveInWorkspace(workspaceRoot, htmlPath)
  const info = await stat(file)
  if (!info.isFile()) throw new Error('Path is not a file.')
  if (!/\.html?$/i.test(htmlPath)) throw new Error('preview_html requires an HTML file.')
  if (info.size > MAX_PREVIEW_SOURCE_BYTES) {
    throw new Error(`HTML file exceeds ${MAX_PREVIEW_SOURCE_BYTES} byte preview limit.`)
  }

  const html = await readFile(file, 'utf-8')
  const skipped: SkippedPreviewAsset[] = []
  const content = await prepareHtmlPreviewSource(workspaceRoot, htmlPath, html, options, skipped)
  return { file, content, skipped }
}

/**
 * Same inlining as `prepareHtmlPreview`, but against HTML supplied by the
 * caller rather than read from disk — used by the file viewer, whose preview
 * has to reflect the *unsaved* editor buffer, not what's currently on disk.
 * `htmlPath` is still required: every relative `href`/`src` in the document is
 * resolved against that file's directory.
 */
export async function prepareHtmlPreviewSource(
  workspaceRoot: string,
  htmlPath: string,
  html: string,
  options: { maxContentChars?: number; maxImageBytes?: number } = {},
  skipped: SkippedPreviewAsset[] = []
): Promise<string> {
  const inlined = await inlineLocalAssets(
    workspaceRoot,
    htmlPath,
    html,
    options.maxImageBytes ?? MAX_PREVIEW_IMAGE_BYTES,
    skipped
  )
  const content = withPreviewScrollbars(inlined)
  const limit = options.maxContentChars ?? MAX_PREVIEW_CONTENT_CHARS
  if (content.length > limit) throw new Error(oversizedPreviewMessage(content.length, limit))
  return content
}

/**
 * Say what actually overflowed, and where to go instead.
 *
 * The message this replaced was "Preview is too large after inlining local
 * assets." — true, and useless: it named no file, no size, and no alternative,
 * so a model that hit it had nothing to act on and simply stopped verifying.
 * Three live runs ended that way. `inspect_visual` serves the real files over a
 * loopback HTTP server instead of inlining them, so it has none of these limits
 * and is the right answer for a page with vendored libraries.
 */
function oversizedPreviewMessage(size: number, limit: number): string {
  const kb = (bytes: number): string => `${Math.round(bytes / 1024)} KB`
  return (
    `Inlining this page's local assets produced ${kb(size)}, over the ${kb(limit)} inline-preview ` +
    'limit. Use inspect_visual on the same path — it serves the real files over a local HTTP ' +
    'server, so it has no inlining limit and runs the page the way a browser would.'
  )
}

/**
 * What a caller should tell the model when assets were dropped.
 *
 * Returns `null` when nothing was skipped, so the ordinary case adds no noise.
 */
export function describeSkippedPreviewAssets(skipped: SkippedPreviewAsset[]): string | null {
  if (skipped.length === 0) return null
  const named = skipped
    .slice()
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3)
    .map((asset) => `${asset.url} (${Math.round(asset.bytes / 1024)} KB)`)
  const more = skipped.length - named.length
  return (
    `${skipped.length} local asset(s) were too large to inline and did not load: ` +
    `${named.join(', ')}${more > 0 ? `, and ${more} more` : ''}. ` +
    'The page may render blank without them — use inspect_visual for a faithful render.'
  )
}

/**
 * Anodex's own scrollbar geometry, for previewed pages.
 *
 * A preview frame (and the pop-out window) otherwise gets the platform's
 * default chunky scrollbar, which sits right next to Anodex's own thin ones
 * and reads as a seam in the app. This is the same shape as `global.css` —
 * 8px, rounded, transparent track, 2px inset via `background-clip` — but with
 * a translucent grey thumb rather than the `--border-strong` theme token,
 * because this scrollbar sits against the *previewed page's* background, not
 * Anodex's chrome, and the page may be light or dark.
 *
 * Injected at the very top of the document so it loses to any scrollbar rule
 * the page sets for itself: these are equal-specificity selectors, so source
 * order decides, and a page that styles its own scrollbars keeps them.
 */
const PREVIEW_SCROLLBAR_CSS = `<style data-anodex-preview-chrome="scrollbars">
* { scrollbar-width: thin; scrollbar-color: rgba(136, 136, 136, 0.45) transparent; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgba(136, 136, 136, 0.45);
  border-radius: 4px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(136, 136, 136, 0.7);
  background-clip: padding-box;
}
::-webkit-scrollbar-corner { background: transparent; }
</style>`

function withPreviewScrollbars(html: string): string {
  const headMatch = /<head\b[^>]*>/i.exec(html)
  if (headMatch) {
    const at = headMatch.index + headMatch[0].length
    return `${html.slice(0, at)}\n${PREVIEW_SCROLLBAR_CSS}${html.slice(at)}`
  }
  // No <head> to hang it off — a bare fragment, or a document that opens
  // straight into <body>. Prepending still applies, and the browser hoists a
  // leading <style> into the head it synthesizes.
  const htmlMatch = /<html\b[^>]*>/i.exec(html)
  if (htmlMatch) {
    const at = htmlMatch.index + htmlMatch[0].length
    return `${html.slice(0, at)}\n${PREVIEW_SCROLLBAR_CSS}${html.slice(at)}`
  }
  return `${PREVIEW_SCROLLBAR_CSS}\n${html}`
}

async function inlineLocalAssets(
  workspaceRoot: string,
  htmlPath: string,
  html: string,
  maxImageBytes: number,
  skipped: SkippedPreviewAsset[]
): Promise<string> {
  const withStyles = await replaceAsync(
    html,
    /<link\b([^>]*?)\bhref=["']([^"']+)["']([^>]*?)>/gi,
    async (match, before: string, href: string, after: string) => {
      if (!/\brel=["']?stylesheet["']?/i.test(`${before} ${after}`)) return match
      const css = await readLocalTextAsset(workspaceRoot, htmlPath, href, skipped)
      return css === null
        ? match
        : `<style data-anodex-preview-source="${escapeAttr(href)}">\n${css}\n</style>`
    }
  )

  const withScripts = await replaceAsync(
    withStyles,
    /<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
    async (_match, before: string, src: string, after: string) => {
      const js = await readLocalTextAsset(workspaceRoot, htmlPath, src, skipped)
      return js === null
        ? `<script${before} src="${escapeAttr(src)}"${after}></script>`
        : `<script${before}${after} data-anodex-preview-source="${escapeAttr(src)}">\n${js}\n</script>`
    }
  )

  return replaceAsync(
    withScripts,
    /<img\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>/gi,
    async (match, before: string, src: string, after: string) => {
      const dataUrl = await readLocalImageAsset(workspaceRoot, htmlPath, src, maxImageBytes)
      return dataUrl === null
        ? match
        : `<img${before}src="${dataUrl}"${after} data-anodex-preview-source="${escapeAttr(src)}">`
    }
  )
}

async function readLocalTextAsset(
  workspaceRoot: string,
  htmlPath: string,
  assetUrl: string,
  skipped: SkippedPreviewAsset[]
): Promise<string | null> {
  if (
    /^(?:[a-z]+:)?\/\//i.test(assetUrl) ||
    assetUrl.startsWith('data:') ||
    assetUrl.startsWith('#')
  ) {
    return null
  }

  const cleanUrl = assetUrl.split(/[?#]/, 1)[0]
  if (!cleanUrl || cleanUrl.startsWith('/')) return null

  const htmlDir = posix.dirname(htmlPath.replace(/\\/g, '/'))
  const assetPath = posix.normalize(posix.join(htmlDir, cleanUrl))
  if (assetPath.startsWith('../')) return null

  try {
    const file = resolveInWorkspace(workspaceRoot, assetPath)
    const info = await stat(file)
    if (!info.isFile()) return null
    // Recorded, not silently dropped: inside a `srcDoc` the surviving tag has
    // no origin to fetch from, so the page runs without this file entirely.
    if (info.size > MAX_PREVIEW_SOURCE_BYTES) {
      skipped.push({ url: assetUrl, bytes: info.size })
      return null
    }
    return await readFile(file, 'utf-8')
  } catch {
    // A referenced asset that doesn't exist (or can't be read) leaves its tag
    // untouched instead of failing the whole preview — the page still renders,
    // just without that one stylesheet/script. Matters most for the live file
    // viewer, where the user may well be editing a page whose sibling file
    // hasn't been written yet.
    return null
  }
}

async function readLocalImageAsset(
  workspaceRoot: string,
  htmlPath: string,
  assetUrl: string,
  maxImageBytes: number
): Promise<string | null> {
  if (
    /^(?:[a-z]+:)?\/\//i.test(assetUrl) ||
    assetUrl.startsWith('data:') ||
    assetUrl.startsWith('#')
  ) {
    return null
  }

  const cleanUrl = assetUrl.split(/[?#]/, 1)[0]
  if (!cleanUrl || cleanUrl.startsWith('/')) return null
  const mimeType = PREVIEW_IMAGE_MIME_TYPES[posix.extname(cleanUrl).toLowerCase()]
  if (!mimeType) return null

  const htmlDir = posix.dirname(htmlPath.replace(/\\/g, '/'))
  const assetPath = posix.normalize(posix.join(htmlDir, cleanUrl))
  if (assetPath.startsWith('../')) return null

  try {
    const file = resolveInWorkspace(workspaceRoot, assetPath)
    const info = await stat(file)
    if (!info.isFile() || info.size > maxImageBytes) return null
    const data = await readFile(file)
    return `data:${mimeType};base64,${data.toString('base64')}`
  } catch {
    // Same as `readLocalTextAsset`: a missing image leaves its <img> alone
    // rather than taking the whole preview down with it.
    return null
  }
}

async function replaceAsync(
  text: string,
  regex: RegExp,
  replacer: (...args: string[]) => Promise<string>
): Promise<string> {
  const matches = [...text.matchAll(regex)]
  const replacements = await Promise.all(matches.map((match) => replacer(...match)))
  let index = 0
  return text.replace(regex, () => replacements[index++])
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
