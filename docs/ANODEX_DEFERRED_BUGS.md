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

### 1. A model repeating an identical reply across turns is never caught

DeepSeek-R1-Distill-32B emitted byte-identical 3,126-character replies with
**zero tool calls** for six consecutive turns, and the run continued to its turn
limit. The loop guard covers repeated tool _calls_; the in-turn repetition guard
covers a single turn. Nothing watches for a turn that produces the same prose
again and again while doing nothing.

**Why skipped:** one model, and the run ends on its turn budget anyway, which is
now reported honestly. Building a cross-turn reply comparator on one observation
is the accumulation pattern that has hurt this codebase before.

**Where to start:** count identical consecutive assistant replies with no
settled tool calls; treat it as a `no-progress` stop rather than new machinery.

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

### 4. Starting a run from the GUI produced nothing, with no error anywhere

The user clicked Start; no `AgentRun` was created (`AgentRunStore.create`
persists immediately and `runs.json` stayed `[]`), no conversation appeared, and
neither the dev log nor `%APPDATA%/anodex/logs/anodex.log` recorded anything
after model-ready. Polled 150s.

**Why skipped:** never reproduced — every subsequent run was started through the
autorun harness, which bypasses the editor entirely.

**Where to start:** the submit path in `AgentRunEditor.tsx` — `canSubmit`
requires a non-empty goal and every budget ≥ 1, and an empty budget field
disables submit with no visible reason.

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

### 8. Turn budgets are denominated in turns, not work

A turn holds as much as the context window has room for: ~11 tool calls at
65,536 tokens, ~1.2 at 8,192, because roughly 1,400 tokens of working room fits
a single tool result. So `maxTurns: 25` means very different amounts of work on
different hardware, while the token and time budgets mean the same everywhere. An
8K run finished 0 of 4 plan steps at 25/25 turns with **1.9%** of its token
budget spent.

**Partly addressed:** `turnBudgetLeftovers` now reports what was left, so the
user can see the turn cap was the binding constraint. The scaling itself is
unfixed.

**Why skipped:** every scaling rule needs a reference point, and fitting one to
this machine is what the Critical Thinking work was undone by.

**Where to start:** consider whether `maxTurns` should be a safety net rather
than the primary bound, given tokens and time already bound cost correctly.

### 9. `MASK_AT_FRACTION` is defined but never used

`MASK_AT_FRACTION = 0.6` and `maskAtTokens` are computed in
`allocateContextBudget` and consumed nowhere outside `contextBudget.ts`.
Observation masking is planned for but not implemented.

**Why skipped:** found while chasing something else; harmless, but a budget that
nothing enforces is exactly the shape of the bug the file's own comments
describe having fixed once before.

---

## Unvalidated fixes

Not bugs — fixes that landed without a live run proving them.

- **`edit_file` near-miss reporting.** Tells the model what the file actually
  says where its `oldText` nearly matched. Has **never fired** in a live run.
- **One-shot provider retry.** Lets a run survive a single `provider-error`
  instead of ending on it. Landed after the only run that would have exercised
  it.

---

## Measurement limitations to know about

- **Tool results are truncated to 2,001 characters in the store.** Anything
  appended to the model-facing result beyond that — the evidence descriptor, for
  instance — cannot be observed from a stored conversation. A check for it will
  silently find nothing and read as a negative result.
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
