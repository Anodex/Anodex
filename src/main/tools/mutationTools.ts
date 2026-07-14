import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ToolCallDiff } from '@shared/tools.types'
import type { WorkspaceToolFactory } from './types'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { runGuardedTool, runGuardedToolWithPrepare } from './helpers'

const PREVIEW_CHARS = 400
const MAX_PATCH_REPLACEMENTS = 20
/**
 * Files larger than this don't get a stored diff — a full before/after copy of
 * a huge file would bloat persisted conversation JSON indefinitely for a diff
 * that's unwieldy to actually read in the chat UI anyway.
 */
const MAX_DIFF_CHARS = 50_000

/** A diff, or `undefined` if there's nothing meaningful to show (unchanged or too large). */
export function diffOrUndefined(
  path: string,
  before: string,
  after: string
): ToolCallDiff | undefined {
  if (before === after) return undefined
  if (before.length > MAX_DIFF_CHARS || after.length > MAX_DIFF_CHARS) return undefined
  return { path, before, after }
}

/** write_file — create or overwrite a text file (requires approval). */
export const writeFileTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description: 'Create or overwrite a text file within the workspace.',
    params: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'The full contents to write.' }
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
          const file = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const relativePath = toWorkspaceRelative(ctx.workspaceRoot, file)
          // Best-effort — an empty "before" just means a new file, and any real
          // problem reading it (permissions, etc.) will surface on the write below.
          const before = await readFile(file, 'utf-8').catch(() => '')
          return {
            confirmDetail: `Write ${args.content.length} characters to ${args.path}:\n\n${preview(args.content)}`,
            confirmDiff: diffOrUndefined(relativePath, before, args.content),
            data: { file, relativePath, before }
          }
        },
        async ({ file, relativePath, before }) => {
          await mkdir(dirname(file), { recursive: true })
          await writeFile(file, args.content, 'utf-8')
          return {
            modelResult: `Wrote ${args.content.length} characters to ${relativePath}.`,
            detail: `${args.content.length} chars`,
            diff: diffOrUndefined(relativePath, before, args.content)
          }
        }
      )
  })

/** edit_file — replace a unique block of text within a file (requires approval). */
export const editFileTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      'Replace an exact, unique block of text within a file. The old text must appear exactly once.',
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
          // An empty oldText matches every position in the file, so it always
          // fails the uniqueness check below with a confusing "appears N times"
          // message. Reject it immediately with a clearer, more actionable one
          // instead — observed directly: models sometimes call edit_file without
          // filling in oldText at all.
          if (!args.oldText) {
            throw new Error(
              'oldText was empty. Provide the exact, existing text from the file to replace — read the file first if you have not already.'
            )
          }
          const file = resolveInWorkspace(ctx.workspaceRoot, args.path)
          const relativePath = toWorkspaceRelative(ctx.workspaceRoot, file)
          const original = await readFile(file, 'utf-8')
          const occurrences = original.split(args.oldText).length - 1
          if (occurrences === 0) throw new Error('The text to replace was not found in the file.')
          if (occurrences > 1) {
            throw new Error(`The text to replace appears ${occurrences} times; make it unique.`)
          }
          const updated = original.replace(args.oldText, args.newText)
          return {
            confirmDetail: `In ${args.path}, replace:\n\n${describeOldText(args.oldText)}\n\n→ with:\n\n${preview(args.newText)}`,
            confirmDiff: diffOrUndefined(relativePath, original, updated),
            data: { file, relativePath, original, updated }
          }
        },
        async ({ file, relativePath, original, updated }) => {
          // Re-verify nothing changed between the confirm prompt and approval —
          // `original` was snapshotted before the user answered, so without this
          // an edit approved against now-stale content could silently clobber a
          // concurrent change instead of failing loudly.
          const current = await readFile(file, 'utf-8').catch(() => null)
          if (current !== original) {
            throw new Error(
              'The file changed since this edit was proposed — read it again and retry.'
            )
          }
          await writeFile(file, updated, 'utf-8')
          return {
            modelResult: `Edited ${relativePath}.`,
            detail: '1 replacement',
            diff: diffOrUndefined(relativePath, original, updated)
          }
        }
      )
  })

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
          const original = await readFile(file, 'utf-8')
          const replacements = args.replacements.slice(0, MAX_PATCH_REPLACEMENTS)
          const droppedCount = args.replacements.length - replacements.length
          // Silently truncating would leave the model believing all of its
          // requested replacements applied when some never ran — say so
          // explicitly in both the confirmation prompt and the final result.
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
              updated: patched.text,
              count: patched.count,
              truncationNote
            }
          }
        },
        async ({ file, relativePath, original, updated, count, truncationNote }) => {
          const current = await readFile(file, 'utf-8').catch(() => null)
          if (current !== original) {
            throw new Error(
              'The file changed since this patch was proposed - read it again and retry.'
            )
          }
          await writeFile(file, updated, 'utf-8')
          return {
            modelResult: `Patched ${relativePath} with ${count} replacement(s).${truncationNote}`,
            detail: `${count} replacement(s)`,
            diff: diffOrUndefined(relativePath, original, updated)
          }
        }
      )
  })

/** delete_file - remove a file from the workspace (requires approval). */
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
      runGuardedTool(ctx, {
        name: 'delete_file',
        kind: 'write',
        title: `Delete ${args.path}`,
        args,
        confirmDetail: `Delete file ${args.path}`,
        risk: 'sensitive',
        touch: { path: args.path, action: 'delete' },
        async run() {
          const file = resolveInWorkspace(ctx.workspaceRoot, args.path)
          await rm(file)
          return {
            modelResult: `Deleted ${toWorkspaceRelative(ctx.workspaceRoot, file)}.`,
            detail: 'deleted'
          }
        }
      })
  })

/** move_file — rename or move a file within the workspace (requires approval). */
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
      runGuardedTool(ctx, {
        name: 'move_file',
        kind: 'write',
        title: `Move ${args.sourcePath} → ${args.targetPath}`,
        args,
        confirmDetail: `Move ${args.sourcePath} to ${args.targetPath}`,
        risk: 'safe',
        touch: { path: args.targetPath, action: 'move' },
        async run() {
          const source = resolveInWorkspace(ctx.workspaceRoot, args.sourcePath)
          const target = resolveInWorkspace(ctx.workspaceRoot, args.targetPath)
          await mkdir(dirname(target), { recursive: true })
          await rename(source, target)
          return {
            modelResult: `Moved ${toWorkspaceRelative(ctx.workspaceRoot, source)} to ${toWorkspaceRelative(ctx.workspaceRoot, target)}.`,
            detail: 'moved'
          }
        }
      })
  })

function preview(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text
}

/** Like `preview`, but flags an empty oldText instead of showing a blank line. */
function describeOldText(oldText: string): string {
  return oldText ? preview(oldText) : '(empty — this call will be rejected)'
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
