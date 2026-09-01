# Critical Thinking — handoff

Updated 2026-08-28. Everything below is measured, not assumed. Where a claim is
unverified it says so.

## Status: UNBLOCKED — search restored, both open items measured

Updated 2026-09-01. Tavily is still exhausted (`HTTP 432` on 2026-08-31, three
days after the first failure and at calendar month-end, so its cycle is the
account's signup date rather than the 1st). Search now runs on the **local
SearXNG** at `localhost:8080`, which was installed but not running.

Load-tested at this workload's own rate for the first time: **40 searches in 17
seconds, zero failures, zero empty, 20 results every time.** The silent-thinning
risk is real but did not appear. It rests on one engine — Brave, DuckDuckGo,
Mojeek, Startpage and Wikipedia are all suspended by CAPTCHA or rate limit, and
every result comes from Google's scraper. There is no margin.

Both previously unresolved items now have valid measurements:

- **Universe Sandbox — CLEAN 6/6.** Zero unverified quotations, zero unverified
  figures, 26 verified sources, the model's own report. This was the question
  with the worst historical record and the one flagged as most likely to expose
  a remaining problem. It did not.
- **Minimum wage — CLEAN 6/6, zero blockers.** `status: completed`, the model's
  own repair stage, 38 cited blocks, 72,589 characters. The first `completed`
  this question has recorded: the 2026-08-28 baseline was `partial` too, so this
  is better than where it started rather than merely recovered.

### The question's own figures were read as fabrication

The blocker that survived everything else was one false positive. The
minimum-wage question opens "raising its local minimum wage to roughly 40
percent above the national floor", and every restatement of that proposal was
flagged `Numeric claim 40 percent is not present in its cited evidence` — a
_safety_ issue, which makes a report unusable.

A figure the run was handed is a premise, not a finding, and no evidence can be
cited for it. It failed the draft, the repair and five sections, and each failed
section was replaced by a ~1,200-character fallback stub in place of 8,750 to
16,435 characters of real prose. That cascade _was_ `recovered-stage`.

`validateResearchReport` now takes the question and skips a figure it contains.
The effect is visible in the attempt list: the run went from roughly twenty
attempts of sections, repairs and fallbacks to `draft` then `repair`, and
stopped.

This is the third defect of its family, after "identifiers were checked as
quantitative claims" and "a topic word vetoed its own step". **The pattern is a
check that treats the run's own inputs as claims about the world.** Look there
first.

### The scholarly search intent, and what it cost

`SearchIntent` lets a caller declare a query as research; SearXNG maps that to
`categories=general,science`. Critical Thinking declares it, ordinary
`web_search` does not. Measured: a query returns 20 results under `general` and
75 under `general,science`, the extra coming from arXiv, Crossref, Semantic
Scholar, Google Scholar and OpenAIRE. Those engines had **never been queried** —
they sit in the `science` category and a default search never consults it.

It also had a cost that nearly outweighed it. Academic publishers are largely
unfetchable, and the fetch failure rate went from 15% to 50%, halving usable
sources and starving two plan steps. The waste clustered by host: ssrn.com
refused 8 times in one run, academic.oup.com 5.

A host now gets **two** refusals before the run stops spending fetches on it.
Two, not one, because a single failure is as likely to be a timeout as a
paywall.

| build                  | reads | failed | rate    | sources | steps   |
| ---------------------- | ----- | ------ | ------- | ------- | ------- |
| baseline, no scholarly | 52    | 8      | 15%     | 44      | 6/6     |
| scholarly, no breaker  | 52    | 26     | 50%     | 22      | 4/6     |
| breaker held per-step  | 60    | 32     | 53%     | 22      | 6/7     |
| breaker held per-run   | 40    | 9      | **23%** | 28      | **7/7** |

**The third row is the lesson.** The breaker was held on the runner, and a
runner is built once per plan step, so the memory reset at every step boundary
and each step handed the same dead host a fresh allowance. It shipped, was
reported as fixed, and did nothing. Seven steps times two is fourteen; ssrn.com
refused 13 times. The counts now belong to the run.

## Rating: 9/10

Updated 2026-09-01. **Eight consecutive clean runs across six subjects on one
build**, including three consecutive clean runs of the question with the worst
historical record.

| run | subject          | steps | chars   |
| --- | ---------------- | ----- | ------- |
| 32  | minimum wage     | 6/6   | 72,589  |
| 34  | bronze age       | 6/6   | 160,271 |
| 35  | heat pumps       | 7/7   | 66,111  |
| 36  | creatine         | 6/6   | 53,606  |
| 37  | EU AI Act        | 6/6   | 79,916  |
| 38  | Universe Sandbox | 5/5   | 51,851  |
| 39  | Universe Sandbox | 6/6   | 58,083  |
| 40  | Universe Sandbox | 6/6   | 29,005  |

Every one `status: completed`, every one on the model's own `repair` stage
rather than a recovered or assembled one, every one zero blockers. Both bars
this document set for a 9 are met: all the new subjects clean, and three
consecutive clean runs on one question.

Universe Sandbox is the meaningful one. Its record before today was `0/7` to
`7/7` across ten attempts, and it was named here as the question most likely to
expose a remaining problem. Three for three.

**Not a 10, and the reasons are specific.** One model on one machine — nothing
here says how a 7B or a cloud provider behaves. `sufficient` sits at 0–8%, so
completion rests almost entirely on the deterministic test rather than the
model's own judgement, which is the semantic shift recorded below and still
worth watching. SearXNG now rests on a single engine, and its silent-thinning
failure — `HTTP 200` with fewer results, reading as "the evidence does not
exist" — remains untested and is the one failure class that produces confidently
wrong reports rather than visible errors. Quotations from memory still occur
(six in the heat-pumps run), though bronze age fell from 12 to 1.

## Five models, one question

`ct-question-creatine` on every local model that fits, after the bold-label fix.

| model                      | ctx | chars  | cited | suff | result |
| -------------------------- | --- | ------ | ----- | ---- | ------ |
| Qwen3.8-27B                | 64K | 53,606 | 57    | 0%   | clean  |
| Qwen3-4B                   | 32K | 18,386 | 10    | 77%  | clean  |
| gemma-3-27B                | 64K | 9,494  | 8     | 42%  | clean  |
| Devstral-24B               | 64K | 6,930  | 8     | 25%  | clean  |
| DeepSeek-Coder-V2-Lite-16B | 64K | 6,103  | 7     | 100% | clean  |

**Five of five complete the workflow.** Before the bold-label fix it was three
of five: gemma and DeepSeek-Coder were both rejected as `structurally-invalid`
for writing their sections as `**Label:**` rather than `# Label`.

**The 27B is an outlier, not a baseline.** Every other model lands at 6,000 to
18,000 characters and 7 to 10 cited blocks, against its 53,606 and 57. Anything
measured only on the 27B describes that model as much as it describes Anodex —
including the eight clean runs this document rates a 9 on.

`sufficient` also inverts with capability: the 27B says its evidence is enough
0% of the time and the 16B says so 100% of the time, on the same question with
the same evidence available. A weaker model is more easily satisfied, and
nothing in the four criteria notices.

## A 4B passes every criterion, and should not

Run on `Qwen3-4B-Instruct` at 32,768 — the smallest model here, given room,
since context size rather than parameter count decided this model's fate on the
Workspace benchmarks. It scored **CLEAN**: 7/7 steps, `completed`, the model's
own repair stage, zero dumps, zero blockers.

It did the same research as the 27B on the same question:

|                              | Qwen3.8-27B @ 64K | Qwen3-4B @ 32K |
| ---------------------------- | ----------------- | -------------- |
| rounds                       | 12                | 13             |
| searches                     | 36                | 36             |
| fetches                      | 44                | 49             |
| sources                      | 26                | 29             |
| evidence items               | 70                | 71             |
| **report characters**        | **53,606**        | **18,386**     |
| **cited substantive blocks** | **57**            | **10**         |
| self-rated `sufficient`      | 0%                | **77%**        |
| minutes                      | 18                | 2              |

**The research was equivalent; the synthesis was not.** The 4B gathered the
evidence and then hardly used it — a sixth of the citations and a third of the
prose — and satisfied itself on 77% of rounds against the 27B's 0%.

`completed` is defined here as research that was substantial, well-sourced **and
cited**, and the four criteria cannot see the last of those. `cited=` is now
printed by `ct-criteria.mjs` so the difference cannot pass unnoticed.

It is deliberately **not** a fifth criterion. Any threshold would be invented
from this single comparison, and a bar fitted to one observation is how this
system was over-fitted before. Two runs are a reason to look, not a reason to
legislate.

The finding this leaves: **a weaker model is more easily satisfied, and the bar
does not notice.** That is the semantic shift recorded below, seen from the
other side.

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

- **The model invents quotations from memory** — much reduced, not gone, and no
  longer the largest gap. Mean unverified quotations per run fell from **3.7
  across the seven runs before 2026-09-01 to 1.2 across the nineteen after**,
  with 13 of those 19 at zero, and bronze age — the worst case, at 12 — coming
  in at 1. Nothing targeted it: better sources and far fewer failed synthesis
  attempts appear to have done it.

  It still appears (heat pumps 6, one Universe Sandbox run 4), it is still
  subject-dependent, and the behaviour is unchanged where it does occur. They
  are neutralised and disclosed, so the reader is told. **More prompt text is
  not the answer** — the prompt already forbids it in plain terms
  (`criticalThinkingPrompts.ts`, "Quotation marks are a claim that a source used
  those words, not emphasis") and the behaviour persisted anyway.

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

1. **Three consecutive clean runs on one question** for the 9. Universe Sandbox
   and minimum wage are both clean once each; the bar is repeatability. Pace
   them — SearXNG rests on a single engine, with no margin.
2. **The quotations-from-memory problem**, the largest remaining quality gap and
   still untouched. Detection and disclosure work; the behaviour does not
   change, and the prompt already forbids it in plain terms, so more prompt text
   is not the answer.
3. **Watch the silent-thinning failure.** SearXNG returns `HTTP 200` with fewer
   results when an engine is throttled, which reads as "the evidence does not
   exist". Brave, DuckDuckGo, Mojeek, Startpage and Wikipedia are all already
   suspended; every result comes from Google's scraper alone.
