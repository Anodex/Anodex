# Prompt for the next session

Paste everything below into a fresh Claude Code chat in `C:\Users\Owner\Desktop\Anodex4`.

---

Read `docs/HANDOFF_CRITICAL_THINKING.md` first. It has the measured state, the
root causes already found, the operational traps, and — importantly — one
mechanism that was built three times and reverted. Do not rebuild it.

## Your goal

Get Anodex's Critical Thinking to a genuine 9, then 10, and keep going until it
holds. Work autonomously: fix, restart, retest, measure, repeat. Do not stop to
ask permission for ordinary engineering decisions.

**A run is clean when all four hold:**
1. `selectedStage` is `draft` or `repair` — the model's own report, not the
   assembled fallback
2. every step `completed` where the evidence exists
3. `status: completed`
4. zero excerpt-dump blocks in the shipped report

**9/10** = three consecutive fresh runs clean on the existing question.
**10/10** = that, plus a clean run on a *different* question, on a different
subject entirely. The second half matters more — every threshold in the codebase
was tuned against one question and has never been tested outside it.

## How to work

**Measure before you change anything.** Every real fix this session came from
reading `%APPDATA%/anodex/critical-thinking/runs.json` and the `evidence/`
sidecar, not from reasoning about the code. `synthesisDiagnostics.attempts`
holds each stage's issues. `scripts/verdict-tally.mjs` is the leading indicator
and shows within ~10 rounds — use it to kill a bad theory early instead of
waiting an hour.

**Write the test that fails first.** Twice a test was added that passed with the
bug still present, and once a "fix" changed nothing for two full runs because of
it. Stash the source fix, confirm the test fails, restore it, confirm it passes.

**Verify the build before trusting a run.** electron-vite does not restart the
main process. `Get-Process electron | Select StartTime` must be newer than the
last commit. Kill Electron and llama-server explicitly and check the count is
zero — `taskkill` on npm leaves them running, and stale instances share the same
data directory.

**Verify a run actually started** by reading the store, never by trusting that a
click landed.

## Do not over-guard

This is the failure mode that broke Anodex before, and most of this session was
undoing it.

- A guard that cannot tell right from wrong should not claim it. A check that
  fires on correct behaviour is worse than no check — it discarded a good
  25,000-word report over 21 quotations that were never quotations.
- Prefer **disclose and ship** over refuse. Quotations get their marks removed
  and are listed in the report's limits; figures are disclosed up to a hard cap.
  The reader is informed rather than handed a different document.
- Distinguish *misattribution* from *invention* before calling anything
  fabricated. Check the cited passage, then the cited page, then all fetched
  evidence.
- Do not add a heuristic cutoff because one run looked stuck. Only build a
  safeguard a real, measured failure demands.
- If you find yourself patching the same mechanism a third time, stop and ask
  whether it addresses the actual cause. It probably doesn't — that is exactly
  how the reverted spare-rounds work happened.

## Report honestly

State what you measured and what you did not. If a run fails, say which of the
four criteria it missed and why. Do not move a rating on one data point — that
mistake was made twice here. An honest `partial` with a correct report is a
better outcome than a `completed` engineered by loosening what "covered" means.

Start by reproducing run 6: restart on the current build, run the Universe
Sandbox question fresh, and report the four criteria plus the `sufficient` rate.
