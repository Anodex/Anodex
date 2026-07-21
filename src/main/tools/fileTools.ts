import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { TEXT_EXT } from '@shared/textFileExtensions'
import type { WorkspaceToolFactory } from './types'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { runReadTool } from './helpers'
import { clampModelResultCap } from './modelResultBudget'

/**
 * Disk-safety ceiling only — how much of a file `read_file`/`read_file_range`
 * are willing to read off disk at all. This is NOT how much of that content
 * reaches the model: `modelResultCap` below is clamped down further, per
 * call, to the active turn's real measured context budget when one is known
 * (see `ToolRuntimeContext.modelResultBudget`). A large local project file
 * can safely exceed this on disk; only the text injected into the exchange
 * is bounded by the runtime budget.
 */
const MAX_FILE_BYTES = 60 * 1024
/** Reserved out of the per-result char budget for read_file_range's own header/continuation line. */
const RANGE_HEADER_RESERVE_CHARS = 200
const MAX_LIST_ENTRIES = 300
const MAX_FIND_RESULTS = 200
const MAX_SEARCH_RESULTS = 100
const SEARCH_HARD_CAP = 200
const MAX_RANGE_LINES = 200
const MAX_FILES_BATCH = 20
const MAX_BATCH_TOTAL_BYTES = 200 * 1024

export interface ReadFileRangeArgs {
  path: string
  startLine: number
  endLine?: number
}

/** Canonicalize every request to the range the tool can actually return. */
export function normalizeReadFileRangeArgs(args: ReadFileRangeArgs): Required<ReadFileRangeArgs> {
  const startLine = Number.isFinite(args.startLine) ? Math.max(1, Math.floor(args.startLine)) : 1
  const maximumEnd = startLine + MAX_RANGE_LINES - 1
  const requestedEnd =
    args.endLine !== undefined && Number.isFinite(args.endLine)
      ? Math.floor(args.endLine)
      : maximumEnd
  return {
    path: args.path.replaceAll('\\', '/').replace(/^\.\//, ''),
    startLine,
    endLine: Math.max(startLine, Math.min(requestedEnd, maximumEnd))
  }
}

export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  '.cache',
  'build',
  '.turbo'
])

/** list_directory — enumerate a folder inside the workspace. */
export const listDirectoryTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description: 'List files and folders at a path within the workspace. Use "." for the root.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to the workspace root.' }
      }
    } as const,
    handler: (args: { path?: string }) => {
      const requested = args.path?.trim() || '.'
      return runReadTool(ctx, {
        name: 'list_directory',
        kind: 'read',
        title: `List ${requested}`,
        args,
        async run() {
          const dir = resolveInWorkspace(ctx.workspaceRoot, requested)
          const entries = await readdir(dir, { withFileTypes: true })
          const sorted = entries
            .sort((a, b) => {
              if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
              return a.name.localeCompare(b.name)
            })
            .slice(0, MAX_LIST_ENTRIES)

          const lines = await Promise.all(
            sorted.map(async (entry) => {
              if (entry.isDirectory()) return `${entry.name}/`
              try {
                const info = await stat(join(dir, entry.name))
                return `${entry.name} (${info.size} bytes)`
              } catch {
                return entry.name
              }
            })
          )

          const overflow =
            entries.length > MAX_LIST_ENTRIES ? `\n… ${entries.length - MAX_LIST_ENTRIES} more` : ''
          const body = lines.length ? lines.join('\n') : '(empty)'
          return {
            modelResult: `${toWorkspaceRelative(ctx.workspaceRoot, dir)}:\n${body}${overflow}`,
            detail: `${entries.length} entries`
          }
        }
      })
    }
  })

/** read_file — read a UTF-8 text file inside the workspace. */
export const readFileTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Read a UTF-8 text file within the workspace. A file too large for the active context returns metadata and a recommendation (code_outline, search_files, or read_file_range) instead of a truncated blob.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' }
      },
      required: ['path']
    } as const,
    handler: (args: { path: string }) =>
      runReadTool(ctx, {
        name: 'read_file',
        kind: 'read',
        title: `Read ${args.path}`,
        args,
        touch: { path: args.path, action: 'read' },
        // Full file content, not a bounded summary — cap at the disk-safety
        // limit (MAX_FILE_BYTES), not the much tighter generic 4000-char
        // default. `run()` below decides itself whether the file actually
        // fits the active runtime budget; this is only the outer backstop.
        modelResultCap: MAX_FILE_BYTES,
        async run() {
          const file = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const info = await stat(file)
          if (!info.isFile()) throw new Error('Path is not a file.')
          const raw = await readFile(file, 'utf-8')
          const charBudget = clampModelResultCap(MAX_FILE_BYTES, ctx.modelResultBudget.current)
          const lineCount = countLines(raw)
          // A file that doesn't fit the active context is a disk-oriented
          // byte cap bypassing the real budget waiting to happen — return an
          // honest, actionable pointer instead of a silently truncated blob
          // the model would mistake for the whole file (and then fail
          // edit_file/patch_file with "text not found" against content it
          // never actually read).
          if (raw.length > charBudget) {
            return {
              modelResult:
                `${toWorkspaceRelative(ctx.workspaceRoot, file)}: ${info.size} bytes, ${lineCount} lines. ` +
                'Too large for the active context to return in full.\n' +
                'Use code_outline for its structure, search_files to locate a section, or read_file_range to page through specific lines.',
              detail: `${info.size} bytes (too large; see recommendation)`
            }
          }
          return {
            modelResult: raw,
            detail: `${lineCount} lines`
          }
        }
      })
  })

/** search_files — case-insensitive text search across the workspace. */
export const searchFilesTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Search text files in the workspace for a query string (case-insensitive). Returns file:line matches.',
    params: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
        path: { type: 'string', description: 'Optional subdirectory to search within.' }
      },
      required: ['query']
    } as const,
    handler: (args: { query: string; path?: string }) =>
      runReadTool(ctx, {
        name: 'search_files',
        kind: 'read',
        title: `Search "${args.query}"`,
        args,
        async run() {
          const start = resolveInWorkspace(ctx.workspaceRoot, args.path?.trim() || '.')
          const results: string[] = []
          await walk(start, ctx.workspaceRoot, args.query.toLowerCase(), results)
          const shown = results.slice(0, MAX_SEARCH_RESULTS)
          const overflow =
            results.length > MAX_SEARCH_RESULTS
              ? `\n… ${results.length - MAX_SEARCH_RESULTS} more matches`
              : ''
          return {
            modelResult: (shown.length ? shown.join('\n') : 'No matches found.') + overflow,
            detail: `${results.length} matches`
          }
        }
      })
  })

/** find_files - find files or folders by path/name without reading contents. */
export const findFilesTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Find files and folders by path or filename in the workspace. Supports plain substring queries and simple * / ? wildcards.',
    params: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Filename/path substring or wildcard pattern, e.g. "*.test.ts" or "Settings".'
        },
        path: { type: 'string', description: 'Optional subdirectory to search within.' },
        includeDirectories: {
          type: 'boolean',
          description: 'Include matching directories in the results. Defaults to true.'
        }
      },
      required: ['query']
    } as const,
    handler: (args: { query: string; path?: string; includeDirectories?: boolean }) =>
      runReadTool(ctx, {
        name: 'find_files',
        kind: 'read',
        title: `Find "${args.query}"`,
        args,
        async run() {
          const query = args.query.trim()
          if (!query) throw new Error('query was empty.')

          const start = resolveInWorkspace(ctx.workspaceRoot, args.path?.trim() || '.')
          const results: string[] = []
          const matcher = createPathMatcher(query)
          await walkNames(
            start,
            ctx.workspaceRoot,
            matcher,
            args.includeDirectories !== false,
            results
          )

          const shown = results.slice(0, MAX_FIND_RESULTS)
          const overflow =
            results.length > MAX_FIND_RESULTS
              ? `\n... ${results.length - MAX_FIND_RESULTS} more matches`
              : ''
          return {
            modelResult: (shown.length ? shown.join('\n') : 'No matching paths found.') + overflow,
            detail: `${results.length} matches`
          }
        }
      })
  })

/** get_file_info - metadata about a file or directory in the workspace. */
export const getFileInfoTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Get metadata about a file or directory in the workspace: size, type, modification time, and line count for text files.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' }
      },
      required: ['path']
    } as const,
    handler: (args: { path: string }) =>
      runReadTool(ctx, {
        name: 'get_file_info',
        kind: 'read',
        title: `Info ${args.path}`,
        args,
        async run() {
          const target = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const info = await stat(target)
          const lineCount =
            info.isFile() && TEXT_EXT.test(target)
              ? countLines(await readFile(target, 'utf-8'))
              : null
          const summary = {
            path: toWorkspaceRelative(ctx.workspaceRoot, target),
            exists: true,
            isDirectory: info.isDirectory(),
            isFile: info.isFile(),
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
            createdAt: info.birthtime.toISOString(),
            lineCount
          }
          return {
            modelResult: JSON.stringify(summary, null, 2),
            detail: `${info.size} bytes`
          }
        }
      })
  })

/** read_file_range — read a specific 1-indexed line range from a text file. */
export const readFileRangeTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description: `Read a specific range of lines from a text file. Lines are 1-indexed and inclusive. Returns at most ${MAX_RANGE_LINES} lines per call regardless of endLine; oversized or non-finite endLine values are equivalent to startLine + ${MAX_RANGE_LINES - 1}. The result states the next startLine for longer files.`,
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        startLine: { type: 'number', description: 'First line to read (1-indexed).' },
        endLine: {
          type: 'number',
          description: `Last line to read (1-indexed). Optional — if omitted, or if this range spans more than ${MAX_RANGE_LINES} lines, reads only the first ${MAX_RANGE_LINES} lines from startLine.`
        }
      },
      required: ['path', 'startLine']
    } as const,
    handler: (args: ReadFileRangeArgs) => {
      const normalized = normalizeReadFileRangeArgs(args)
      return runReadTool(ctx, {
        name: 'read_file_range',
        kind: 'read',
        title: `Read ${normalized.path} lines ${normalized.startLine}-${normalized.endLine}`,
        args: normalized,
        touch: { path: normalized.path, action: 'read' },
        // See read_file's modelResultCap comment — this is the outer
        // backstop; `run()` below already bounds itself to the real runtime
        // budget along complete line boundaries, so this should rarely fire.
        modelResultCap: MAX_FILE_BYTES,
        async run() {
          const file = resolveInWorkspace(ctx.workspaceRoot, normalized.path)
          const info = await stat(file)
          if (!info.isFile()) throw new Error('Path is not a file.')
          const raw = await readFile(file, 'utf-8')
          const lines = raw.split('\n')
          const start = normalized.startLine
          if (start > lines.length)
            throw new Error(`Start line ${start} is beyond the file's ${lines.length} lines.`)
          const requestedEnd = Math.min(lines.length, normalized.endLine)
          const requestedLines = lines.slice(start - 1, requestedEnd)
          const charBudget = Math.max(
            0,
            clampModelResultCap(MAX_FILE_BYTES, ctx.modelResultBudget.current) -
              RANGE_HEADER_RESERVE_CHARS
          )
          const { includedLines, partialLastLine } = boundLinesToCharBudget(
            requestedLines,
            charBudget
          )
          const actualEnd = start + includedLines.length - 1
          const content = includedLines.join('\n')
          const continuation = actualEnd < lines.length ? ` Next startLine: ${actualEnd + 1}.` : ''
          const partialNote = partialLastLine
            ? ' The last line included was too long to fit whole and was cut short — it is not complete.'
            : ''
          return {
            modelResult:
              `[${normalized.path}: lines ${start}-${actualEnd} of ${lines.length}.${continuation}${partialNote}]\n` +
              content,
            detail: `lines ${start}-${actualEnd}`
          }
        }
      })
    }
  })

/**
 * Select the largest prefix of complete lines that fits `charBudget`
 * (joining newlines counted). A single line that alone exceeds the whole
 * budget is still returned, truncated, with `partialLastLine: true` — never
 * silently reporting zero lines back, but never claiming a cut line is whole.
 */
function boundLinesToCharBudget(
  lines: string[],
  charBudget: number
): { includedLines: string[]; partialLastLine: boolean } {
  if (charBudget <= 0) return { includedLines: [], partialLastLine: false }
  const included: string[] = []
  let used = 0
  for (const line of lines) {
    const separator = included.length > 0 ? 1 : 0
    if (used + separator + line.length <= charBudget) {
      included.push(line)
      used += separator + line.length
      continue
    }
    if (included.length === 0) {
      included.push(line.slice(0, charBudget))
      return { includedLines: included, partialLastLine: true }
    }
    break
  }
  return { includedLines: included, partialLastLine: false }
}

/** read_multiple_files — read several text files in a single call. */
export const readMultipleFilesTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description: `Read up to ${MAX_FILES_BATCH} text files in one call. Returns the contents of each readable file; unreadable files are listed with their error.`,
    params: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_FILES_BATCH,
          description: `Up to ${MAX_FILES_BATCH} file paths relative to the workspace root.`
        }
      },
      required: ['paths']
    } as const,
    handler: (args: { paths: string[] }) => {
      // Populated during run() and read afterward by runReadTool — only paths
      // actually read successfully get recorded, not the whole requested batch.
      const readTouches: { path: string; action: 'read' }[] = []
      return runReadTool(ctx, {
        name: 'read_multiple_files',
        kind: 'read',
        title: `Read ${args.paths.length} file(s)`,
        args,
        touch: readTouches,
        // See read_file's modelResultCap comment — this tool already budgets
        // its own MAX_BATCH_TOTAL_BYTES across files (further clamped to the
        // active runtime budget in run() below); don't let the generic
        // 4000-char cap re-truncate that down to a near-useless prefix.
        modelResultCap: MAX_BATCH_TOTAL_BYTES,
        async run() {
          const paths = args.paths.slice(0, MAX_FILES_BATCH)
          // The active runtime budget, allocated evenly across the batch up
          // front — deterministic and simple, rather than first-come-first-
          // served exhausting the budget before later files get anything.
          const totalCharBudget = clampModelResultCap(
            MAX_BATCH_TOTAL_BYTES,
            ctx.modelResultBudget.current
          )
          const perFileShare = Math.max(0, Math.floor(totalCharBudget / Math.max(1, paths.length)))
          const results: string[] = []
          let totalBytes = 0
          for (const relativePath of paths) {
            try {
              const file = resolveInWorkspace(ctx.workspaceRoot, relativePath)
              const info = await stat(file)
              if (!info.isFile()) {
                results.push(`--- ${relativePath} ---\nError: Path is not a file.`)
                continue
              }
              if (info.size > MAX_FILE_BYTES) {
                results.push(
                  `--- ${relativePath} ---\nError: File exceeds ${MAX_FILE_BYTES} byte disk-read limit.`
                )
                continue
              }
              if (perFileShare <= 0) {
                results.push(
                  `--- ${relativePath} ---\nError: Skipped — no room left in the active context for this batch.`
                )
                continue
              }
              const content = await readFile(file, 'utf-8')
              totalBytes += content.length
              const lines = content.split('\n')
              const { includedLines, partialLastLine } = boundLinesToCharBudget(lines, perFileShare)
              const bounded = includedLines.join('\n')
              const wasTruncated = includedLines.length < lines.length || partialLastLine
              const header = wasTruncated
                ? `--- ${relativePath} (showing ${includedLines.length} of ${lines.length} lines; use read_file_range for the rest) ---`
                : `--- ${relativePath} ---`
              results.push(`${header}\n${bounded}`)
              readTouches.push({ path: relativePath, action: 'read' })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              results.push(`--- ${relativePath} ---\nError: ${message}`)
            }
          }
          return {
            modelResult: results.join('\n\n'),
            detail: `${paths.length} files, ${totalBytes} bytes`
          }
        }
      })
    }
  })

/** Recursively scan text files, collecting matching lines (bounded). */
async function walk(dir: string, root: string, needle: string, results: string[]): Promise<void> {
  if (results.length >= SEARCH_HARD_CAP) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (results.length >= SEARCH_HARD_CAP) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(full, root, needle, results)
      continue
    }
    if (!TEXT_EXT.test(entry.name)) continue
    try {
      const info = await stat(full)
      if (info.size > MAX_FILE_BYTES * 4) continue
      const lines = (await readFile(full, 'utf-8')).split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          results.push(
            `${toWorkspaceRelative(root, full)}:${i + 1}: ${lines[i].trim().slice(0, 160)}`
          )
          if (results.length >= SEARCH_HARD_CAP) break
        }
      }
    } catch {
      /* Unreadable file — skip. */
    }
  }
}

async function walkNames(
  dir: string,
  root: string,
  matches: (path: string) => boolean,
  includeDirectories: boolean,
  results: string[]
): Promise<void> {
  if (results.length >= MAX_FIND_RESULTS * 2) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (results.length >= MAX_FIND_RESULTS * 2) return
    const full = join(dir, entry.name)
    const relativePath = toWorkspaceRelative(root, full)
    if (entry.isDirectory()) {
      if (includeDirectories && matches(relativePath)) results.push(`${relativePath}/`)
      if (!SKIP_DIRS.has(entry.name))
        await walkNames(full, root, matches, includeDirectories, results)
      continue
    }
    if (matches(relativePath)) results.push(relativePath)
  }
}

function createPathMatcher(query: string): (path: string) => boolean {
  const normalizedQuery = query.replace(/\\/g, '/').toLowerCase()
  if (!/[*?]/.test(normalizedQuery)) {
    return (path) => path.toLowerCase().includes(normalizedQuery)
  }

  const regex = new RegExp(
    `^${escapeRegex(normalizedQuery).replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`,
    'i'
  )
  return (path) => regex.test(path.replace(/\\/g, '/'))
}

function escapeRegex(text: string): string {
  return text.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
}

function countLines(text: string): number {
  if (text.length === 0) return 0
  return text.split('\n').length
}
