import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isTextFile } from '@shared/textFileExtensions'
import { describeWorkspaceError } from './workspaceErrors'
import { isSkippedDirectory } from '@shared/skipDirectories'
import type { WorkspaceToolFactory } from './types'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { runReadTool } from './helpers'
import { clampModelResultCap, type ModelToolResultBudget } from './modelResultBudget'

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
/**
 * A file at or above this many lines is large enough that paging through it
 * one `MAX_RANGE_LINES`-sized call at a time is expensive — a live retest
 * read two files of 2,352 and 1,109 lines to completion this way, consuming
 * 84 tool calls and the full bounded-task time budget on just those two
 * files. `code_outline` already exists and is already described as "use
 * before reading whole source files," but nothing surfaced that suggestion
 * at the moment it would actually help: the first read of a large file.
 */
const LARGE_FILE_SUGGEST_OUTLINE_LINES = 500
/**
 * At most this many genuinely-new `read_file_range` calls against the same
 * file before further ones are redirected instead of served — a live retest
 * showed the `code_outline`-first suggestion alone (see
 * `LARGE_FILE_SUGGEST_OUTLINE_LINES`) is not reliably followed: a run read a
 * single 2,352-line file across 15+ consecutive calls, methodically paging
 * from line 1 to the end, and never touched any of the other 11+ files a
 * 12-file audit needed. A soft one-time suggestion clearly isn't enough on
 * its own; this is the deterministic backstop. 6 calls is a substantial
 * single-file allowance (roughly 900-1,200 lines at this tool's per-call
 * cap) before it takes effect, so ordinary deep-dive reads on one important
 * file are unaffected — this only fires once a file has already consumed
 * well more than its fair share of one bounded task's tool-call budget.
 */
const MAX_SAME_FILE_READS = 6
/**
 * Hard ceiling on how large a file `read_file_range`/`get_file_info` will
 * pull into memory at all (both need the whole decoded text to count/slice
 * lines). Far above any real source file — a 10 MB source file is ~200k
 * lines — this exists purely so pointing a line-oriented tool at a huge
 * artifact (a giant log, a bundled blob) degrades to an honest redirect
 * instead of decoding gigabytes into the main process.
 */
const MAX_LINE_TOOL_SOURCE_BYTES = 10 * 1024 * 1024
/**
 * UTF-8 never decodes to fewer than one UTF-16 code unit per 3 bytes (2-
 * and 3-byte sequences → one unit; 4-byte sequences → two), so a file whose
 * byte size exceeds 3× the character budget cannot possibly fit — usable to
 * reject a file on `stat` alone, without first reading it into memory.
 */
const MAX_UTF8_BYTES_PER_CHAR = 3

export interface ReadFileRangeArgs {
  path: string
  startLine: number
  endLine?: number
}

/**
 * Source lines assumed per character when sizing a request against the char
 * budget. Deliberately generous — over-estimating the line count costs
 * nothing, because `boundLinesToCharBudget` trims the response to what
 * actually fits, while under-estimating spends a whole extra round trip.
 */
const APPROX_CHARS_PER_LINE = 40

/**
 * Lines one call may ask for, scaled to the room this turn actually has.
 *
 * The cap used to be a flat 200 regardless of hardware, while the *result*
 * budget scaled with the context window. On a large context that made the line
 * cap — not memory — the binding constraint, so a model paged through a file
 * 200 lines at a time when its budget could have carried a thousand. The cost
 * is round trips, and they are the expensive part: this file's own history
 * records two files taking 84 tool calls and an entire 15-minute budget to
 * read.
 *
 * Safe to raise because it was never the real limit. The handler still trims
 * the response to the measured character budget along whole line boundaries,
 * so a request larger than the room simply comes back shorter, exactly as a
 * 200-line request already did. The floor keeps small contexts behaving as
 * before; the ceiling keeps one call from claiming an unreasonable share.
 */
export function maxRangeLinesFor(budget: ModelToolResultBudget | null): number {
  if (!budget) return MAX_RANGE_LINES
  const chars = Math.max(
    0,
    clampModelResultCap(MAX_FILE_BYTES, budget) - RANGE_HEADER_RESERVE_CHARS
  )
  const affordable = Math.floor(chars / APPROX_CHARS_PER_LINE)
  return Math.max(MAX_RANGE_LINES, Math.min(affordable, MAX_RANGE_LINES_CEILING))
}

/** Upper bound on a single range request, however much room a turn has. */
const MAX_RANGE_LINES_CEILING = 2_000

/** Canonicalize every request to the range the tool can actually return. */
export function normalizeReadFileRangeArgs(
  args: ReadFileRangeArgs,
  maxLines: number = MAX_RANGE_LINES
): Required<ReadFileRangeArgs> {
  const startLine = Number.isFinite(args.startLine) ? Math.max(1, Math.floor(args.startLine)) : 1
  const maximumEnd = startLine + Math.max(1, maxLines) - 1
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

export { SKIP_DIRS } from '@shared/skipDirectories'

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
          // Coverage is only trusted after reconciling with the file's
          // current mtime — a file changed since it was read (a run_command
          // side effect, the user's own editor) must be served fresh, not
          // short-circuited against stale coverage. The stat this costs is
          // trivial next to serving wrong "already read" answers.
          ctx.ledger.reads.reconcileMtime(file, info.mtimeMs)
          // Already read in full earlier this bounded task (a prior cycle or
          // turn) and unchanged since — see `ReadCoverageTracker`'s doc
          // comment. Skip the content read and the redundant context growth
          // entirely rather than silently reproducing identical content a
          // second time.
          // A file already read in full is deliberately *not* refused here.
          //
          // This used to answer with "nothing new here", then with a pointer to
          // stored evidence. Both are dead ends dressed differently: the model
          // asks again precisely because the content was evicted, and the copy
          // it gets pointed at is the one that was already stale. A live run
          // spent 39% of 156 calls recalling, and still had four edits rejected
          // for line numbers that had moved under an earlier edit of its own.
          //
          // Serving the read is cheap now and self-correcting: identical reads
          // collapse to the newest in `projectHistoryForModel`, so repeating one
          // cannot compound context, and what comes back reflects the file as it
          // is rather than as it was. Runaway repetition is still bounded by the
          // loop guard's abort and by the gathering ladder.
          const charBudget = clampModelResultCap(MAX_FILE_BYTES, ctx.modelResultBudget.current)
          // Rejectable on byte size alone (see MAX_UTF8_BYTES_PER_CHAR) —
          // return the honest pointer without pulling a potentially huge
          // file into memory first. Files under this bound still get the
          // exact character check below after a bounded read.
          if (info.size > charBudget * MAX_UTF8_BYTES_PER_CHAR) {
            return {
              modelResult:
                `${toWorkspaceRelative(ctx.workspaceRoot, file)}: ${info.size} bytes. ` +
                'Too large for the active context to return in full.\n' +
                'Use code_outline for its structure, search_files to locate a section, or read_file_range to page through specific lines.',
              detail: `${info.size} bytes (too large; see recommendation)`
            }
          }
          const raw = await readFile(file, 'utf-8')
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
          ctx.ledger.reads.recordFullFile(file)
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
          // `find_files` already rejects this; without the same guard here an
          // empty needle matched every line of every text file and returned
          // whatever 100 the walk happened to reach first.
          const query = args.query.trim()
          if (!query) throw new Error('query was empty.')

          const start = resolveInWorkspace(ctx.workspaceRoot, args.path?.trim() || '.')
          const results: string[] = []
          await walk(start, ctx.workspaceRoot, query.toLowerCase(), results)
          const shown = results.slice(0, MAX_SEARCH_RESULTS)
          // The walk itself stops at `SEARCH_HARD_CAP`, so once it is reached
          // the count is a floor rather than a total — reporting it bare told
          // the model there were exactly 100 more when there might be
          // thousands, which is the difference between "nearly done" and
          // "narrow your query".
          const capped = results.length >= SEARCH_HARD_CAP
          const overflow =
            results.length > MAX_SEARCH_RESULTS
              ? `\n… ${results.length - MAX_SEARCH_RESULTS}${capped ? '+' : ''} more matches` +
                (capped ? ' (search stopped early; narrow the query or the path)' : '')
              : ''
          return {
            modelResult: (shown.length ? shown.join('\n') : 'No matches found.') + overflow,
            detail: `${results.length}${capped ? '+' : ''} matches`
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
          // Same floor-not-total caveat as `search_files` — the walk stops at
          // twice the display cap.
          const capped = results.length >= MAX_FIND_RESULTS * 2
          const overflow =
            results.length > MAX_FIND_RESULTS
              ? `\n... ${results.length - MAX_FIND_RESULTS}${capped ? '+' : ''} more matches` +
                (capped ? ' (scan stopped early; narrow the query or the path)' : '')
              : ''
          return {
            modelResult: (shown.length ? shown.join('\n') : 'No matching paths found.') + overflow,
            detail: `${results.length}${capped ? '+' : ''} matches`
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
          // Line-counting decodes the whole file — skipped above the same
          // in-memory bound the line-range tool enforces; metadata stays
          // useful (size/type/mtime) with lineCount honestly null.
          const lineCount =
            info.isFile() && isTextFile(target) && info.size <= MAX_LINE_TOOL_SOURCE_BYTES
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
    description: `Read a specific range of lines from a text file. Lines are 1-indexed and inclusive. Returns as many lines as this turn's remaining context allows — at least ${MAX_RANGE_LINES}, more on a large context — so ask for the whole range you need rather than paging in fixed steps. The result states the next startLine when more remains.`,
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        startLine: { type: 'number', description: 'First line to read (1-indexed).' },
        endLine: {
          type: 'number',
          description: `Last line to read (1-indexed). Optional. A range larger than the turn's remaining room is served from startLine as far as it reaches, and the result says where to continue.`
        }
      },
      required: ['path', 'startLine']
    } as const,
    handler: (args: ReadFileRangeArgs) => {
      const normalized = normalizeReadFileRangeArgs(
        args,
        maxRangeLinesFor(ctx.modelResultBudget.current)
      )
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
          // A vanished or unreadable path is the commonest way a read fails,
          // and Node's own message names an errno and the host's absolute path
          // while saying nothing about what to do — see `describeWorkspaceError`.
          const info = await stat(file).catch((error: unknown) => {
            throw new Error(describeWorkspaceError(error, normalized.path))
          })
          if (!info.isFile()) throw new Error('Path is not a file.')
          // See read_file's identical comment — coverage is only trusted
          // after reconciling with the file's current mtime, so a file
          // changed out-of-band is served fresh instead of short-circuited.
          ctx.ledger.reads.reconcileMtime(file, info.mtimeMs)
          // Already read in full, or this exact range already returned
          // earlier this bounded task (a prior continuation cycle or agent
          // turn, possibly since folded into a compaction summary that no
          // longer states it precisely) and unchanged since — see
          // `ReadCoverageTracker`'s doc comment. Trim the request down to
          // only what's genuinely new before reading content, rather than
          // re-serving (and re-growing context with) covered territory.
          // Coverage no longer refuses, and no longer trims the request down to
          // its uncovered gaps. The model is asking because its copy is gone or
          // has moved under an edit of its own, so serving half the range — the
          // part the tracker happens to think is new — hands back something
          // that does not line up with what it asked for. It gets what it asked
          // for, and `projectHistoryForModel` collapses the duplicate so
          // serving it costs nothing that lasts.
          // A genuinely new range, but this file alone has already consumed
          // its fair share of one bounded task's read budget — redirect
          // instead of serving more, deterministically, since the softer
          // code_outline suggestion below is not reliably followed on its
          // own. Counted only for a real, new-content attempt (not the
          // already-covered case above), so exact duplicates don't count
          // twice toward this cap.
          const attemptCount = ctx.ledger.reads.recordReadAttempt(file)
          if (attemptCount > MAX_SAME_FILE_READS) {
            return {
              modelResult: `[${normalized.path}: this is read attempt ${attemptCount} on this same file this task.]\nThe request needs coverage across many files, not exhaustive depth on one — move to a different file now. If you need to find something specific in this file later, use search_files or code_outline instead of paging through it further.`,
              detail: `Redirected after ${attemptCount - 1} reads of this file`,
              madeProgress: false
            }
          }
          // Captured before this call records its own coverage below — used
          // only to decide whether to suggest `code_outline` on what turns
          // out to be the FIRST read of a large file, not on every call.
          const isFirstReadOfThisFile = !ctx.ledger.reads.hasAnyCoverage(file)
          const target = { start: normalized.startLine, end: normalized.endLine }
          // Serving any line range requires decoding the whole file to split
          // it — bounded here so a huge artifact degrades to an honest
          // redirect instead of decoding gigabytes (see
          // MAX_LINE_TOOL_SOURCE_BYTES). run_command genuinely can slice
          // such a file; the workspace read tools cannot.
          if (info.size > MAX_LINE_TOOL_SOURCE_BYTES) {
            return {
              modelResult:
                `[${normalized.path}: ${info.size} bytes — beyond the ${MAX_LINE_TOOL_SOURCE_BYTES}-byte limit for line-range reads.]\n` +
                'Use run_command with a shell command that slices the specific lines you need instead.',
              detail: `${info.size} bytes (too large for line-range reads)`
            }
          }
          const raw = await readFile(file, 'utf-8')
          const lines = raw.split('\n')
          const start = target.start
          if (start > lines.length) {
            // `target` is the first *uncovered* segment, which can begin past
            // the end of the file when everything up to EOF has already been
            // served and the request asked for more (a model reading in fixed
            // 200-line strides walks straight into this on the last page).
            // Reporting it as a bad start line was misleading — the model then
            // retried with 319, 315, 310, each producing the identical error
            // against a range it had in fact already been given. The honest
            // answer is that there is nothing left.
            return {
              modelResult:
                `[${normalized.path}: the file has ${lines.length} lines and everything from line ` +
                `${normalized.startLine} onward was already read this task — there is nothing further to read.]`,
              detail: 'Already read to the end of the file',
              madeProgress: false
            }
          }
          const requestedEnd = Math.min(lines.length, target.end)
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
          if (includedLines.length === 0) {
            // Nothing fits at all. Falling through produced an inverted range
            // ("lines 5-4") with empty content, which reads as a file bug
            // rather than an exhausted budget.
            return {
              modelResult:
                `[${normalized.path}: no room left in the active context to return any of lines ${start}-${requestedEnd}.]\n` +
                'Summarize or act on what you already have before reading more.',
              detail: 'No context budget left',
              madeProgress: false
            }
          }
          const actualEnd = start + includedLines.length - 1
          const content = includedLines.join('\n')
          // Recorded before the continuation hint below is computed, so the
          // hint can see this call's own coverage merged in.
          //
          // A last line cut mid-way is deliberately NOT recorded: coverage is
          // what the model has actually seen, and marking a partial line
          // covered puts the rest of it permanently out of reach — every later
          // request for it short-circuits as "already read earlier this task".
          const coveredEnd = partialLastLine ? actualEnd - 1 : actualEnd
          if (coveredEnd >= start) ctx.ledger.reads.recordRange(file, start, coveredEnd)
          // Points at the next line NOT yet covered this task, not blindly at
          // `actualEnd + 1` — when a covered island sits just past this
          // call's end (an earlier cycle read it), the naive hint would send
          // the next call straight into an "already read" short-circuit,
          // wasting a round trip on exactly the multi-cycle tasks this
          // tracker exists for.
          const nextGap =
            actualEnd < lines.length
              ? ctx.ledger.reads.uncovered(file, actualEnd + 1, lines.length)[0]
              : undefined
          const continuation =
            actualEnd < lines.length
              ? nextGap
                ? ` Next startLine: ${nextGap.start}.`
                : ' Every remaining line was already read earlier this task.'
              : ''
          const partialNote = partialLastLine
            ? ' The last line included was too long to fit whole and was cut short — it is not complete. Use search_files to check specific content inside it.'
            : ''
          // Only note a skip when this call actually served something
          // narrower than what was requested — the common case (nothing
          // already covered) stays exactly as it read before this existed.
          const skippedNote =
            start !== normalized.startLine || target.end < normalized.endLine
              ? ` Lines ${normalized.startLine}-${normalized.endLine} were requested; only the first unread segment is shown because other portions overlap earlier reads.`
              : ''
          const budgetNote =
            actualEnd < target.end
              ? ' Output stopped at the active context budget; continue from Next startLine.'
              : ''
          // Surfaced once, on what turns out to be the first read of a large
          // file — not on every call, which would just repeat the same
          // advice on every page and eat into the content budget for no
          // benefit.
          const outlineSuggestion =
            isFirstReadOfThisFile && lines.length >= LARGE_FILE_SUGGEST_OUTLINE_LINES
              ? ` This file has ${lines.length} lines; consider code_outline first to locate the relevant section instead of reading it end to end.`
              : ''
          return {
            modelResult:
              `[${normalized.path}: lines ${start}-${actualEnd} of ${lines.length}.${continuation}${partialNote}${skippedNote}${budgetNote}${outlineSuggestion}]\n` +
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
          let madeProgress = false
          for (const relativePath of paths) {
            try {
              const file = resolveInWorkspace(ctx.workspaceRoot, relativePath)
              const info = await stat(file)
              if (!info.isFile()) {
                results.push(`--- ${relativePath} ---\nError: Path is not a file.`)
                continue
              }
              // See read_file's identical comment — reconcile before
              // trusting coverage, so a file changed out-of-band is served
              // fresh instead of short-circuited.
              ctx.ledger.reads.reconcileMtime(file, info.mtimeMs)
              // Already read in full earlier this bounded task and unchanged
              // since — see `ReadCoverageTracker`'s doc comment. Skip the
              // content read and the redundant context growth entirely.
              if (ctx.ledger.reads.isFullyCovered(file)) {
                results.push(
                  `--- ${relativePath} ---\n` +
                    'Already read in full earlier this task and unchanged since — nothing new ' +
                    'here. Read it on its own with read_file if you need the text back.'
                )
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
              madeProgress = true
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
              if (wasTruncated) {
                // Same rule as `read_file_range`: a last line cut mid-way is
                // not covered, or the rest of it can never be fetched.
                const completeLines = partialLastLine
                  ? includedLines.length - 1
                  : includedLines.length
                if (completeLines > 0) ctx.ledger.reads.recordRange(file, 1, completeLines)
              } else {
                ctx.ledger.reads.recordFullFile(file)
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              results.push(`--- ${relativePath} ---\nError: ${message}`)
            }
          }
          return {
            modelResult: results.join('\n\n'),
            detail: `${paths.length} files, ${totalBytes} bytes`,
            madeProgress
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
      if (!isSkippedDirectory(entry.name, toWorkspaceRelative(root, full))) {
        await walk(full, root, needle, results)
      }
      continue
    }
    if (!isTextFile(entry.name)) continue
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
      if (!isSkippedDirectory(entry.name, relativePath))
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

/**
 * Number of ignored coverage refusals before the response stops being a
 * cooperative note and starts being a failure.
 *
 * The original refusal was uniformly worded, returned a `success` status, and
 * therefore cost nothing to ignore — in chat
 * `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef` the model re-requested
 * already-served ranges **eleven consecutive times** while making no progress.
 * A single politely-worded message repeated eleven times is not feedback; it is
 * wallpaper. These thresholds turn repetition into escalating consequence.
 */
