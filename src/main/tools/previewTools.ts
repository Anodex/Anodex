import { readFile, stat } from 'node:fs/promises'
import { posix } from 'node:path'
import type { WorkspaceToolFactory } from './types'
import { runReadTool } from './helpers'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'

const MAX_PREVIEW_SOURCE_BYTES = 200 * 1024
const MAX_PREVIEW_CONTENT_CHARS = 120 * 1024

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
      'Render an HTML file as an inline preview card in chat. Use this when the user asks to see a web page, game, animation, or visual result in chat.',
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
        touch: { path: args.path, action: 'read' },
        async run() {
          const file = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const info = await stat(file)
          if (!info.isFile()) throw new Error('Path is not a file.')
          if (!/\.html?$/i.test(args.path)) throw new Error('preview_html requires an HTML file.')
          if (info.size > MAX_PREVIEW_SOURCE_BYTES) {
            throw new Error(`HTML file exceeds ${MAX_PREVIEW_SOURCE_BYTES} byte preview limit.`)
          }

          const html = await readFile(file, 'utf-8')
          const content = await inlineLocalAssets(ctx.workspaceRoot, args.path, html)
          if (content.length > MAX_PREVIEW_CONTENT_CHARS) {
            throw new Error('Preview is too large after inlining local assets.')
          }

          return {
            modelResult: `Rendered an inline chat preview for ${args.path}.`,
            detail: 'inline preview',
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

async function inlineLocalAssets(
  workspaceRoot: string,
  htmlPath: string,
  html: string
): Promise<string> {
  const withStyles = await replaceAsync(
    html,
    /<link\b([^>]*?)\bhref=["']([^"']+)["']([^>]*?)>/gi,
    async (match, before: string, href: string, after: string) => {
      if (!/\brel=["']?stylesheet["']?/i.test(`${before} ${after}`)) return match
      const css = await readLocalTextAsset(workspaceRoot, htmlPath, href)
      return css === null ? match : `<style data-anodex-preview-source="${escapeAttr(href)}">\n${css}\n</style>`
    }
  )

  return replaceAsync(
    withStyles,
    /<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
    async (_match, before: string, src: string, after: string) => {
      const js = await readLocalTextAsset(workspaceRoot, htmlPath, src)
      return js === null
        ? `<script${before} src="${escapeAttr(src)}"${after}></script>`
        : `<script${before}${after} data-anodex-preview-source="${escapeAttr(src)}">\n${js}\n</script>`
    }
  )
}

async function readLocalTextAsset(
  workspaceRoot: string,
  htmlPath: string,
  assetUrl: string
): Promise<string | null> {
  if (/^(?:[a-z]+:)?\/\//i.test(assetUrl) || assetUrl.startsWith('data:') || assetUrl.startsWith('#')) {
    return null
  }

  const cleanUrl = assetUrl.split(/[?#]/, 1)[0]
  if (!cleanUrl || cleanUrl.startsWith('/')) return null

  const htmlDir = posix.dirname(htmlPath.replace(/\\/g, '/'))
  const assetPath = posix.normalize(posix.join(htmlDir, cleanUrl))
  if (assetPath.startsWith('../')) return null

  const file = resolveInWorkspace(workspaceRoot, assetPath)
  const info = await stat(file)
  if (!info.isFile() || info.size > MAX_PREVIEW_SOURCE_BYTES) return null
  return readFile(file, 'utf-8')
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
