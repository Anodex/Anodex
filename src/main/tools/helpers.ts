import { randomUUID } from 'node:crypto'
import type {
  EmailDraftPreview,
  ToolCallDiff,
  ToolCallPreview,
  ToolKind,
  ToolRisk
} from '@shared/tools.types'
import type { CheckpointFileChange } from '@shared/checkpoint.types'
import type { FileTouchAction } from '@shared/projectMemory.types'
import type { Plan } from '@shared/plan.types'
import type { ToolRuntimeContext } from './types'
import { needsTurnGate, resolvePermission } from './permissions'
import { loopGuardKey } from './loopGuard'
import { projectMemoryStore } from '../projects/ProjectMemoryStore'
import { resolveInWorkspace, toWorkspaceRelative } from './workspace'
import { checkpointStore } from '../checkpoints/CheckpointStore'
import { clampModelResultCap } from './modelResultBudget'
import { recordCompletedCall } from './turnProgress'
import { effectiveToolKind } from './commandEffect'
import { withEvidenceMarker } from './evidenceStore'

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
  /** Explicitly false when a successful tool result is only a redirect/no-op. */
  madeProgress?: boolean
}

function rememberResult(modelResult: string): string {
  return modelResult.length > MAX_REMEMBERED_RESULT
    ? `${modelResult.slice(0, MAX_REMEMBERED_RESULT)}…`
    : modelResult
}

/**
 * Tools whose truncated result can be continued by asking for a narrower part
 * of the same file, which is the advice worth giving alongside the cut.
 */
const RANGE_READABLE_TOOLS = new Set([
  'read_file',
  'read_file_range',
  'read_multiple_files',
  'code_outline'
])

/**
 * Trim a result to the room this turn has for it, and say what to do about it.
 *
 * The note used to read only `(truncated, N bytes total)`. That states the fact
 * and withholds the one thing the model needs: that the *same* call returns the
 * *same* prefix. Without it, re-reading looks like a way to see the rest of the
 * file, and a model whose earlier result was evicted will do exactly that.
 * Measured: one turn spent 27 reads and zero writes cycling through the same
 * five files five times, because two of them were over the per-result cap and
 * the note gave no way forward.
 *
 * Not a small-file edge case. The cap is a share of what is left of the window,
 * so on a tight context most real source files exceed it — that turn's cap was
 * ~10,000 characters against a 15,915-character file.
 */
function truncateModelResult(modelResult: string, cap: number, toolName?: string): string {
  if (cap <= 0) {
    return '(No room left in the active context for this result. Continue in a fresh turn, or narrow the request — e.g. a smaller line range or a more specific search.)'
  }
  if (modelResult.length <= cap) return modelResult
  // Only worth spending the words where the result itself is substantial. On a
  // cap of a few dozen characters the guidance would dwarf the content it is
  // explaining, and the byte counts alone already say what happened.
  const nextStep =
    cap < MIN_CONTENT_CHARS_BESIDE_MARKER
      ? ''
      : toolName !== undefined && RANGE_READABLE_TOOLS.has(toolName)
        ? ' Repeating it returns this same prefix — use code_outline or read_file_range to read further.'
        : ' Repeating it returns this same prefix — narrow the request.'
  return `${modelResult.slice(0, cap)}
… (truncated: showing the first ${cap} of ${modelResult.length} bytes.${nextStep})`
}

/**
 * Note the result in the task's record of what it has gathered, and hand back
 * the context-facing copy with its descriptor attached.
 *
 * The order matters: the record is taken *before* `truncateModelResult` touches
 * the result, so the size it reports is the whole thing rather than whatever
 * happened to fit this round. Every successful call goes through here, reads
 * and mutations alike — a build log from `run_command` is exactly as likely to
 * be evicted mid-task as a file read.
 *
 * See `TurnEvidenceStore` for why evicting a result *silently* (the previous
 * behaviour) deadlocked long tasks.
 */
function retainAsEvidence(
  ctx: ToolRuntimeContext,
  spec: { name: string; title: string },
  modelResult: string,
  cap: number,
  madeProgress: boolean
): string {
  // A call that made no progress produced no evidence: its result is a refusal
  // or a no-op notice. Recording those would file control messages in the
  // catalogue alongside the real reads, so the task's own account of what it
  // has gathered would overstate it.
  if (!madeProgress) return truncateModelResult(modelResult, cap, spec.name)
  const record = ctx.ledger.evidence.record({
    tool: spec.name,
    label: spec.title,
    body: modelResult
  })
  if (!record) return truncateModelResult(modelResult, cap, spec.name)
  // The descriptor is part of the result the model receives, so it is paid for
  // out of the same budget rather than added on top of it. A cap is a promise
  // about how much of the context one call may take, and quietly exceeding it
  // is how the accounting the transports plan against stops being true.
  const descriptor = ctx.ledger.evidence.descriptor(record)
  const room = cap - descriptor.length - 1
  if (room < MIN_CONTENT_CHARS_BESIDE_MARKER)
    return truncateModelResult(modelResult, cap, spec.name)
  return withEvidenceMarker(truncateModelResult(modelResult, room, spec.name), descriptor)
}

/**
 * Below this much room for actual content, the descriptor is not worth its own
 * cost: a result reduced to almost nothing but a note about itself tells the
 * model less than the same characters of real output would.
 */
const MIN_CONTENT_CHARS_BESIDE_MARKER = 200

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
  /** The resolved outgoing message, when this call sends mail, so the prompt can render it as a draft. */
  confirmEmailDraft?: EmailDraftPreview
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
  const preflight = beginToolCall(ctx, spec)
  const { id } = preflight
  if (preflight.blocked) return preflight.blocked
  const repeat: RepeatReview = { advice: preflight.advice }
  try {
    const { modelResult, detail, plan, preview, madeProgress = true } = await spec.run()
    ctx.ledger.recordOutcome({ kind: effectiveToolKind(spec, 'read'), madeProgress })
    const truncated = withGatheringAdvice(
      retainAsEvidence(
        ctx,
        spec,
        modelResult,
        effectiveModelResultCap(ctx, spec.modelResultCap),
        madeProgress
      ),
      repeat.advice
    )
    const touchedPaths = recordTouch(ctx, spec.touch)
    if (madeProgress) markProgress(ctx, spec)
    ctx.emit({
      id,
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      status: 'success',
      ...(madeProgress ? {} : { madeProgress: false }),
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

/** What a completed preflight established about a call that is about to run. */
interface ToolCallPreflight {
  /** The card this call reports on, claimed once for the whole call. */
  id: string
  /** Set when the call must not run at all; this is the model-facing reason. */
  blocked?: string
  /** A correction to append to the result of a call that is still allowed to run. */
  advice?: string
}

/**
 * Everything that must happen before a tool's own work begins: claim the UI
 * card, charge the execution budget, show the call as running, and let the task
 * ledger decide whether it should run at all.
 *
 * Shared by all three entry points so the order can never drift between them,
 * and — the reason it was extracted — so it can run exactly once for a
 * prepare-then-run pair. `runGuardedToolWithPrepare` used to reach the ledger
 * only after its `prepare()` step had succeeded, which meant every failure
 * raised in `prepare()` was invisible to the loop guard: a size-limit refusal,
 * a path outside the workspace, a missing file, an `edit_file` whose `oldText`
 * is no longer in the file. Those are the *commonest* write failures, and a
 * model repeating one got the identical error back forever with nothing
 * counting the repeats. Observed directly: eight byte-identical `append_file`
 * calls, each rejected for the same over-limit payload, none of them counted.
 */
function beginToolCall(
  ctx: ToolRuntimeContext,
  spec: { name: string; kind: ToolKind; title: string; args?: unknown }
): ToolCallPreflight {
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
    return { id, blocked: limitMessage }
  }
  ctx.emit({ id, name: spec.name, kind: spec.kind, title: spec.title, status: 'running' })
  const repeat = reviewRepeat(ctx, spec, id)
  return { id, blocked: repeat.blocked, advice: repeat.advice }
}

/**
 * Ask the task ledger what to do about this call, and emit the outcome when it
 * must not run.
 *
 * **Advice** runs the call and appends a correction to its result. Refusing on
 * the first sign of over-gathering would be wrong — that call may be the one
 * that finally locates the problem — but saying nothing is how a turn reaches a
 * hundred calls and no output.
 *
 * A repeated stable read is deliberately *not* refused; see
 * `TaskLedger.reviewCall` and `docs/CONTEXT_SYSTEM_ROOT_CAUSE.md` §1 for the
 * livelock that refusing it produced.
 */
function reviewRepeat(
  ctx: ToolRuntimeContext,
  spec: {
    name: string
    kind: ToolKind
    title: string
    args?: unknown
  },
  id: string
): RepeatReview {
  const verdict = ctx.ledger.reviewCall({
    name: spec.name,
    // A shell command used to read a file is gathering, whatever kind the tool
    // declares — see `effectiveToolKind`. Without this the ledger's gathering
    // ladder has a shell-shaped hole in it, and a live run walked straight
    // through it.
    kind: effectiveToolKind(spec, 'read'),
    key: loopGuardKey(spec),
    args: spec.args,
    // Only a read may simply repeat — see `TaskLedger.reviewCall`.
    rereadable: spec.kind === 'read'
  })
  if (verdict.action === 'run') return {}
  if (verdict.action === 'advise') return { advice: verdict.message }

  // Only claim generation is stopping when something can actually stop it.
  // Every first-party transport wires this callback: local text aborts its
  // opaque native loop; explicit local-vision/cloud loops latch the request and
  // refuse another provider round. Keep it optional for custom callers.
  const aborting = verdict.action === 'abort' && Boolean(ctx.abortGeneration)
  const message = aborting
    ? verdict.message
    : verdict.message.replace(
        ' Generation is being stopped now because this kept repeating after being told to stop.',
        ''
      )
  ctx.ledger.recordOutcome({ kind: effectiveToolKind(spec, 'read'), madeProgress: false })
  ctx.emit({
    id,
    name: spec.name,
    kind: spec.kind,
    title: spec.title,
    status: 'error',
    detail: verdict.detail,
    result: message
  })
  if (verdict.action === 'abort') ctx.abortGeneration?.()
  return { blocked: message }
}

/**
 * What `reviewRepeat` decided: run it (`{}`), run it with a correction appended
 * to the result (`advice`), or don't run it at all (`blocked`).
 */
interface RepeatReview {
  blocked?: string
  advice?: string
}

/**
 * Append the ledger's "stop gathering and act" correction to a result.
 *
 * Carried on the result rather than sent as its own turn: an extra generation
 * to deliver one sentence costs a full round on a slow local model, at exactly
 * the moment the turn is already running long.
 */
function withGatheringAdvice(result: string, advice: string | undefined): string {
  return advice
    ? `${result}

[Anodex] ${advice}`
    : result
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
 * Records a successful tool call in `ctx.progress` — see `TurnProgress` in
 * `turnProgress.ts` for what is tracked and why.
 *
 * Every successful call is recorded, not just changes: the ledger needs the
 * ordering of reads too, because `inspect_visual` is a `read` and the whole
 * point is knowing whether it ran *after* the last change. Which kinds count
 * as "real work" for `finish_goal`'s purposes is decided inside
 * `recordCompletedCall`, not here.
 */
function markProgress(ctx: ToolRuntimeContext, spec: { name: string; kind: ToolKind }): void {
  recordCompletedCall(ctx.progress, spec)
}

/**
 * Run a write/command tool. When approval is required, the user is asked first;
 * a denial is reported back to the model so it can adapt.
 */
export async function runGuardedTool(
  ctx: ToolRuntimeContext,
  spec: GuardedToolSpec,
  /**
   * A preflight already performed by the caller. `runGuardedToolWithPrepare`
   * passes its own so the call is counted, budgeted and card-claimed exactly
   * once across the prepare-then-run pair; direct callers omit it.
   */
  done?: ToolCallPreflight
): Promise<string> {
  const preflight = done ?? beginToolCall(ctx, spec)
  const { id } = preflight
  if (preflight.blocked) return preflight.blocked
  const repeat: RepeatReview = { advice: preflight.advice }

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
        emailDraft: spec.confirmEmailDraft,
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

    const {
      modelResult,
      detail,
      diff,
      preview,
      checkpointChanges,
      madeProgress = true
    } = await spec.run()
    ctx.ledger.recordOutcome({ kind: effectiveToolKind(spec, 'read'), madeProgress })
    const truncated = withGatheringAdvice(
      retainAsEvidence(
        ctx,
        spec,
        modelResult,
        effectiveModelResultCap(ctx, spec.modelResultCap),
        madeProgress
      ),
      repeat.advice
    )
    const touchedPaths = recordTouch(ctx, spec.touch)
    if (madeProgress) markProgress(ctx, spec)
    const changes = checkpointChanges ?? checkpointChangesFromDiff(diff)
    noteMutatedReadCoverage(ctx, spec.touch, changes)
    recordCheckpoint(ctx, changes)
    ctx.emit({
      id,
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      status: 'success',
      ...(madeProgress ? {} : { madeProgress: false }),
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
      ctx.ledger.reads.noteMutation(resolveInWorkspace(ctx.workspaceRoot, path))
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
  confirmEmailDraft?: EmailDraftPreview
  data: TData
}

/**
 * Like `runGuardedTool`, but for tools that need to read/validate/compute
 * something — e.g. an edit's whole-file before/after diff — before the confirm
 * prompt is even shown, so it can render real content instead of just the raw
 * call arguments. A `prepare()` failure (bad input, file not found, sandbox
 * violation) is reported exactly like a `run()` failure: a clean resolved
 * error string and no confirm prompt for a call that's already known to fail.
 *
 * The preflight (card, budget, loop guard) runs *before* `prepare()` and its
 * result is handed to `runGuardedTool`, so the pair is treated as the single
 * call it is. See {@link beginToolCall} for the failure this ordering fixes.
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
  const preflight = beginToolCall(ctx, spec)
  if (preflight.blocked) return preflight.blocked

  let prepared: PreparedGuardedCall<TData>
  try {
    prepared = await prepare()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.emit({
      // The card claimed by the preflight, not a fresh one. `write_file`,
      // `edit_file`, and `patch_file` are simultaneously the only tools with a
      // provisional streaming card (`PendingToolCallTracker`'s `TRACKED_TOOLS`)
      // and all users of this function. A failing `prepare()` — a path outside
      // the workspace, a missing file, an `oldText` that isn't in the file,
      // which is edit_file's single commonest failure — used to emit the real
      // error onto a brand-new card while the card the user had watched fill
      // in was left unclaimed, to be swept at the end of the round as
      // "Interrupted". One failed call, two cards, and the one naming the
      // actual reason was not the one attached to the call they were watching.
      id: preflight.id,
      name: spec.name,
      kind: spec.kind,
      title: spec.title,
      status: 'error',
      detail: message,
      result: `Error: ${message}`
    })
    return `Error: ${message}`
  }

  return runGuardedTool(
    ctx,
    {
      ...spec,
      confirmDetail: prepared.confirmDetail,
      confirmDiff: prepared.confirmDiff,
      confirmEmailDraft: prepared.confirmEmailDraft,
      run: () => run(prepared.data)
    },
    preflight
  )
}
