import { readFile, writeFile } from 'node:fs/promises'
import type { WorkspaceToolFactory } from './types'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { runGuardedTool } from './helpers'
import { diffOrUndefined } from './mutationTools'

/** A real, visible, user-editable file in the workspace root — not an app-internal store. */
export const PROJECT_NOTES_FILENAME = 'ANODEX.md'

const MAX_NOTE_CHARS = 500

const HEADER =
  '# Anodex Notes\n\n' +
  'Notes Anodex has recorded about this project across sessions — conventions, gotchas, ' +
  'decisions. Feel free to edit or delete anything here.\n'

/** `## YYYY-MM-DD` heading for grouping same-day notes together. */
export function todayHeading(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `## ${year}-${month}-${day}`
}

/**
 * Appends `note` as a bullet under today's date heading in `existing` file content,
 * creating the file (with header) if it's empty, or adding a new dated section if
 * today doesn't have one yet. Pure and independently tested — the tool handler just
 * wires this to disk.
 */
export function appendNote(existing: string, note: string, heading = todayHeading()): string {
  const bullet = `- ${note.trim()}`

  if (!existing.trim()) {
    return `${HEADER}\n${heading}\n${bullet}\n`
  }

  const lines = existing.replace(/\s+$/, '').split('\n')
  const headingIndex = lines.findIndex((line) => line.trim() === heading)

  if (headingIndex === -1) {
    return `${lines.join('\n')}\n\n${heading}\n${bullet}\n`
  }

  let insertAt = lines.length
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      insertAt = i
      break
    }
  }
  while (insertAt > headingIndex + 1 && lines[insertAt - 1].trim() === '') insertAt--

  lines.splice(insertAt, 0, bullet)
  return `${lines.join('\n')}\n`
}

/**
 * update_project_notes — record a short, durable learning about the project into a
 * real, visible `ANODEX.md` file at the workspace root (not the app-internal
 * `ProjectMemoryStore`, which is invisible and not user-editable). A dedicated,
 * narrow tool rather than asking the model to compose a full `edit_file` replace
 * against a growing file — same reasoning as `write_plan`/`update_plan_step`:
 * a purpose-built tool with one simple string argument is far less likely to
 * misfire than a generic file edit for this specific, recurring shape of task.
 */
export const updateProjectNotesTool: WorkspaceToolFactory = (define, ctx) =>
  define({
    description:
      `Record a short, durable note about this project into a visible ${PROJECT_NOTES_FILENAME} ` +
      'file at the workspace root — a convention, a gotcha, a decision, something worth a future ' +
      'session knowing. Use sparingly, only for things worth persisting, not routine narration of ' +
      'what you just did.',
    params: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: `A one or two sentence note (max ${MAX_NOTE_CHARS} characters).`
        }
      },
      required: ['note']
    } as const,
    handler: (args: { note: string }) =>
      runGuardedTool(ctx, {
        name: 'update_project_notes',
        kind: 'write',
        title: `Update ${PROJECT_NOTES_FILENAME}`,
        args,
        confirmDetail: `Add to ${PROJECT_NOTES_FILENAME}:\n\n${args.note}`,
        risk: 'safe',
        touch: { path: PROJECT_NOTES_FILENAME, action: 'write' },
        async run() {
          const note = args.note.trim().slice(0, MAX_NOTE_CHARS)
          if (!note) throw new Error('note was empty.')

          const file = resolveInWorkspace(ctx.workspaceRoot, PROJECT_NOTES_FILENAME)
          const relativePath = toWorkspaceRelative(ctx.workspaceRoot, file)
          const before = await readFile(file, 'utf-8').catch(() => '')
          const after = appendNote(before, note)
          await writeFile(file, after, 'utf-8')

          return {
            modelResult: `Added a note to ${relativePath}.`,
            detail: note.length > 60 ? `${note.slice(0, 60)}…` : note,
            diff: diffOrUndefined(relativePath, before, after)
          }
        }
      })
  })
