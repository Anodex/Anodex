# Anodex context system — root cause and replacement design

Independent investigation answering `docs/CLAUDE_CONTEXT_SYSTEM_HANDOFF.md`. Evidence comes from
the persisted conversation named there
(`c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef.json`, 80 messages, 18.6 MB) plus the current source.

## 0. The fact the handoff does not state

Every persisted `contextBudget` in that conversation carries `reservedTokens: 512`.

That value is `RESERVED_TOKENS` in `src/main/llama/LlamaVisionService.ts:65`. The node-llama-cpp
text path uses `defaultContextShiftReserve(contextSize)` instead, which is never 512 at 16K or 32K.

**The entire failing conversation ran on `LlamaVisionService` — the stateless llama-server
transport.** None of the node-llama-cpp context-shift machinery
(`contextShiftStrategy.ts`, `deterministicCheckpoint.ts`, the KV-cache session reuse) was involved
in any of the failures. Time spent auditing that code was time spent on the wrong transport.

The defect described below is nevertheless _structural_, not vision-specific: the same
eviction-without-recovery shape exists in the node-llama-cpp mid-turn strategy and, more mildly,
in the cloud round budget. The fix must be provider-neutral, which is what the design in §3 is.

## 1. Root cause: the evidence-eviction livelock

Anodex deletes the evidence the model is working from, tells it to fetch the evidence again, then
refuses the fetch, then stops the turn for not making progress. Three subsystems, each locally
reasonable, compose into a livelock.

### 1.1 The cycle, with source references

1. **A result lands.** `computeModelToolResultBudget` (`src/main/tools/modelResultBudget.ts:59`)
   caps one tool result at ~50% of remaining room. At 16K with `fixedTokens ≈ 10,000` that is
   ~2,400 tokens.

2. **The next round no longer fits.** `LlamaVisionService.generate` measures
   `fitsNow` (`LlamaVisionService.ts:426`) and escalates through `RECLAIM_TIERS`
   (`LlamaVisionService.ts:1376`): keep 2,000 chars → keep 400 → **drop the body entirely**,
   protecting only the two newest results.

3. **The dropped result is replaced with an instruction to re-run the tool**
   (`LlamaVisionService.ts:1261`):

   > `[Result trimmed to fit the context.] The full result of read_file_range was dropped to make
room in this turn. Run it again if you still need it — do not guess at what it said.`

4. **The model complies. `ReadCoverageTracker` refuses it**
   (`src/main/tools/readCoverage.ts:188` → `uncovered()` returns empty →
   `coverageRefusalResponse` in `fileTools.ts`):

   > `[js/universe-sandbox.js: lines 1-200 were already read earlier this task — no new content
here.] This is repeat request 5 for already-covered content…`

   Observed **44 `read_file_range` errors in a single assistant message** (`m_1765b232`).

5. **The model works around the refusal by perturbing the range** — `1-200`, `25-224`, `35-234`,
   `40-239`, `59-160` — which is the only way to get content back. `checkLoopGuard`
   (`src/main/tools/loopGuard.ts:68`) then blocks it as a repeat: **31 `Blocked: repeated identical
call` errors** conversation-wide.

6. **No write is ever possible.** `edit_file` requires an exact `oldText` copied from a read whose
   body has been deleted from context. Hence **11 `The text to replace was not found in the file`**
   and **4 `Replacement 1: oldText was not found`** — the model guessing at text it can no longer
   see. `m_1765b232`: 157 tool calls, 109 successful, **0 successful writes**.

7. **`boundedChatRunner` reacts to the resulting `context-limit` by starting a context epoch**
   (`src/main/chat/boundedChatRunner.ts:442`), which resets `history` to `baseHistory`
   (line 506) — deleting the cycle's whole tool transcript — and grants
   `RECOVERY_READS_PER_EPOCH = 3` re-reads (line 208). Three reads later the cycle repeats. The
   epoch machinery _is the loop's outer ring_, not its cure.

### 1.2 The throughput number that makes it concrete

In `m_1765b232` alone:

| measure                | value                             |
| ---------------------- | --------------------------------- |
| tool results generated | **178,808 chars ≈ 51,000 tokens** |
| model context window   | **16,384 tokens**                 |
| read calls             | 64                                |
| _distinct_ read calls  | 28 (**56% were duplicates**)      |
| successful writes      | **0**                             |

The turn pushed ~3× its entire context window through as file evidence and produced nothing,
because no piece of it survived long enough to be used.

## 2. Second root cause: ~70% of a 16K window is spent before any work

Measured from the persisted budgets and the source constants, at `contextSize = 16,384`:

| component                               | tokens            | source                                                                                                                 |
| --------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| system prompt                           | ~3,500            | `CODING_AGENT_PROMPT` alone is 7,359 chars ≈ 1,840 tok (`src/shared/prompts.ts:19`) + environment + workspace + memory |
| tool schemas (23 active)                | ~3,000            | `maxDirectToolsForContext(16384) = 10` in the WIP, was 20 (`toolSurface.ts:27`)                                        |
| `RESERVED_TOKENS`                       | 512               | `LlamaVisionService.ts:65`                                                                                             |
| `minimumViableOutputTokens`             | 1,966             | `LlamaVisionService.ts:155`                                                                                            |
| `epochHeadroomTokens`                   | 2,457             | `LlamaVisionService.ts:161`                                                                                            |
| **overhead total**                      | **~11,435 (70%)** |                                                                                                                        |
| **left for history + evidence + reply** | **~4,900**        |                                                                                                                        |

`proactiveLimitTokens = 15,872 − 1,966 − 2,457 = 11,449`. Observed `fixedTokens` on the failing
messages: 9,601 / 11,624 / 11,751 / 13,569.

**So the turn can afford roughly one substantial file read before it must stop.** Every subsequent
action is recovery, and recovery costs another read. That is the arithmetic behind "157 calls, 0
writes".

Two of those reserves are also double-counted: `epochHeadroomTokens` exists to hold room for "one
bounded result landing", but results are _already_ bounded by `computeModelToolResultBudget` against
the same remaining room. At 16K that is ~2,457 tokens (15% of the window) reserved twice.

## 3. The replacement design

The governing idea: **on a small window, working memory must live outside the context, and the
context must carry addresses rather than content.** Everything below follows from that. None of it
inspects user or assistant prose.

### Pillar 1 — Turn-scoped evidence store (replaces reclaim-by-deletion)

Every tool result is written to a durable per-turn store keyed by an id (`E1`, `E2`, …). The
provider message array carries a bounded excerpt plus that id. When room is needed, the excerpt
shrinks to a one-line **descriptor** that stays in context permanently and cheaply:

```
[E7] read_file_range js/universe-sandbox.js:1-200 — 200 lines, 8,412 chars — recall_evidence("E7")
```

One small native tool, `recall_evidence(id, offset?, match?)`, serves the stored bytes back. It is
free (no disk read, no tool re-execution, no side effect), deterministic, and **exempt from both the
read-coverage tracker and the loop guard by construction** — it is the sanctioned recovery path, so
punishing it is a category error.

This removes the contradiction at its source. The model is never told "run it again"; it is told
"recall E7", and recalling E7 always works.

### Pillar 2 — Anchored edits, so file text need not be held in context

Add `replace_lines(path, startLine, endLine, newText, expectedFirstLine?)`. Reads already return
line numbers. The model then needs ~15 tokens of working memory ("`planetData` is at 412-418")
instead of 8,000 characters of exact quoted text. `expectedFirstLine` is an optimistic-concurrency
check so a stale anchor fails loudly instead of corrupting the file.

`edit_file` stays for models that prefer it; this is an addition, not a replacement. It is the
single change most likely to turn "0 writes" into writes on a small model.

### Pillar 3 — One state-driven progress ledger (replaces three overlapping guards)

`ReadCoverageTracker`, `loopGuard`, and `boundedChatRunner`'s cross-cycle `seenToolActivity` /
`seenReadActivity` sets each independently decide "this is a repeat". Merge into one `TaskLedger`
that additionally knows whether the evidence for a call is **currently visible** or
**evicted-but-recallable**. The rules become:

- repeat read whose evidence is _visible_ → refuse, with the pointer to where it is;
- repeat read whose evidence was _evicted_ → **redirect to `recall_evidence`**, not refuse;
- repeat that is neither → genuine loop, block.

### Pillar 4 — Make the fixed floor fit the window

- **Tiered system prompt.** Same rules, fewer words below ~24K: a compact core (~600 tokens)
  replaces the 1,840-token prose block. Selected by measured context size, never by prompt wording.
- **Collapse the double reserve** (`minimumViableOutputTokens` + `epochHeadroomTokens`) into one,
  since result size is already bounded against the same room.
- **Size the native surface by measurement**, not by the arbitrary `maxDirectToolsForContext`
  count; the gateway keeps every tool reachable either way.

### Pillar 5 — Delete the prose classifiers

The handoff already rejects these; they are still live in `boundedChatRunner.ts`:
`looksLikeVagueFollowUp`, `looksLikePlanContinuation`, `claimsTaskCompletion`,
`looksLikeBuildDiagnosis`, `isProcessNarration`, `factualRecoveryText`, plus `claimsVisualSuccess`
and the disabled `SEMANTIC_PROSE_ROUTING_ENABLED` branch and `intentNudges.ts`. Each is replaced by
settled-call state that is already being tracked.

## 4. Assessment of the uncommitted work-in-progress

| change                                                                | verdict                                                                                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxDirectToolsForContext` 20 → 10                                    | **Right direction, wrong mechanism.** It cut schemas from ~3,000 to 1,504 tokens (observed in `m_8c707813`). But a fixed count is arbitrary; measure instead. |
| Removing prompt-keyword email gating / native-tool ranking            | **Correct. Keep.**                                                                                                                                            |
| `SEMANTIC_PROSE_ROUTING_ENABLED = false`                              | **Correct, but finish it** — delete the dead branch rather than leaving it to drift back.                                                                     |
| Observational `run_command` classified read-only (`commandEffect.ts`) | **Correct. Keep.**                                                                                                                                            |
| Context-epoch handoff / `capContextEpochHandoff`                      | **Treats the symptom.** Harmless, but epochs stop being load-bearing once Pillar 1 lands; keep the handoff, shrink its role.                                  |
| Rebuilt-epoch "did not reclaim room" preflight                        | **Correct as a failsafe. Keep.**                                                                                                                              |
| Stream ordering / `tokenBatcher` / `taskPhase`                        | **Unrelated to this defect and independently good. Keep.**                                                                                                    |

Nothing in the WIP is wrong enough to revert. None of it addresses §1.

## 5. Acceptance checks (from the handoff, mapped to this design)

- black-screen prompt completes → Pillars 1+2
- 16K model starts with materially more room → Pillar 4
- recovery shrinks input and resumes → Pillar 1 makes recovery mostly unnecessary
- no keyword controls orchestration → Pillar 5
- all tools reachable → gateway unchanged
- no repeated mutation after compaction → Pillar 3 ledger
- no tool stuck `running` → already fixed in the WIP (`settleInterruptedReadCalls`)

## 6. What has been built

All five pillars, transport-neutral: the ledger, the store and the tool live in
`src/main/tools/`, and every transport (node-llama-cpp, llama-server vision, OpenAI, Anthropic,
OpenAI-compatible, agent runs) threads one `TaskLedger` where it used to thread three separate
pieces of state.

| file                                                      | change                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/tools/taskLedger.ts`                            | **new.** `TaskLedger` owns read coverage, the loop guard and the evidence store, and answers the one question they used to answer separately: run, redirect, block, or abort.                                                                    |
| `src/main/tools/evidenceStore.ts`                         | **new.** `TurnEvidenceStore` — full results outside the window, one-line handles inside it.                                                                                                                                                      |
| `src/main/tools/evidenceTools.ts`                         | **new.** `recall_evidence(id?, offset?, match?)`. No disk, no re-execution, no side effects; bounded by the same per-result budget.                                                                                                              |
| `src/main/tools/helpers.ts`                               | `retainAsEvidence` stores every successful result before truncation and attaches its handle _inside_ the cap. `reviewRepeat` routes both tool runners through the ledger. No-progress results (refusals, redirects) are deliberately not stored. |
| `src/main/llama/LlamaVisionService.ts`                    | eviction collapses a result to its handle instead of saying "run it again"; `collapseEvidenceDescriptors` sheds old handles; `epochHeadroomTokens` no longer double-reserves.                                                                    |
| `src/main/tools/fileTools.ts`                             | a repeat read is redirected to `recall_evidence` when a stored copy exists; the escalation ladder now only fires when none does.                                                                                                                 |
| `src/main/tools/mutationTools.ts`                         | **new tool** `replace_lines(path, startLine, endLine, newText, expectedFirstLine?)`, CRLF-preserving, with a stale-anchor interlock.                                                                                                             |
| `src/main/llama/toolSurface.ts`                           | `DIRECT_TOOL_PRIORITY` reordered so the first ten native schemas are a complete builder loop including `recall_evidence` and `replace_lines`.                                                                                                    |
| `src/shared/prompts.ts`                                   | `COMPACT_CODING_AGENT_PROMPT` + `coreAgentPrompt(contextWindowTokens)`; selected by measured window only.                                                                                                                                        |
| `src/shared/chat.types.ts`, `src/shared/contextPrompt.ts` | `ContextEpochHandoff.evidenceIndex` replaces `recoveryReadAllowance` — a catalogue of what the task holds, instead of permission to re-read three files.                                                                                         |

### The classifiers that were removed

Each is replaced by state that was already being tracked, not by a different pattern.

| removed                                                                                                                                                                                                                                   | decided                                                                      | now decided by                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `looksLikeVagueFollowUp`, `looksLikePlanContinuation`                                                                                                                                                                                     | whether an unfinished plan is active                                         | always passed; `renderCurrentPlan` states its precedence in a constant string |
| `claimsTaskCompletion`                                                                                                                                                                                                                    | whether to run the plan-reconciliation pass, and whether to report open rows | durable work + an open plan row                                               |
| `looksLikeBuildDiagnosis`                                                                                                                                                                                                                 | whether to warn that a change is unverified                                  | a successful `write` call with no build/test/lint command in the task         |
| `claimsVisualSuccess` (whole file)                                                                                                                                                                                                        | whether a visual claim needs a screenshot                                    | `hasStaleVisualEvidence` — an inspection exists and a change came after it    |
| `isProcessNarration`, `factualRecoveryText`                                                                                                                                                                                               | what survives into a recovery handoff                                        | newest distinct paragraphs, verbatim, plus the evidence index                 |
| `looksLikeUnactedIntent`, `looksLikeFabricatedOutcome`, `looksLikeStalledIntent`, `looksLikeToolBypass`, `looksLikeUnfinishedActionPromise`, `detectFabricatedUserTurn` + `intentNudges.ts` + the `SEMANTIC_PROSE_ROUTING_ENABLED` branch | whether to spend an extra generation re-prompting the model                  | nothing — deleted. What a turn did is in its settled calls                    |
| the fabrication signal feeding `AgentRun.flaggedTurns` and the reliability score                                                                                                                                                          | model writing style                                                          | `findUnverifiedPathClaims` — files named but never touched and not on disk    |

`detectFallbackToolCall` stays: recovering a malformed call is _parsing syntax the model emitted_,
not guessing at what a reply means. So does `findUnverifiedPathClaims`, which extracts path-shaped
identifiers and checks them against the filesystem rather than classifying the sentence around them.

### Measured effect at 16,384 tokens

| item                    | before     | after      |
| ----------------------- | ---------- | ---------- |
| core system prompt      | 2,005 tok  | 573 tok    |
| tooling note            | 86 tok     | 0 (folded) |
| native tool schemas     | ~3,000 tok | ~1,500 tok |
| `epochHeadroomTokens`   | 2,457 tok  | 655 tok    |
| `proactiveLimitTokens`  | 11,449     | 13,251     |
| **usable working room** | **~4,900** | **~9,800** |

Roughly double the room — and, more importantly, evicting a result is no longer destructive, so
running near the limit costs a collapse to a handle rather than the loss of the evidence.

### Verification

`npm run typecheck` (both projects), `eslint .`, `prettier --check`, `vitest run`
(**275 files / 3,125 passed, 1 skipped**), `npm run build`, and the Electron E2E suite
(**7/7**) — all green.

New regression coverage: `evidenceStore.test.ts` (19 cases), `taskLedger.test.ts` (6 cases,
including that a repeated read redirects while a repeated command still blocks), `replace_lines` in
`mutationTools.test.ts` (11 cases), the "never says run it again" contract in
`LlamaVisionService.test.ts`, compact-prompt selection in `prompts.test.ts`, and an
`orchestration does not read prose` suite in `boundedChatRunner.test.ts` that runs the same
scenarios through several phrasings — including a non-English one and an empty reply — and asserts
the outcome does not move.

## 7. What is not done

**A live replay.** Everything above is static analysis plus unit coverage; the failing conversation
has not been re-run on real hardware. In the logs, the things to watch are:

- `read_file_range` errors and `Blocked: repeated identical call` should largely disappear, replaced
  by `recall_evidence` calls;
- a message that previously completed zero writes should complete some;
- `fixedTokens` at round 0 on a 16K model should land near 5,000–6,000 rather than 9,000–13,000.

If a turn still stalls, the first thing to check is whether `recall_evidence` appears in the tool
calls at all. If it does not, the native surface is not carrying it (check `activeToolCount` and the
`DIRECT_TOOL_PRIORITY` order); if it does and the turn still churns, the evidence index in the epoch
handoff is the next thing to look at.

## 8. First live retest — the recall storm

The first dev-build run of the failing prompt (`m_61218823`) went **103 calls, 50 of them
`recall_evidence`, zero writes**. Longer than before, and stuck differently. Three causes, all fixed.

### 8.1 Recall was minting copies of itself

`recallOutcome` returned without `madeProgress: false`, so `retainAsEvidence` stored every recall
result as a _new_ record — a copy of part of the record it had just read. The catalogue grew by one
entry per recall, and a model looking at a lengthening list of handles kept recalling. A compounding
feedback loop, introduced by the fix itself.

`madeProgress: false` on every recall path is the whole correction, and it is the right semantic
rather than a patch: **a recall returns real content but advances nothing.** One flag makes four
separate things true at once — it is not stored, it does not count toward `finish_goal`'s evidence
gate, it cannot buy the bounded runner another cycle, and it is not carried as durable work in an
epoch handoff. Every one of those was wrong before.

### 8.2 Nothing noticed a turn producing no output

The loop guard catches an _identical_ call; read coverage catches an _identical_ range. Neither
notices forty legitimately-distinct calls that gather and gather and change nothing — which is the
literal shape of both failures on this prompt (157/0 and 103/0).

`TaskLedger` now tracks gathering calls since the last durable change:

- **22** → the call still runs, with a correction appended to its result: act on what you have.
- **34** → further gathering is refused; the turn ends with an answer rather than with nothing.
- any successful mutation resets it, so read → edit → read is unaffected.

A mutation is never blocked by this, however long the gathering ran — the point is to push the turn
toward acting, so the action itself must always get through.

### 8.3 The descriptor invited whole-file recalls

It suggested `recall_evidence("E7")`, i.e. page the whole thing back into a window that could not
hold it. It now suggests `recall_evidence("E7", match: "…")`, and the compact prompt says to locate
first, read narrow, and recall only what the next action needs.

### 8.4 Also fixed

A stride-reading model walking off the end of a file hit `Start line 333 is beyond the file's 332
lines` four times in a row (the coverage tracker's first uncovered segment can begin past EOF). It
now reports that there is nothing further to read, which is what is actually true.

### Still worth watching

`systemTokens` on the retest was 3,256 of 16,384. The compact core is 573 of that; most of the rest
is reference material (workspace context, retrieved memory, project rules) plus the epoch handoff.
Scaling the _reference_ sections to the window is the next lever if a turn still runs short of room
— it was not touched here, and it competes directly with evidence.

## 9. Second live retest — it started working, then ran out of rounds

`m_7a9bc662` on the same prompt: **207 calls, and for the first time on this request, writes.**

|                   | m_1765b232 (before)   | m_61218823 (recall storm) | m_7a9bc662 (this)                        |
| ----------------- | --------------------- | ------------------------- | ---------------------------------------- |
| successful writes | **0**                 | **0**                     | **8** (7 `replace_lines`, 1 `edit_file`) |
| `recall_evidence` | n/a                   | 50 of 103                 | 42 of 207                                |
| ended by          | repeated-action guard | repeated-action guard     | provider-round budget, work preserved    |

`replace_lines` is doing exactly what it was added for — `Replace js/universe-sandbox.js lines 48-54`,
`lines 720-720`, `lines 271-276`. The turn no longer stalls; it runs out of budget while working.

### 9.1 The model found a hole in the gathering ladder and said so

From its own reply: _"The system is blocking repeated info calls. Let me use a command to read the
file content I need, then make the edit."_ Twenty-two shell reads followed — `sed -n '40,50p'`,
`Get-Content … Select-Object -Index`, `head -n 100 … | tail -n 30`, `Select-String -Pattern`.

`run_command` declares `kind: 'command'`, which the ladder counted as productive work, so every
shell read **reset the allowance**. The guard was decorative for any model that thought of it.

Fixed by classifying at the ledger with the same `isObservationalCommand` the rest of the system
already uses (`effectiveToolKind`, now shared with `boundedChatRunner` rather than duplicated). While
testing it, `sed` and `awk` turned out to be missing from `DIRECT_READ_RE` entirely — so the two
utilities the model actually reached for were exactly the ones that scored as work. Added those plus
`nl`, `wc`, `cut`, `uniq`, `od`, `xxd`, `strings`, `stat`, `file`, `basename`, `dirname`, `du`, with
`sed -i` excluded as the one form that writes.

### 9.2 `edit_file` failed eleven times, each one a wasted round

All with "the text to replace was not found" — the model reconstructing `oldText` from memory after
its read had been trimmed out of context. The error now names `replace_lines` and `recall_evidence`
as the two ways out, so the failure teaches instead of just costing a round.

### 9.3 Not fixed, worth knowing

- The model tried `python -m http.server 8000` (a server that never exits) and twice ran
  `inspect_visual` as a _shell command_. Both are model errors rather than runtime ones, but the
  first can burn a whole command timeout.
- 207 calls for 8 edits is still a poor ratio. The turn ends gracefully now, which is the important
  change; making it converge faster is the next piece of work, and §8's note about reference-context
  sizing is the most likely lever.

## 10. Third live retest — the silent stop

`m_5091a0e5`, same prompt, fresh app start. Two `read_file_range` calls, both successful, then:

> "I see the ambient light is declared but never added to the scene. Let me check the rest of the
> planet creation and animation code."

…and the reply ended. `stopReason: undefined`, `stopped: undefined`, `error: null`, 235 characters
of content, nothing written. `fixedTokens` 11,120 of a 13,251 proactive limit, so no context
pressure; the log shows round 2 completing normally and no round 3. The model simply emitted a round
with no tool call, which ends a provider loop.

**Not a loop, not a budget, not context.** The model announced its next action and did not take it.

### 10.1 Why this is not fixed by continuing

The obvious repair is to continue the turn when it ends cleanly having changed nothing. I built that,
and then reverted it, because an existing test named it correctly:

> `does not turn a diagnosis-only project question into an action continuation`

with the prompt _"Why is the renderer black? Diagnose only; do not edit it."_

That turn and this one are **identical in every observable state**: one successful read, no durable
change, clean provider finish, project workspace, no plan. The only thing separating "deliberately
diagnosed" from "stalled mid-fix" is the user's wording — and reading that to decide whether to keep
working is the first item on this document's prohibited list. Guessing wrong means editing a project
the user explicitly asked not to touch. A silent stop is a bad outcome; an unrequested edit is a
worse one.

Anodex's old answer here was `looksLikeStalledIntent` + `ACTION_FOLLOW_THROUGH_NUDGE_PROMPT`, which
matched "Let me…" and spent a whole extra generation re-prompting. That is the machinery §3 removed,
and it should stay removed.

### 10.2 What was actually missing

Anodex said _nothing_. Every honesty note it has is conditional on something having happened — a
write with no build (§3), a stale inspection, a fabricated path, an open plan row. There was no note
for **nothing happened at all**, which is why the user saw a reply that just stopped.

`describeNoDurableChange` now appends one line when a reply used workspace tools and none of them
changed anything:

> No files were changed by this reply — it only inspected. Say "continue" if you expected an edit.

Suppressed when the turn stopped for a known reason (that already renders its own banner) and when
no tools ran at all. An observational `run_command` does not count as a change, via the same
`isObservationalRunCommand` §9.1 introduced.

For a genuine diagnosis this is a true, quiet confirmation that nothing was touched. For a stall it
is the missing signal, and it names the one-word fix. **Reporting, not guessing** — the user decides,
because only the user knows which of the two turns they asked for.

## 11. Fourth live retest — it worked, and then it broke the file

`m_714f2289`: 163 calls, **18 successful writes** (17 `replace_lines`, 1 `edit_file`), 24 minutes,
both honesty notes fired (build verification + open plan rows). By every measure tracked so far,
the best run: the context system is no longer the thing standing in the way.

Then the workspace was checked.

```
js/universe-sandbox.js:68     const planets = [];
js/universe-sandbox.js:69     const planets = [];
js/universe-sandbox.js:70     const planets = [];
```

`SyntaxError: Identifier 'planets' has already been declared`. The module does not parse, so the
page renders nothing — **the exact symptom the user asked to have fixed, now caused by the fix.**

### 11.1 `replace_lines` did it

From the recorded diffs of that message:

| call                  | `const planets = [];` before → after |
| --------------------- | ------------------------------------ |
| `Replace lines 55-66` | 1 → **2**                            |
| `Replace lines 70-71` | 2 → **3**                            |

Both are the same mistake: `newText` re-stated a line that already existed just _outside_ the range
being replaced. And the call immediately preceding the second one is the tell —
`Replace lines 70-75` was **correctly refused** ("Line 70 does not match expectedFirstLine"), and
the model retried the same region as `70-71` without a usable anchor, which went straight through.

### 11.2 Two design errors, both mine

**`expectedFirstLine` was optional.** The original justification — "the anchor is often taken from a
read in the same round, where nothing can have moved" — is exactly backwards: a model omits the
anchor precisely when it is least sure what the line says. An interlock a caller may decline is not
an interlock. It is now required, and a missing one is refused with instructions to read the range
first.

**The anchor only ever guarded the start of the range.** Both corruptions entered at the _end_,
where nothing was checked at all. `describeSeamDuplication` now refuses a replacement whose first or
last line repeats the line immediately outside the range. It is mechanical and language-agnostic —
it asks only whether the edit restated a neighbour — and it ignores insubstantial lines (`}`, `);`,
blanks), because real code repeats those constantly and refusing them would make the tool unusable.

### 11.3 The lesson

Enabling a small model to write was the right fix for §1, and it worked. But a tool that lets a
model act on a stale mental model of a file will, given enough calls, corrupt it. The guards on such
a tool are not polish — they are the reason it is safe to offer at all, and "optional" is the wrong
default for every one of them.

## 12. Fifth live retest — the guards hold, and the room hypothesis dies

`m_f4510158`, run against a workspace whose `SyntaxError` the user had already removed by hand.

|                            | value                          |
| -------------------------- | ------------------------------ |
| tool calls                 | 39                             |
| **errors**                 | **0**                          |
| writes                     | 2 (both `ANODEX.md`)           |
| duration                   | 8.4 min                        |
| `fixedTokens`              | 9,679                          |
| `effectiveMaxOutputTokens` | **5,425**                      |
| thinking : visible         | 28,943 : 5,346 chars (5.4 : 1) |

Zero guard firings of any kind — no gathering blocks, no loop-guard hits, no stale anchors, no
failed edits. Every earlier run had between 6 and 20. The two new `replace_lines` interlocks were
not exercised in anger (both writes went to a markdown file), so they remain unproven live.

**And the turn still stopped mid-intent** — "Now let me read the specific sections I need to fix —
the orbit line creation and the createPlanetTexture function" — followed by nothing. Four honesty
notes fired, so the user was told this time.

### 12.1 §10's hypothesis was wrong

§10 and §11 proposed that the stall was an output-budget problem: `effectiveMaxOutputTokens` of
2,418 leaving a reasoning model no room to emit a call after thinking. This run had **5,425** —
more than double, and that figure is the _last_ round's, so it is the minimum across the turn — and
stopped in exactly the same way.

The stall is not budget-bound. It is the model ending its turn. That also means restricting
thinking would not have fixed it, and neither would the reference-context work in §8's note (still
worth doing for other reasons, but not for this).

### 12.2 What actually distinguishes a stall

§10 rejected continuing because a stall and a deliberate diagnosis are identical in state. That was
true of the state being looked at. It is not true of all state: this conversation carries a **plan**
with `in_progress` and `pending` steps, written by the model itself and visible to the user in the
Workspace Dock. A question — "why is the renderer black? diagnose only" — never has one.

`stalledWithOpenPlan` resumes a turn that

- ended cleanly (not a stop, which has its own handling),
- has no standing `/goal` (that path already continues),
- has an unfinished plan,
- made **real** tool progress this cycle — a successful call that was not plan bookkeeping and not a
  redirect, so ticking a row or being handed a pointer cannot buy another cycle,

bounded at `MAX_OPEN_PLAN_CONTINUATIONS = 3`.

The self-limiting property matters more than the bound: a cycle that calls nothing does not qualify,
and a finished turn's next cycle calls nothing. So a genuinely complete turn pays exactly one extra
round to say so, and only a turn that keeps _working_ keeps going.

No prose is read anywhere in it.

## 13. Sixth live retest — data loss

`m_2d3acaa3`: 208 calls, 31 minutes, 11 successful writes, ended on the provider-round budget.

`js/universe-sandbox.js` went from **966 lines / 41,455 bytes to 90 lines / 3,969 bytes**, truncated
mid-class: `SyntaxError: Unexpected end of input`. The user's working module was destroyed.

Recovered in full from the `write_file` call's own recorded `diff.before`; the broken state was kept
alongside as `universe-sandbox.js.broken-backup`.

### 13.1 Two defects, and neither alone would have done it

**`write_file` was offered without `append_file`.** `write_file` overwrites and is capped at
`MAX_FILE_WRITE_CONTENT_CHARS` (4,000), and its own description tells the model to _"write a short
first chunk, then use append_file for the remaining content."_ But §12's reordering left
`append_file` at position 16 in `DIRECT_TOOL_PRIORITY`, and only ten tools get native schemas at
16K. **The model was instructed to perform a sequence the tool surface made impossible.** It wrote a
1,839-byte first chunk over 41,455 bytes; the transcript records **zero** `append_file` calls.

`append_file` now sits immediately after `write_file`, with a comment saying why the two may not be
separated.

**Nothing refused the truncating write.** That is the real guard, and it was simply absent.
`describeDestructiveOverwrite` now refuses a `write_file` that replaces an existing file of ≥2,000
characters with less than half its content, naming `replace_lines`/`patch_file` for in-place edits
and `delete_file` as the explicit path for a genuine rewrite. Creating files, rewriting small ones,
and rewrites that keep or grow content are all untouched.

### 13.2 The pattern across §11 and §13

Both corruptions came from the same shape: a tool whose _individually reasonable_ properties compose
into a data-loss machine on a model that cannot reliably finish a multi-call sequence.

- `replace_lines`: line addressing is safe **if** the caller is held to what it believed was there —
  and the interlock was optional, and only covered one end of the range (§11).
- `write_file`: overwriting is fine **if** the whole file fits in one call — and it does not, so the
  contract silently became "destroy it now, restore it over the next ten calls".

The general rule this earns: **a mutating tool that cannot complete its own contract in a single
call needs a guard that assumes the sequence will be interrupted.** On a small local model, the
sequence _will_ be interrupted.

## 14. Seventh live retest — no corruption, and a starved output budget

`m_5466c17c`: 99 calls, 13 minutes, 2 successful `replace_lines`. **The workspace survived** —
`js/universe-sandbox.js` is 966 lines and parses clean. §13's guards held, and the two stale-anchor
refusals show `replace_lines`' required anchor doing its job on real edits.

The turn ended on `"reached its safe local output limit of 2,940 tokens"`.

### 14.1 The first round of every cycle was the most starved

From the log:

| round             | `fixedTokens` | `effectiveMaxOutputTokens` |
| ----------------- | ------------- | -------------------------- |
| 9                 | 10,735        | 4,369                      |
| 10                | 10,956        | 4,179                      |
| 11                | 12,194        | 3,127                      |
| **0** (new cycle) | **8,462**     | **2,940**                  |

Round 0 had 3,700 _fewer_ fixed tokens than round 11 and got _less_ output room. The arithmetic:

```
available    = 15,872 − 8,462      = 7,410
safeCeiling  = 7,410 − 768         = 6,642
replayPool   = 15,872 − 8,462 + 40 = 7,450
replayBudget = floor(7,450 × 0.4)  = 2,980
ceiling      = 2,980 − 40          = 2,940   ← wins
```

`replaySafeOutputCeiling` exists to stop a single _answer_ growing too large to replay verbatim next
turn. It was being applied to a _round of an agentic loop_, which is a different quantity — and
because `0.4 × available` is below `available − 768` for any window worth using, **it always won**.
The measured safe ceiling was effectively dead code at round 0, and every cycle's first round was
silently held to 40% of the window it had just been handed back.

It no longer applies when the turn has tools registered. A tool-less turn — the long prose answer the
ceiling was built for — still gets it.

**The trade, stated plainly:** a long prose reply in a _project_ chat has tools registered too, so it
loses this protection and could produce a reply large enough to need compacting next turn. That is a
meter/compaction cost. What it buys back is that an agentic round is no longer capped at 40% of free
space, which is what ended this turn with two-thirds of the window empty.

### 14.2 Still open

92 of the 99 calls were gathering (36 reads, 35 recalls, 21 searches) against 2 writes, and the
gathering ladder fired once. Two successful writes reset the streak, which is by design — but the
ratio says the soft rung at 22 is not changing behaviour much on this model. That is the next thing
to measure, not to guess at.

## 15. Eighth live retest — it completed

`m_ac4e98b3`, the same request that opened this document.

|                       | value                                  |
| --------------------- | -------------------------------------- |
| tool calls            | 98                                     |
| duration              | 11.8 min                               |
| stop reason           | **none — clean finish with a summary** |
| writes                | 2 `replace_lines`, both applied        |
| workspace             | 966 lines, **parses clean**            |
| plan                  | **all 6 steps completed**              |
| round-0 output budget | **8,448 / 10,471** (was 2,940)         |

The §14 budget fix is visible in the log: round 0 of a fresh cycle now gets the measured room instead
of 40% of it. The turn ran to its own conclusion rather than hitting a limit, ticked its plan closed,
and left the file valid.

For comparison, the same prompt across this document:

| run          | calls | writes | outcome                                 |
| ------------ | ----- | ------ | --------------------------------------- |
| `m_1765b232` | 157   | 0      | repeated-action guard                   |
| `m_61218823` | 103   | 0      | recall storm                            |
| `m_7a9bc662` | 207   | 8      | round budget                            |
| `m_5091a0e5` | 2     | 0      | silent stop                             |
| `m_714f2289` | 163   | 18     | **file corrupted**                      |
| `m_2d3acaa3` | 208   | 11     | **file destroyed**                      |
| `m_5466c17c` | 99    | 2      | output limit, file intact               |
| `m_ac4e98b3` | 98    | 2      | **completed, plan closed, file intact** |

### 15.1 One false accusation, fixed

The completed reply carried a note claiming it had fabricated `8000/index.html`. That fragment came
out of `http://localhost:8000/index.html` — correct advice the model had given the user. The
lookbehind in `PATH_PATTERN` rejects a match starting after `/` or `.` but not after `:`, so the
port number read as a directory.

`:` is now in the rejection class and URLs are masked out wholesale before matching. A check that
accuses a correct reply is worth less than no check: this machinery only earns its place if the user
can trust what it says.

### 15.2 What has not been established

Two writes is not a lot of work for 98 calls, and 74 of those calls were gathering. The turn
completing is not the same as the task being _well_ done — whether the sandbox now looks right is a
judgement only the user can make from the page. The gathering ratio remains the open question from
§14.2, and it should be measured across a few more runs before anyone tunes the ladder.
