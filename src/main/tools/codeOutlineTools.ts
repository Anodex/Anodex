import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkspaceToolFactory } from './types'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { runReadTool } from './helpers'
import { SKIP_DIRS } from './fileTools'

const MAX_OUTLINE_FILES = 40
const MAX_FILE_BYTES = 180 * 1024
const MAX_LISTED_EXTENSIONS = 6
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

/** What a scan found: files this tool can map, and what it passed over. */
interface CodeFileScan {
  files: string[]
  /** Extension to count, for everything this tool cannot map. */
  others: Map<string, number>
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
      'Return a compact JavaScript/TypeScript code map for a file or folder: imports and exported top-level symbols. Use before reading whole source files to orient on project structure cheaply.',
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
        args,
        async run() {
          const requested = args.path?.trim() || '.'
          const root = resolveInWorkspace(ctx.workspaceRoot, requested)
          const maxFiles = normalizeMaxFiles(args.maxFiles)
          const scan = await collectCodeFiles(root, maxFiles)
          const outlines = await Promise.all(
            scan.files.map((file) => outlineFile(ctx.workspaceRoot, file))
          )
          const body = outlines.length
            ? outlines.map(formatOutline).join('\n\n')
            : describeNothingToOutline(scan.others)
          return {
            modelResult: body,
            detail: `${outlines.length} file${outlines.length === 1 ? '' : 's'}`
          }
        }
      })
  })

/**
 * Tell the model what is really there when nothing could be outlined.
 *
 * This tool maps JavaScript and TypeScript only, and used to answer any other
 * project with "No source files found." That is false in a Python, Go, or Rust
 * repository, and it reads as "there is no code here" rather than "this tool
 * does not speak that language" - so a model is told its project is empty and
 * given no hint that another tool would have worked.
 *
 * Measured on a live run: a 4B model called `code_outline` on a Python project,
 * was told there were no source files, and spent its next twenty calls hunting
 * for code that `read_file_range` had already shown it.
 *
 * Extensions are counted, not classified. Deciding which of them are "really"
 * source would need a list of languages to keep current, and being wrong about
 * exactly that is how this failed in the first place; a plain count of what was
 * passed over is true in any language and needs no maintenance.
 */
function describeNothingToOutline(others: Map<string, number>): string {
  if (others.size === 0) return 'No source files found.'
  const listed = [...others.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_LISTED_EXTENSIONS)
    .map(([ext, count]) => `${count} ${ext}`)
    .join(', ')
  return (
    'No JavaScript or TypeScript files here, and code_outline maps only those. ' +
    `There are other files present (${listed}), so this location is not empty. ` +
    'Use search_files to locate a symbol in them, or read_file_range to read one.'
  )
}

async function collectCodeFiles(start: string, maxFiles: number): Promise<CodeFileScan> {
  const scan: CodeFileScan = { files: [], others: new Map() }
  const info = await stat(start)
  if (info.isFile()) {
    if (CODE_FILE_EXT.test(start) && info.size <= MAX_FILE_BYTES) scan.files.push(start)
    else noteOther(scan, start)
    return scan
  }

  await walk(start, scan, maxFiles)
  return scan
}

/** Record the extension of a file this tool cannot map. */
function noteOther(scan: CodeFileScan, name: string): void {
  const dot = name.lastIndexOf('.')
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  const ext = dot > slash + 1 ? name.slice(dot).toLowerCase() : '(no extension)'
  scan.others.set(ext, (scan.others.get(ext) ?? 0) + 1)
}

async function walk(dir: string, scan: CodeFileScan, maxFiles: number): Promise<void> {
  if (scan.files.length >= maxFiles) return
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (scan.files.length >= maxFiles) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(full, scan, maxFiles)
      continue
    }
    if (!CODE_FILE_EXT.test(entry.name)) {
      noteOther(scan, entry.name)
      continue
    }
    const info = await stat(full)
    if (info.size <= MAX_FILE_BYTES) scan.files.push(full)
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
