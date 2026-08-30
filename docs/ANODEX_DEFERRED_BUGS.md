# Anodex — deferred bugs and open questions

Started 2026-08-30, from the Workspace reliability and multi-model compatibility
work. **Anodex issues only.** Nothing here is about the Universe Sandbox game or
any other project Anodex works on — a model writing bad Python is not an Anodex
bug and does not belong in this file.

Each entry says what was seen, the evidence, why it was left, and where to start.
Cross them off as they are fixed. Add to it rather than rewriting it, so the
reasoning for skipping stays readable later.

---

## Open

### 2. Shell surveying is invisible to the gathering guard

`taskLedger`'s gathering streak counts `read`/`web`/`plan` kinds. **Any**
successful `run_command` resets it, including `python -c "open('ui.py').read()"`
and `Select-String`. One run spent ~170 of 208 calls gathering, 82 of them shell
inspection scripts, and the guard built for "all input, no output" never fired.

**Why skipped:** `isObservationalCommand` exists but does not classify
`python -c "...read()..."` as read-only either, so wiring it in does not fix it.
Writing a new classifier risks marking a build or a test as "gathering", which
would block real work — a worse failure than the one it fixes.

**Where to start:** not a classifier. Consider whether a command that produced no
file change and no non-zero exit should count as gathering, decided from the
settled record rather than the command text.

### 3. `DEFAULT_RECALL_WINDOW_FRACTION` is the only unbounded budget fraction

Every other budget in `contextBudget.ts` is `{fraction, floor, ceiling}` —
`OUTPUT_RESERVE`, `REFERENCE_CONTEXT`, `TOOL_SCHEMAS` — with the ceiling
explicitly reasoned about ("reserving one would starve the working set on
exactly the machines that paid for the most memory"). The recall window is a
bare `0.4`. On a 200K-context machine it withholds ~120K for refill room no turn
has ever used, and it gets worse the better the hardware.

**Why skipped:** contraindicated by measurement. Bounding what is withheld means
retaining _more_ history, and the one experiment on retaining more history (0.4
vs 0.75) showed no benefit and possibly harm. Fixing the shape without evidence
of benefit would be guessing.

**Where to start:** measure at 128K+ directly. The generality argument is sound;
the benefit is unproven at any size tested so far.

### 5. Blank trailing assistant messages

Four agent runs end with an empty assistant message carrying
`{tokens: 0, durationMs: 1}`, created ~20ms after the previous turn. Visible as
an empty bubble in the transcript.

**Why skipped:** the signature is consistent with the run being stopped rather
than a generation fault, and the agent-run records that would say which were
cleared on 08-27 before they could be read.

**Where to start:** reproduce by stopping a run mid-flight and checking whether
the empty message is persisted.

### 6. `finish_goal` accepts a summary with no substance

A run finished with the literal summary `placeholder` while 4 of 7 plan steps
were open.

**Why skipped:** the guard deliberately never parses the summary — two attempts
at reading it failed before, and both failures are recorded in `agentTools.ts`.
A length or content check is gameable and would reject a legitimately terse
honest summary.

**Where to start:** probably nothing to do. Recorded because it is a real hole in
the disclosure mechanism, not because a fix is obvious.

### 7. An insertion-style `patch_file` applied twice duplicates code

One run issued `patch_file` against `ui.py` twice with the same 5 replacements.
A patch whose `newText` contains its `oldText` — the ordinary way to insert a
line — is not idempotent, so the second application duplicated the block three
times over. The model detected and repaired it itself.

**Why skipped:** tool arguments are not persisted, so it cannot be shown from the
store that the two patches were byte-identical. One self-corrected observation.

**Where to start:** persist a hash of tool arguments, then re-measure. Without
that, this is unprovable from stored data.

### 10. The gathering guard blocks calls without ending the run

A 4B model on an 8,192-token window hit `GATHERING_HARD_LIMIT` and had
**22 subsequent calls refused** with "Blocked: gathering without progress".
The streak lives for the whole run and only a durable change resets it, so
once past the limit every remaining gathering call was refused and the run
spent roughly fifteen turns of its thirty producing nothing.

There is a real deadlock shape here: at a small context the earlier reads have
scrolled out of the window, `edit_file` needs exact existing text, and the read
that would supply it is refused. That is the same class as the livelock in the
`anodex-context-livelock-fix` memory.

**Why skipped:** it reproduced on the third run (10 calls refused, 30/30 turns,
plan 0/4, nothing changed), so the "did not reproduce" note written after the
second run was wrong. What changed is that the run now _says_ so — "Ended early
— 10 further information-gathering call(s) were refused" — because the count it
had was no longer thrown away. Left unfixed because the guard is not the cause:
the model never managed a single valid edit call in any of the three runs, and
writes were never blocked, so it always had a path out and did not take it.
Loosening a guard that is correctly describing a stuck model would trade an
honest stop for a longer one.

**Where to start:** reproduce deliberately by forcing the streak past the hard
limit at a small context. If it holds, the fix is not to weaken the guard but to
let a read through when the content it would return is no longer in the window —
the guard's premise ("you already have this") is false once that is true.

### 11. `finish_goal`'s plan gate is exactly one call deep

The gate refused a finish with six open plan steps, and accepted the identical
call on the very next turn with no work in between. That is the intended design
— `openStepsToldIn` tells a model once and then stops arguing — but the gate is
bypassed by retrying rather than by doing anything.

**Why skipped:** deliberately. Refusing repeatedly is what made runs burn their
budget fighting a gate, and the standing rule is to disclose rather than refuse.
A run that finishes this way is now flagged instead, so the outcome is honest
even though the gate is thin.

**Where to start:** probably nothing. Recorded so the thinness is a known
property rather than a surprise.

### 12. `finish_goal` does not stop the turn it is called in

One run called `finish_goal` three times in a row and all three returned "Run
finished." The tool deliberately has "no special plumbing" — `AgentRunService`
inspects the accumulated calls _after_ the generation — so the turn keeps going
and the model can call it repeatedly.

**Why skipped:** harmless as measured. The run ends after the turn either way,
and the summary is taken from the first successful call. Adding abort plumbing
to a design whose doc comment explains why it has none is not worth two wasted
calls.

**Where to start:** if it ever matters, the cheap version is a different message
on the second and later calls ("already finishing; no further calls needed")
rather than a third identical "Run finished."

### 13. Plan ticking is not reliably fixed

Recorded in `HANDOFF_WORKSPACE.md` as "found, fixed, validated" on the strength
of one task going 2/7 to 7/7. Later runs disagree: a trail-controls run reached
6/6, and an energy-overlay run reached **1/7** while doing real work — 48
`write_file` calls, 63 `run_command` calls, and `update_plan_step` called four
times with **zero failures**.

So the tool works and the model simply stops calling it partway through. That
makes it model behaviour rather than an Anodex defect, but the handoff's
"validated" is too strong for what the evidence supports.

**Why skipped:** nothing in Anodex is broken. Anodex cannot tick a step on the
model's behalf without deciding a step is done, which it has no way to know.

**Where to start:** treat the plan-completion criterion as measuring the model,
not Anodex, unless `update_plan_step` is seen failing.

## Fixed, kept for the reasoning

An entry moves here rather than being deleted, because _why it was skipped_
and _what changed the decision_ are the parts worth having later.

### Two budgets that nothing enforced (were #9 and #14)

`MASK_AT_FRACTION = 0.6` and a `maskAtTokens` on every allocation, for an
observation-masking pass that was never built. `TurnSummaryInput.stopped`,
declared and passed by both call sites and read nowhere.

Both removed rather than left in place. `contextBudget.ts`'s own comments
describe having once shipped a budget nothing enforced, and the doc on
`maskAtTokens` stated as fact that masking happened — so a reader of that file
would believe a feature existed that did not. That is worse than an unused
field: it is a false claim in the place people go to understand the design.

**If observation masking is ever implemented**, the threshold that was designed
for it is 0.6 of the input limit, sitting below `ROTATE_AT_FRACTION`'s 0.8, on
the reasoning that context degrades well before the hard limit so both should
fire early and proportionally rather than at a constant. That is the whole of
what was lost, and it is one line to restore.

Removing `stopped` also removed a small trap: one call site was deriving a
value carefully and passing it into nothing.

### Start produced nothing, with no error anywhere (was #4)

The user clicked Start; no `AgentRun` was created, no conversation appeared, and
neither the dev log nor `anodex.log` recorded anything. Polled 150s.

**Was skipped for:** never reproduced. Every run since went through the autorun
harness, which bypasses the editor entirely - so the one path with the bug was
also the one path nothing was testing.

**Found by reading it instead.** `RangeControl` reports
`Number(event.target.value)`, and `Number('')` is `0`. Clearing the turn, token
or time field therefore sets it to 0, which fails `canSave`'s `>= 1` check, which
disables the Start button - with nothing anywhere saying so. A click on a
disabled button does nothing, submits nothing, and logs nothing, which is
exactly the report. A non-numeric entry gives `NaN` and fails the same way.

**Fixed** by saying why: `startBlockedReason` names everything missing at once,
and the button's `disabled` is derived from that same function, so the two can
never disagree. No validation was added and nothing new is refused - the refusal
was already there and simply silent.

**Not proven against the original report.** This is a code-level match for the
symptom, found by inspection, not a reproduction of that session. If a silent
Start is ever seen again, it is a different bug.

### Turn budgets denominated in turns, not work (was #8)

A turn holds as much as the window has room for, so `maxTurns: 30` meant wildly
different amounts of work on different hardware while the token and time
budgets meant the same everywhere. Measured across 40 stored runs, a turn cost
between **94 and 10,802 tokens** — a 115x spread. Every run that hit its turn
cap had spent almost nothing of what it was granted: 1.9%, 2.2% and 3.4% of its
token budget. `MAX_MAX_TURNS` was 60, so there was no configuring around it.

**Was skipped for:** "every scaling rule needs a reference point, and fitting
one to this machine is what the Critical Thinking work was undone by."

**What changed the decision:** the reference point did not have to be invented.
`MAX_MAX_TURNS`'s own comment already names the pair it assumes — ~7.5k tokens
per turn at a 65,536 window — so scaling is a _ratio between two windows_ rather
than a new fitted constant, and at that window nothing changes at all.

Scaling is by **working set**, not raw context size: the output reserve,
reference context and tool schemas have floors, so a small window loses
proportionally more of itself to them. `allocateContextBudget` already models
that exactly. At 8,192 the working set is a ninth of 65,536's, not an eighth.

Neither bound can go _down_. Naive scaling hands a 200k window a ceiling of 15,
and this file's own reasoning says raising a ceiling removes a limit while
lowering one adds a limit nobody asked for. Tests pin that at 65k, 131k, 200k
and 1M.

**Answered, and the answer is no.** The same 4B/8,192 task that had failed three
times at 30 turns was re-run with the scaled budget: 72 turns available, **24
used**, 6,441 of 300,000 tokens, plan 0/4, nothing written. It ended on the
idle-turn stop - "3 turns in a row without making a single tool call" - not on
the turn cap.

So the turn cap was a real bug and is fixed: it no longer binds, and the run now
ends with a specific reason at turn 24 instead of grinding to 72 and reporting
that it ran out of turns. But **the extra turns did not make the model
succeed.** On this model at this window the binding constraint was never the
budget; it was that the model stops driving the loop. Do not expect the turn fix
to move completion rates.

### A model that stops driving the loop (was #1)

DeepSeek-R1-Distill-32B emitted byte-identical 3,126-character replies with
**zero tool calls** for six consecutive turns, and the run continued to its turn
limit. The loop guard covers repeated tool _calls_; the in-turn repetition guard
covers a single turn. Nothing watches for a turn that produces the same prose
again and again while doing nothing.

**Was skipped for:** one model, and one observation.

**Reopened and fixed** when Qwen3-4B did the same thing at a different size and
context — turns 22 through 30, nine consecutive turns, no tool calls at all,
then the turn cap. Two models three sizes apart is no longer one observation.

The fix counts consecutive turns that made **no tool call**, rather than
comparing reply text. Only one of the two models repeated itself, so the
repetition was incidental; an agent turn can only act or finish through a tool,
so "did this turn do anything" is both the stronger question and one that needs
no text comparison. See `idleRunReason` in `agentTurnClaims.ts`.

---

## Unvalidated fixes

Not bugs — fixes that landed without a live run proving them.

- **`edit_file` near-miss reporting.** Tells the model what the file actually
  says where its `oldText` nearly matched. Has **never fired** in a live run.
- **One-shot provider retry.** Lets a run survive a single `provider-error`
  instead of ending on it. Landed after the only run that would have exercised
  it.
- **The multi-language fixes** (`TEXT_EXT`, `SKIP_DIRS`, `code_outline`, the
  toolchain line in the orientation summary). No live run has exercised them:
  two Rust runs used `read_file` directly, because a one-file crate never needs
  to search. They are covered instead by `multiLanguageSearch.test.ts`, which
  drives the real search and listing tools over a real Rust layout — the level
  the bug lived at. Treat that as the evidence, not a live run.
- **Context-scaled turn budgets.** `maxTurnsCeilingFor` is unit-tested at seven
  window sizes, and one live run started with 72 turns where it would have had 30. Whether the extra turns are _used well_ is a separate question that needs
  more than one run.

---

## Measurement limitations to know about

- **Tool results are truncated to 2,001 characters in the store.** Anything
  appended to the model-facing result beyond that — the evidence descriptor, for
  instance — cannot be observed from a stored conversation. A check for it will
  silently find nothing and read as a negative result.
- **`findUnverifiedPathClaims` only sees paths containing a separator.**
  `PATH_PATTERN` requires `dir/file.ext`; a bare `physics.py` is never a
  candidate. This is deliberate and must stay — without the separator,
  `numpy.array`, `Math.random` and `self.value` all read as fabricated file
  paths, and the module records two live incidents where a correct reply was
  accused. A model that names bare filenames is simply outside what this check
  can verify. Do not "fix" it.
- **Tool call arguments are not persisted.** Any question of the form "were
  these two calls identical" is unanswerable from the store.
- **`conversation.updatedAt` is unreliable.** A bulk store rewrite set every file
  to the same timestamp; real recency comes from `messages[].createdAt`.
- **`conversation.plan` holds only the last plan.** `write_plan` replaces it, so
  a run that completed three plans and started a fourth reads as "0 completed".
  Plan history is recoverable from the per-call `plan` snapshots.

---

## Closed with a verdict — do not reopen without new measurement

- **Wasteful repeated calls (~18.6 per 100).** Seven theories: six refuted by
  measurement, one built and reverted. Waste correlates with neither retained
  context (r = −0.15, n=31) nor run length (r = −0.11, n=45). Every remaining
  lever requires refusing a re-read, which caused the context livelock recorded
  in the `anodex-context-livelock-fix` memory. Judged model behaviour, not
  Anodex's context handling. Full record in `docs/HANDOFF_WORKSPACE.md`.
