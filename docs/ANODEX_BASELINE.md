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
to `hierarchical-report` — a mechanical assembly organised by research step
rather than an answer to the question. Two of the rejections were not claims at
all: a markdown table header, and the report stating that its own evidence
packet lacked the numbers the question needed. The second is the perverse one —
a citation was demanded for an absence, so an honest caveat was failed for being
made. Fixed in `criticalThinkingEvidence.ts`; see the tests there.

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
