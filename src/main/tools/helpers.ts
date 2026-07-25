import { randomUUID } from 'node:crypto'
import type { ToolCallDiff, ToolCallPreview, ToolKind, ToolRisk } from '@shared/tools.types'
import type { CheckpointFileChange } from '@shared/checkpoint.types'
import type { FileTouchAction } from '@shared/projectMemory.types'
import type { Plan } from '@shared/plan.types'
import type { ToolRuntimeContext } from './types'
import { needsTurnGate, resolvePermission } from './permissions'
import { checkLoopGuard, loopGuardKey, loopGuardMessage } from './loopGuard'
import { projectMemoryStore } from '../projects/ProjectMemoryStore'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { checkpointStore } from '../checkpoints/CheckpointStore'
import { clampModelResultCap } from './modelResultBudget'

/** Truncated tool output retained for cross-session memory. */
const MAX_REMEMBERED_RESULT = 2000
/** Maximum chars of a single tool result sent to the model, absent an active runtime budget. */
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
  /** Restorable file snapshots for this successful mutation. */
  checkpointChanges?: CheckpointFileChange[]
}

function rememberResult(modelResult: string): string {
  return modelResult.length > MAX_REMEMBERED_RESULT
    ? `${modelResult.slice(0, MAX_REMEMBERED_RESULT)}…`
    : modelResult
}

function truncateModelResult(modelResult: string, cap: number): string {
  if (cap <= 0) {
    return '(No room left in the active context for this result. Continue in a fresh turn, or narrow the request — e.g. a smaller line range or a more specific search.)'
  }
  return modelResult.length > cap
    ? `${modelResult.slice(0, cap)}\n… (truncated, ${modelResult.length} bytes total)`
    : modelResult
}

/**
 * The cap actually applied to one tool result: the tool's own requested cap
 * (or the generic default), clamped down to what the active turn's measured
 * context budget allows. Never clamps upward — a tool's own cap always wins
 * when it's already the tighter of the two.
 */
function effectiveModelResultCap(
  ctx: ToolRuntimeContext,
  requestedCap: number | undefined
): number {
  return clampModelResultCap(requestedCap ?? MAX_MODEL_RESULT_CHARS, ctx.modelResultBudget.current)
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
  /**
   * The tool handler's own parsed arguments — used as the loop guard's call
   * -identity fingerprint (see `loopGuardKey` in `loopGuard.ts`) so it can
   * tell apart calls that share a title (e.g. the same file path with
   * different new content) from genuine repeats. Falls back to `title` when
   * omitted, which is coarser — pass this whenever the tool takes more than
   * the single value already fully captured in its title.
   */
  args?: unknown
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
   * Adds an extra, independent reason to confirm — used by tools with their own
   * approval toggle (e.g. `web_search`'s privacy setting). Additive only: `true`
   * forces a confirmation the permission mode/turn gate wouldn't otherwise
   * require. `false` and `undefined` behave identically — neither one can
   * remove a confirmation the permission mode or turn gate would otherwise
   * require; there is no way to force auto-run through this field. (A prior
   * version treated `false` as an unconditional bypass — `web_search`'s
   * `forceConfirm: ctx.webSearch.requireApproval` silently skipped the turn
   * gate too whenever that setting was off, not just its own toggle.)
   */
  forceConfirm?: boolean
  /**
   * Stronger than `forceConfirm`: this call needs an actual person, so the
   * unattended surfaces refuse it instead of auto-approving (see
   * `headlessConfirm`). Implies `forceConfirm` — it confirms in every
   * permission mode. Mirror any tool set here with `requiresHumanApproval` on
   * its `TOOL_CATALOG` entry, so the Scheduler and Agent editors stop offering
   * it for unattended runs rather than letting the user opt into a call that
   * can only ever be refused.
   */
  requiresHumanApproval?: boolean
}

/**
 * Run a read-only tool: emit `running`, execute, then emit `success`/`error`.
 * Errors are converted into a message the model can read and recover from,
 * rather than throwing (which would abort the whole generation).
 */
export async function runReadTool(ctx: ToolRuntimeContext, spec: ReadToolSpec): Promise<string> {
  const id = ctx.claimPendingToolCallId?.(spec.name) ?? randomUUID()
  const limitMessage = ctx.beforeTool?.(spec.name, spec.args) ?? null
  if (limitMessage) {
    ctx.emit({
      id,
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      status: 'error',
      detail: 'Blocked: execution budget reached',
      result: limitMessage
    })
    return limitMessage
  }
  ctx.emit({ id, name: spec.name, kind: spec.kind, title: spec.title, status: 'running' })
  const loopGuard = checkLoopGuard(ctx.loopGuard, spec.name, loopGuardKey(spec))
  if (loopGuard.blocked) {
    // Only claim generation is stopping when something can actually stop it —
    // cloud providers (Anthropic/OpenAI) don't wire abortGeneration at all
    // (their own MAX_TOOL_ROUNDS cap bounds the damage differently; see
    // ToolRuntimeContext.abortGeneration's doc comment), so telling the model
    // "generation is being stopped now" there would be false: nothing stops,
    // and the round loop just keeps going, burning further paid API rounds.
    const canActuallyAbort = Boolean(ctx.abortGeneration)
    const message = loopGuardMessage(
      spec.name,
      loopGuard.count,
      loopGuard.shouldAbort && canActuallyAbort
    )
    ctx.emit({
      id,
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      status: 'error',
      detail: 'Blocked: repeated identical call',
      result: message
    })
    if (loopGuard.shouldAbort) ctx.abortGeneration?.()
    return message
  }
  try {
    const { modelResult, detail, plan, preview } = await spec.run()
    const truncated = truncateModelResult(
      modelResult,
      effectiveModelResultCap(ctx, spec.modelResultCap)
    )
    const touchedPaths = recordTouch(ctx, spec.touch)
    markProgress(ctx, spec)
    ctx.emit({
      id,
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      status: 'success',
      detail,
      plan,
      preview,
      result: rememberResult(modelResult),
      touchedPaths: touchedPaths.length ? touchedPaths : undefined
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
 * Record a file touch (or several) in project memory, if a project is active,
 * and return the normalized path(s) recorded — the single authoritative
 * source (rather than re-deriving from `title`/`diff` later) for what this
 * call actually changed, threaded onto the emitted `ToolCall` below and, from
 * there, into `ProjectRecallEvent`'s `changedFiles`.
 * Normalizes the path against the workspace root first — the model can supply
 * equivalent spellings of the same path (`./foo.ts`, `foo.ts`), which would
 * otherwise create separate ledger entries for the same file.
 */
function recordTouch(
  ctx: ToolRuntimeContext,
  touch: FileTouch | FileTouch[] | undefined
): string[] {
  if (!touch || !ctx.projectId) return []
  const projectId = ctx.projectId
  const touches = Array.isArray(touch) ? touch : [touch]
  return touches.map((t) => {
    const path = normalizeTouchPath(ctx, t.path)
    projectMemoryStore.recordTouch(projectId, path, t.action)
    return path
  })
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
 * Marks `ctx.progress` once a non-read tool call succeeds — see
 * `ToolRuntimeContext.progress`'s doc comment. Excludes `finish_goal` itself
 * so it can never satisfy its own precondition.
 */
function markProgress(ctx: ToolRuntimeContext, spec: { name: string; kind: ToolKind }): void {
  if (spec.name !== 'finish_goal' && spec.kind !== 'read') {
    ctx.progress.madeChange = true
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
  const id = ctx.claimPendingToolCallId?.(spec.name) ?? randomUUID()
  const limitMessage = ctx.beforeTool?.(spec.name, spec.args) ?? null
  if (limitMessage) {
    ctx.emit({
      id,
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      status: 'error',
      detail: 'Blocked: execution budget reached',
      result: limitMessage
    })
    return limitMessage
  }
  ctx.emit({ id, name: spec.name, kind: spec.kind, title: spec.title, status: 'running' })
  const loopGuard = checkLoopGuard(ctx.loopGuard, spec.name, loopGuardKey(spec))
  if (loopGuard.blocked) {
    // See the identical comment in runReadTool above — only claim generation
    // is stopping when abortGeneration actually exists to do it.
    const canActuallyAbort = Boolean(ctx.abortGeneration)
    const message = loopGuardMessage(
      spec.name,
      loopGuard.count,
      loopGuard.shouldAbort && canActuallyAbort
    )
    ctx.emit({
      id,
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      status: 'error',
      detail: 'Blocked: repeated identical call',
      result: message
    })
    if (loopGuard.shouldAbort) ctx.abortGeneration?.()
    return message
  }

  try {
    const permissionDecision = resolvePermission(ctx.permissionMode, spec.risk)
    const gatedByTurnStart = needsTurnGate(ctx.permissionMode, spec.risk, ctx.turnGate.approved)
    const needsConfirm =
      spec.forceConfirm === true ||
      spec.requiresHumanApproval === true ||
      permissionDecision === 'confirm' ||
      gatedByTurnStart
    if (needsConfirm) {
      const response = await ctx.confirm({
        id: randomUUID(),
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
        toolName: spec.name,
        kind:
          spec.kind === 'command' || spec.kind === 'web' || spec.kind === 'mcp'
            ? spec.kind
            : 'write',
        title: spec.title,
        detail: spec.confirmDetail,
        risk: spec.risk,
        diff: spec.confirmDiff,
        turnGate: gatedByTurnStart,
        requiresHumanApproval: spec.requiresHumanApproval
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
      // Only the turn gate's own checkpoint satisfies the turn gate — an
      // unrelated confirmation (a forced privacy toggle, a plain
      // ask-mode/destructive confirm) approving here must not silently mark
      // the turn's "first action" checkpoint as done too, or a later call
      // that genuinely needed that checkpoint would auto-run without ever
      // showing it.
      if (gatedByTurnStart) ctx.turnGate.approved = true
    }

    const { modelResult, detail, diff, preview, checkpointChanges } = await spec.run()
    const truncated = truncateModelResult(
      modelResult,
      effectiveModelResultCap(ctx, spec.modelResultCap)
    )
    const touchedPaths = recordTouch(ctx, spec.touch)
    markProgress(ctx, spec)
    const changes = checkpointChanges ?? checkpointChangesFromDiff(diff)
    noteMutatedReadCoverage(ctx, spec.touch, changes)
    recordCheckpoint(ctx, changes)
    ctx.emit({
      id,
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      status: 'success',
      detail,
      diff,
      preview,
      result: rememberResult(modelResult),
      touchedPaths: touchedPaths.length ? touchedPaths : undefined
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
 * Mark every path a successful guarded call mutated as stale in the task's
 * read-coverage tracker (see `ReadCoverageTracker.noteMutation`). Uses both
 * the declared touch (write/delete/move — never read) and the checkpoint
 * changes, since only the latter carries a move's source path. Keyed by the
 * same workspace-resolved absolute path the read tools track under. Unlike
 * `recordCheckpoint`, this must not depend on an active project — coverage
 * staleness is real in any workspace chat. Changes no touch declares (a
 * `run_command` side effect, the user's own editor) are caught separately,
 * at read time, by `ReadCoverageTracker.reconcileMtime`.
 */
function noteMutatedReadCoverage(
  ctx: ToolRuntimeContext,
  touch: FileTouch | FileTouch[] | undefined,
  changes: CheckpointFileChange[] | undefined
): void {
  if (!ctx.workspaceRoot) return
  const touches = Array.isArray(touch) ? touch : touch ? [touch] : []
  const paths = [
    ...touches.filter((t) => t.action !== 'read').map((t) => t.path),
    ...(changes ?? []).map((change) => change.path)
  ]
  for (const path of paths) {
    try {
      ctx.readCoverage.noteMutation(resolveInWorkspace(ctx.workspaceRoot, path))
    } catch {
      /* Outside the workspace — the tracker never held coverage for it. */
    }
  }
}

function recordCheckpoint(
  ctx: ToolRuntimeContext,
  changes: CheckpointFileChange[] | undefined
): void {
  if (!ctx.projectId || !ctx.workspaceRoot || !changes?.length) return
  for (const change of changes) {
    checkpointStore.recordChange(ctx.workspaceRoot, ctx.conversationId, ctx.messageId, change)
  }
}

function checkpointChangesFromDiff(diff: ToolCallDiff | undefined): CheckpointFileChange[] {
  return diff ? [{ path: diff.path, before: diff.before, after: diff.after }] : []
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
  spec: Pick<
    GuardedToolSpec,
    'name' | 'kind' | 'title' | 'risk' | 'touch' | 'forceConfirm' | 'requiresHumanApproval' | 'args'
  >,
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
