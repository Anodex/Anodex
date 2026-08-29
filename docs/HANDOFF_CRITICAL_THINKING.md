# Critical Thinking — handoff

Updated 2026-08-28. Everything below is measured, not assumed. Where a claim is
unverified it says so.

## Status: PAUSED — blocked on web search quota

Tavily returns `HTTP 432` on every search. **Verified, not inferred**: a probe
run 3.5 hours after the failures still got 432 on all three of its first
searches, which rules out a burst rate limit. It is the monthly credit
allowance, and it resets on the account's own cycle. Check the Tavily dashboard
for the date.

Nothing further can be measured until search works. Options, in order:

1. **Wait for the Tavily reset** — free, nothing to change. Pace runs afterwards;
   this session burned a month of credits in ~200 searches across five runs.
2. **Brave** — `$5` free credits/month at `$5`/1,000 requests, so ~1,000
   requests ≈ **25 runs/month**. Fails loudly. Needs a key the user pastes into
   Settings → Tools; an assistant must not enter it.
3. **SearXNG** — already installed and working (see Operational notes). Free and
   unlimited by quota, but **degrades silently**: throttled engines return
   `HTTP 200` with fewer results, which reads exactly like "the evidence does not
   exist". Load-test it before trusting it.

## Rating: 8/10

Three clean runs on three different subjects, on one build. Not a 9, because the
bar set for this work was _all four_ new subjects clean, and one failed and one
could not be measured.

## The measured record

A run is clean when all four hold: `selectedStage` is the model's own report
(`draft`/`repair`), every step `completed`, `status: completed`, and zero
excerpt-dump blocks.

`scripts/ct-criteria.mjs` scores every stored run against those four.

| run | subject          | result                    | blocker                                 |
| --- | ---------------- | ------------------------- | --------------------------------------- |
| 10  | Universe Sandbox | **clean** 6/6, 55% suff   | — (pre-fix build)                       |
| 11  | heat pumps       | 6/7, 0% suff              | evidence never retrieved                |
| 12  | heat pumps       | 7/7, 14% suff             | `recovered-stage`                       |
| 13  | heat pumps       | **clean** 7/7, 36% suff   | —                                       |
| 14  | Universe Sandbox | 3/6, 20% suff             | `limited-steps`                         |
| 15  | bronze age       | 5/6, 0% suff              | `structurally-invalid`, `limited-steps` |
| 16  | creatine         | 5/6, 15% suff             | `limited-steps`                         |
| 17  | EU AI Act        | **failed** — no plan      | planning output budget                  |
| 18  | minimum wage     | 6/6, 8% suff              | `recovered-stage`                       |
| 19  | Universe Sandbox | 4/6, 29% suff             | `limited-steps`                         |
| 20  | EU AI Act        | **clean** 7/7, 29% suff   | —                                       |
| 21  | bronze age       | **clean** 6/6, 0% suff    | —                                       |
| 22  | creatine         | **clean** 6/6, 36% suff   | —                                       |
| 23  | minimum wage     | **failed** — invalid plan | not reproducible (see below)            |
| 24  | Universe Sandbox | 0/6                       | **invalid** — search quota died mid-run |

Runs 20–22 are the result: three different domains (regulatory, ancient history,
clinical), three different task shapes, all clean on one build, each having
failed for a _different_ measured reason beforehand.

## What was wrong, and what fixed it

Seven real bugs. **Five of them were invisible on the original question** and
only appeared when the subject changed. That is the single most important lesson
here: this system was tuned against one question, and every threshold in it was
fitted to that question's shape.

### 1. Large PDFs silently returned nothing

11 of 48 fetches returned `HTTP 200` with **zero characters**, and they were
disproportionately the authoritative sources — DOE, PNNL, MIT, govinfo. Every
one carried `truncated: true` and "Invalid Root reference".

A PDF keeps its cross-reference table and trailer at the **end** of the file.
Cutting one at the byte cap does not yield less text, it yields nothing: pdf.js
rejects the document outright. HTML degrades gracefully under the same cap,
which is why one constant served both. The seven failing PDFs measured 1.27 MB
to 3.25 MB — all just past the 1 MB cap.

Fixed: PDFs get their own 16 MB budget (`MAX_PDF_FETCH_BYTES`). Costs nothing in
network — `arrayBuffer()` was already downloading the whole response and
discarding the tail. The catch branch also dropped the truncation warning, so
the record read as a corrupt file; both warnings are now reported.

Result: empty fetches went **11 of 48 → 1 of 49**.

### 2. Tool-free phases were told they had tools

Synthesis, repair, section and overview run with `enabledTools` empty. That stops
tools being _registered_; it does not stop the model being _told it has them_.
Every phase was handed the coding-agent system prompt ("every coding action must
be done through a tool call") followed by `NO_WORKSPACE_NOTE`, which ends: "You
can still answer questions and **use web tools**."

Measured: the draft came back as 648 characters of _"I'll write the report
directly in chat (no workspace is selected...)"_ plus `<tool_call>` for
`search_files`; the repair was 217 characters of `<function=web_search>`.

Fixed: `ISOLATED_WRITING_PROMPT` in `src/shared/prompts.ts`, selected by
`isolatedWriting` on `composeSystemPrompt` and passed by `generateToolFreeTurn`.
It states there are no tools, forbids tool-call syntax, and says that naming a
gap is part of the job while going to look for more is not available. It also
drops workspace/memory/past-chat/project-rules sections — uncited text competing
with the evidence packet — while keeping the environment section for the date.

Result on the same question: draft **648 → 27,811 chars**, run `partial` →
`completed`.

### 3. Identifiers were checked as quantitative claims

`UL 1995` was reported as `Numeric claim 1995 is not present in its cited
evidence` — a **safety** issue, which alone makes a report unusable. So were
`454`, `410`, `290` (the refrigerants R-454B, R-410A, R-290) and `1847877` (an
OSTI record number inside a URL).

Fixed: `withoutIdentifiers` strips URLs, reference-labelled numbers (Article,
Annex, Regulation, ISO, UL…) and alphanumeric codes before claim extraction.
Applied to the report's **claims only, never to the evidence being searched** —
being reluctant to call something a claim costs nothing; being reluctant to find
support for one would reject correct reports.

### 4. Planning could not fit the plan its own schema allows

The schema permits 12 steps of up to 240 characters — ~3,300 characters, near
950 tokens, before the model reasons at all. Planning capped its total at 1,536
tokens and, alone among the phases, passed **no hidden-reasoning cap**. On a
long, multi-part question the model spent the whole budget thinking and returned
nothing. Measured: run 17 failed outright.

Fixed: `PLANNING_OUTPUT_TOKENS = 3_072` with reasoning capped at half, so ~1,536
tokens always survive for the plan.

### 5. A malformed chart block destroyed the whole report

Measured on run 18: a **36,121-character draft with 31 cited substantive
blocks** — real elasticities, named city comparisons — was rejected as unusable
and replaced by a 25,217-character assembly of ~1,300-character excerpt
fallbacks. The single disqualifying issue was `A chart block does not match the
supported chart schema`. Everything else was disclosable.

A block the schema cannot parse cannot assert anything false; it cannot even
render. Fixed: both structural chart problems (bad JSON, schema mismatch) are
now **coverage** issues, and `stripUnsupportedChartBlocks` removes the block
before the report ships. A chart whose _values_ are absent from the evidence is
still a safety issue — that distinction is guarded by its own test.

### 6. The completion fallback tested the subject's domain, not the evidence

**This is the big one, and it explains the Universe Sandbox variance that
puzzled this work from the start.**

A step completes either when the model says `sufficient` or through
`stepHasReportableCoverage` — a deterministic fallback for a well-researched step
the model won't call done. That fallback required **≥2 scholarly-or-official
sources**, meaning a journal, a `.gov` or a `.edu`.

That is a test of the subject's domain, not the evidence's quality. Measured
across the limited steps:

| subject          | limited steps | preferred sources found              |
| ---------------- | ------------- | ------------------------------------ |
| Universe Sandbox | 5             | **0**                                |
| bronze age       | 1             | 1                                    |
| creatine         | 1             | 5 (vetoed for another reason, below) |

Every one of those steps passed the other gates by a wide margin — findings of
**2,100–3,081 characters** against a 160-character bar, **9–17 verified pages**
against a bar of 4. They were rejected on source _class_ alone. For a commercial
game the storefront, the vendor's site and the community forum **are** the
primary sources. On the EU AI Act question, `commission.europa.eu` — the
regulation's own publisher — scored zero: of 39 unique hosts, the old gate
counted **1**, the new gate counts **39**.

`completed` was structurally unreachable for entire subject areas.

Fixed: the gate now requires ≥2 sources that are **not weak** (not
general-reference, not commercial/aggregator) — the same intent ("better than
junk") tested honestly. A test that a step resting on Wikipedia is still
`limited` passes both before and after, guarding against over-correction.

### 7. A topic word vetoed its own step

The same fallback rejects a step whose gaps mention unresolved disagreement. The
regex was a bare `\bconflict\b`, so a step titled _"Audit funding and conflicts
of interest"_ was vetoed by its own subject — with 5 scholarly sources and a
2,273-character finding.

Fixed: `GAP_TOPIC_PHRASE` strips "conflict(s) of interest" before the
`UNRESOLVED_DISAGREEMENT` test, so the word still counts everywhere it genuinely
means a clash.

### Two instrumentation bugs (both cost real diagnosis time)

- **`completion` was dropped on restart.** It was added to the type and the
  writer but not to `CriticalThinkingStore`'s normaliser, which rebuilds every
  diagnostic field by name on load. It survived until the app next started and
  then vanished — exactly when a stored diagnostic matters most.
- **Contract issues were truncated away.** Attempt `issues` is capped at 24 with
  citation issues first, so a report with 24 unverified quotations pushed every
  structural issue off the end. A run recorded `structurally-invalid` while
  storing nothing about which check failed. Fixed additively with a separate
  `contractIssues` field — deliberately _not_ by reordering `issues`, because
  that array is what the repair prompt is built from.

## A semantic shift you should know about

`completed` now means **"the research was substantial, well-sourced and cited"**
rather than **"the model judged it sufficient"**. Run 21 completed 6/6 with a
`sufficient` rate of **0%** — every step via the deterministic fallback.

This is defensible: the model's self-assessment was never reliable (3% at round
one, ~26–31% at round two, essentially a coin flip), and a deterministic test of
finding length, page count and source quality is more trustworthy. The reports
still disclose their gaps — run 21's limits section states outright that the
packet contains no primary excavation reports. But it is a change in what the
word means, and it is the kind of change that can shade into scoring your own
homework. Watch it.

## Do not rebuild: the spare-rounds mechanism

`44531c4` reverts `089fd7f`, `0b5f439`, `ff53790`. It failed three times, and it
was aimed at the wrong thing. **This session nearly rebuilt it a fourth time.**

The bait: `sufficient` rate by round number reads 3% → 26% → 31% → **71%**, and
every run leaves 6–8 of its 21 rounds unused while steps are cut off at
`maxRoundsPerStep: 3`. That looks like proof the per-step cap strangles steps
about to finish.

**It is a mirage.** Every round-4 sample comes from _resumed_ runs (runs 2 and
4), where a step was reopened with evidence already banked. The per-step cap has
been 3 for all 24 runs; nothing has ever had a genuine fourth consecutive round.
The number measures "a step reopened with a full evidence store converts well",
not "a fourth round converts well".

Check the provenance before believing any round-depth statistic.

## Known-unfixed

- **The model invents quotations from memory.** Run 21 shipped with 12
  untraceable quotations (run 15 had 21). They are neutralised and disclosed, so
  the reader is told — but the behaviour is unchanged. Worst on humanities
  subjects, where the material _is_ quoted text.
- **Run 23's planning failure is not reproducible.** The same question failed
  twice at 11:44 and produced a clean 6-step plan at 15:02 on the identical
  build. Local-model nondeterminism, not a regression from the budget change.
  One flake in ~24 runs. A second repair attempt was **deliberately not added** —
  see Restraint below.
- **`structurally-invalid` (run 15) was never diagnosed.** The data was
  truncated away before it could be read; it did not recur in run 21. Do not
  claim it is fixed. The `contractIssues` field will now catch it.
- **The planning-failure diagnostic is unproven live.** Written and unit-tested,
  but planning succeeded on its only re-run, so it has never captured a real
  failure.
- **Universe Sandbox has no valid measurement since the fixes.** Run 24 died on
  the search quota. This is the question with the worst historical record
  (`0/7` to `7/7` across ten attempts) and it is the one most likely to expose a
  remaining problem.
- **Agent and Workspace are untested.** See `docs/HANDOFF_WORKSPACE.md`.

## Restraint — what was deliberately not built

- **A second planning repair attempt.** One flake in ~24 runs, non-deterministic,
  and the failure message already tells the user to retry. Adding retries to
  shared orchestration on a single observation is the accumulation pattern that
  broke Anodex before. If it recurs, the new diagnostic will capture the model's
  actual output first.
- **Anything touching the round budget.** See the mirage above.
- **Loosening the completion bar further.** Two limited steps (creatine funding
  audit, bronze age excavation layers) were traced to genuinely paywalled
  evidence — JSTOR, journal back-matter. The queries were good and varied. The
  only ways to complete those are to loosen what "covered" means or to reach past
  paywalls. Neither is acceptable. An honest `partial` beats an engineered
  `completed`.

## Operational notes

Carried forward from the previous session and still true:

- **electron-vite does not restart the main process.** Every code change needs a
  full restart. Verify `Get-Process electron | Select StartTime` is newer than
  the change before trusting a run.
- **`taskkill` on npm does not kill Electron** — kill `electron` and
  `llama-server` explicitly and verify the count is zero.
- **Always verify a run started by reading the store**, never by trusting a
  click or a launch.
- **Checking whether a quotation was neutralised**: split the report at the
  disclosure heading and search only the _body_.

New this session:

- **`spawn('cmd.exe', ['/c', 'npm run dev > log 2>&1'])` fails silently on
  Windows** — exits 1 immediately, writes nothing. Node's argument quoting and
  cmd's parsing disagree about the `>`. Launch through PowerShell
  `Start-Process` instead. This cost three hours: the series driver waited out
  its full timeout on a run that never started, which is the exact trap the
  operational notes already warned about.
- **`scripts/ct-run-series.mjs`** runs a list of question files unattended —
  kill, verify zero processes, launch, wait, record. It fails fast (12 min) if no
  run appears, and one bad launch no longer aborts the rest of the series.
- **The autorun harness** (`src/main/criticalThinking/criticalThinkingAutorun.ts`)
  starts a run and approves its plan from `ANODEX_CT_AUTORUN`. Dev-only, inert
  without the variable, refuses to arm in a packaged build. This removes the GUI
  from the measurement loop entirely.
- **The evidence sidecar is pruned when the next run starts.** Read
  `evidence/<runId>.json` before launching anything else.
- **`sufficient` rate is meaningless until every step has had a second round.**
  Research is round-robin: every step gets round 1 (almost always `continue`)
  before any step gets round 2. An early reading of 0% is an artifact, not a
  signal.
- **SearXNG is installed** in WSL Ubuntu at `~/searxng` (venv, no sudo, no system
  packages). Config at `~/searxng-config/settings.yml` with the JSON API enabled
  — stock SearXNG serves HTML only and Anodex needs `format=json`. Start it with:
  `wsl.exe -e bash -lc 'cd ~/searxng && SEARXNG_SETTINGS_PATH=$HOME/searxng-config/settings.yml ./venv/bin/python -m searx.webapp'`
  It is not a service and does not survive a reboot. On the first probe Brave,
  DuckDuckGo and Startpage all refused immediately (rate limit / CAPTCHA) and
  only Google answered; the engine pool was widened in response but **never
  load-tested**.

## Scripts

- `scripts/ct-criteria.mjs` — scores every stored run against the four criteria,
  prints `completion.blockers`. **Start here.**
- `scripts/ct-run-series.mjs <question-file>...` — unattended run series.
- `scripts/verdict-tally.mjs` — `sufficient` vs `continue` for the newest run.
- `scripts/watch-ct-new-run.mjs` — waits for a _new_ run, then polls it.
  (`watch-ct-run.mjs` latches onto the newest stored run, which is still the
  previous finished one while a fresh run starts — it reports the wrong run.)
- `scripts/analyse-safety-issues.mjs`, `check-quote-locations.mjs`,
  `check-quote-origin.mjs` — quotation and figure provenance.
- Question files: `scripts/ct-question-*.txt` (universe-sandbox, heat-pumps,
  bronze-age, creatine, eu-ai-act, minimum-wage, probe).

## What to do next, in order

1. **When search returns**, re-run **Universe Sandbox** and **minimum wage** —
   the two unresolved items. Universe Sandbox is the higher-value test.
2. **Then three consecutive clean runs on one question** for the 9. Pace them;
   do not burn a month of search credits in one sitting.
3. **Then** the quotations-from-memory problem, which is the largest remaining
   quality gap and is untouched.
