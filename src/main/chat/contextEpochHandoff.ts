import { createHash, randomUUID } from 'node:crypto'
import type { ChatRequest, ContextEpochHandoff } from '@shared/chat.types'
import type { ToolCall } from '@shared/tools.types'
import { isObservationalRunCommand } from '../tools/commandEffect'
import { isReadLikeCall, progressFromSettledCalls } from '../tools/turnProgress'
import { outstandingVerification } from './continuationBrief'

/**
 * Building the handoff that carries work across a context epoch.
 *
 * Lifted out of `boundedChatRunner.ts` unchanged. It had been private there,
 * which made it chat's alone -- and agent runs, which never go through that
 * runner, had no context recovery at all: a turn that ran out of room was
 * retried against the same oversized history, failed the same way, and after
 * three of those a guard meant for "the model stopped trying" ended a run that
 * was still working. Measured on bench-1 at 8,192 (2026-09-05): seven turns
 * ended with "no room left for a usable reply", and the suite scored 1 of 6
 * against 6 of 6 at 65,536.
 *
 * Shared rather than copied. A second implementation of this would drift from
 * the first the way `email-criteria.mjs` drifted from the shared log parser --
 * it never learned a new line format and failed a model that had answered
 * correctly. The same drift here costs runs rather than scores.
 *
 * Nothing in it was chat-specific: the inputs are an objective, a plan, the
 * settled calls, and a summary, all of which an agent run has.
 */
export function buildContextEpochHandoff(input: {
  epoch: number
  cause: ContextEpochHandoff['cause']
  objective: string
  plan: ChatRequest['plan'] | null | undefined
  calls: ToolCall[]
  workingSummary?: string
  evidenceIndex?: string
  priorFixedTokens?: number
}): ContextEpochHandoff {
  const settledCalls = input.calls.filter(
    (call): call is ToolCall & { status: 'success' | 'error' | 'denied' } =>
      call.status === 'success' || call.status === 'error' || call.status === 'denied'
  )
  const completedTools = selectContextEpochCalls(settledCalls).map((call) => ({
    name: call.name,
    kind: call.kind,
    status: call.status,
    ...(call.madeProgress === false ? { madeProgress: false } : {}),
    touchedPaths: call.touchedPaths?.slice(0, 4),
    identity: toolCallIdentity(call),
    outcome: call.detail?.trim() ? call.detail.trim().slice(0, 120) : undefined,
    contentHash: writtenContentHash(call)
  }))
  return {
    version: 1,
    id: randomUUID(),
    createdAt: Date.now(),
    epoch: input.epoch,
    cause: input.cause,
    objective: input.objective,
    workingSummary: input.workingSummary,
    evidenceIndex: input.evidenceIndex,
    plan: input.plan ?? undefined,
    completedTools,
    // Derived in `turnProgress.ts` from the same kind sets the live gate uses,
    // so an epoch can never disagree with `agentTools.ts` about what counts as
    // work or as a rendering-affecting change.
    progress: progressFromSettledCalls(input.calls.map(asProgressCall)),
    priorFixedTokens: input.priorFixedTokens,
    // Derived from the same settled state the continuation brief uses, rather
    // than a fixed sentence. The note this replaced — "after a
    // rendering-affecting change, inspect the result again" — is true on every
    // turn and so says nothing about this one. It matters most here: once an
    // epoch starts the brief is suppressed for the rest of the reply, and an 8K
    // run took twelve epochs, so this note is the only place the outstanding
    // verification can still reach the model.
    verificationNote:
      outstandingVerification(settledCalls) ??
      'Preserve the existing evidence gate: after a rendering-affecting change, inspect the result again before claiming success.'
  }
}

/**
 * Keep the latest settlements while reserving room for recent durable work.
 * Error/no-op churn used to evict every earlier mutation from a 12-call
 * handoff, making the fresh epoch repeat work it had genuinely completed.
 */
function selectContextEpochCalls<T extends ToolCall>(calls: readonly T[]): T[] {
  const durableLimit = 6
  const recentOtherLimit = 2
  const evidenceLimit = 4
  const durable = (call: T): boolean =>
    call.status === 'success' &&
    call.madeProgress !== false &&
    !isReadLikeCall(call) &&
    call.kind !== 'plan'
  const selected = new Set(calls.filter(durable).slice(-durableLimit))
  const visual = calls.findLast(
    (call) => call.name === 'inspect_visual' && call.status === 'success'
  )
  if (visual) selected.add(visual)

  const evidenceKeys = new Set<string>()
  let evidenceCount = visual ? 1 : 0
  for (const call of calls.toReversed()) {
    if (evidenceCount >= evidenceLimit) break
    if (!isReadLikeCall(call) || call.status !== 'success' || call === visual) continue
    const key = readEvidenceKey(call)
    if (evidenceKeys.has(key)) continue
    evidenceKeys.add(key)
    selected.add(call)
    evidenceCount++
  }

  for (const call of calls
    .filter((call) => !durable(call) && !(isReadLikeCall(call) && call.status === 'success'))
    .slice(-recentOtherLimit)) {
    selected.add(call)
  }
  return calls.filter((call) => selected.has(call))
}

function readEvidenceKey(call: ToolCall): string {
  const path = call.touchedPaths?.[0]?.toLowerCase()
  if (path) {
    const category = call.name === 'inspect_visual' ? 'visual' : 'file'
    return `${category}:${path}`
  }
  return `${call.name}:${call.title.toLowerCase().replace(/\d+/g, '#')}`
}

function asProgressCall(call: ToolCall): ToolCall {
  return isObservationalRunCommand(call) ? { ...call, kind: 'read' } : call
}

/**
 * The one-line identity of a settled call.
 *
 * `ToolCall.title` is authoritative — `parseRunCommandVerification` already
 * parses the command back out of it — and it is a settlement-time snapshot, so
 * the in-turn argument reclamation that rewrites the provider message array
 * cannot have truncated it first.
 */
function toolCallIdentity(call: ToolCall): string | undefined {
  const title = call.title?.trim()
  return title ? title.slice(0, 200) : undefined
}

/**
 * Digest of what a successful write actually left on disk, so a resumed epoch
 * can recognize its own completed work rather than redo it. Deliberately not
 * the content: the handoff carries facts, and the file itself is still there.
 */
function writtenContentHash(call: ToolCall): string | undefined {
  if (call.status !== 'success' || !call.diff) return undefined
  return createHash('sha256').update(call.diff.after).digest('hex').slice(0, 12)
}
