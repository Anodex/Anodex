import { randomUUID } from 'node:crypto'
import type { ToolCallDiff, ToolCallPreview, ToolKind, ToolRisk } from '@shared/tools.types'
import type { FileTouchAction } from '@shared/projectMemory.types'
import type { Plan } from '@shared/plan.types'
import type { ToolRuntimeContext } from './types'
import { resolvePermission } from './permissions'
import { projectMemoryStore } from '../projects/ProjectMemoryStore'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'

/** Truncated tool output retained for cross-session memory. */
const MAX_REMEMBERED_RESULT = 2000
/** Maximum chars of a single tool result sent to the model. */
const MAX_MODEL_RESULT_CHARS = 4000

/** The two pieces a tool produces: what the model sees, and a short UI detail. */
interface ToolOutcome {
  /** Returned to the model. */
  modelResult: string
  /** Short status shown in the UI (not the full payload). */
  detail?: string
  /** Before/after content for a file write/edit, so the UI can render a diff. */
  diff?: ToolCallDiff
  /** Full plan snapshot after a plan tool call, so the UI can update its Plan panel live. */
  plan?: Plan
  /** Optional rich preview shown in the chat transcript. */
  preview?: ToolCallPreview
}

function rememberResult(modelResult: string): string {
  return modelResult.length > MAX_REMEMBERED_RESULT
    ? `${modelResult.slice(0, MAX_REMEMBERED_RESULT)}…`
    : modelResult
}

function truncateModelResult(modelResult: string, cap: number): string {
  return modelResult.length > cap
    ? `${modelResult.slice(0, cap)}\n… (truncated, ${modelResult.length} bytes total)`
    : modelResult
}

/**
 * The model-facing message returned when the user denies a guarded tool call.
 * Weaves in the user's typed reason when they gave one, so the model gets real
 * feedback to adapt to instead of just "denied" — falls back to the original
 * generic message when the reason is missing or whitespace-only, so a plain
 * Deny click (no typing) behaves exactly as it always has.
 */
export function composeDenialMessage(reason?: string): string {
  const trimmed = reason?.trim()
  if (!trimmed) {
    return 'The user denied this action. Do not retry it — ask how they would like to proceed.'
  }
  return `The user denied this action for this reason: "${trimmed}". Do not retry it — adjust your approach based on their feedback.`
}

/** A file this call touches, recorded in project memory on success. */
interface FileTouch {
  path: string
  action: FileTouchAction
}

interface ReadToolSpec {
  name: string
  kind: ToolKind
  title: string
  /** When set and a project is active, records this (or these) path(s) in project memory on success. */
  touch?: FileTouch | FileTouch[]
  /**
   * Overrides the default 4000-char model-result cap. Tools meant to deliver
   * full file content (read_file, read_multiple_files) need a much higher
   * ceiling — otherwise the model silently sees only a prefix of the file,
   * then calls edit_file/patch_file with an oldText it never actually read,
   * which fails with "text not found" even though nothing else is wrong.
   */
  modelResultCap?: number
  run: () => Promise<ToolOutcome>
}

interface GuardedToolSpec extends ReadToolSpec {
  /** Details shown in the approval prompt. */
  confirmDetail: string
  /** Before/after content for a file write/edit, so the prompt can render a real diff. */
  confirmDiff?: ToolCallDiff
  /** How risky this call is; decides whether the active permission mode confirms it. */
  risk: ToolRisk
  /**
   * Overrides the permission-mode decision with a fixed answer. Used by tools that
   * have their own independent approval toggle (e.g. `web_search`'s privacy setting)
   * instead of following the workspace permission mode.
   */
  forceConfirm?: boolean
}

/**
 * Run a read-only tool: emit `running`, execute, then emit `success`/`error`.
 * Errors are converted into a message the model can read and recover from,
 * rather than throwing (which would abort the whole generation).
 */
export async function runReadTool(ctx: ToolRuntimeContext, spec: ReadToolSpec): Promise<string> {
  const id = randomUUID()
  ctx.emit({ id, name: spec.name, kind: spec.kind, title: spec.title, status: 'running' })
  try {
    const { modelResult, detail, plan, preview } = await spec.run()
    const truncated = truncateModelResult(
      modelResult,
      spec.modelResultCap ?? MAX_MODEL_RESULT_CHARS
    )
    recordTouch(ctx, spec.touch)
    ctx.emit({
      id,
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      status: 'success',
      detail,
      plan,
      preview,
      result: rememberResult(modelResult)
    })
    return truncated
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.emit({
      id,
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      status: 'error',
      detail: message,
      result: `Error: ${message}`
    })
    return `Error: ${message}`
  }
}

/**
 * Record a file touch (or several) in project memory, if a project is active.
 * Normalizes the path against the workspace root first — the model can supply
 * equivalent spellings of the same path (`./foo.ts`, `foo.ts`), which would
 * otherwise create separate ledger entries for the same file.
 */
function recordTouch(ctx: ToolRuntimeContext, touch: FileTouch | FileTouch[] | undefined): void {
  if (!touch || !ctx.projectId) return
  const projectId = ctx.projectId
  const touches = Array.isArray(touch) ? touch : [touch]
  for (const t of touches) {
    projectMemoryStore.recordTouch(projectId, normalizeTouchPath(ctx, t.path), t.action)
  }
}

/** Best-effort normalization; falls back to the raw path if it can't be resolved. */
function normalizeTouchPath(ctx: ToolRuntimeContext, path: string): string {
  if (!ctx.workspaceRoot) return path
  try {
    return toWorkspaceRelative(ctx.workspaceRoot, resolveInWorkspace(ctx.workspaceRoot, path))
  } catch {
    return path
  }
}

/**
 * Run a write/command tool. When approval is required, the user is asked first;
 * a denial is reported back to the model so it can adapt.
 */
export async function runGuardedTool(
  ctx: ToolRuntimeContext,
  spec: GuardedToolSpec
): Promise<string> {
  const id = randomUUID()
  ctx.emit({ id, name: spec.name, kind: spec.kind, title: spec.title, status: 'running' })

  try {
    const needsConfirm =
      spec.forceConfirm ?? resolvePermission(ctx.permissionMode, spec.risk) === 'confirm'
    if (needsConfirm) {
      const response = await ctx.confirm({
        id: randomUUID(),
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
        toolName: spec.name,
        kind: spec.kind === 'command' || spec.kind === 'web' ? spec.kind : 'write',
        title: spec.title,
        detail: spec.confirmDetail,
        risk: spec.risk,
        diff: spec.confirmDiff
      })
      if (!response.approved) {
        ctx.emit({
          id,
          name: spec.name,
          kind: spec.kind,
          title: spec.title,
          status: 'denied',
          detail: response.reason ? `Denied: ${response.reason}` : 'Denied by user'
        })
        return composeDenialMessage(response.reason)
      }
    }

    const { modelResult, detail, diff, preview } = await spec.run()
    const truncated = truncateModelResult(
      modelResult,
      spec.modelResultCap ?? MAX_MODEL_RESULT_CHARS
    )
    recordTouch(ctx, spec.touch)
    ctx.emit({
      id,
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      status: 'success',
      detail,
      diff,
      preview,
      result: rememberResult(modelResult)
    })
    return truncated
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.emit({
      id,
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      status: 'error',
      detail: message,
      result: `Error: ${message}`
    })
    return `Error: ${message}`
  }
}

/** What a `prepare()` step hands off to the confirm prompt and, once approved, to `run()`. */
interface PreparedGuardedCall<TData> {
  confirmDetail: string
  confirmDiff?: ToolCallDiff
  data: TData
}

/**
 * Like `runGuardedTool`, but for tools that need to read/validate/compute
 * something — e.g. an edit's whole-file before/after diff — before the confirm
 * prompt is even shown, so it can render real content instead of just the raw
 * call arguments. A `prepare()` failure (bad input, file not found, sandbox
 * violation) is reported exactly like a `run()` failure: a clean resolved
 * error string and no confirm prompt for a call that's already known to fail.
 */
export async function runGuardedToolWithPrepare<TData>(
  ctx: ToolRuntimeContext,
  spec: Pick<GuardedToolSpec, 'name' | 'kind' | 'title' | 'risk' | 'touch' | 'forceConfirm'>,
  prepare: () => Promise<PreparedGuardedCall<TData>>,
  run: (data: TData) => Promise<ToolOutcome>
): Promise<string> {
  let prepared: PreparedGuardedCall<TData>
  try {
    prepared = await prepare()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.emit({
      id: randomUUID(),
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      status: 'error',
      detail: message,
      result: `Error: ${message}`
    })
    return `Error: ${message}`
  }

  return runGuardedTool(ctx, {
    ...spec,
    confirmDetail: prepared.confirmDetail,
    confirmDiff: prepared.confirmDiff,
    run: () => run(prepared.data)
  })
}
