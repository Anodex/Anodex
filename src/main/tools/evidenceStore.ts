/**
 * Durable working memory for one bounded task.
 *
 * ## Why this exists
 *
 * Anodex's transports bound a turn by *deleting* older tool results out of the
 * active exchange (`RECLAIM_TIERS` in `LlamaVisionService`, the mid-turn
 * context-shift strategy on node-llama-cpp, the shrinking per-result cap on
 * cloud). That is the right instinct — the window really does have to be freed —
 * but the implementation replaced the result with a note telling the model to
 * *run the tool again*, while `ReadCoverageTracker` simultaneously refused any
 * re-read as already-covered and `loopGuard` blocked the perturbed retries the
 * model used to get around that refusal.
 *
 * The measured consequence, in the conversation recorded in
 * `docs/CONTEXT_SYSTEM_ROOT_CAUSE.md`: one assistant message issued 157 tool
 * calls, pushed ~51,000 tokens of file evidence through a 16,384-token window,
 * had 56% of its reads be exact duplicates, and completed **zero** writes —
 * because `edit_file` needs an `oldText` copied from a read whose body had
 * already been deleted from context.
 *
 * ## What it changes
 *
 * The full result is kept here, outside the context window, and the context
 * keeps only a one-line **descriptor** naming what was gathered and how to get
 * it back. Eviction stops destroying information; it just moves it out of the
 * prompt. `recall_evidence` reads it back with no disk access, no tool
 * re-execution, no coverage refusal, and no side effect.
 *
 * Two properties matter more than the storage itself:
 *
 * - the descriptor list *is* the compact index of everything this task has
 *   discovered, which is the working memory a small-context model otherwise has
 *   no way to hold; and
 * - the model is never again told to do something another subsystem forbids.
 *
 * Lifetime is one bounded reply (`runBoundedChatGeneration`) or one agent run —
 * the same lifetime as `ReadCoverageTracker`, and for the same reason: both
 * describe what this *task* has seen, which outlives any single provider call
 * or context epoch. In-memory is deliberate; results are already bounded by
 * `modelResultBudget`, so a long turn holds single-digit megabytes.
 */

/** One stored tool result. */
export interface EvidenceRecord {
  /** Short stable handle the model uses: `E1`, `E2`, … */
  id: string
  /** Tool that produced it. */
  tool: string
  /** What it is, in the tool's own terms — e.g. `js/app.js lines 1-200`. */
  label: string
  /** The complete model-facing text, before any context truncation. */
  body: string
  createdAt: number
}

/** A slice of a stored result, plus where to continue from. */
export interface EvidenceSlice {
  record: EvidenceRecord
  text: string
  offset: number
  /** Next offset to request, or null when this slice reached the end. */
  nextOffset: number | null
}

/**
 * Results shorter than this are not worth storing: the descriptor that would
 * replace them costs about as much as the body, so eviction would free nothing
 * and the indirection would only cost the model a round trip.
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
  private readonly records = new Map<string, EvidenceRecord>()
  private readonly order: string[] = []
  private nextIndex = 1

  /**
   * Store a complete tool result and return its record, or `null` when the
   * result is too small to be worth an indirection (see
   * `MIN_STORED_RESULT_CHARS`).
   */
  record(input: { tool: string; label: string; body: string }): EvidenceRecord | null {
    const body = input.body
    if (body.length < MIN_STORED_RESULT_CHARS) return null
    const id = `E${this.nextIndex++}`
    const record: EvidenceRecord = {
      id,
      tool: input.tool,
      label: input.label.trim() || input.tool,
      body,
      createdAt: Date.now()
    }
    this.records.set(id, record)
    this.order.push(id)
    return record
  }

  /**
   * Look up a record, tolerating the punctuation weaker local models wrap an
   * identifier in and the lowercase spelling they sometimes emit. The id is a
   * handle this module minted, so recovering an obvious variant of it is
   * normalization, not guesswork — and refusing `"e7"` would send the model
   * back to re-running the tool, which is the whole failure being fixed.
   */
  get(id: string): EvidenceRecord | undefined {
    const trimmed = id.trim().replace(/^[`"'<>[\]]+|[`"'<>[\]]+$/g, '')
    return this.records.get(trimmed) ?? this.records.get(trimmed.toUpperCase())
  }

  get size(): number {
    return this.records.size
  }

  /**
   * The one-line form that stands in for a result once its body has left the
   * active context. Self-contained on purpose: it names the tool, what was
   * gathered, how much of it there is, and the exact call that returns it — so
   * a model that has lost the body still knows both that it has the evidence
   * and how to reach it.
   */
  descriptor(id: string): string {
    const record = this.get(id)
    if (!record) return ''
    const chars = record.body.length.toLocaleString('en-US')
    // Steers to a *targeted* recall. Suggesting the bare id invites paging a
    // whole file back into a window that could not hold it in the first place —
    // observed live as a run that recalled entry after entry trying to
    // reassemble a 966-line file instead of acting on it.
    return `${MARKER_PREFIX}${record.id} · ${record.tool} · ${record.label} · ${chars} chars · recall_evidence("${record.id}", match: "…")]`
  }

  /**
   * Ids of stored results whose label mentions `needle`, newest first.
   *
   * Read tools use this to answer "you already read that" with *where it is*
   * rather than a dead end. Labels are the tool titles Anodex itself composed
   * (`Read src/app.ts lines 1-200`), so matching a path inside one is a lookup
   * over this module's own records — not an interpretation of model or user
   * text, which orchestration must never depend on.
   */
  idsMentioning(needle: string, limit = 3): string[] {
    const target = needle.toLowerCase()
    if (!target) return []
    const found: string[] = []
    for (let index = this.order.length - 1; index >= 0 && found.length < limit; index--) {
      const record = this.records.get(this.order[index])!
      if (record.label.toLowerCase().includes(target)) found.push(record.id)
    }
    return found
  }

  /**
   * A compact catalogue of everything gathered this task, newest last.
   *
   * This is what `recall_evidence` returns with no id, and what a collapsed
   * descriptor block points at. Bounded by entry count rather than characters
   * because each line is already short and fixed-shape.
   */
  index(limit = 40): string {
    if (this.order.length === 0) {
      return 'No stored evidence yet this task. Results are stored automatically as tools run.'
    }
    const shown = this.order.slice(-limit)
    const omitted = this.order.length - shown.length
    const lines = shown.map((id) => {
      const record = this.records.get(id)!
      return `${record.id}\t${record.tool}\t${record.label}\t${record.body.length} chars`
    })
    const header =
      omitted > 0
        ? `${this.order.length} stored results (${omitted} older ones not listed):`
        : `${this.order.length} stored result(s):`
    return `${header}\n${lines.join('\n')}\nCall recall_evidence("E<n>") to read one back; add an offset to page through it.`
  }

  /**
   * Read part of a stored result back.
   *
   * `limit` is supplied by the caller from the turn's measured result budget,
   * so a recall can never claim more room than a fresh read would have.
   */
  slice(id: string, offset: number, limit: number): EvidenceSlice | null {
    const record = this.get(id)
    if (!record) return null
    const safeOffset = Math.min(Math.max(0, Math.floor(offset)), record.body.length)
    const text = record.body.slice(safeOffset, safeOffset + Math.max(1, limit))
    const end = safeOffset + text.length
    return {
      record,
      text,
      offset: safeOffset,
      nextOffset: end < record.body.length ? end : null
    }
  }

  /**
   * The lines of a stored result containing `match`, with their offsets.
   *
   * Cheaper than paging when the model knows what it is looking for — the
   * common case after a descriptor reminded it that it already read the file.
   * A plain substring test, never a regex: the argument comes from the model,
   * and a pathological pattern must not be able to stall the main process.
   */
  findLines(id: string, match: string, limit: number): string | null {
    const record = this.get(id)
    if (!record) return null
    const needle = match.toLowerCase()
    const out: string[] = []
    let offset = 0
    let used = 0
    for (const line of record.body.split('\n')) {
      if (line.toLowerCase().includes(needle)) {
        const entry = `@${offset}\t${line}`
        if (used + entry.length > limit) {
          out.push(`… more matches omitted at the active context budget.`)
          break
        }
        out.push(entry)
        used += entry.length + 1
      }
      offset += line.length + 1
    }
    if (out.length === 0) {
      return `No line of ${record.id} (${record.label}) contains "${match}". Call recall_evidence("${record.id}", 0) to page through it instead.`
    }
    return `Lines of ${record.id} (${record.label}) matching "${match}", prefixed with their character offset:\n${out.join('\n')}`
  }
}

export function createTurnEvidenceStore(): TurnEvidenceStore {
  return new TurnEvidenceStore()
}

/**
 * Append a descriptor line to a model-facing result, so the body and the handle
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
 * collapse a result to its handle without holding a reference to the store.
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
 * They are still recoverable — `recall_evidence` with no argument lists every
 * one — so collapsing them loses nothing but the at-a-glance view of the oldest.
 */
export function collapsedEvidenceNotice(count: number): string {
  return `${MARKER_PREFIX}archive · ${count} earlier result(s) still stored · recall_evidence() to list them]`
}
