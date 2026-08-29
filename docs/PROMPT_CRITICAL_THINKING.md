# Prompt for resuming Critical Thinking

**This work is PAUSED.** It is blocked on the Tavily monthly search quota, which
resets on the account's own cycle. Do not start this until web search works —
verify first, with the check in step 0 below.

Paste everything below into a fresh Claude Code chat in
`C:\Users\Owner\Desktop\Anodex4`.

---

Read `docs/HANDOFF_CRITICAL_THINKING.md` first. It has the measured state, seven
root causes already found and fixed, the operational traps, and two mechanisms
that must not be rebuilt — one reverted three times, one that nearly got rebuilt
a fourth on the strength of a statistic that turned out to be a mirage.

## Step 0: confirm search actually works

Nothing here is measurable without it. Tavily was returning `HTTP 432` on every
search — verified as the monthly credit allowance, not a burst limit, by a probe
3.5 hours after the failures.

Start a throwaway run and read the store to confirm the first searches succeed:

```
node scripts/ct-run-series.mjs scripts/ct-question-probe.txt
```

Then check `activities` for `kind: 'search'` entries with `status: 'success'`.
If they are errors, stop and tell the user — see the handoff's Status section for
the options (wait, Brave, or the already-installed SearXNG).

## Your goal

Get Critical Thinking to a genuine 9, then 10, and keep going until it holds.
Work autonomously: fix, restart, retest, measure, repeat. Do not stop for
ordinary engineering decisions.

**A run is clean when all four hold:**

1. `selectedStage` is `draft` or `repair` — the model's own report, not the
   assembled fallback
2. every step `completed` where the evidence exists
3. `status: completed`
4. zero excerpt-dump blocks in the shipped report

`scripts/ct-criteria.mjs` scores every stored run against all four and prints
`completion.blockers`, which names the failing condition directly. Start there.

**Current state: 8/10.** Three clean runs on three different subjects (EU AI Act,
bronze age, creatine) on one build. Two items unresolved:

- **Universe Sandbox** — no valid measurement since the fixes; its last run died
  on the search quota. Worst historical record of any question (`0/7` to `7/7`
  across ten attempts). **Run this first** — it is the most likely to expose a
  remaining problem.
- **minimum wage** — one non-reproducible planning failure. Failed twice, then
  produced a clean plan on the identical build.

**9/10** = three consecutive clean runs on one question.
**10/10** = that, plus clean runs holding across the different subjects.

## How to work

**Measure before you change anything.** Every real fix has come from reading
`%APPDATA%/anodex/critical-thinking/runs.json` and the `evidence/` sidecar, not
from reasoning about the code. `synthesisDiagnostics.completion.blockers` names
the failing condition; `synthesisDiagnostics.attempts` holds each stage's issues
and now `contractIssues` separately.

**Write the test that fails first.** Three times this has caught a test that
passed with the bug still present — once because the fixture didn't reproduce the
failure at all. Stash the source fix, confirm the test fails _for the right
reason_, restore it, confirm it passes. When you loosen a check, also write the
test that proves the bar still holds, and confirm that one passes both before and
after.

**Check the provenance of any statistic before acting on it.** The round-depth
`sufficient` rate looked like proof that the per-step cap was strangling steps.
Every deep-round sample came from _resumed_ runs with evidence already banked.

**Verify the build before trusting a run.** electron-vite does not restart the
main process. `Get-Process electron | Select StartTime` must be newer than your
last change. Kill `electron` and `llama-server` explicitly and check the count is
zero.

**Verify a run actually started by reading the store**, never by trusting a
launch. A silent launch failure cost three hours in the last session, and the
handoff had already warned about exactly that.

**Pace the runs.** The last session burned a month of search credits in ~200
searches across five back-to-back runs. Each run costs roughly 40 searches.

## Do not over-guard

This is the failure mode that broke Anodex before, and four of the seven bugs
fixed last session were over-guards, not missing guards.

- A guard that cannot tell right from wrong should not claim it. A malformed
  chart block — which cannot even render, let alone assert something false —
  discarded a 36,000-character report with 31 cited blocks.
- A check must test the thing it means to test. The completion fallback asked
  "are these sources academic?" when it meant "are these sources better than
  junk", and made `completed` unreachable for whole subject areas.
- A keyword veto will match its own subject matter. `\bconflict\b` vetoed a step
  titled "Audit funding and conflicts of interest".
- Prefer disclose and ship over refuse.
- Only build a safeguard a real, measured failure demands. A single
  non-reproducible flake is not one.

## Report honestly

State what you measured and what you did not. If a run fails, say which of the
four criteria it missed and why. **Do not move the rating on one data point** —
that mistake has now been made three times in this work. An honest `partial` with
a correct report is a better outcome than a `completed` engineered by loosening
what "covered" means.
