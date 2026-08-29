import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ToolCallDiff } from '@shared/tools.types'
import type { WorkspaceToolFactory } from './types'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { assertFileStateUnchanged } from './fileState'
import { runGuardedToolWithPrepare } from './helpers'
import { encodeCheckpointBuffer } from '../checkpoints/contentEncoding'
import { describeEditResult } from './editEcho'
import { clampModelResultCap } from './modelResultBudget'

const PREVIEW_CHARS = 400
/**
 * Room an edit may spend quoting its own result back. Sized as a window, not a
 * file: see `editEcho.ts` for why an edit answers with content at all.
 */
const EDIT_ECHO_MAX_CHARS = 3_000

const MAX_PATCH_REPLACEMENTS = 20
/**
 * The chunk size a write is *asked* for, in every tool description that
 * mentions one. Small enough that a tool call can finish and the next
 * continuation round still has room, and it gives compaction a sequence of
 * bounded tool results instead of one giant JSON argument.
 *
 * Advice, not enforcement — see {@link MAX_FILE_WRITE_CONTENT_CHARS}.
 */
export const FILE_WRITE_CHUNK_TARGET_CHARS = 4_000

/**
 * The largest payload actually accepted. A sanity bound, deliberately far
 * above {@link FILE_WRITE_CHUNK_TARGET_CHARS}.
 *
 * **Never named in a tool description.** It was, briefly, and a number that
 * large is the one a model anchors on: a live run emitted a 10,507-character
 * `write_file` into a round with 3,920 tokens of room and was cut off
 * mid-argument, having been told both "about 4,000 characters" and "hard limit
 * 64,000" in the same sentence. Descriptions state only the size to aim for;
 * this appears solely in the error raised when it is genuinely exceeded.
 *
 * These were one constant, and refusing anything over the chunk target was a
 * loop generator. By the time a handler sees the payload the model has already
 * spent the tokens to produce it; rejecting it recovers nothing and discards
 * work that is complete and safe to apply. What it does instead is hand the
 * model an error whose only remedy — "split it up" — the model must implement
 * by regenerating the same content, which small local models simply do not do:
 * a measured run reissued the *same* 6,201-character `append_file` eight times
 * in a row, was refused every time for the same reason, and finished the turn
 * with none of it on disk.
 *
 * The chunking advice still reaches the model where it can help, before
 * generation, through the tool descriptions. Enforcement past that point only
 * needs to stop a runaway payload, and a payload that arrived whole is by
 * definition not truncated: writing it is one atomic operation, strictly safer
 * than the chunk-then-append sequence a refusal forces, which leaves the file
 * invalid if the turn ends part-way through.
 */
export const MAX_FILE_WRITE_CONTENT_CHARS = 64_000
/**
 * Files larger than this don't get a stored diff: a full before/after copy of
 * a huge file would bloat persisted conversation JSON for a diff that's hard
 * to read in the chat UI anyway.
 */
const MAX_DIFF_CHARS = 50_000

/** A diff, or `undefined` if there's nothing meaningful to show. */
export function diffOrUndefined(
  path: string,
  before: string,
  after: string
): ToolCallDiff | undefined {
  if (before === after) return undefined
  if (before.length > MAX_DIFF_CHARS || after.length > MAX_DIFF_CHARS) return undefined
  return { path, before, after }
}

/** write_file - create or overwrite a text file. */
export const writeFileTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description: `Create or overwrite a text file within the workspace. Keep the content under ${FILE_WRITE_CHUNK_TARGET_CHARS} characters: a longer file must be a first chunk plus append_file calls, because one long payload runs out of room part-way through and is lost entirely.`,
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: {
          type: 'string',
          maxLength: MAX_FILE_WRITE_CONTENT_CHARS,
          description: `The file contents, under ${FILE_WRITE_CHUNK_TARGET_CHARS} characters. For a longer file write a first chunk this size and use append_file for the rest.`
        }
      },
      required: ['path', 'content']
    } as const,
    handler: (args: { path: string; content: string }) =>
      runGuardedToolWithPrepare(
        ctx,
        {
          name: 'write_file',
          kind: 'write',
          title: `Write ${args.path}`,
          args,
          risk: 'safe',
          touch: { path: args.path, action: 'write' }
        },
        async () => {
          if (args.content.length > MAX_FILE_WRITE_CONTENT_CHARS) {
            throw new Error(
              `write_file content was ${args.content.length} characters; the hard limit is ${MAX_FILE_WRITE_CONTENT_CHARS}. ` +
                `Write a first chunk of about ${FILE_WRITE_CHUNK_TARGET_CHARS} characters, then use append_file for the remaining content.`
            )
          }
          const file = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const relativePath = toWorkspaceRelative(ctx.workspaceRoot, file)
          const beforeExists = await access(file)
            .then(() => true)
            .catch(() => false)
          const beforeBuffer = beforeExists ? await readFile(file) : null
          const beforeState = beforeBuffer ? encodeCheckpointBuffer(beforeBuffer) : null
          const beforeText = beforeState?.encoding === 'utf8' ? beforeState.data : ''
          const truncation = describeDestructiveOverwrite(beforeText, args.content, relativePath)
          if (truncation) throw new Error(truncation)
          return {
            confirmDetail: `Write ${args.content.length} characters to ${args.path}:\n\n${preview(args.content)}`,
            confirmDiff:
              beforeState?.encoding === 'base64'
                ? undefined
                : diffOrUndefined(relativePath, beforeText, args.content),
            data: { file, relativePath, beforeBuffer, beforeState, beforeText }
          }
        },
        async ({ file, relativePath, beforeBuffer, beforeState, beforeText }) => {
          await assertFileStateUnchanged(file, beforeBuffer, 'write')
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, args.content, 'utf-8')
          return {
            modelResult: `Wrote ${args.content.length} characters to ${relativePath}.`,
            detail: `${args.content.length} chars`,
            diff:
              beforeState?.encoding === 'base64'
                ? undefined
                : diffOrUndefined(relativePath, beforeText, args.content),
            checkpointChanges: [
              {
                path: relativePath,
                before: beforeState?.data ?? null,
                after: args.content,
                beforeEncoding: beforeState?.encoding,
                afterEncoding: 'utf8'
              }
            ]
          }
        }
      )
  })

/**
 * Refuse a `write_file` that would replace a substantial existing file with a
 * far smaller payload.
 *
 * `write_file` overwrites, and a model that cannot emit a long file in one call
 * rewrites it as a first chunk plus a run of `append_file` calls — a turn that
 * stops part-way through that sequence leaves the file truncated. Not
 * hypothetical: a live run replaced a 41,455-byte working module with a
 * 1,839-byte first chunk, never appended (the tool was not in its native
 * surface), ran out of provider rounds, and left an unparseable stub where the
 * user's page had been.
 *
 * Overwrite semantics and chunked rewrites are each individually defensible,
 * and together they are a data-loss machine on any model that cannot reliably
 * finish a ten-call sequence. Incremental in-place edits do not have that
 * property — the file is valid after every one — so that is what this points
 * at, leaving `delete_file` as the explicit path for genuinely starting over.
 *
 * Raising the accepted payload to `MAX_FILE_WRITE_CONTENT_CHARS` shrank how
 * often this can fire without weakening it: a whole-file rewrite that arrives
 * whole is no longer cut down to a first chunk, so it is no longer a shrink.
 *
 * Fires only for an existing file of real size being cut down substantially.
 * Creating a file, rewriting a small one, and any rewrite that keeps or grows
 * the content are all untouched.
 */
function describeDestructiveOverwrite(
  before: string,
  after: string,
  relativePath: string
): string | null {
  if (before.length < MIN_PROTECTED_OVERWRITE_CHARS) return null
  if (after.length >= before.length * MAX_OVERWRITE_SHRINK_RATIO) return null
  return (
    `write_file would replace ${relativePath} (${before.length} characters) with only ` +
    `${after.length}, discarding most of the file. It was not applied. ` +
    'To change part of a file use replace_lines or patch_file — they keep it valid at every step, ' +
    'which a chunked rewrite does not if the turn ends part-way through. ' +
    'If you genuinely mean to start this file from scratch, delete_file it first.'
  )
}

/** Existing files below this size are cheap to rewrite wholesale and not worth guarding. */
const MIN_PROTECTED_OVERWRITE_CHARS = 2_000

/** A write keeping at least this share of an existing file is a rewrite, not a truncation. */
const MAX_OVERWRITE_SHRINK_RATIO = 0.5

/** append_file - append text to an existing UTF-8 text file. */
export const appendFileTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description: `Append text to an existing UTF-8 file within the workspace. Use this for long new files after a first write_file call. Keep each chunk under ${FILE_WRITE_CHUNK_TARGET_CHARS} characters, for the same reason.`,
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: {
          type: 'string',
          maxLength: MAX_FILE_WRITE_CONTENT_CHARS,
          description: `Text to append to the end of the file, under ${FILE_WRITE_CHUNK_TARGET_CHARS} characters.`
        }
      },
      required: ['path', 'content']
    } as const,
    handler: (args: { path: string; content: string }) =>
      runGuardedToolWithPrepare(
        ctx,
        {
          name: 'append_file',
          kind: 'write',
          title: `Append to ${args.path}`,
          args,
          risk: 'safe',
          touch: { path: args.path, action: 'write' }
        },
        async () => {
          if (args.content.length > MAX_FILE_WRITE_CONTENT_CHARS) {
            throw new Error(
              `append_file content was ${args.content.length} characters; the hard limit is ${MAX_FILE_WRITE_CONTENT_CHARS}. ` +
                `Append about ${FILE_WRITE_CHUNK_TARGET_CHARS} characters now and put the rest in a following append_file call.`
            )
          }
          const file = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const relativePath = toWorkspaceRelative(ctx.workspaceRoot, file)
          const { text: beforeText, buffer: beforeBuffer } = await readEditableText(
            file,
            relativePath
          )
          const afterText = beforeText + args.content
          return {
            confirmDetail: `Append ${args.content.length} characters to ${args.path}:\n\n${preview(args.content)}`,
            confirmDiff: diffOrUndefined(relativePath, beforeText, afterText),
            data: { file, relativePath, beforeText, beforeBuffer, afterText }
          }
        },
        async ({ file, relativePath, beforeText, beforeBuffer, afterText }) => {
          await assertFileStateUnchanged(file, beforeBuffer, 'append')
          await writeFile(file, afterText, 'utf-8')
          return {
            modelResult: `Appended ${args.content.length} characters to ${relativePath}.`,
            detail: `${args.content.length} chars`,
            diff: diffOrUndefined(relativePath, beforeText, afterText),
            checkpointChanges: [{ path: relativePath, before: beforeText, after: afterText }]
          }
        }
      )
  })

/** edit_file - replace a unique block of text within a file. */
export const editFileTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Replace an exact, unique block of text within a file. The old text must appear exactly once.' +
      'Answers with the edited lines and their new line numbers, so you do not need to read the file again to check the result.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        oldText: { type: 'string', description: 'The exact text to replace (must be unique).' },
        newText: { type: 'string', description: 'The replacement text.' }
      },
      required: ['path', 'oldText', 'newText']
    } as const,
    handler: (args: { path: string; oldText: string; newText: string }) =>
      runGuardedToolWithPrepare(
        ctx,
        {
          name: 'edit_file',
          kind: 'write',
          title: `Edit ${args.path}`,
          args,
          risk: 'safe',
          touch: { path: args.path, action: 'write' }
        },
        async () => {
          if (!args.oldText) {
            throw new Error(
              'oldText was empty. Provide the exact, existing text from the file to replace; read the file first if you have not already.'
            )
          }
          const file = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const relativePath = toWorkspaceRelative(ctx.workspaceRoot, file)
          const { text: original, buffer: originalBuffer } = await readEditableText(
            file,
            relativePath
          )
          const occurrences = original.split(args.oldText).length - 1
          if (occurrences === 0) {
            // Point at the tool that works from what the model still has.
            // `edit_file` needs text copied exactly from a read, and on a small
            // window that read has usually been trimmed out of context by the
            // time the edit is attempted — the model then reconstructs `oldText`
            // from memory and lands here. Observed live: eleven of these in one
            // turn, each one a wasted round. `replace_lines` needs only the line
            // numbers, which every read reports and which are cheap to hold.
            const nearMiss = whereOldTextNearlyIs(args.oldText, original)
            throw new Error(
              'The text to replace was not found in the file. Do not guess at it — if you no ' +
                'longer have the exact text in view, use replace_lines with the line numbers ' +
                'instead, or read that part of the file again to get the exact text first.' +
                (nearMiss ? `\n\n${nearMiss}` : '')
            )
          }
          if (occurrences > 1) {
            throw new Error(
              `The text to replace appears ${occurrences} times; make it unique by including more ` +
                'surrounding lines, or use replace_lines to target one specific line range.'
            )
          }
          const updated = original.replace(args.oldText, args.newText)
          return {
            confirmDetail: `In ${args.path}, replace:\n\n${describeOldText(args.oldText)}\n\n-> with:\n\n${preview(args.newText)}`,
            confirmDiff: diffOrUndefined(relativePath, original, updated),
            data: { file, relativePath, original, originalBuffer, updated }
          }
        },
        async ({ file, relativePath, original, originalBuffer, updated }) => {
          // Byte-exact, like every other tool here. Comparing decoded strings
          // also swallowed unrelated read failures via `.catch(() => null)` and
          // reported them as "the file changed".
          await assertFileStateUnchanged(file, originalBuffer, 'edit')
          await writeFile(file, updated, 'utf-8')
          const echo = describeEditResult({
            relativePath,
            original,
            updated,
            charBudget: clampModelResultCap(EDIT_ECHO_MAX_CHARS, ctx.modelResultBudget.current),
            action: '1 replacement'
          })
          return {
            modelResult: echo.modelResult,
            detail: echo.detail,
            diff: diffOrUndefined(relativePath, original, updated),
            checkpointChanges: [{ path: relativePath, before: original, after: updated }]
          }
        }
      )
  })

/**
 * replace_lines - replace a line range, addressed by number rather than by
 * quoted text.
 *
 * ## Why a second edit tool
 *
 * `edit_file` requires an `oldText` copied verbatim from a read. That is a fine
 * contract when the read is still in the model's context and a hopeless one
 * when it is not — and on a small window it very often is not, because the
 * transports evict older tool results to make room. In the incident recorded in
 * `docs/CONTEXT_SYSTEM_ROOT_CAUSE.md` a single assistant message made 157 tool
 * calls and zero successful writes, while producing eleven "the text to replace
 * was not found" errors: the model was reconstructing `oldText` from memory
 * because the read it came from had been deleted out from under it.
 *
 * A line range is working memory a small model can actually hold. "planetData
 * is at 412-418" is about fifteen tokens; the eight thousand characters
 * `edit_file` would need are not available at any price on a 16K window. Every
 * read tool already returns line numbers, so the anchor comes for free.
 *
 * ## The two interlocks, and why both are required
 *
 * Addressing code by number is only safe if the caller can be held to what it
 * believed was there. Both checks below exist because a live run corrupted a
 * file without either one firing.
 *
 * `expectedFirstLine` is **required**, not optional. It began optional — "the
 * anchor is often taken from a read in the same round, where nothing can have
 * moved" — and that reasoning is exactly backwards: a model omits the anchor
 * precisely when it is least sure what the line says. In the incident, a
 * `70-75` replacement was correctly refused as stale, and the model
 * immediately retried as `70-71` without a usable anchor and duplicated a
 * declaration. An interlock a caller may decline is not an interlock.
 *
 * `describeSeamDuplication` covers what an anchor structurally cannot: the
 * *end* of the range. Both corruptions in that run came in that way — the
 * replacement text re-stated a line that already existed just past the range,
 * leaving `const planets = [];` three times over and the file with a
 * `SyntaxError`, which is precisely the blank screen the user had asked to have
 * fixed. Checking the seams is mechanical and language-agnostic: it asks only
 * whether the edit repeated a substantial line that was already its neighbour.
 *
 * This is an addition, not a replacement: `edit_file` remains the better tool
 * whenever the model does have the text, and larger models will keep using it.
 */
export const replaceLinesTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description: `Replace lines startLine..endLine (1-based, inclusive) of a file with newText. Use this instead of edit_file when you know where the code is but no longer have its exact text in view — every read tool reports line numbers. Pass an empty newText to delete the range. Keep newText under ${FILE_WRITE_CHUNK_TARGET_CHARS} characters; replace a smaller range if it would be longer. Answers with the edited lines and their new line numbers, so you do not need to read the file again to check the result.`,
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        startLine: { type: 'integer', description: 'First line to replace (1-based, inclusive).' },
        endLine: {
          type: 'integer',
          description: 'Last line to replace (1-based, inclusive). Equal to startLine for one line.'
        },
        newText: {
          type: 'string',
          maxLength: MAX_FILE_WRITE_CONTENT_CHARS,
          description: 'Replacement text for that range. May span several lines. Empty deletes it.'
        },
        expectedFirstLine: {
          type: 'string',
          description:
            'Required. What line startLine currently says right now, copied from your most recent read of the file — compared ignoring surrounding whitespace. If it no longer matches, the edit is refused and the real line is reported, so a stale line number cannot overwrite the wrong code. If you do not know it, read the range before editing.'
        }
      },
      required: ['path', 'startLine', 'endLine', 'newText', 'expectedFirstLine']
    } as const,
    handler: (args: {
      path: string
      startLine: number
      endLine: number
      newText: string
      expectedFirstLine?: string
    }) =>
      runGuardedToolWithPrepare(
        ctx,
        {
          name: 'replace_lines',
          kind: 'write',
          title: `Replace ${args.path} lines ${args.startLine}-${args.endLine}`,
          args,
          risk: 'safe',
          touch: { path: args.path, action: 'write' }
        },
        async () => {
          if (args.newText.length > MAX_FILE_WRITE_CONTENT_CHARS) {
            throw new Error(
              `replace_lines newText was ${args.newText.length} characters; the hard limit is ${MAX_FILE_WRITE_CONTENT_CHARS}. Replace a smaller range, or make several calls working from the bottom of the file upward so earlier line numbers stay valid.`
            )
          }
          const start = Math.floor(args.startLine)
          const end = Math.floor(args.endLine)
          if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1) {
            throw new Error(
              'startLine and endLine must be whole numbers, and startLine at least 1.'
            )
          }
          if (end < start) {
            throw new Error(`endLine (${end}) is before startLine (${start}).`)
          }
          const file = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const relativePath = toWorkspaceRelative(ctx.workspaceRoot, file)
          const { text: original, buffer: originalBuffer } = await readEditableText(
            file,
            relativePath
          )
          const lines = original.split('\n')
          if (start > lines.length) {
            throw new Error(
              `startLine ${start} is beyond the file's ${lines.length} lines. Read the file again to get current line numbers.`
            )
          }
          // The anchor's job is to identify the block being replaced. When it
          // identifies exactly one line, that line *is* the block, and the line
          // number the model supplied is redundant information that happens to
          // be stale -- so the edit is placed rather than refused. See
          // `relocateToAnchor` for the measurements behind that change.
          const placement = relocateToAnchor(args.expectedFirstLine, lines, start, end)
          if (typeof placement === 'string') throw new Error(placement)
          const { start: effectiveStart, end: effectiveEnd, movedBy } = placement
          const clampedEnd = Math.min(effectiveEnd, lines.length)
          if (clampedEnd < effectiveStart) {
            throw new Error(
              `The anchor for this edit is on line ${effectiveStart}, but the range ends before ` +
                'it once shifted. Read the file again and retry with current line numbers.'
            )
          }

          // Rejoining with '\n' preserves whatever the file already used,
          // because splitting on '\n' leaves any '\r' attached to the end of
          // each line. Only the incoming text has to be converted, and only
          // when the file is CRLF — otherwise a single edit silently rewrites
          // the line endings of the lines it touches and every later diff and
          // `oldText` lookup is off by one invisible character per line.
          const replacement = replacementLines(args.newText, original)
          const seamDuplication = describeSeamDuplication(
            lines,
            replacement,
            effectiveStart,
            clampedEnd
          )
          if (seamDuplication) throw new Error(seamDuplication)
          const updated = [
            ...lines.slice(0, effectiveStart - 1),
            ...replacement,
            ...lines.slice(clampedEnd)
          ].join('\n')
          const replacedCount = clampedEnd - effectiveStart + 1
          return {
            confirmDetail:
              `In ${relativePath}, replace ${replacedCount} line(s) ${effectiveStart}-${clampedEnd}:\n\n` +
              `${preview(lines.slice(effectiveStart - 1, clampedEnd).join('\n'))}\n\n-> with:\n\n${preview(args.newText || '(nothing — deleting the range)')}`,
            confirmDiff: diffOrUndefined(relativePath, original, updated),
            data: {
              file,
              relativePath,
              original,
              originalBuffer,
              updated,
              replacedCount,
              start: effectiveStart,
              movedBy
            }
          }
        },
        async ({
          file,
          relativePath,
          original,
          originalBuffer,
          updated,
          replacedCount,
          start,
          movedBy
        }) => {
          await assertFileStateUnchanged(file, originalBuffer, 'edit')
          await writeFile(file, updated, 'utf-8')
          // Reporting the new total is what lets the next call address the file
          // correctly without re-reading it: after an edit that changes the line
          // count, every anchor below `start` has shifted, and the model has no
          // other way to know by how much. `describeEditResult` states that and
          // also quotes the region back, which is the other half of what a
          // re-read was being spent on.
          const echo = describeEditResult({
            relativePath,
            original,
            updated,
            charBudget: clampModelResultCap(EDIT_ECHO_MAX_CHARS, ctx.modelResultBudget.current),
            action: `${replacedCount} line(s) replaced starting at line ${start}`
          })
          // Never silent: a relocated edit says so, so a model working from a
          // wrong picture of the file is corrected rather than quietly
          // accommodated.
          const movedNote = movedBy
            ? `Your line numbers were stale by ${Math.abs(movedBy)} line(s); the anchor was on ` +
              `line ${start}, so that is where the replacement went.\n`
            : ''
          return {
            modelResult: `${movedNote}${echo.modelResult}`,
            detail: echo.detail,
            diff: diffOrUndefined(relativePath, original, updated),
            checkpointChanges: [{ path: relativePath, before: original, after: updated }]
          }
        }
      )
  })

/**
 * Where this numbered edit should actually be applied.
 *
 * Returns the range to use, or the message to refuse with.
 *
 * `expectedFirstLine` exists as an interlock: proof that the model's line
 * numbers still describe the file, so a stale number cannot overwrite the wrong
 * code. That is unchanged here. An edit whose anchor cannot be found, or which
 * could mean several places, is still refused with exactly the wording it had.
 *
 * What changes is the case where the anchor is found exactly once, somewhere
 * else. That was never ambiguous: the anchor names the block, the block is in
 * one place, and the line number is the redundant half of the pair. Refusing
 * there told the model "that text is now on line 40 - retry there, shifting the
 * rest of the range by the same amount", which is a complete description of the
 * correct edit, handed back with a demand that it be retyped.
 *
 * Measured rather than assumed:
 *
 * - Anchored edits fail 21% of the time across the whole store, and 22% in the
 *   window after both the edit echo and the relocation hint landed. Two careful
 *   fixes in a row moved that number not at all.
 * - 59 of 103 post-echo failures were preceded, *within the same assistant
 *   message*, by a successful write to that same file. 69 of 95 messages
 *   containing anchored edits contain more than one; several contain 20-36.
 *
 * That is the mechanism. The model composes a batch of edits against one view
 * of the file, the first lands and shifts every line below it, and the rest
 * arrive stale. Better reporting cannot reach them: they were written before
 * any result came back. The shift is uniform and the anchor proves where each
 * block went, so the placement is recoverable by construction rather than by
 * asking.
 *
 * The end of the range moves by the same delta as the start - the same
 * arithmetic the refusal used to instruct - which is correct exactly when the
 * block moved as a unit, that being what a uniform shift above it means.
 * `describeSeamDuplication` still runs on the result, so the far end of the
 * range keeps the protection it already had.
 */
function relocateToAnchor(
  expectedFirstLine: string | undefined,
  lines: readonly string[],
  start: number,
  end: number
): { start: number; end: number; movedBy: number } | string {
  const wanted = expectedFirstLine?.trim() ?? ''
  if (!wanted) {
    return (
      'expectedFirstLine is required: give the current text of line ' +
      `${start} so a stale line number cannot overwrite the wrong code. ` +
      'Read that range again and retry with it.'
    )
  }
  if ((lines[start - 1] ?? '').trim() === wanted) return { start, end, movedBy: 0 }

  const matches: number[] = []
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() === wanted) {
      matches.push(index + 1)
      if (matches.length > 1) break
    }
  }
  // Several matches cannot be resolved without choosing one, and no match means
  // the text really has gone. Both stay refusals, with the wording they had.
  if (matches.length !== 1) {
    return describeAnchorMismatch(expectedFirstLine, lines[start - 1], start) ?? ''
  }
  const movedBy = matches[0] - start
  return { start: matches[0], end: end + movedBy, movedBy }
}

/**
 * Refuse a numbered edit whose anchor no longer describes the file.
 *
 * Compared with surrounding whitespace stripped: a model recalling a line from
 * an indented read reproduces the text reliably and the indentation only
 * sometimes, and failing on indentation alone would make the interlock so
 * irritating that callers would stop supplying the anchor — which is the one
 * outcome that actually costs safety.
 *
 * Only reached now when the anchor matches zero lines or several: a unique
 * match is placed by `relocateToAnchor` rather than refused, so the advice here
 * is genuinely the right advice. It used to end by naming the line the text had
 * moved to, which was a complete description of the correct edit handed back as
 * a refusal; that branch is gone because the edit is simply made.
 */
function describeAnchorMismatch(
  expected: string | undefined,
  actual: string | undefined,
  line: number
): string | null {
  const wanted = expected?.trim() ?? ''
  if (!wanted) {
    return (
      'expectedFirstLine is required: give the current text of line ' +
      `${line} so a stale line number cannot overwrite the wrong code. ` +
      'Read that range again and retry with it.'
    )
  }
  const found = (actual ?? '').trim()
  if (found === wanted) return null
  return (
    `Line ${line} does not match expectedFirstLine, so the line numbers are stale and this edit was not applied. ` +
    `Expected: ${JSON.stringify(wanted)}. Found: ${JSON.stringify(found)}. ` +
    'Read the file again to get current line numbers, then retry.'
  )
}

/**
 * Say what the file actually holds where `oldText` nearly matched.
 *
 * `whereItActuallyIs` for text instead of line numbers, and it exists for the
 * same reason: the file is already in hand when the anchor fails, so telling
 * the model to go and read it again spends a round on something already known.
 *
 * Measured across the stored runs: 107 anchor failures in the recent set,
 * three quarters of all Workspace tool failures, and 81% of them are answered
 * by an immediate re-read of the same file. `edit_file` accounts for the half
 * that got no help at all — its message says only that the text was not found.
 *
 * The anchor is `oldText`'s first non-blank line, trimmed, because indentation
 * is what a model reconstructing text from memory loses first while the line's
 * content survives. The uniqueness rule is `whereItActuallyIs`'s, unchanged:
 * several matches cannot be resolved without guessing which was meant, and
 * guessing is what this interlock exists to prevent; no match means the text
 * really has gone, and re-reading is then the right advice. Both fall back to
 * saying nothing extra.
 *
 * Nothing is applied on this path — the edit stays refused either way. This
 * only changes how much the model is told about why.
 */
function whereOldTextNearlyIs(oldText: string, original: string): string | null {
  const wantedLines = oldText.split('\n')
  const anchor = wantedLines.find((line) => line.trim().length > 0)?.trim()
  // A punctuation-only anchor ("}", "});") matches almost every block in a
  // file. The uniqueness test below would usually reject it anyway; this keeps
  // the one that slips through from pointing at an arbitrary line.
  if (!anchor || anchor.length < 4) return null

  const lines = original.split('\n')
  const matches: number[] = []
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim() === anchor) {
      matches.push(index)
      if (matches.length > 1) return null
    }
  }
  if (matches.length !== 1) return null

  const start = matches[0]
  const end = Math.min(lines.length, start + wantedLines.length)
  const actual = lines.slice(start, end).join('\n')
  return (
    `That first line is on line ${start + 1}. What the file actually says at ` +
    `lines ${start + 1}-${end}:\n${truncateEcho(actual)}\n` +
    'Copy that exactly if it is the text you meant, or use replace_lines with those line numbers.'
  )
}

/** Keep a near-miss echo from crowding out the rest of the tool result. */
function truncateEcho(text: string): string {
  const MAX = 1_200
  return text.length > MAX ? `${text.slice(0, MAX)}\n…(truncated)` : text
}

/**
 * Refuse a replacement that repeats a substantial line already sitting just
 * outside the range it replaces.
 *
 * This is the failure `expectedFirstLine` structurally cannot see, because it
 * happens at the *other* end. A model working from a slightly stale view
 * re-states the trailing context it thinks it is preserving, and the line ends
 * up twice. Live consequence: `const planets = [];` three times over, a
 * `SyntaxError`, and a page that renders nothing — the exact symptom the user
 * had asked to have fixed, now caused by the fix.
 *
 * Only *substantial* lines count. Real code is full of legitimately repeated
 * `}`, `);`, `],` and blank lines, and refusing those would make the tool
 * unusable. A line has to carry enough of its own identity to be worth
 * refusing over.
 */
function describeSeamDuplication(
  original: string[],
  replacement: string[],
  start: number,
  end: number
): string | null {
  if (replacement.length === 0) return null
  const before = original[start - 2]
  const after = original[end]
  const head = replacement[0]
  const tail = replacement[replacement.length - 1]

  for (const [side, neighbour, edge] of [
    ['before', before, head],
    ['after', after, tail]
  ] as const) {
    if (!isSubstantialLine(edge) || normalizeLine(neighbour) !== normalizeLine(edge)) continue
    return (
      `This replacement would repeat a line that already exists immediately ${side} lines ` +
      `${start}-${end}: ${JSON.stringify(normalizeLine(edge))}. The edit was not applied. ` +
      'Drop that line from newText, or widen the range to cover the copy that is already there — ' +
      'do not restate surrounding context you are not replacing.'
    )
  }
  return null
}

function normalizeLine(line: string | undefined): string {
  return (line ?? '').replace(/\r$/, '').trim()
}

/**
 * Whether a line carries enough identity that seeing it twice is a mistake
 * rather than ordinary syntax.
 */
function isSubstantialLine(line: string | undefined): boolean {
  const trimmed = normalizeLine(line)
  if (trimmed.length < 8) return false
  // At least two word-ish tokens: `});` and `] );` are structure, whereas
  // `const planets = [];` names something.
  return (trimmed.match(/[A-Za-z_$][\w$]*/g) ?? []).length >= 2
}

/**
 * Split the incoming text into the array form the surrounding file uses.
 *
 * The whole file is handled as `split('\n')` and rejoined the same way, which
 * preserves CRLF for untouched lines automatically — each keeps its own
 * trailing `\r`. New lines therefore need that `\r` added to *every* element,
 * including the last: it is followed by a join separator like any other. The
 * obvious version (convert the string to CRLF, then split) leaves the final
 * replacement line without one, producing a single stray LF in the middle of a
 * CRLF file — invisible in review and enough to break a later exact-text edit.
 */
function replacementLines(newText: string, original: string): string[] {
  if (newText === '') return []
  const lines = newText.replace(/\r\n/g, '\n').split('\n')
  const crlfCount = (original.match(/\r\n/g) ?? []).length
  const lfCount = (original.match(/\n/g) ?? []).length
  const usesCrlf = crlfCount > 0 && crlfCount >= lfCount / 2
  return usesCrlf ? lines.map((line) => `${line}\r`) : lines
}

interface PatchReplacement {
  oldText: string
  newText: string
  /** 1-based match number to replace when oldText appears more than once. */
  occurrence?: number
  /** Replace every occurrence of oldText. Takes precedence over occurrence. */
  replaceAll?: boolean
}

/** patch_file - apply one or more exact text replacements to a single file. */
export const patchFileTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Apply one or more exact text replacements to a file. Use when edit_file is too narrow: repeated snippets, several related replacements in one file, or replace-all edits.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        replacements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string', description: 'Exact text to replace.' },
              newText: { type: 'string', description: 'Replacement text.' },
              occurrence: {
                type: 'number',
                description:
                  'Optional 1-based occurrence to replace when oldText appears multiple times.'
              },
              replaceAll: {
                type: 'boolean',
                description: 'Set true to replace every occurrence of oldText.'
              }
            },
            required: ['oldText', 'newText']
          },
          description: `Up to ${MAX_PATCH_REPLACEMENTS} replacements, applied in order.`
        }
      },
      required: ['path', 'replacements']
    } as const,
    handler: (args: { path: string; replacements: PatchReplacement[] }) =>
      runGuardedToolWithPrepare(
        ctx,
        {
          name: 'patch_file',
          kind: 'write',
          title: `Patch ${args.path}`,
          args,
          risk: 'safe',
          touch: { path: args.path, action: 'write' }
        },
        async () => {
          const file = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const relativePath = toWorkspaceRelative(ctx.workspaceRoot, file)
          const { text: original, buffer: originalBuffer } = await readEditableText(
            file,
            relativePath
          )
          const replacements = args.replacements.slice(0, MAX_PATCH_REPLACEMENTS)
          const droppedCount = args.replacements.length - replacements.length
          const truncationNote =
            droppedCount > 0
              ? ` Only the first ${MAX_PATCH_REPLACEMENTS} of ${args.replacements.length} requested replacements were applied; the remaining ${droppedCount} were dropped. Call patch_file again for the rest.`
              : ''
          const patched = applyTextPatch(original, replacements)
          return {
            confirmDetail: `Apply ${patched.count} replacement(s) to ${args.path}:\n\n${describePatch(replacements)}${truncationNote}`,
            confirmDiff: diffOrUndefined(relativePath, original, patched.text),
            data: {
              file,
              relativePath,
              original,
              originalBuffer,
              updated: patched.text,
              count: patched.count,
              truncationNote
            }
          }
        },
        async ({
          file,
          relativePath,
          original,
          originalBuffer,
          updated,
          count,
          truncationNote
        }) => {
          // Byte-exact, matching every other tool here — see `edit_file`.
          await assertFileStateUnchanged(file, originalBuffer, 'patch')
          await writeFile(file, updated, 'utf-8')
          return {
            modelResult: `Patched ${relativePath} with ${count} replacement(s).${truncationNote}`,
            detail: `${count} replacement(s)`,
            diff: diffOrUndefined(relativePath, original, updated),
            checkpointChanges: [{ path: relativePath, before: original, after: updated }]
          }
        }
      )
  })

/** delete_file - remove a file from the workspace. */
export const deleteFileTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description: 'Delete a file inside the workspace.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' }
      },
      required: ['path']
    } as const,
    handler: (args: { path: string }) =>
      runGuardedToolWithPrepare(
        ctx,
        {
          name: 'delete_file',
          kind: 'write',
          title: `Delete ${args.path}`,
          args,
          risk: 'sensitive',
          touch: { path: args.path, action: 'delete' }
        },
        async () => {
          const file = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const relativePath = toWorkspaceRelative(ctx.workspaceRoot, file)
          const beforeBuffer = await readFile(file)
          const before = encodeCheckpointBuffer(beforeBuffer)
          return {
            confirmDetail: `Delete file ${args.path}`,
            data: { file, relativePath, beforeBuffer, before }
          }
        },
        async ({ file, relativePath, beforeBuffer, before }) => {
          await assertFileStateUnchanged(file, beforeBuffer, 'deletion')
          await rm(file)
          return {
            modelResult: `Deleted ${relativePath}.`,
            detail: 'deleted',
            checkpointChanges: [
              {
                path: relativePath,
                before: before.data,
                after: null,
                beforeEncoding: before.encoding
              }
            ]
          }
        }
      )
  })

/** move_file - rename or move a file within the workspace. */
export const moveFileTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Move or rename a file inside the workspace. Both source and target paths must be within the workspace.',
    params: {
      type: 'object',
      properties: {
        sourcePath: {
          type: 'string',
          description: 'Current file path relative to the workspace root.'
        },
        targetPath: { type: 'string', description: 'New file path relative to the workspace root.' }
      },
      required: ['sourcePath', 'targetPath']
    } as const,
    handler: (args: { sourcePath: string; targetPath: string }) =>
      runGuardedToolWithPrepare(
        ctx,
        {
          name: 'move_file',
          kind: 'write',
          title: `Move ${args.sourcePath} -> ${args.targetPath}`,
          args,
          risk: 'safe',
          touch: { path: args.targetPath, action: 'move' }
        },
        async () => {
          const source = resolveInWorkspace(ctx.workspaceRoot, args.sourcePath)
          const target = resolveInWorkspace(ctx.workspaceRoot, args.targetPath)
          const sourceRelativePath = toWorkspaceRelative(ctx.workspaceRoot, source)
          const targetRelativePath = toWorkspaceRelative(ctx.workspaceRoot, target)
          const sourceBeforeBuffer = await readFile(source)
          const sourceBefore = encodeCheckpointBuffer(sourceBeforeBuffer)
          const targetBeforeExists = await access(target)
            .then(() => true)
            .catch(() => false)
          const targetBeforeBuffer = targetBeforeExists ? await readFile(target) : null
          const targetBefore = targetBeforeBuffer
            ? encodeCheckpointBuffer(targetBeforeBuffer)
            : null
          return {
            // `rename` replaces an existing target outright. The approval card
            // said only "Move A to B", so the one consequence the user most
            // needed to weigh — that B's current contents are about to be
            // destroyed — was the one thing it did not mention.
            confirmDetail: targetBeforeBuffer
              ? `Move ${args.sourcePath} to ${args.targetPath}.\n\nThis OVERWRITES the existing file at ${args.targetPath} (${targetBeforeBuffer.length} bytes), replacing its contents.`
              : `Move ${args.sourcePath} to ${args.targetPath}`,
            data: {
              source,
              target,
              sourceRelativePath,
              targetRelativePath,
              sourceBeforeBuffer,
              sourceBefore,
              targetBeforeBuffer,
              targetBefore
            }
          }
        },
        async ({
          source,
          target,
          sourceRelativePath,
          targetRelativePath,
          sourceBeforeBuffer,
          sourceBefore,
          targetBeforeBuffer,
          targetBefore
        }) => {
          await assertFileStateUnchanged(source, sourceBeforeBuffer, 'move')
          await assertFileStateUnchanged(target, targetBeforeBuffer, 'move target')
          await mkdir(dirname(target), { recursive: true })
          await rename(source, target)
          return {
            modelResult: `Moved ${sourceRelativePath} to ${targetRelativePath}.`,
            detail: 'moved',
            checkpointChanges: [
              {
                path: sourceRelativePath,
                before: sourceBefore.data,
                after: null,
                beforeEncoding: sourceBefore.encoding
              },
              {
                path: targetRelativePath,
                before: targetBefore?.data ?? null,
                after: sourceBefore.data,
                beforeEncoding: targetBefore?.encoding,
                afterEncoding: sourceBefore.encoding
              }
            ]
          }
        }
      )
  })

/**
 * Reads a file as text for a replacement-style edit, refusing when decoding it
 * is not byte-for-byte reversible.
 *
 * `edit_file` and `patch_file` are the only tools that read a file as UTF-8,
 * transform the string, and write that string back. Node replaces every invalid
 * byte sequence with U+FFFD on decode, so on a file that is not valid UTF-8 —
 * a latin-1 source file, anything with a stray byte — that round trip silently
 * rewrites bytes the edit never touched.
 *
 * Worse, the checkpoint stores the same lossy string as the "before" state, so
 * restoring the turn cannot recover the original either. `isLikelyBinary` does
 * not catch this: it keys on NUL and control bytes, and a latin-1 file has
 * neither. Comparing the re-encoded text against the bytes actually on disk
 * does catch it, exactly.
 */
async function readEditableText(
  file: string,
  relativePath: string
): Promise<{ text: string; buffer: Buffer }> {
  const buffer = await readFile(file)
  const text = buffer.toString('utf-8')
  if (!Buffer.from(text, 'utf-8').equals(buffer)) {
    throw new Error(
      `${relativePath} is not valid UTF-8, so a text replacement would rewrite bytes it never touched. ` +
        'Use write_file with the full intended contents if this file really should be replaced.'
    )
  }
  return { text, buffer }
}

function preview(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}...` : text
}

function describeOldText(oldText: string): string {
  return oldText ? preview(oldText) : '(empty; this call will be rejected)'
}

function applyTextPatch(
  original: string,
  replacements: PatchReplacement[]
): { text: string; count: number } {
  if (replacements.length === 0) throw new Error('replacements was empty.')

  let text = original
  let total = 0
  for (const [index, replacement] of replacements.entries()) {
    if (!replacement.oldText) {
      throw new Error(`Replacement ${index + 1} had an empty oldText.`)
    }
    const result = applyOneReplacement(text, replacement, index + 1)
    text = result.text
    total += result.count
  }

  if (text === original) throw new Error('Patch did not change the file.')
  return { text, count: total }
}

function applyOneReplacement(
  text: string,
  replacement: PatchReplacement,
  index: number
): { text: string; count: number } {
  const matches = countOccurrences(text, replacement.oldText)
  if (matches === 0) throw new Error(`Replacement ${index}: oldText was not found.`)

  if (replacement.replaceAll) {
    return {
      text: text.split(replacement.oldText).join(replacement.newText),
      count: matches
    }
  }

  if (replacement.occurrence !== undefined) {
    const occurrence = Math.floor(replacement.occurrence)
    if (occurrence < 1) throw new Error(`Replacement ${index}: occurrence must be 1 or greater.`)
    if (occurrence > matches) {
      throw new Error(
        `Replacement ${index}: occurrence ${occurrence} was requested but only ${matches} match(es) exist.`
      )
    }
    const start = nthIndexOf(text, replacement.oldText, occurrence)
    return {
      text:
        text.slice(0, start) + replacement.newText + text.slice(start + replacement.oldText.length),
      count: 1
    }
  }

  if (matches > 1) {
    throw new Error(
      `Replacement ${index}: oldText appears ${matches} times; provide occurrence or replaceAll.`
    )
  }

  return { text: text.replace(replacement.oldText, replacement.newText), count: 1 }
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1
}

function nthIndexOf(text: string, needle: string, occurrence: number): number {
  let from = 0
  for (let seen = 1; ; seen++) {
    const index = text.indexOf(needle, from)
    if (index === -1) return -1
    if (seen === occurrence) return index
    from = index + needle.length
  }
}

function describePatch(replacements: PatchReplacement[]): string {
  return replacements
    .slice(0, MAX_PATCH_REPLACEMENTS)
    .map((replacement, index) => {
      const target = replacement.replaceAll
        ? 'all occurrences'
        : replacement.occurrence
          ? `occurrence ${replacement.occurrence}`
          : 'unique occurrence'
      return `${index + 1}. Replace ${target}:\n${preview(replacement.oldText)}\n\nwith:\n${preview(replacement.newText)}`
    })
    .join('\n\n')
}
