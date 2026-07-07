import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkspaceToolFactory } from './types'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { runReadTool } from './helpers'

const MAX_FILE_BYTES = 60 * 1024
const MAX_LIST_ENTRIES = 300
const MAX_FIND_RESULTS = 200
const MAX_SEARCH_RESULTS = 100
const SEARCH_HARD_CAP = 200
const MAX_RANGE_LINES = 200
const MAX_FILES_BATCH = 20
const MAX_BATCH_TOTAL_BYTES = 200 * 1024

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
const TEXT_EXT =
  /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|env|csv|html?|css|s[ac]ss|less|jsx?|tsx?|mjs|cjs|vue|svelte|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|bash|ps1|sql|xml|dockerfile|lock)$/i

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
      'Read a UTF-8 text file within the workspace. Very large files are truncated — prefer read_file_range to page through one.',
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
        touch: { path: args.path, action: 'read' },
        async run() {
          const file = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const info = await stat(file)
          if (!info.isFile()) throw new Error('Path is not a file.')
          const raw = await readFile(file, 'utf-8')
          // No truncation here: `runReadTool`'s own MAX_MODEL_RESULT_CHARS cap
          // already applies to every read tool's result uniformly. Truncating
          // here too (as this used to) compounded with that outer cap on a
          // large file — the outer layer would then re-truncate this already-
          // truncated-and-annotated string, reporting a meaningless
          // intermediate length instead of the real file size.
          return {
            modelResult: raw,
            detail: `${countLines(raw)} lines`
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
    description: `Read a specific range of lines from a text file. Lines are 1-indexed and inclusive. Returns at most ${MAX_RANGE_LINES} lines per call regardless of endLine — for a longer file, call this repeatedly with successive ranges.`,
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
    handler: (args: { path: string; startLine: number; endLine?: number }) =>
      runReadTool(ctx, {
        name: 'read_file_range',
        kind: 'read',
        title: `Read ${args.path} lines ${args.startLine}-${args.endLine ?? '…'}`,
        touch: { path: args.path, action: 'read' },
        async run() {
          const file = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const info = await stat(file)
          if (!info.isFile()) throw new Error('Path is not a file.')
          const raw = await readFile(file, 'utf-8')
          const lines = raw.split('\n')
          const start = Math.max(1, Math.floor(args.startLine))
          // Cap the returned range to MAX_RANGE_LINES even when the model
          // supplies an explicit endLine — an unbounded or wildly oversized
          // endLine (seen live: 1e15) would otherwise return everything up to
          // the actual end of file in one call, defeating the point of a
          // "range" read and blowing up context on a large file.
          const requestedEnd =
            args.endLine !== undefined ? Math.floor(args.endLine) : start + MAX_RANGE_LINES - 1
          const end = Math.min(lines.length, requestedEnd, start + MAX_RANGE_LINES - 1)
          if (start > lines.length)
            throw new Error(`Start line ${start} is beyond the file's ${lines.length} lines.`)
          const selected = lines.slice(start - 1, end)
          const content = selected.join('\n')
          return {
            modelResult: content,
            detail: `lines ${start}-${start + selected.length - 1}`
          }
        }
      })
  })

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
          description: 'File paths relative to the workspace root.'
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
        touch: readTouches,
        async run() {
          const paths = args.paths.slice(0, MAX_FILES_BATCH)
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
                  `--- ${relativePath} ---\nError: File exceeds ${MAX_FILE_BYTES} byte limit.`
                )
                continue
              }
              if (totalBytes + info.size > MAX_BATCH_TOTAL_BYTES) {
                results.push(
                  `--- ${relativePath} ---\nError: Skipped to keep total batch size under ${MAX_BATCH_TOTAL_BYTES} bytes.`
                )
                continue
              }
              const content = await readFile(file, 'utf-8')
              totalBytes += content.length
              results.push(`--- ${relativePath} ---\n${content}`)
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
