# Prompt for the Workspace session

Paste everything below into a fresh Claude Code chat in
`C:\Users\Owner\Desktop\Anodex4`.

---

Read `docs/HANDOFF_WORKSPACE.md` first, then skim
`docs/HANDOFF_CRITICAL_THINKING.md` — not for its subject matter, but for its
method and its list of traps. That work found seven real bugs, and **four of them
were over-guards rather than missing guards**. The same failure modes are likely
here.

## Your goal

Get Anodex's **Workspace** to a genuine 9 and keep it there. The test workload is
the Universe Sandbox game that Anodex builds itself.

Work autonomously: measure, fix, restart, retest, measure again. Do not stop for
ordinary engineering decisions.

## The rule that governs everything

**Anodex writes all of the game. You fix Anodex, never the game.**

```
C:\Users\Owner\Desktop\Sandbox\Sandbox\UniverseSandbox
```

The path is doubled — the outer `Sandbox` holds `.anodex/`, the inner one holds
the game. If a run produces broken game code, that is the finding. Resist opening
the file and fixing it yourself; the point is the tool, not the artefact.

Every Anodex fix must stay **general** — never specific to this project, this
language, or this machine. Anodex is for many users building anything.

`python _smoke_test.py` in that folder runs headless and prints per-subsystem OK
lines. It passes cleanly as of 2026-08-28. Run it before and after every session:
it is the fastest way to see what a run actually left behind, and the only honest
check on whether a run's claims are true.

## Start here

```
node scripts/ws-criteria.mjs
```

It reads `%APPDATA%/anodex/conversations/<projectId>/<conversationId>.json` and
reports tool-call count, failure rate and the tools that failed, plan completion,
and repeated call signatures. `VERBOSE=1` lists every failed call.

Baseline from one real run (96 messages): **1,378 tool calls, 141 failed (10%)**,
61 of them `read_file_range`; **80 call signatures repeated more than twice**,
worst at 59×. A second, smaller conversation: 7 errors in 48 calls with its plan
left at **0/3 completed** despite the work appearing done.

Two conversations is a starting reading, not a measurement. Get more before
theorising.

## Proposed criteria for a clean run — confirm these first

The Critical Thinking work only became tractable once "clean" meant four
unambiguous, mechanically checkable things. Workspace needs the same. **Ask the
user to confirm or amend these before using them to move a rating:**

1. **The task is actually done** — `_smoke_test.py` passes and exercises the
   feature that was asked for.
2. **The plan is finished** — every step `completed`, not left `pending`.
3. **Tool calls are reliable** — failed-call rate under 5%.
4. **No claim outruns the evidence** — no build/test/fix reported as verified
   unless the command actually ran. Cross-check against `toolCalls`.
5. **No pathological repetition** — no call signature repeated more than ~5 times.

**9/10** = three consecutive clean runs on different features of the game.
**10/10** = that, plus a clean run in a different project in a different
language. The second half matters more: Critical Thinking had five bugs that
stayed invisible until the subject changed.

## How to work

**Measure before you change anything.** Every real fix in the research work came
from reading the store, not from reasoning about the code. Do the same here.

**Write the test that fails first.** Three times a test was added that passed
with the bug still present — once because the fixture did not reproduce the
failure at all. Stash the source fix, confirm the test fails _for the right
reason_, restore it, confirm it passes.

**When you loosen a check, also write the test that proves the bar still holds**,
and confirm that one passes both before and after. That is what stops a fix
turning into a quietly lowered standard.

**Check a statistic's provenance before acting on it.** A round-depth number
looked like proof that a cap was strangling the system; every sample turned out
to come from resumed runs. It nearly caused a mechanism to be rebuilt for the
fourth time.

**Verify the build before trusting a run.** electron-vite does not restart the
main process. `Get-Process electron | Select StartTime` must be newer than your
last change. Kill `electron` and `llama-server` explicitly and check the count is
zero — `taskkill` on npm leaves them running and stale instances share the data
directory.

**Never `git checkout`, `stash` or `merge` while a run is in flight** — it
reloads the renderer and destroys the in-flight transcript.

**Prefer giving the user manual GUI steps and asking for a screenshot** over
driving Anodex through computer-use. It is far cheaper.

## Do not over-guard

This is the failure mode that broke Anodex before, and most of the research
session was undoing it.

- A guard that cannot tell right from wrong should not claim it. A malformed
  chart block — which cannot even render, let alone assert anything false —
  discarded a 36,000-character report.
- A check must test the thing it means to test. One asked "are these sources
  academic?" when it meant "are these better than junk", making success
  unreachable for entire subject areas.
- A keyword veto will match its own subject matter.
- Prefer disclose and ship over refuse. Prefer removing machinery to adding it.
- Only build a safeguard a real, measured failure demands. A single
  non-reproducible flake is not one.
- If you are patching the same mechanism a third time, stop and ask whether it
  addresses the actual cause. It probably does not.

## Report honestly

State what you measured and what you did not. If a run fails, say which criterion
it missed and why. **Do not move the rating on one data point** — that mistake
was made three times in the research work. An honest "not clean, here is the
measured reason" is worth more than a pass engineered by loosening what "done"
means.

## First task

Measure the current state, agree the criteria with the user, then have Anodex
build the next feature of the game and score it. `_plan.md` in the game folder
shows the black hole feature complete through Part 5 — ask the user what should
come next, or propose something that stresses a part of Workspace the existing
runs have not (multi-file refactor, a failing test to diagnose, a git operation).
