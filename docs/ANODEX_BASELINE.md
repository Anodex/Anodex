# Anodex — measured baseline

Started 2026-09-04. **Numbers here are measurements, not impressions.** Every row
says how it was produced, so it can be re-run and compared rather than argued
about.

Why this file exists: surface quality was being reported from memory and from
whichever run happened most recently. That is not a baseline — it drifts, and it
cannot tell a regression from a bad sample. Anything below without a command
next to it should be treated as unverified.

**Reading the numbers.** A score is only meaningful with its model _and_ its
context size. Anodex is meant to work across hardware, model families, sizes and
context windows, so "12/12" means nothing without saying on what. Where a
surface passes on a 27B and fails on a 4B, both are recorded — the goal is not a
good score on the best model available.

---

## How to reproduce

```bash
# every structural check, seconds — run after any change
node scripts/verify-surfaces.mjs

# add the behavioural matrices, tens of minutes
node scripts/verify-surfaces.mjs --models

# one surface at a time
node scripts/chat-matrix.mjs <out> <modelKey...>                      # chat, baseline rubric
node scripts/chat-matrix.mjs <out> <modelKey...> \
  --script scripts/chat-script-hard.json \
  --criteria scripts/chat-hard-criteria.mjs                            # chat, hard rubric
node scripts/chat-matrix.mjs <out> qwen27b \
  --script scripts/email-script-matrix.json \
  --criteria scripts/email-criteria.mjs                                # email
node scripts/scheduler-verify.mjs                                      # scheduler, after a run
node scripts/ct-criteria.mjs                                           # critical thinking, stored runs
node scripts/ws-criteria.mjs                                           # workspace, stored conversations
node scripts/provider-endpoints.mjs                                    # every provider base URL
node scripts/chat-flakiness.mjs <run> <run> --criteria <file>          # which criteria are unstable
```

Model keys and their context sizes are declared in `scripts/chat-matrix.mjs`.

---

## Chat

**Hard rubric** (12 criteria, `chat-script-hard.json`), 2026-09-03/04, after the
runtime-section fix and the tool-floor scoping:

| model       | ctx   | score               | fails                          |
| ----------- | ----- | ------------------- | ------------------------------ |
| qwen27b     | 8192  | 12/12               | —                              |
| qwen27b     | 65536 | 12/12               | —                              |
| devstral24b | 8192  | 12/12               | —                              |
| gemma27b    | 8192  | 12/12               | —                              |
| dscoder16b  | 8192  | 11/12               | `no-invented-referent`         |
| peach9b     | 8192  | 11/12               | `answers-aside`                |
| qwen4b      | 8192  | 11/12               | `holds-under-pressure`         |
| qwen27b     | 4096  | see _Context sizes_ | vision transport, partly fixed |

**Baseline rubric** (10 criteria): qwen27b 10/10; qwen4b 9–10/10, flaky on
`reads-own-state` — measured 3 runs with and 3 without the runtime clause and the
distribution is identical (9,9,10 both ways), so that flakiness is the model, not
a regression.

**Confidence: medium, and lower than the numbers suggest.** The rubric itself was
wrong five separate times on 2026-09-03, each time failing _better_ behaviour
than it passed. Every one was found by reading transcripts, not by the rubric.
See `anodex-convention-vs-absence` in memory.

---

## Email

10/10 on the email rubric (7/7 turns), qwen27b @ 8192, measured twice on
2026-09-03 — once before and once after the tool-floor scoping, unchanged.
Earlier the same week: 18/18 mailbox tools exercised, including a `move_email`
round trip, `batch_email` across 5 threads, and an attachment read back verbatim
after an SMTP/IMAP round trip. Prompt-injection defence verified.

---

## Scheduler

10/10 on `scheduler-verify.mjs`: a task created from chat actually fired and
returned its marker, a sub-minimum interval was floored rather than accepted, and
the repeating task rescheduled itself. `delete_scheduled_task` verified
end-to-end in the GUI on 2026-09-04 — approval card, deletion, and the result
confirmed on disk.

---

## Critical Thinking

**Depends on a search backend, and that dominates the result.** Three runs on
2026-09-03/04 (47, 48, 52) ended `partial` with 0 steps and no report. None was
a code fault: SearXNG was not serving Anodex at all. It had two independent
problems, and the second is easy to miss —

1. `server.secret_key` was never changed from `ultrasecretkey`, so it refused to
   start.
2. `search.formats` listed only `html`. Anodex's `web_search` asks for
   `format=json`, so it would have received nothing **even while running**.

Both fixed 2026-09-04 (config backed up first). Verified: 20 real results.

**Its engines rate-limit, and that is normal.** A live check returned
`brave: Suspended: too many requests`, `duckduckgo: CAPTCHA`,
`google cse: Suspended`, `startpage: Suspended: CAPTCHA` — while other queries
in the same minute returned 20 results. **A CT run's source count is therefore
not controlled**, and two runs are only comparable if their source counts are.
Always record sources/evidence alongside the score.

| run        | date     | sources | steps         | outcome                                       |
| ---------- | -------- | ------- | ------------- | --------------------------------------------- |
| 49–51      | 09-03    | —       | 5/5, 6/6, 6/6 | CLEAN                                         |
| 47, 48, 52 | 09-03/04 | 0       | 0             | `partial` — search backend down               |
| 53         | 09-04    | 36      | 6/6           | `partial` — synthesis rejected 11/17 attempts |

**Run 53 is the interesting one and produced a real fix.** Research succeeded
(36 sources, 77 evidence, 29 cited blocks) and _synthesis_ failed, falling back
to `hierarchical-report`. Two of the rejections were not claims at all: a
markdown table header, and the report stating that its own evidence packet
lacked the numbers the question needed. The second is the perverse one — a
citation was demanded for an absence, so an honest caveat was failed for being
made. Fixed in `criticalThinkingEvidence.ts`; see the tests there.

### The evidence packet was sized from leftovers (2026-09-04)

Chasing runs 53–56 through their rejection strings led to the actual defect,
which was arithmetic rather than judgement.

`criticalThinkingSynthesisLimits` allocates shares of the prompt to the
question, plan, findings, and evidence. The prompt's own fixed instruction
block — 3,203 characters for synthesis, 2,577 for the coverage assessment — was
not in that allocation, and each caller sized its packet from what happened to
be left:

```
min(maxEvidenceChars, maxPromptChars - promptWithoutEvidence.length)
```

so the scaffold's whole cost fell on the evidence, the one input nothing else in
the prompt can stand in for. **The distortion scales inversely with the
context**, which is why it broke modest hardware and left large windows looking
correct.

| context | evidence share | evidence delivered |
| ------- | -------------- | ------------------ |
| 4,096   | 2,583          | **271** (10%)      |
| 8,192   | 6,058          | 4,944 (82%)        |
| 16,384+ | 13,542+        | full share         |

A 4K run was asking a model to write a cited research report from 271 characters
of evidence. Four stored 8K runs (53–56) came in at 4,873–4,901 packet
characters, and every one of them reported the passages as too fragmentary to
conclude anything — an accurate description of what it had been handed. **The
model was not failing; it was reporting a starved input honestly.**

Two things were wrong, and both were needed:

1. The scaffold is now declared by the caller and subtracted before the shares
   are cut, so the declared share is the delivered share.
2. `maxEvidenceChars` is a floor the budget guarantees, **not a ceiling**. The
   other inputs are capped, not fixed; whatever they do not spend goes to the
   evidence. The old inline formula picked that room up by accident, because its
   shares were cut from a budget that ignored the scaffold and so were usually
   smaller than what was left — fixing the scaffold alone would have removed the
   accident along with the bug, and made 8K _worse_.

The rule now lives in `evidencePacketChars` rather than open-coded at three call
sites, each of which had the same error. Delivered characters, before → after:

| context | synthesis        | coverage assessment |
| ------- | ---------------- | ------------------- |
| 4,096   | 0 → **851**      | 1,372 → 1,939       |
| 8,192   | 3,901 → 4,925    | 6,525 → 7,093       |
| 16,384  | 12,676 → 13,700  | 15,631 → 16,197     |
| 32,768  | 35,295 → 35,679  | 35,930 → 40,225     |
| 65,536  | 96,092 → 122,108 | 96,092 → 126,729    |

Reproduce: the invariants are pinned in
`__tests__/criticalThinkingSynthesisBudget.test.ts`.

### A hierarchical report was being reported as a failure (2026-09-04)

Run 56 wrote all six sections with the model, repaired every one to valid, and
assembled a report that came back `valid`, `usable`, `safe`, 31 cited
substantive blocks, zero issues, zero excerpt dumps — and was reported to the
user as `partial`. The sole blocker was `recovered-stage`. It also told the
reader the report "was assembled from verified excerpts because the written
report did not pass its evidence checks", which was untrue: nothing had failed
and nothing had been discarded. Runs 53 and 55 were the same.

`isRecoveredStage` named three stages and treated them alike.
`deterministic-fallback` and `section-fallback` replace the model's prose with
text Anodex assembles from raw excerpts. `hierarchical-report` is the _designed_
answer to a context too small for a one-shot report — same citation and
fabrication checks, one bounded section at a time. Grouping them told a user on
modest hardware that the feature does not work for them at the moment it had
just worked.

Narrowed, not dropped: `assembleHierarchicalReport` uses whatever sections it
has, and a section that failed every attempt is replaced by the same
deterministic excerpt builder — so the run now tracks whether a deterministic
section is in what actually **ships**, and only then is the stage a blocker. The
observed failure that put the check there (a run finishing `completed` while
shipping twelve blocks of raw excerpts) is pinned by explicit status assertions
on the existing `section-fallback` test.

`scripts/ct-criteria.mjs` scores the same distinction, so the measured history
and the product agree on what a clean run is.

### One prompt could not carry the research (2026-09-04)

`reportNeedsHierarchicalRecovery` had two conditions, both floors: cite at least
once per researched step, and clear a length minimum. They ask whether the model
engaged with each step at all, and were being read as whether the report was
finished.

Run 60 cleared both by the narrowest possible margin — six cited blocks against
six required, 3,768 characters against 2,700 — and shipped 4,423 characters
citing 6 blocks, from **81 evidence items across 48 sources**. At 8K a single
prompt carries about 5,700 characters of evidence however much the run gathers,
so the report was written from a tenth of the research and still looked tidy.

Added a third condition, deliberately not a quality bar: `evidencePacketChars`
over verified passage characters. Below a quarter, hierarchical recovery gives
each step its own packet and the same context shows the model several times more
evidence in total.

| run | coverage | strategy     | cited | chars  |
| --- | -------- | ------------ | ----- | ------ |
| 50  | 67.6%    | single-pass  | 24    | 30,143 |
| 49  | 42.7%    | single-pass  | 25    | 47,549 |
| 51  | 36.9%    | single-pass  | 28    | 35,161 |
| 60  | 10.1%    | single-pass  | 6     | 4,423  |
| 61  | 9.6%     | hierarchical | 28    | 30,549 |
| 56  | 6.4%     | hierarchical | 31    | 38,093 |

Every run that did well on one pass saw at least 36.9%; the starved one saw
10.1%. A quarter sits in the middle of that 26-point gap rather than on either
edge, so it separates the observed cases without being fitted to them.

**Runs 60 and 61 are the controlled comparison** — same question, same 8K
window, same transport, comparable evidence (48 sources/81 items against
38/69), differing only in the path taken:

|                    | run 60                  | run 61                     |
| ------------------ | ----------------------- | -------------------------- |
| coverage           | 10.1%                   | 9.6%                       |
| strategy           | single-pass             | hierarchical               |
| shipped            | 4,423 chars, 6 cited    | **30,549 chars, 28 cited** |
| candidate validity | `valid=false`, 2 issues | **`valid=true`, 0 issues** |
| duration           | 617s                    | 783s                       |

Seven times the length and 4.7x the cited coverage, for **27% more runtime** —
not the ~3x that run 58 (51 sources, 1,886s) suggested. The recovered report was
also the only _fully valid_ one either run produced, so this is not a
length-for-correctness trade.

`evidenceCorpusChars` is now stored beside `evidencePacketChars` and shown as
`cov=` by `ct-criteria.mjs`, so the choice is auditable rather than re-derived
from the evidence store. It reads `-` on runs recorded before it existed.

### What is confirmed live, and what is not

Runs 60 and 61 confirm, on a real 8K local model: the scaffold-aware packet
(5,725 characters, against the 4,873–4,901 ceiling of runs 53–56); the stage
verdict (run 61 is the first hierarchical report allowed to report `completed`);
the reader-facing caveat now describing the report's arrangement instead of
claiming excerpts stood in for prose; the store retry (no `EPERM` across two
runs); and the coverage trigger.

**The issue-density fix is still not exercised live.** In run 61 the
hierarchical report won at `overallValid`, an earlier tiebreak, so the rate
comparison never ran. Its evidence remains the replay across all 48 stored runs
holding two or more whole-report candidates, where it changes three choices and
agrees on 45.

**`suff=0%` on every recent run.** The coverage assessment has never once
declared a step sufficient. Nothing above touches it, and it is not understood.

### Failure messages named the wrong subsystem (2026-09-04)

A run that gathered nothing citable closed with "Check your web search provider
and internet connection" whatever had gone wrong. Two real runs: one failed on
`EPERM ... rename runs.json.<pid>.tmp`, a local file lock, and sent the reader
to debug their network; one failed because the model threw before a single
search was issued, and got the same advice — and an existing test asserted that
wording. A run that never issued a search did not fail at searching, so only a
run that actually tried to search is now told to check the provider.

**Confidence: measured, but a single question.** All of the above used
`ct-question-heat-pumps.txt`. Six question files exist and the others have not
been run since these changes.

---

## Workspace and Agent

Measured 2026-09-04, qwen27b @ 8192, `bench-1-single-file-small` from a reset
project (`node scripts/bench-reset.mjs bench-1-single-file-small`).

|                     | result                                         |
| ------------------- | ---------------------------------------------- |
| run status          | done, 11 turns, 262s active, no error          |
| tool calls          | 14, of which **0 workspace-tool failures**     |
| plan                | 1 written, **3/3 steps completed**             |
| repeated signatures | 0                                              |
| wasted calls        | 1 (a `finish_goal` retry after it was refused) |

The single failed call was `finish_goal` being **refused** because a plan step
was not yet marked complete — a guard doing its job, which is why the scorer
counts workspace-tool failures separately from guard decisions.

**The code it wrote is correct, verified independently.** Its own
`test_stats.py` reports 15 checks passing at exit 0, but the agent wrote both the
code and the test, so that only proves self-consistency. Checked against
`statistics.fmean`/`statistics.median` and the spec's own tie rule (smallest
value wins) plus all three empty-input errors: all pass.

Its verification claim in chat — "All 15 checks passed with a real exit code of
0" — is backed by a command that actually ran, and is true.

**Note on margin, not a failure:** this run sat at `fixedTokens: 6243` against a
gate of `inputLimit 7680 − minimumOutput 1280 = 6400`. That is 157 tokens of
headroom on an 8K agent run. It worked, but the same arithmetic with a slightly
longer prompt is what killed 4096 outright.

---

## Cloud providers

All 10 shipped base URLs reachable, verified without any API key
(`scripts/provider-endpoints.mjs`, 2026-09-03). Azure excluded by design — its
base URL is the customer's own resource name.

DeepSeek is the only provider verified end-to-end with a real key. The other nine
are endpoint-reachable but unexercised: a cloud run takes a different code path
from a local one, so reachability is not the same as working.

---

## Context sizes

| window                     | state                                                                  |
| -------------------------- | ---------------------------------------------------------------------- |
| 65536                      | chat 12/12 (the only row exercising the full, non-compact prompt)      |
| 8192                       | every surface's normal row; agent runs here with ~157 tokens of margin |
| 4096, `LlamaService`       | **fixed 2026-09-03.** Was 12/12 turns empty; now generates             |
| 4096, `LlamaVisionService` | **partly fixed.** Was 12/12 empty, now 4/12 empty                      |

4096 is the tightest window anyone runs and it was completely dead on both
transports until 2026-09-03 — four separate floors with no ceiling. See
`ANODEX_DEFERRED_BUGS.md` for what remains on the vision path.
