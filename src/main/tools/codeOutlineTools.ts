import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkspaceToolFactory } from './types'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { runReadTool } from './helpers'
import { SKIP_DIRS } from './fileTools'

const MAX_OUTLINE_FILES = 40
const MAX_FILE_BYTES = 180 * 1024
const CODE_FILE_EXT = /\.(tsx?|jsx?|mjs|cjs)$/i
const IMPORT_RE = /^\s*import(?:\s+type)?(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/gm
const SIDE_EFFECT_IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"]/gm
const SYMBOL_RE =
  /^\s*export\s+(?:default\s+)?(?:async\s+)?(function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/gm
const NAMED_EXPORT_RE = /^\s*export\s*\{([^}]+)\}/gm

interface CodeOutlineArgs {
  path?: string
  maxFiles?: number
}

interface FileOutline {
  path: string
  imports: string[]
  symbols: string[]
}

/** code_outline — compact symbol/import map for source files. */
export const codeOutlineTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Return a compact code map for a file or folder: imports and exported top-level symbols. Use before reading whole source files to orient on project structure cheaply.',
    params: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File or directory path relative to the workspace root.'
        },
        maxFiles: {
          type: 'number',
          description: `Maximum source files to outline. Defaults to ${MAX_OUTLINE_FILES}.`
        }
      }
    } as const,
    handler: (args: CodeOutlineArgs) =>
      runReadTool(ctx, {
        name: 'code_outline',
        kind: 'read',
        title: `Outline ${args.path?.trim() || '.'}`,
        async run() {
          const requested = args.path?.trim() || '.'
          const root = resolveInWorkspace(ctx.workspaceRoot, requested)
          const maxFiles = normalizeMaxFiles(args.maxFiles)
          const files = await collectCodeFiles(root, maxFiles)
          const outlines = await Promise.all(
            files.map((file) => outlineFile(ctx.workspaceRoot, file))
          )
          const body = outlines.length
            ? outlines.map(formatOutline).join('\n\n')
            : 'No source files found.'
          return {
            modelResult: body,
            detail: `${outlines.length} file${outlines.length === 1 ? '' : 's'}`
          }
        }
      })
  })

async function collectCodeFiles(start: string, maxFiles: number): Promise<string[]> {
  const info = await stat(start)
  if (info.isFile()) return CODE_FILE_EXT.test(start) && info.size <= MAX_FILE_BYTES ? [start] : []

  const results: string[] = []
  await walk(start, results, maxFiles)
  return results
}

async function walk(dir: string, results: string[], maxFiles: number): Promise<void> {
  if (results.length >= maxFiles) return
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (results.length >= maxFiles) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(full, results, maxFiles)
      continue
    }
    if (!CODE_FILE_EXT.test(entry.name)) continue
    const info = await stat(full)
    if (info.size <= MAX_FILE_BYTES) results.push(full)
  }
}

async function outlineFile(workspaceRoot: string, file: string): Promise<FileOutline> {
  const source = await readFile(file, 'utf-8')
  return {
    path: toWorkspaceRelative(workspaceRoot, file),
    imports: extractImports(source),
    symbols: extractSymbols(source)
  }
}

function extractImports(source: string): string[] {
  const imports = new Set<string>()
  for (const match of source.matchAll(IMPORT_RE)) imports.add(match[1])
  for (const match of source.matchAll(SIDE_EFFECT_IMPORT_RE)) imports.add(match[1])
  return [...imports].slice(0, 20)
}

function extractSymbols(source: string): string[] {
  const symbols: string[] = []
  for (const match of source.matchAll(SYMBOL_RE)) symbols.push(`${match[1]} ${match[2]}`)
  for (const match of source.matchAll(NAMED_EXPORT_RE)) {
    const names = match[1]
      .split(',')
      .map((name) => name.trim().replace(/\s+as\s+.+$/i, ''))
      .filter(Boolean)
    for (const name of names) symbols.push(`export ${name}`)
  }
  return symbols.slice(0, 40)
}

function formatOutline(outline: FileOutline): string {
  return [
    outline.path,
    outline.imports.length ? `  imports: ${outline.imports.join(', ')}` : '  imports: (none)',
    outline.symbols.length ? `  exports: ${outline.symbols.join(', ')}` : '  exports: (none)'
  ].join('\n')
}

function normalizeMaxFiles(maxFiles?: number): number {
  if (maxFiles === undefined || !Number.isFinite(maxFiles)) return MAX_OUTLINE_FILES
  return Math.max(1, Math.min(Math.floor(maxFiles), MAX_OUTLINE_FILES))
}
