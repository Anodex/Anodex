import type { MemoryEntry, MemoryKind, MemoryScope } from '@shared/memory.types'
import type { ToolFactory, ToolRuntimeContext } from './types'
import { runGuardedToolWithPrepare } from './helpers'
import { MAX_MEMORY_TEXT_CHARS, memoryStore, normalizeMemoryText } from '../memory/MemoryStore'

/**
 * Resolve which scope a `remember_fact` call actually lands in, honoring the
 * Settings → Memory toggles. Falls back to whichever scope is enabled rather
 * than failing outright, so a model that guesses the "wrong" scope (e.g. asks
 * for 'project' with no project open) still gets the fact stored somewhere
 * sensible instead of silently losing it.
 */
export function resolveMemoryScope(
  requested: 'project' | 'global',
  ctx: Pick<ToolRuntimeContext, 'projectId' | 'memory'>
): MemoryScope | null {
  const canProject = Boolean(ctx.projectId) && ctx.memory.crossChatEnabled
  const canGlobal = ctx.memory.personalEnabled
  if (!canProject && !canGlobal) return null
  if (requested === 'project' && canProject) {
    return { type: 'project', projectId: ctx.projectId as string }
  }
  return canGlobal ? { type: 'global' } : { type: 'project', projectId: ctx.projectId as string }
}

/**
 * remember_fact — record a short, structured memory that gets retrieved
 * (ranked, capped) in future conversations. Distinct from `update_project_notes`:
 * that writes prose into a human-visible ANODEX.md file (project-only); this
 * writes one atomic fact into the app-internal, user-manageable memory store
 * surfaced in Settings → Memory, in either scope:
 *   - 'global' ("personal memory"): about the user themselves — their name, a
 *     preference, how they like things communicated. Recalled in every chat,
 *     project or not.
 *   - 'project' ("cross-chat memory"): specific to the current codebase — a
 *     convention, a gotcha, an open task. Recalled across chats in that
 *     project only.
 *
 * Available in every chat, not just inside a project — a general chat has no
 * workspace/project to scope a fact to, but the user can still share something
 * worth remembering globally (this was previously a real gap: a plain "my
 * name is X" in a non-project chat had nowhere to go, since this tool used to
 * require an open project and only ever wrote project-scoped memories).
 */
export const rememberFactTool: ToolFactory = (define, ctx) =>
  define({
    // Led by the trigger rather than the capability, deliberately. The original
    // opened "Record one short, durable fact worth recalling later", which
    // describes what the tool *is*; measured across an eight-model chat matrix,
    // six models then acknowledged "my name is Merlin" in prose and never
    // called it — while calling anodex_status freely in the same conversation.
    // The difference is that a status question cannot be answered without the
    // tool, whereas saving a fact is an unprompted side-action a model will
    // skip unless the description tells it when to act.
    description:
      'CALL THIS whenever the user states something about themselves that should outlive this ' +
      "conversation — their name, a preference, how they like things done, what they're working " +
      'on, a project convention or gotcha, an open task. Replying "got it" does not save anything; ' +
      'only this call does, and without it the next conversation starts with no memory of them. ' +
      `Records one short fact (max ${MAX_MEMORY_TEXT_CHARS} characters) into structured memory. ` +
      "Use scope 'global' for anything about the user personally (recalled in every chat); use " +
      "'project' for something specific to this codebase (recalled across chats in this project " +
      'only, requires a project to be open). State identity facts (kind identity) literally and ' +
      'directly, e.g. "The user\'s name is X.", so a later direct question about it matches. One ' +
      'call per fact — do not fold two facts into one entry — and not for routine narration of ' +
      'what you just did.',
    params: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: `A single atomic fact, one sentence if possible (max ${MAX_MEMORY_TEXT_CHARS} characters).`
        },
        kind: {
          enum: ['identity', 'convention', 'gotcha', 'preference', 'open_task'],
          description:
            'identity: a fact about who the user is (their name or similar). convention: a coding/style rule to follow. gotcha: a pitfall to avoid. preference: how the user likes things done. open_task: something still left to do.'
        },
        scope: {
          enum: ['global', 'project'],
          description:
            "'global': about the user personally, recalled everywhere. 'project': specific to this codebase, recalled only in this project's chats."
        }
      },
      required: ['text', 'kind', 'scope']
    } as const,
    handler: (args: { text: string; kind: MemoryKind; scope: 'global' | 'project' }) =>
      runGuardedToolWithPrepare(
        ctx,
        {
          name: 'remember_fact',
          kind: 'write',
          title: 'Remember fact',
          args,
          risk: 'safe',
          // Only ever force *on*: omitting this when the setting is off lets
          // the normal permission-mode decision apply as usual (including
          // Ask mode still confirming). Passing `false` here would instead
          // force confirmation *off* even in Ask mode — not what "leave the
          // setting off" should mean.
          forceConfirm: ctx.memory.confirmBeforeSaving ? true : undefined
        },
        // Resolve the actual scope *before* the user sees the confirm prompt,
        // so it shows the real destination ("Save as global personal
        // memory") rather than the requested one, silently redirected after
        // approval — the requested scope can legitimately differ (e.g.
        // 'project' asked for with cross-chat memory off), and the user
        // should know which one they're actually approving.
        () => {
          const text = normalizeMemoryText(args.text)
          if (!text) throw new Error('text was empty.')

          const scope = resolveMemoryScope(args.scope, ctx)
          if (!scope) throw new Error('Memory is turned off in Settings → Memory.')

          const redirectNote =
            scope.type !== args.scope
              ? `\n\n(Requested '${args.scope}' scope, but that's currently off in Settings → Memory.)`
              : ''

          return Promise.resolve({
            confirmDetail: `Save as ${scopeLabel(scope)} memory (${args.kind}): ${text}${redirectNote}`,
            data: { text, scope }
          })
        },
        ({ text, scope }: { text: string; scope: MemoryScope }) => {
          const entry: MemoryEntry = memoryStore.create({
            kind: args.kind,
            text,
            scope,
            source: { conversationId: ctx.conversationId }
          })

          // A dedup update-in-place keeps the original createdAt but bumps
          // updatedAt; a fresh create sets both to the same instant.
          const updateNote =
            entry.createdAt !== entry.updatedAt ? ' Updated an existing memory.' : ''

          return Promise.resolve({
            modelResult: `Remembered as ${scopeLabel(entry.scope)} memory.${updateNote}`,
            detail: text.length > 60 ? `${text.slice(0, 60)}…` : text
          })
        }
      )
  })

function scopeLabel(scope: MemoryScope): string {
  return scope.type === 'global' ? 'global personal' : 'project cross-chat'
}
