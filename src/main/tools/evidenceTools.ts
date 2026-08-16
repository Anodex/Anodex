import type { DefineChatSessionFunction, ToolFactory, ToolRuntimeContext } from './types'
import { runReadTool } from './helpers'
import { modelResultCharBudget } from './modelResultBudget'

/**
 * Characters one recall may return when the turn has no measured budget yet
 * (the first round of a transport that has not tokenized anything, or a caller
 * that does not measure at all). Deliberately modest: a recall the model can
 * repeat with an offset is strictly safer than one large enough to refill the
 * window it was called to relieve.
 */
const DEFAULT_RECALL_CHARS = 4_000

/**
 * Read back a tool result this task already produced.
 *
 * This is the counterpart to `TurnEvidenceStore` — the sanctioned way to
 * recover evidence a transport evicted to free context. It exists so the
 * runtime never again has to tell the model to re-run a tool that
 * `ReadCoverageTracker` will refuse and `loopGuard` will block; see
 * `docs/CONTEXT_SYSTEM_ROOT_CAUSE.md` §1 for the livelock that produced.
 *
 * Deliberately free of side effects: no disk access, no tool re-execution, no
 * network, nothing to approve. It touches neither `readCoverage` (recall is not
 * a read of the file, it is a read of what was already served) nor the progress
 * ledger — recalling is not doing work, and must not be able to satisfy
 * `finish_goal`'s evidence gate. The loop guard *does* still apply, and
 * correctly: `recall_evidence` with identical arguments four times running is a
 * loop by any definition, while paging with different offsets is not.
 */
export const recallEvidenceTool: ToolFactory = (
  define: DefineChatSessionFunction,
  ctx: ToolRuntimeContext
) =>
  define({
    description:
      'Read back the full result of a tool call already made in this task, using the id shown in its [evidence E<n> …] line. Results are stored in full even after their text is trimmed out of the conversation to save room, so recall this instead of running the tool again. Omit id to list everything stored so far.',
    params: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'Evidence id such as "E7". Omit to list every stored result with its id and size.'
        },
        offset: {
          type: 'integer',
          description:
            'Character offset to read from, for paging a long result. Omit or use 0 to start at the beginning.'
        },
        match: {
          type: 'string',
          description:
            'Return only the lines containing this text, each prefixed with its character offset. Faster than paging when you know what you are looking for.'
        }
      }
    },
    handler: async (args: { id?: string; offset?: number; match?: string }) => {
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      const match = typeof args.match === 'string' ? args.match.trim() : ''
      const offset =
        typeof args.offset === 'number' && Number.isFinite(args.offset)
          ? Math.max(0, Math.floor(args.offset))
          : 0
      const title = id
        ? match
          ? `Recall ${id} matching "${match}"`
          : offset > 0
            ? `Recall ${id} from ${offset}`
            : `Recall ${id}`
        : 'List stored evidence'

      return runReadTool(ctx, {
        name: 'recall_evidence',
        kind: 'read',
        title,
        args,
        // Synchronous by nature: recall reads a store already in memory, which
        // is the point — it costs no disk access and no tool re-execution.
        run: () => Promise.resolve(recallOutcome(ctx, id, offset, match))
      })
    }
  })

/**
 * What one recall returns.
 *
 * **Always `madeProgress: false`, including on success.** A recall returns real
 * content, but it advances nothing — it is a view of something this task
 * already holds. That single flag is what keeps four separate things honest,
 * and every one of them was wrong without it (observed live: one turn made 50
 * recalls and zero writes):
 *
 * - `retainAsEvidence` does not store it, so a recall cannot mint a *copy* of
 *   the record it just read. Without this the catalogue grew by one entry per
 *   recall, and a model looking at a growing list of handles kept recalling.
 * - `recordCompletedCall` does not count it, so recalling cannot satisfy
 *   `finish_goal`'s evidence gate.
 * - `runBoundedChatGeneration` does not treat it as novel tool activity, so a
 *   cycle that only recalled cannot buy another cycle.
 * - `selectContextEpochCalls` does not carry it as durable work.
 */
function recallOutcome(
  ctx: ToolRuntimeContext,
  id: string,
  offset: number,
  match: string
): { modelResult: string; detail: string; madeProgress: false } {
  if (!id) {
    return {
      modelResult: ctx.ledger.evidence.index(),
      detail: `${ctx.ledger.evidence.size} stored`,
      madeProgress: false
    }
  }
  const limit = recallCharBudget(ctx)
  if (match) {
    const found = ctx.ledger.evidence.findLines(id, match, limit)
    if (found === null) return unknownEvidence(ctx, id)
    return { modelResult: found, detail: `Searched ${id}`, madeProgress: false }
  }
  const slice = ctx.ledger.evidence.slice(id, offset, limit)
  if (!slice) return unknownEvidence(ctx, id)
  const header =
    `${slice.record.id} · ${slice.record.tool} · ${slice.record.label} · ` +
    `characters ${slice.offset}-${slice.offset + slice.text.length} of ${slice.record.body.length}`
  const continuation =
    slice.nextOffset === null
      ? ''
      : `\n… more remains. Call recall_evidence("${slice.record.id}", ${slice.nextOffset}) to continue, or pass match to jump straight to what you need.`
  return {
    modelResult: `${header}\n${slice.text}${continuation}`,
    detail: slice.nextOffset === null ? 'Recalled in full' : 'Recalled a section',
    madeProgress: false
  }
}

/**
 * A recall is bounded by the same measured per-result budget a fresh tool
 * result is. Recalling must relieve context pressure, not become another way to
 * refill the window — and a model paging with offsets loses nothing by it.
 */
function recallCharBudget(ctx: ToolRuntimeContext): number {
  const budget = ctx.modelResultBudget.current
  const total = budget ? Math.max(512, modelResultCharBudget(budget)) : DEFAULT_RECALL_CHARS
  // The header and the "call again from offset N" line are part of the result
  // and are truncated away with everything else if they are not budgeted for.
  // Losing the continuation line is the worst possible thing to lose: the model
  // is then holding a partial recall with no stated way to get the rest, which
  // is how it ends up re-running the original tool.
  return Math.max(256, total - RECALL_FRAMING_CHARS)
}

/** Header line plus the longest continuation/paging sentence this tool emits. */
const RECALL_FRAMING_CHARS = 320

/**
 * Answering an unknown id with the index rather than a bare error: the model
 * asked the right question with the wrong handle, and the catalogue is both the
 * correction and the answer.
 */
function unknownEvidence(
  ctx: ToolRuntimeContext,
  id: string
): { modelResult: string; detail: string; madeProgress: false } {
  return {
    modelResult: `No stored result has id "${id}".\n${ctx.ledger.evidence.index()}`,
    detail: `Unknown evidence id ${id}`,
    madeProgress: false as const
  }
}
