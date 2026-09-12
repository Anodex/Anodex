# The context system — why it is shaped like this

Anodex's context handling looks over-engineered until you know what it is for. This is that
record: the two failures that produced it, the mechanisms that answer them, and where the
measurements came from.

It replaces six documents written while the work was in flight — a root-cause
investigation, a design comparison, two runtime-recovery handoffs, a benchmark handoff and a
reliability handoff. They overlapped heavily, contradicted each other wherever a later one
had learned something, and between them carried a few thousand lines of status reporting
about work that has since shipped. What was durable is here. The rest is in the history.

**Line numbers are deliberately absent.** The originals cited them precisely, and six of the
eight most-referenced had rotted by the time this was written. A stale reference that looks
exact is worse than a symbol name you have to grep for.

## 1. The evidence-eviction livelock

**Anodex deleted the evidence the model was working from, told it to fetch the evidence
again, refused the fetch, then stopped the turn for making no progress.** Three subsystems,
each locally reasonable, composing into a livelock.

The cycle:

1. A tool result lands. `computeModelToolResultBudget` caps a single result at roughly half
   the remaining room.
2. The next round no longer fits. The vision service measures whether it still fits and
   escalates through reclaim tiers — keep 2,000 characters, keep 400, then drop the body
   entirely, protecting only the two newest results.
3. The dropped result is replaced with an instruction to run the tool again.
4. The model complies, and `ReadCoverageTracker` refuses it, because those lines were
   already read this task. One assistant message produced **44 `read_file_range` errors**
   this way.
5. The model works around the refusal by perturbing the range — `1-200`, `25-224`,
   `35-234` — which is the only way to get content back. The loop guard then blocks that as
   a repeated call: **31 blocked calls** across the conversation.
6. No write is ever possible, because `edit_file` needs an exact `oldText` copied from a
   read whose body has been deleted. Hence eleven "text to replace was not found" errors —
   the model guessing at text it could no longer see.
7. `boundedChatRunner` sees the resulting `context-limit` and starts a context epoch, which
   resets history and grants a few recovery reads. Three reads later the cycle repeats.
   **The epoch machinery was the loop's outer ring, not its cure.**

One message, `m_1765b232`, makes it concrete:

| measure                | value                         |
| ---------------------- | ----------------------------- |
| tool results generated | 178,808 chars ≈ 51,000 tokens |
| model context window   | 16,384 tokens                 |
| read calls             | 64                            |
| _distinct_ read calls  | 28 — 56% were duplicates      |
| tool calls             | 157                           |
| successful writes      | **0**                         |

The turn pushed roughly three times its entire context window through as file evidence and
produced nothing, because no piece of it survived long enough to be used.

## 2. Where a small window goes before any work begins

Measured at `contextSize = 16,384`, from persisted budgets and source constants:

| component                                | tokens            |
| ---------------------------------------- | ----------------- |
| system prompt                            | ~3,500            |
| tool schemas                             | ~3,000            |
| reserved tokens                          | 512               |
| minimum viable output                    | 1,966             |
| epoch headroom                           | 2,457             |
| **overhead**                             | **~11,435 (70%)** |
| **left for history, evidence and reply** | **~4,900**        |

**The turn could afford roughly one substantial file read before it had to stop.** Every
action after that was recovery, and recovery cost another read. That arithmetic is the whole
explanation for "157 calls, 0 writes".

Two of those reserves were also double-counted: epoch headroom existed to hold room for one
bounded result landing, but results were _already_ bounded against the same remaining room.
Fifteen per cent of the window, reserved twice.

## 3. Newest-read-wins, rather than a ban on re-reading

The mechanism that dissolved the knot: **let the model re-read anything it likes, and
collapse the older copy to a marker when it does.**

It answers three failures at once:

- **The livelock**, because eviction can now tell the model to re-run a tool that will
  actually succeed.
- **The recall storm.** `recall_evidence` existed only to work around the re-read ban. With
  re-reads legal it has no job.
- **Stale edits**, because newest-read-wins means the copy in context is the current one, so
  the line numbers an edit was built from are still right when it lands.

The asymmetry that makes this work: **re-reading is bounded and idempotent; recall is
neither.** On a stateless transport every recall permanently inflates replayed history, so
context can only grow.

## 4. What the mechanisms are

- **A turn-scoped evidence store**, replacing reclaim-by-deletion. Evidence is held outside
  the replayed transcript and referenced, rather than carried in it and evicted.
- **Anchored edits**, so a write does not require the file's text to still be in context.
- **One state-driven progress ledger** — `TaskLedger` — replacing three overlapping guards
  that each had a partial view of whether the turn was getting anywhere.
- **A fixed floor sized against the window**, rather than assumed. See §2 for what happens
  otherwise.
- **No prose classifiers.** They cost tokens in that fixed floor to decide things structure
  already answers.

## 5. Bounded stops, and the budget a local model actually gets

A local generation can stop without finishing, and from outside the two cases look
identical: the model chose to stop, or the runtime ran out of room. `isRecoverableTurnStop`
and the diagnostics beside it exist to tell them apart.

- **Record why a bounded stop happened** — visible tokens, where the output budget went — as
  diagnostic metadata rather than content. Without it a stop is unattributable and the next
  fix is a guess.
- **Reasoning and required output need separate constraints.** A model that reasons until
  the budget is gone has no room left to answer, and that surfaces as an empty reply rather
  than as a budget problem.
- **Budget a run's lifetime, not each step greedily.** Critical Thinking spent its allowance
  per step, so late steps ran against an exhausted budget and approved steps could go
  unattempted.
- **Read coverage is a budget, not a prohibition.** See §3 for why the ban was itself the
  defect.

**8K is a regression canary, not the architecture.** A build that behaves at 8K is one whose
fixed overhead has not quietly crept back up. It is not evidence that 8K is a target worth
optimising for.

## 6. What was measured

Live benchmark records at 4K, 8K and 16K, against local text and local vision, are in the
git history of `CONTEXT_OS_HANDOFF.md` — capacity matrices, paired batch runs, and a
correction record for an earlier run that turned out to be measuring the wrong thing.

The finding that still governs the planner: **effective output is far smaller than the
nominal window**, and the gap widens as tools are added, because every schema is paid for on
every turn. `contextPlanner` is built against measured effective output rather than the
number on the box.

---

_Written 2026-09-11, consolidating work from July and August 2026. Where this contradicts an
older document, this one is correct. Where it is silent and an older one was specific, check
the history rather than assuming._
