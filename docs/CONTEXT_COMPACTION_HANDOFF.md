# Handoff — compaction thrash on the stateless transport

Written 2026-08-18. Companion to `CONTEXT_SYSTEM_DESIGN.md` (the plan) and
`CONTEXT_SYSTEM_ROOT_CAUSE.md` (the earlier investigation, parts of which are superseded).

Nothing in this document is committed. Working tree is on `main` at `7ccf1cb`.

## 1. What prompted it

A live reply (`m_7e45aa5f`, 2026-08-18 11:36, in conversation
`c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef`) ended with the banner:

> This reply stopped early — the conversation ran out of context space.

That reading is wrong, and the wrongness is the finding. The same reply carries
`latestEpochHandoff.epoch: 17` — it stopped, compacted and resumed **seventeen times** before
giving up. The conversation carries **151 compaction revisions**.

## 2. Diagnosis

**The transport is `LlamaVisionService`, not `LlamaService`.** `contextBudget.reservedTokens: 512`
identifies it (`RESERVED_TOKENS`; the node-llama-cpp path never produces that value). This matters:
`LlamaService.ts:837` has a proactive-compaction trigger that looks like the obvious culprit —
a bare `usageRatio > COMPACTION_TRIGGER_RATIO` with no check that compaction achieved anything —
and it was **not involved**. Confirm the transport before touching it; §0 of the root-cause doc
records the same trap costing a previous investigation.

The stateless path's real bounding is upstream in `runGeneration`, via
`boundHistoryForStatelessProvider` (`contextAssembler.ts`). Stateless means history is re-assembled
**every provider round**, and its overflow path is the rolling LLM summary. So:

- ~200 tool calls → one bounding pass per round → 151 ledger revisions.
- All 151 name the same `throughMessageId`. They must: the boundary is a _message_ id, and no new
  message is persisted until the reply ends, so it cannot advance mid-turn.
- `removedTurns` creeps 1494 → 1496 → … → 1504, **+2 per pass**.
- `fixedTokens` was **13,591 against an input limit of 15,872** — roughly 2,300 tokens of working
  room. Two turns is about all that fits, which is exactly the per-pass gain.

Each of those passes is a local summarizer generation. That is where the reply's 26 minutes went.

The defect is not the per-round fold itself — on a stateless transport that is the architecture.
It is that the fold is **unconditional**: nothing notices it gained almost nothing, and nothing
notices the floor is fixed overhead (system prompt + tool schemas), which folding history
structurally cannot reduce. `LlamaService.generate` states this in a comment directly beneath the
wrong trigger: _"Tool schemas are fixed prompt overhead: history compaction cannot make them
smaller."_

## 3. What landed

**Fix 2 — one revision per boundary. Done.** `src/shared/context.types.ts`.

`appendCompactionSnapshot` deduped on revision `id` only, and every fold mints a fresh id, so each
round appended a row. `mergeCompactionHistory` keyed on `throughMessageId + removedTurns + summary`,
and since `removedTurns` crept, every row stayed distinct. Both now key on the **boundary**, newest
wins. Revisions at genuinely different boundaries still accumulate.

Effect: "Context condensed 151 revisions" becomes one row per place the conversation was actually
condensed. This is also a precondition for the inline transcript markers the user asked for —
151 markers stacked on one boundary would be noise.

Typecheck clean, 3,265 tests pass.

## 4. What did NOT land, and why

**Fix 1 — make the fold conditional. Implemented, found wrong, reverted.**

The attempt: skip the fold when `historyBudget <= MAX_COMPACTION_SUMMARY_TOKENS` (800), on the
reasoning that a digest bounded at 800 tokens landing in a budget of ≤800 cannot come out ahead.

Two problems, both real:

1. **It would not have fired on the case it was written for.** The budget in the measured run is
   roughly 2,000–3,000 tokens after `recallWindowFraction` (0.4) — comfortably above 800. An
   absolute token threshold does not describe the failure.
2. It broke three legitimate tests in `boundHistoryForStatelessProvider` that exercise summarizing
   at small synthetic context sizes. Those tests are correct; the guard was not.

**The signal that actually distinguishes the failure is per-pass progress, not budget size.** The
run's tell is a fold advancing the boundary by two turns, repeatedly, against an unchanged boundary.
So the guard wants to be stateful: compare this fold's `coveredTurns` against the previous
revision's (`currentLedgerRevision(context)?.coveredTurns`, already read in
`boundHistoryForStatelessProvider` as `priorCoveredTurns`). If the boundary is unchanged and the
advance is below some minimum, reuse the existing digest and skip the generation.

Sketch, not yet written:

- in `boundHistoryForStatelessProvider`, before delegating to `assembleModelContext`, read the prior
  revision's boundary and `coveredTurns`;
- if the boundary matches what this pass would produce and the projected advance is small, take the
  drop path and return the seeded summary unchanged (`seeded.systemPrompt` already carries the old
  digest, so continuity is preserved);
- let `boundedChatRunner`'s context epoch be the recovery for fixed-overhead dominance, which is
  what it is for.

Needs a test that asserts the summarizer is called **once** across several rounds at one boundary,
not once per round. The existing three tests are the guard against over-correcting.

## 5. Also worth fixing, not started

- **The stop message lies by omission.** `describeGenerationStop`
  (`src/renderer/features/chat/generationStopMessages.ts:26`) keys purely on
  `stopReason === 'context-limit'` and has no idea 17 epochs preceded it. It should say Anodex
  compacted N times and then stopped because compacting stopped freeing room. Same class as
  `7ccf1cb` ("stop suppressing the reason a turn ended").
- **Why it stops compacting** is `MAX_CONSECUTIVE_RECOVERY_ONLY_CYCLES = 2` in `boundedChatRunner` —
  two consecutive post-epoch cycles where every call was a read and none read anything new. That
  guard is correct and deliberate (13 epochs once repeated the same two reads). It is simply never
  reported.
- **Inline compaction markers.** All data needed is already persisted:
  `conversation.context.compactionHistory` rows carry `throughMessageId` (the anchor),
  `removedTurns`, `reason`, and the full `summary`. Nothing needs capturing — only rendering. The
  only current surface is the global "Context condensed" chip.

## 6. Care needed

`src/main/llama/contextAssembler.ts` was listed as modified in this session's opening `git status`,
and now matches `7ccf1cb` exactly. Fix 1 was written into that file and then reverted; the revert
restored HEAD content rather than the session's starting content, so a small uncommitted change that
was there beforehand is gone, and there is no stash to recover it from. It may have been nothing
more than whitespace — the file typechecks and the full suite passes — but it should be eyeballed
against intent before anyone builds on that file.

## 7. Standing caveat

Everything here rests on one reply. Runs of this same prompt have ranged from 78 calls / 0 failures
to 220 calls / 19 failures. The 151-revision pattern is structural rather than stochastic — it
follows from statelessness plus an unconditional fold — but the _size_ of any improvement should be
measured, not assumed.
