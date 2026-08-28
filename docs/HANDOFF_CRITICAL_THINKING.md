# Critical Thinking — handoff

Written 2026-08-28. Everything below is measured, not assumed. Where a claim is
unverified it says so.

## Where things stand

`main` is clean and pushed at `c0c8565`. Full suite: 3,577 passing, 3 skipped.

Critical Thinking began this work returning 8,379 characters of raw excerpts
organised by research method — a log of what it did, not an answer. It now
returns 31–45k characters organised around the question, with a feature
ranking, build tiers and a recommendation.

**Rating: 8/10.** Not 9, because the step-completion fix has one run behind it.

## The measured record (same question, local Qwen3.8-27B)

| run | status | winning stage | steps done | `sufficient` rate | chars |
| --- | --- | --- | --- | --- | --- |
| 1 (resumed, 100 sources banked) | completed | draft | 7/7 | 25% | 34,015 |
| 2 (fresh) | partial | repair | 2/6 | 11% | 44,878 |
| 3 (fresh) | partial | draft | 3/6 | 20% | 44,773 |
| 4 (fresh, 7 steps) | partial | repair | 0/7 | 0% | 13,638 |
| 5 (fresh) | partial | draft | 2/6 | 11% | 43,459 |
| 6 (fresh, after prompt fix) | partial | repair | **6/6** | **46%** | 31,913 |

Run 1 is not comparable to the rest — it resumed with 100 sources already
gathered. Treat runs 2–6 as the real series.

**The report half is solved.** Six of six runs shipped the model's own report
(draft or repair), single-pass, with **zero excerpt-dump blocks**. That was the
original failure and it has not recurred.

## What was actually wrong

Two waves, both diagnosed from stored run data in
`%APPDATA%/anodex/critical-thinking/` rather than from logs.

### Wave 1 — evidence was fetched but never reached the model

- `www.reddit.com` returns HTTP 200 with an 8 KB JavaScript shell that extracts
  to **0 characters**. Seven threads fetched, nothing readable, no warning.
  Rewritten to `old.reddit.com` (60 KB → 2,390 chars).
- PDFs were refused as "Unsupported content type", losing the MIT/Harvard/
  Stanford sources — the `scholarly` class the ranker rates highest. pdf.js was
  already in the tree for email attachments; extractor moved to
  `src/main/tools/pdfText.ts` and shared.
- Wikipedia's `data-mw` attribute (56 per page) carries the article's whole
  template source, and single-quoted attribute values containing `>` broke tag
  matching, so `{{cite web ...}}` landed in extracted prose. Attribute values
  are now stripped before any tag pass.
- Flat budget ceilings cancelled the context-aware sizing: at 65,536 tokens the
  run could use 141,312 prompt chars but a ceiling admitted 80,000, and evidence
  46,400 vs 36,000. **30% of gathered evidence reached the model.** Now 68%.

### Wave 2 — the report was written and then thrown away

`synthesisDiagnostics.attempts` showed a 25,458-char draft answering the
question, discarded for 8,379 chars of excerpts.

- **Phantom quotations.** A straight `"` opens and closes, so when a quotation
  fell under the 20-char floor its *closing* mark opened a match running to the
  next quotation's opener — the prose *between* two quotations was checked
  against the sources. 21 phantoms sank one report. Quotations are now paired by
  scanning left to right.
- **Careful quoting read as fabrication.** `freeze[s] the entire planet` and
  `at first intimidating amount of… options` were rejected by exact matching.
  `[]` and `…` are now honoured, elision fragments required in order.
- **Misattribution ≠ invention.** Checked at three levels (cited passage → cited
  page → all fetched evidence) for quotations, numbers and chart values alike.
  Measured: 14 of 16 flagged figures were present in the run's own evidence.
- **Uncheckable figures.** Bare one/two-digit integers can't be verified in
  either direction ("12" appears in almost any page). Only figures with a unit,
  a decimal, or three digits are checked as claims.
- **Neutralise, then disclose.** Quotations the evidence can't confirm have
  their marks removed (so nothing is presented as a source's words) and are
  listed in the report's limits section. Figures get the same treatment with a
  hard cap of 2.
- **Repair scored its own preface.** "I'll repair the report by…" counted as
  uncited report text, so repair always arrived 3–4 issues down and lost.

### Wave 3 — the root cause of steps never completing

The assessment prompt showed the model this as its output shape:

```json
{"verdict":"continue","evidenceBasis":"insufficient",
 "remainingGaps":["material gap"],"nextQueries":["targeted follow-up"]}
```

Every field is the *continue* branch, filled in. The model returned that verdict
on nearly every round of five runs. The rules beneath it were already correct —
they say optional follow-up is not a reason to continue — but a local model
copies the shape it is handed.

Showing the options instead (`"sufficient | continue"`) took the `sufficient`
rate from ~10% to 46% and produced the first fresh run to complete every step.

**This is the single highest-leverage change in the whole effort**, and it
invalidated a mechanism I had spent three commits on (see below).

## What was tried and reverted — do not rebuild it

`44531c4` reverts `089fd7f`, `0b5f439`, `ff53790`: a mechanism letting a step
draw on the run's spare rounds.

It failed three times:
1. The reservation counted a full allowance for every unfinished step, including
   rounds already spent, so the spare was mathematically unreachable.
2. Fixing that revealed the rule is enforced at **two** gates; fixing one left
   the other overriding it, which is why two live runs showed no change.
3. The run budget is a flat 21 while a plan's guarantee is `steps × 3`, so
   "spare" means something different at one step than at seven. A one-step plan
   with a cap of 2 could take 21 rounds — the per-step cap destroyed, not
   relaxed.

And it was aimed at the wrong thing entirely. Steps were not starved of rounds;
the model would not call anything sufficient. More rounds would have bought more
`continue`s.

## Known-unfixed

- **The model invents quotations from memory.** Traced against a run's own
  passages, findings, plan and question: 6 of 9 flagged quotations existed
  *nowhere* in the run's state — recalled marketing copy. Prompt guidance halved
  it. The pipeline now neutralises and discloses rather than discarding the
  report, but it still happens.
- **Occasional empty drafts.** One run produced a 69-character draft ("I'll
  write the report now, working directly from the evidence packet.") after 3,505
  chars of thinking. Repair recovered it. Never investigated.
- **`universesandbox.fandom.com` returns 403** to Anodex's headers, so a
  selected page can be silently lost.
- **One question only.** Every threshold — two untraceable figures, three-digit
  verifiability, half-the-cited-blocks for quotations — was tuned against
  Universe Sandbox research. **A different subject has never been tested.**
- **Agent and Workspace are untested.** No measurements taken at all.

## Operational notes (these cost hours; don't rediscover them)

- **electron-vite does not restart the main process on source change.** Every
  code change needs a full restart. Verify with
  `Get-Process electron | Select StartTime` newer than the file mtime *before*
  trusting any GUI result.
- **`taskkill` on the npm process does not kill Electron** — it detaches. Three
  instances were once running at once, all sharing `%APPDATA%/anodex`, so an
  older build could execute the run being watched. Kill explicitly and verify
  zero:
  ```powershell
  Stop-Process -Name electron -Force -ErrorAction SilentlyContinue
  Stop-Process -Name llama-server -Force -ErrorAction SilentlyContinue
  ```
- **`open_application("Electron")` launches a fresh Electron binary**, it does
  not focus Anodex. It manufactured most of the "extra instance" confusion.
  Click the window directly instead.
- **computer-use sees the dev app only as `electron.exe`** (not "Anodex", not
  "electron"), and only when launched with `dangerouslyDisableSandbox`.
- **`TextInputHost` steals focus** and blocks input; `Stop-Process -Name
  TextInputHost -Force` clears it.
- **Always verify a run started by reading the store**, never by trusting a
  click. Three times a run was reported as in-flight when nothing was running.
- **Checking whether a quotation was neutralised**: split the report at the
  disclosure heading and search only the *body*. The disclosure list wraps every
  entry in curly quotes by design, and matching against it produces a false
  "still quoted" reading. This wasted two investigations.

## Useful scripts (committed, one-off diagnostics)

- `scripts/watch-ct-run.mjs` — polls the stored run to completion, prints the
  outcome. Run states include `validating` and `repairing`, not just
  `researching`/`synthesizing`.
- `scripts/verdict-tally.mjs` — `sufficient` vs `continue` rate for the newest
  run. **This is the leading indicator**; it shows within ~10 rounds.
- `scripts/analyse-safety-issues.mjs` — for each flagged figure, whether it is
  genuinely absent from the run's evidence (standalone matching, not substring).
- `scripts/check-quote-locations.mjs`, `scripts/check-quote-origin.mjs` — where
  a flagged quotation came from: a passage, a finding, the plan, or nowhere.

## What to do next, in order

1. **Reproduce run 6.** One run at 6/6 is not a result. Two more fresh runs
   holding ≥5/6 with `sufficient` ≥30% would justify calling it a 9.
2. **Test a different question.** This is the biggest unknown. If the thresholds
   are fitted to game research, a different subject exposes it.
3. **Then** consider the per-step allowance, the empty-draft failure, or Agent
   and Workspace.
