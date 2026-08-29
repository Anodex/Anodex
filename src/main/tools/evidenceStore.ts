/**
 * A record of what one bounded task has already gathered.
 *
 * ## Why this exists
 *
 * Anodex's transports bound a turn by *shortening* older tool results in the
 * active exchange (`RECLAIM_TIERS` in `LlamaVisionService`, the mid-turn
 * context-shift strategy on node-llama-cpp, the shrinking per-result cap on
 * cloud). The window really does have to be freed, but the old implementation
 * deleted the result outright and left nothing in its place — so the model
 * could not tell whether it had ever run the tool, and reran it blind.
 *
 * The measured consequence, in the conversation recorded in
 * `docs/CONTEXT_SYSTEM_ROOT_CAUSE.md`: one assistant message issued 157 tool
 * calls, pushed ~51,000 tokens of file evidence through a 16,384-token window,
 * had 56% of its reads be exact duplicates, and completed **zero** writes.
 *
 * ## What it changes
 *
 * A shortened result leaves a one-line **descriptor** behind naming the tool,
 * what it acted on, and how big the result was. Eviction stops being silent: it
 * costs the body, not the knowledge that the body once existed.
 *
 * Two properties matter more than the bookkeeping itself:
 *
 * - the descriptor list *is* the compact index of everything this task has
 *   discovered, which is the working memory a small-context model otherwise has
 *   no way to hold; and
 * - the model is never told to do something another subsystem forbids — a
 *   re-read is legal (see `TaskLedger.reviewCall`), so "read it again" is
 *   advice it can actually follow.
 *
 * ## What this deliberately does *not* do
 *
 * It does not keep result bodies. It used to, to serve them back through a
 * `recall_evidence` tool; that tool is retired. A re-read costs one bounded
 * call and returns what is on disk *now*, while a recall cost a call and
 * permanently enlarged replayed history with a copy that was already stale.
 * One measured run spent 39% of 156 calls recalling and still had four edits
 * rejected for stale line numbers. See `docs/CONTEXT_SYSTEM_DESIGN.md` §3.2.
 *
 * Lifetime is one bounded reply (`runBoundedChatGeneration`) or one agent run —
 * the same lifetime as `ReadCoverageTracker`, and for the same reason: both
 * describe what this *task* has seen, which outlives any single provider call
 * or context epoch.
 */

/** One tool result this task produced. Metadata only — never the body. */
export interface EvidenceRecord {
  /** Short stable handle: `E1`, `E2`, … Ties an inline descriptor to the index. */
  id: string
  /** Tool that produced it. */
  tool: string
  /** What it is, in the tool's own terms — e.g. `js/app.js lines 1-200`. */
  label: string
  /** Size of the model-facing text, before any context truncation. */
  chars: number
}

/**
 * Results shorter than this are not worth recording: the descriptor that would
 * replace them costs about as much as the body, so eviction would free nothing.
 */
const MIN_STORED_RESULT_CHARS = 240

/**
 * Marker prefix. Deliberately a bracketed sentinel rather than prose: the
 * transports recognise their own marker to collapse a result to its descriptor,
 * and that recognition must never depend on natural-language matching.
 */
const MARKER_PREFIX = '[evidence '

/** Matches a descriptor line this module produced. Anchored, whole-line. */
const MARKER_LINE = /^\[evidence (E\d+) · .*\]$/

export class TurnEvidenceStore {
  /**
   * Append-only, oldest first. A plain array rather than a keyed map: nothing
   * looks a record up by id any more. Ids used to be handles the *model* typed
   * back at `recall_evidence`, which is why lookup once had to tolerate the
   * punctuation and casing weaker models wrap them in. With that tool retired
   * an id is only ever printed, never parsed, so the normalization it needed
   * went with it.
   */
  private readonly records: EvidenceRecord[] = []

  /**
   * Note a completed tool result and return its record, or `null` when the
   * result is too small to be worth a descriptor (see
   * `MIN_STORED_RESULT_CHARS`).
   */
  record(input: { tool: string; label: string; body: string }): EvidenceRecord | null {
    const chars = input.body.length
    if (chars < MIN_STORED_RESULT_CHARS) return null
    const record: EvidenceRecord = {
      id: `E${this.records.length + 1}`,
      tool: input.tool,
      label: input.label.trim() || input.tool,
      chars
    }
    this.records.push(record)
    return record
  }

  /**
   * The one-line form that stands in for a result once its body has left the
   * active context. Self-contained on purpose: it names the tool, what was
   * gathered, and how much of it there was — so a model that has lost the body
   * still knows the work happened, and knows what re-running it would cost.
   */
  descriptor(record: EvidenceRecord): string {
    const chars = record.chars.toLocaleString('en-US')
    return `${MARKER_PREFIX}${record.id} · ${record.tool} · ${record.label} · ${chars} chars · body trimmed; read it again if you need it]`
  }

  /**
   * A compact catalogue of everything gathered this task, newest last.
   *
   * This is what a collapsed descriptor block and a context-epoch handoff point
   * at. Bounded by entry count rather than characters because each line is
   * already short and fixed-shape.
   */
  index(limit = 40): string {
    if (this.records.length === 0) {
      return 'Nothing gathered yet this task. Results are recorded automatically as tools run.'
    }
    const shown = this.records.slice(-limit)
    const omitted = this.records.length - shown.length
    const lines = shown.map(
      (record) => `${record.id}\t${record.tool}\t${record.label}\t${record.chars} chars`
    )
    // The omitted entries are gone, not merely unlisted: this index is
    // metadata only, and `recall_evidence` — the tool that used to fetch an
    // older record by id — was retired with the context rebuild. Saying
    // "not listed" invited the model to assume it still had that ground
    // covered and could go back for it; it cannot, and re-running the tool
    // is the only way to see any of it again.
    const header =
      omitted > 0
        ? `${this.records.length} results so far. The ${omitted} older ones are no longer ` +
          `available — re-run the tool if you need them again:`
        : `${this.records.length} result(s) so far:`
    return `${header}\n${lines.join('\n')}`
  }
}

export function createTurnEvidenceStore(): TurnEvidenceStore {
  return new TurnEvidenceStore()
}

/**
 * Append a descriptor line to a model-facing result, so the body and the note
 * that outlives it travel together.
 *
 * Placed last and on its own line because that is what makes eviction a pure
 * truncation: a transport freeing room keeps this line and drops everything
 * above it (see `evidenceDescriptorOf`), with no need to look the record up.
 */
export function withEvidenceMarker(modelResult: string, descriptor: string): string {
  if (!descriptor) return modelResult
  return `${modelResult}\n${descriptor}`
}

/**
 * The descriptor line of an already-marked result, or `null`.
 *
 * This reads a sentinel this module wrote, not the model's or the user's prose
 * — the distinction the architecture requires. It exists so a transport can
 * collapse a result to its descriptor without holding a reference to the store.
 */
export function evidenceDescriptorOf(content: string): string | null {
  const lastNewline = content.lastIndexOf('\n')
  if (lastNewline < 0) return MARKER_LINE.test(content) ? content : null
  const candidate = content.slice(lastNewline + 1)
  return MARKER_LINE.test(candidate) ? candidate : null
}

/** Whether `content` is *only* a descriptor — already collapsed, nothing left to free. */
export function isEvidenceDescriptorOnly(content: string): boolean {
  return MARKER_LINE.test(content.trim())
}

/**
 * The single line that stands in for descriptors old enough to be dropped
 * themselves.
 *
 * A long task accumulates enough descriptors that they become their own context
 * cost (fifty results is on the order of a thousand tokens of handles alone).
 * Collapsing them loses only the at-a-glance view of the oldest; what they
 * described is still on disk, one read away.
 */
export function collapsedEvidenceNotice(count: number): string {
  return `${MARKER_PREFIX}archive · ${count} earlier result(s), bodies and descriptors both trimmed]`
}
