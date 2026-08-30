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

_Nothing open as of 2026-08-30._ Everything found so far is either fixed below,
or closed with a verdict at the end of this file. Add new findings here.

---

## Fixed, kept for the reasoning

An entry moves here rather than being deleted, because _why it was skipped_ and
_what changed the decision_ are the parts worth having later.

### finish_goal repeated in a turn said nothing useful (was #12)

One run called `finish_goal` three times in a row and was told "Run finished."
each time. The run does end — the turn loop inspects settled calls afterwards,
which is why the tool deliberately has no abort plumbing — but an identical
answer teaches the model nothing and spends two more calls.

A repeat now says the run is already finishing and that nothing further will
change the outcome, and is marked as no progress. The design is untouched: the
first call still ends the run, and no plumbing was added to a tool whose doc
comment explains why it has none.

### Blank trailing assistant messages (was #5)

Four agent runs end with an empty assistant message carrying
`{tokens: 0, durationMs: 1}` — a duration saying no generation happened at all —
rendering as an empty bubble in the transcript. Still present in the store and
still exactly four, so the original count was right.

**Was skipped for:** the agent-run records that would have identified them were
cleared before they could be read.

**What changed the decision:** the store answers it without those records. A
sweep of 1,038 assistant messages found 19 blanks: 7 trailing, 12
mid-conversation, and — importantly — **several carrying real data**. One held
6,579 characters of reasoning alongside an `error` and `errorKind`; others
carried an error with no visible reply.

So the obvious fix was the wrong one. Dropping a message because its content is
empty would have destroyed exactly the records someone goes looking for after a
failure. `carriesNothing` discards a message only when every channel is empty:
no visible text, no tool calls, no reasoning, no error. A turn that genuinely
produced nothing is already accounted for — `turnsUsed` counts it and the stop
reason explains it.

**Not fixed at the source.** This stops the empty bubble being persisted; it
does not explain why a turn occasionally costs 1ms and produces nothing. The
`ms=5000`–`10000` blanks are a different thing again: a real generation that ran
for seconds and returned nothing, which is the model, not Anodex.

### An insertion-style patch applied twice duplicated code (was #7)

One run issued `patch_file` against `ui.py` twice with the same five
replacements and left the block duplicated three times over. The model noticed
and repaired it, which is luck rather than a guarantee.

**Was skipped for:** tool arguments are not persisted, so it could not be shown
from the store that the two patches were byte-identical — "unprovable from
stored data".

**What changed the decision:** it did not need proving from the store. The
non-idempotent shape is visible in the code and reproducible in a test. A plain
replacement is self-protecting — once `oldText` has become `newText` it is gone,
so a repeat fails harmlessly with "oldText was not found". But the ordinary way
to _insert_ is a replacement whose `newText` contains its `oldText`, and there
`oldText` survives inside the text the first application wrote, so the second
application finds it and inserts again.

**Fixed** by detecting exactly that shape: `newText` contains `oldText`, and the
file already contains `newText`. Such a replacement is skipped, and a patch
where every replacement is already applied fails with a message saying so
instead of duplicating. Narrow on purpose — anything that is not that shape
patches as it always did, and the test that a plain replacement still refuses a
vanished `oldText` is kept.

### Shell surveying was invisible to the gathering guard (was #2)

One run spent about 170 of 208 calls gathering, 82 of them shell inspection
scripts of the shape `python -c "open('ui.py').read()"`, and the guard built for
"all input, no output" never fired.

**Was skipped for:** the obvious fix is a classifier, and `isObservationalCommand`
already fails to recognise `python -c "...read()..."`, so extending it does not
generalise — a model can write an inspection script in any shape. Worse, any
rule that made an unrecognised command _count as gathering_ would make running
the test suite or a build push a run toward being blocked, which is a worse
failure than the one it fixes.

**What changed the decision:** the defect is not the missing classifier. It is
that `run_command` reported `madeProgress: true` for anything it did not
recognise as a read, and progress **resets** the streak. So each of those 82
unrecognised scripts bought a free reset. Absence of evidence was being treated
as evidence of progress.

An unrecognised command is now **neutral**: it neither resets the streak nor
counts toward it. That is what makes this safe — a build or a test suite still
cannot push a run toward the guard, which is the exact risk that made this
unfixable before. Only a command Anodex positively recognises as changing
something (`isKnownMutatingCommand`) resets it.

`madeProgress` is deliberately unchanged. It is load-bearing for the
`finish_goal` evidence gate, durable-change reporting and the runner's own
progress checks, so a command that changed the workspace must keep counting as
progress even when Anodex cannot tell that it did. The streak asks a stricter
question and reads a separate field.

**Worth knowing:** the first wiring silently did nothing. `helpers.ts`
destructures a tool's result explicitly, so the new field was dropped and the
ledger-level tests passed against unchanged production behaviour — the same
shape as the hardcoded blanks in agent turns. The regression test now drives
`run_command` itself, and was checked to fail against the old code.

### The gathering guard fed itself (was #10)

A 4B model on an 8,192-token window hit `GATHERING_HARD_LIMIT` and had 22
subsequent calls refused; a later run had 10. Both spent about half their turns
making calls that could not run.

**The mechanism, found by reading `recordOutcome`:** a call the ledger refused
was recorded as a no-op, and a no-op increments the streak. So past the hard
limit, _every refusal pushed the count higher_ — the guard's own output became
its evidence, blocking could never stop, and the "N calls refused" figure
reported to the user grew from the guard's activity rather than the model's.

**Fixed** by not counting a call this ledger itself refused. That is not a
loosening: the streak still stands wherever the model's own behaviour put it,
still blocks there, and still resets only on a durable change. It stops the
count being circular.

**What is still open underneath it.** The deadlock shape is real and this does
not address it: at a small window the earlier reads have scrolled out, an edit
needs exact existing text, and the read that would supply it is refused. The
guard's premise — "you already have this" — is false once the content has been
evicted.

It is left alone deliberately. Across three runs the model never managed a
single valid edit call and writes were never blocked, so it always had a path
out and did not take it. Loosening a guard that is correctly describing a stuck
model would trade an honest stop for a longer one, and `idleRunReason` now ends
these runs with a specific reason anyway. Reopen it only with a run where the
model demonstrably _needed_ a refused read to proceed.

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

- **`DEFAULT_RECALL_WINDOW_FRACTION` has no ceiling.** It is the only budget in
  `contextBudget.ts` without one, and on a 200K window it withholds ~120K. The
  generality argument is sound and the fix is still contraindicated: bounding
  what is withheld means replaying _more_ history, and the one experiment on
  that (0.4 vs 0.75) showed no benefit and possibly harm. It cannot be measured
  on this hardware, whose largest configured window is 65,536. **Reopen only
  with a measurement at 128K+ showing replay depth changes an outcome.**

- **`finish_goal` accepts a summary with no substance.** A run finished with the
  literal summary `placeholder`. The guard deliberately never parses the summary
  — two attempts at reading it failed before, and both failures are recorded in
  `agentTools.ts`. It is now largely moot: the factual account is appended
  beside the summary whatever the summary says, a finish with an untouched
  workspace and open plan steps is flagged, and a length or content check would
  still reject a legitimately terse honest summary.

- **`finish_goal`'s plan gate.** Logged as "exactly one call deep", which
  understated it. The gate refuses a same-turn repeat with an explanation and
  accepts only on a _later_ turn, so a run cannot end itself by accident in one
  batch. That is the intended design and it holds.

- **Plan ticking.** `update_plan_step` works — called four times with zero
  failures in the run that finished 1/7. The model stops calling it. Anodex
  cannot tick a step on the model's behalf without deciding a step is done,
  which it has no way to know. Plan completion measures the model, not Anodex.

- **Wasteful repeated calls (~18.6 per 100).** Seven theories: six refuted by
  measurement, one built and reverted. Waste correlates with neither retained
  context (r = −0.15, n=31) nor run length (r = −0.11, n=45). Every remaining
  lever requires refusing a re-read, which caused the context livelock recorded
  in the `anodex-context-livelock-fix` memory. Judged model behaviour, not
  Anodex's context handling. Full record in `docs/HANDOFF_WORKSPACE.md`.
