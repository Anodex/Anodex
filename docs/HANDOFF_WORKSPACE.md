# Workspace — handoff

Updated 2026-08-28. Everything below that is a number was measured from the
stored conversations, not from reasoning about the code. Where a claim is
unverified it says so.

## Rating: unchanged, and a single number is now the wrong shape

The 9/10 bar - three consecutive clean runs - is still not met. But the larger
finding is that a single rating describes one model: everything scored below is
Qwen3.8-27B at 65,536 tokens on this machine. Five makes were tested and four of
them exposed defects invisible from that baseline, two of which made a model
completely unusable.

Read the per-model table under "Compatibility across makes" before quoting any
number here.

### On the baseline specifically

Seven runs: four clean, three failed. On the _current_ build (all five fixes)
the record is clean, clean, fail — two consecutive, not three.

The one genuinely new result is run 6: a clean run in a **different project, in
a different language, on a different toolchain**, first attempt. That is the
half of the 10/10 bar that hid five bugs in the Critical Thinking work, and it
passed. The 9 is still unearned because the three-consecutive condition is not
met.

## What Workspace is

The mode where Anodex works inside a project folder: file read/write tools,
shell commands, git, structured project checks, plans, checkpoints, and the
Workspace Dock. `docs/FEATURES.md` §"Workspace Tools" describes the surface.

## The test workload

Anodex builds a Python/tkinter **Universe Sandbox** game.

```
C:\Users\Owner\Desktop\Sandbox\Sandbox\UniverseSandbox
```

The path is doubled — the outer `Sandbox` is the workspace root and holds
`.anodex/`; the inner one holds the game. The Anodex project is named
`Sandbox` (`p_mt6bc8wx_0mno0`).

**Anodex writes all of the game. You fix Anodex, never the game.** If a run
produces broken game code, that is the finding. `python _smoke_test.py` runs
headless and prints per-subsystem OK lines; run it before and after every
session. It passed at the start and end of this one.

## Clean-run criteria (confirmed with the user 2026-08-28)

1. **The task is actually done** — `_smoke_test.py` passes and exercises the
   feature asked for.
2. **No silently-open plan steps** — every plan the run started ends complete,
   _or_ the reply names the step left undone and why. Chosen over "every step
   completed" because abandoning a step is legitimate when it is said out loud,
   which is what `finish_goal`'s guard already asks for.
3. **Tool calls are reliable** — failed-call rate under 5%.
4. **No claim outruns the evidence** — cross-checked against `toolCalls`.
5. **No pathological repetition** — no call signature repeated more than ~5×.

**9/10** = three consecutive clean runs on different features. **10/10** = that
plus a clean run in a different project, in a different language.

## Read this before trusting any number: three instrumentation bugs

All three had the same shape — **finding "the current thing" by recency or
position instead of naming it** — and each produced a confident, wrong reading.

1. **`ws-criteria.mjs` sorted by `conversation.updatedAt`.** Every stored file
   shares an `updatedAt` of 2026-08-28T01:5x from a bulk store rewrite, so
   "newest" was arbitrary: it scored a run from 08-23 while the genuinely newest
   was 08-26. Real recency comes from `messages[].createdAt`.
2. **Plan completion was read from `conversation.plan`.** That is a single slot
   `write_plan` overwrites. One run scored "0/7 — a defect the user sees" had in
   fact completed 6/6, 5/5 and 8/8 before starting a fourth plan. Plan history
   is recoverable from the per-call `plan` snapshots, and that is what the
   script reads now.
3. **The run monitor used `runs[runs.length - 1]`.** `agent-runs/runs.json` is
   not append-ordered, and a freshly started run is not written yet while the
   previous finished one still is. It latched onto the finished run, saw `done`,
   and reported the wrong run's result — exactly the failure `watch-ct-run.mjs`
   was already documented for.

## The corrected baseline

The handoff's old headline — 1,378 calls, 10% failures — came from one outlier
conversation (`Build Solar System Website`, last active 08-23) that predates the
repetition work.

| window                               | calls | failed         |
| ------------------------------------ | ----- | -------------- |
| all 78 conversations with tool calls | 6,313 | 389 (6%)       |
| since 2026-08-24                     | 3,083 | 145 (**4.7%**) |

So criterion 3 was **already met** before this session started. That number is
also misleading on its own, because it averages over tools that never fail.

### The real number: anchored edits fail ~22%

Broken out by tool, `edit_file` / `replace_lines` / `patch_file` — editing an
existing file, which is most of software work:

| window                                    | anchored calls | failed    |
| ----------------------------------------- | -------------- | --------- |
| all time                                  | 769            | 165 (21%) |
| after the edit echo (`6a3187b`, 08-25)    | 468            | 103 (22%) |
| after the relocation hint too (`eea0103`) | 96             | 21 (22%)  |

**Two careful, well-reasoned fixes in a row moved that number not at all.** Any
further work here should be measured against this table, not against the 4.7%.

### Why they fail — the assumed cause was wrong

The code comments attribute it to the model's read being compacted out of
context. Measured across post-echo failures:

- **47%** happen when the model saw that file in the _immediately preceding_
  call. Median gap: 2 calls. It has current information and still produces a bad
  anchor. Eviction is not the cause.
- **59 of 103** were preceded, _within the same assistant message_, by a
  successful write to that same file. **69 of 95** messages containing anchored
  edits contain more than one; several contain 20–36.

The mechanism is batching: the model composes several edits against one view of
the file, the first lands and shifts every line below it, and the rest arrive
stale. Better reporting cannot reach them — they were written before any result
existed. That is why the echo did nothing.

**This is the single most important finding in this document.** The same
batching mechanism explains the `finish_goal` failure below, and probably
explains other things not yet looked at.

## What was fixed

Five changes. Four narrow an existing over-guard rather than adding one; the
fifth raises a cap that was destroying the disclosure another guard demands.
Each was tested by stashing the fix and confirming the test failed _for the
right reason_, with the "bar still holds" tests passing in both states.

### 1. `finish_goal`'s evidence gate measured the turn, not the task

`AgentRunService` calls `runGeneration` once per turn, so a run that did its
work in turn 3 began turn 4 with `madeChange: false`. `CONTINUE_PROMPT` then
asks it to finish, and the gate refused — telling it to "create or edit a file,
run a command" when the work was already done. Measured: five refusals of that
shape in five runs; two never recovered, one ended blank with its plan at 0/5.

`priorTaskProgress` in `turnProgress.ts` reads the answer off the history the
request already carries, so it survives a resumed run. Only `madeChange`
carries; the ordering fields stay fresh so `hasStaleVisualEvidence` is not
silently tightened.

### 2. `replace_lines` refused an edit it could place

Its own refusal read _"That text is now on line 40 — retry there, shifting the
rest of the range by the same amount"_ — a complete description of the correct
edit, handed back as an error. When `expectedFirstLine` matches exactly one
line, the anchor has done its whole job and the line number is the redundant
half. `relocateToAnchor` now places the edit and says it moved. Zero matches,
several matches and a missing anchor still refuse with the wording they had, and
`describeSeamDuplication` still guards the far end.

The old relocation-hint helper was deleted: once a unique match is placed, its
only working branch was unreachable.

### 3. `edit_file` said nothing about a near miss

It had the whole file in hand and reported only "the text to replace was not
found". It now reports what the file actually says where the text nearly
matched, under the same uniqueness rule. **Fired zero times in live runs so
far — unvalidated.**

### 4. A run's summary was capped below the disclosure it was required to make

`MAX_SUMMARY_CHARS` was 1,000 in the first agent-runs commit (`ac482a7`,
07-10), when the summary was a short outcome note. The open-steps guard later
gave it a second job — name the steps you are leaving undone and why — and
nobody resized it.

Measured on run 7: it finished with 4 of 7 steps open and wrote a careful
account of both halves. It was cut mid-word at exactly 1,000 characters, after
item 5 of 7, so the two steps it abandoned were never named. The disclosure the
guard exists to force was destroyed by the cap on the field it forces it into.

Now 4,000, and truncation says `[cut off by Anodex]` rather than trailing into
an ellipsis a reader cannot tell from the model's own punctuation.

### 5. The open-steps reconsideration spanned a generation, not a turn

`finish_goal` refuses once when plan steps are open, then lets the next call
through — one unmissable prompt to reconsider. But a model emits several calls
in one response, all written before any result comes back, so a second
`finish_goal` in that batch is a _sibling_ of the refused one, not a
reconsideration of it.

Measured: **10 of the 32** stored messages containing `finish_goal` contain more
than one. Run 3 died on exactly this: it called `finish_goal` by accident, was
refused, wrote in its own reply _"I accidentally called finish_goal — the plan
is still open, let me get back to executing it"_, carried on working, and then
had four more calls from the same batch accepted. It stopped at 1 of 8 steps
with 12 turns and 260,000 tokens unspent.

The refusal now stands for the rest of the generation that earned it and lifts
on the next one, keyed on the `TaskLedger` (whose lifetime is already the whole
run, so this needed no plumbing). A run that means to stop early still can, and
its summary is still never parsed — it just has to say so on a turn that has
seen the answer.

## The measured record

| run | task                                 | result                                                        |
| --- | ------------------------------------ | ------------------------------------------------------------- |
| 1   | split `rendering.py` into `render/`  | **clean** — 6/6, 0/85 failed, smoke green                     |
| 2   | add comet body type                  | **clean** — 8/8, 5/125 failed (4%), 5 new checks green        |
| 3   | colour palette                       | **fail** — accidental `finish_goal` at turn 8, 1/8 steps      |
| 4   | colour palette, fixes live           | **fail** — spent all 20 turns, 2/6 steps                      |
| 5   | colour palette, 40 turns             | **clean** — 8/8, 0/65 failed, claims verified                 |
| 6   | TypeScript CSV→JSON CLI, new project | **clean** — 7/7, 4% failed, tool verified working             |
| 7   | orbit prediction                     | **fail** — 3/7 steps, 7x repetition, smoke checks never added |

Run 1 did not exercise either fix (tool mix was `write_file` 11 vs `edit_file`
3 — a split-into-new-files refactor structurally avoids the anchor path). Run 2
did: 4 of its 11 anchored edits failed, and both failing anchors occur exactly
once in the file, so `relocateToAnchor` would have placed all three stale ones.

Run 4 made **zero** `finish_goal` calls, so fix 4 was **not exercised** there.
What run 4 does establish is the negative: tightening that guard caused no
livelock. `relocateToAnchor` fired **once** live in run 4 — real, but n=19
anchored calls is far too small to claim it moved the 22%.

Every failed run left the workspace **working** (`ALL CHECKS PASSED` after each).
A run that exhausts its budget or stops early does not leave broken code.

### Run 6 is the one that moved the picture

Verified independently rather than trusted: `npm test` run directly (31
passing), then the CLI exercised by hand against embedded commas, escaped `""`,
embedded newlines, CRLF, `--delimiter`, `--no-header`, and malformed input
returning exit 1 with a clear message and no stack trace.

It produced the first live evidence for two fixes:

- **Fix 4 caught its target.** Three `finish_goal` calls in one batch: the first
  refused for the open step "Run npm install and npm test", the next two refused
  by the new turn-spanning rule. Under the old code the second would have
  succeeded and ended the run at 6/7 with the tests never run — a success claim
  on unverified work. The model then ran them and finished honestly at 7/7.
- **The anchor path was finally exercised**: 12 anchored edits, **0 failures**,
  with one relocation firing live.

Live anchored-edit data across runs 5-7 is now 25 calls with 2 failures (8%)
against a 21-22% baseline drawn from 769 calls. Suggestive, not conclusive.

## Known-unfixed, with evidence

### Shell surveying is invisible to the gathering guard

`taskLedger`'s gathering streak counts `read`/`web`/`plan` kinds; **any**
successful `run_command` resets it to zero. Run 4 spent ~170 of its 208 calls
gathering, 82 of them shell inspection scripts (`python -c "src=open('sprites.py').read()..."`,
`Select-String -Path ui.py`, `python _final_scan.py`). Peak streak never
approached the soft limit of 22, so the guard built for "all input, no output"
runs cannot fire against a model that surveys through the shell.

**Deliberately not fixed.** Anodex's own `isObservationalCommand` would not
classify `python -c "...open(...).read()..."` as read-only either, so wiring in
the existing predicate does not catch these. Writing a new classifier means
guessing what a shell command does, and guessing wrong in the other direction
blocks builds and tests as "gathering" — a worse failure than the one it fixes.
Note that run 3 had **zero** such commands and disproved this theory; run 4
proved it. A measurement that kills a theory on one run does not kill it
generally.

### A Start click that produced nothing

The user started a run from the GUI and no `AgentRun` was created
(`AgentRunStore.create` persists immediately, and `runs.json` stayed `[]`), no
conversation appeared, and neither log recorded an error. Never diagnosed. A
Start button that silently does nothing is a real defect if it recurs.

### Blank trailing assistant messages

Four agent runs end with an empty assistant message. The `durationMs: 1`,
zero-token signature and the ~20 ms gap after the previous turn are consistent
with the run being stopped rather than a generation bug, and the agent-run
records that would settle it were cleared on 08-27. The empty bubbles _are_
visible in the transcript. Unresolved — not built for.

### Repetition: the binding constraint, and no safe fix found

Every failure on the current build after the fixes landed was criterion 5.
Criteria 3 and 4 have not failed once. Measured as wasteful repeats — an
identical call with nothing in between that could have changed its answer:

| run              | calls | recall   | wasted per 100 |
| ---------------- | ----- | -------- | -------------- |
| orbit prediction | 184   | 0.4      | 19.0           |
| scenario presets | 198   | 0.4      | 14.6           |
| save/load        | 123   | 0.4      | 13.0           |
| diagnostics      | 124   | **0.75** | **19.4**       |

Three explanations were tested and all three died:

1. **The edit echo** (`6a3187b`) was supposed to remove the need to re-read
   after an edit. Anchored-edit failures were 22% before it and 22% after.
2. **Prompting.** The save/load goal said outright "read each file once before
   editing it and work from that, rather than re-reading it repeatedly." It
   changed nothing: 8 reads of one file, 13.0 per 100.
3. **History eviction.** Raising `recallWindowFraction` from 0.4 to 0.75 made
   it _worse_ — the only 0.75 run is the worst of the four. An earlier
   comparison appeared to support the theory and was confounded by run length.

**This also contraindicates the generality fix below.** Giving the recall
window a ceiling means retaining more history on large contexts, and the one
experiment on retaining more history says it does not help and may hurt.

The remaining levers are all known-harmful: refusing re-reads caused a context
livelock (see `anodex-context-livelock-fix`), and widening the loop guard's
18-entry window would block re-running the smoke test after each edit, which is
correct behaviour. On the evidence available this is a model-behaviour ceiling
rather than a defect the tooling can reach. Do not patch it a fourth time
without a new measurement that distinguishes a cause.

### `finish_goal` accepted a summary of "placeholder"

With 4 of 7 plan steps open, a run was refused once and then finished with the
literal summary `placeholder`. The guard deliberately never parses prose — two
attempts at reading the summary failed before, and both failures are recorded
above — so it cannot tell that from a real account. A length or content check
would be gameable and would reject a legitimately terse honest summary. One
occurrence, recorded rather than built for.

### An insertion-style patch applied twice duplicates code

Run 7 issued `patch_file` against `ui.py` twice with the same 5 replacements.
A patch whose `newText` contains its `oldText` (the ordinary way to insert a
line) is not idempotent, so the second application duplicated the block — three
duplicated blocks in that file. The model detected and repaired it itself and
the smoke test passed, so this was self-correcting here.

Not acted on: tool arguments are not persisted, so it cannot be shown from the
store that the two patches were byte-identical, and one self-corrected
observation is not grounds for changing how patches apply. Worth watching.

**Not caused by `relocateToAnchor`** — the only relocation in run 7 was on
`physics.py`, and it placed correctly.

### Plan ticking: found, fixed, validated — "validated" is too strong

Read the correction in `ANODEX_DEFERRED_BUGS.md` #13 first. The fix is real and
`update_plan_step` works, but later runs reached 6/6 and 1/7 on other tasks, so
one task going 2/7 to 7/7 did not validate it. Where a run leaves steps unticked
while doing real work, the tool is being called successfully and then abandoned
by the model, which makes plan completion a measure of the model rather than of
Anodex.

**The final plan step was never attempted.** Across all 13 current-build runs
that ended with an incomplete plan, `update_plan_step` was called zero times for
the last step - not called and refused, never called. When it is called it
almost always succeeds, so ticking was never broken.

In at least three of those runs the work was demonstrably done. One had the step
"Report the actual exit code and delete any temporary scripts created" sitting
`pending`, and its last three commands were the smoke test, `Remove-Item
_final_out.txt` and `Remove-Item _probe_exit.py` - verbatim what the step asked,
performed and unmarked.

The cause was Anodex's own wording. The open-steps guard fires at exactly the
right moment, with the plan in front of the model, and offered two options:
"finish them" or "say which you are leaving undone". A model that had already
finished read the first as a demand for more work and took the second. The
option it needed - mark the step - was never mentioned. It is now, first.

Validated on the identical task, same model, same settings:

| measurement tool | plan    | waste/100 | failures     |
| ---------------- | ------- | --------- | ------------ |
| before           | 2/7     | 23.7      | -            |
| after            | **7/7** | **5.0**   | **0 of 101** |

The plan result is attributable. The waste drop is **not explained** - a run that
completes and one that quits at 2/7 are not the same workload, and two later
runs landed at 2.1 and 5.0 against an 18.6 mean. Worth investigating; not
established.

### Criterion 5: an amendment was tried and refused by its own test

The raw "no signature repeated more than ~5x" bar now fails runs for
re-running the smoke test after each edit - correct behaviour, and what the
goals explicitly ask for. A body-editor run scored worst=6 (six `python
_smoke_test.py` calls) while wasting only 2.1 per 100, the lowest of the
session.

Replacing it with a waste-based bar was tested against all 48 stored runs first.
It preserves most verdicts **but passes the worst run of the session**: the
Devstral run that made 642 identical `find_skill` calls, failed 90% of its calls,
broke the build and claimed success, scores 4.6 waste - because its 940 blocked
calls were failures, and the waste measure only counts successful repeats.

So the raw bar catches a pathological loop that the waste bar misses, and the
amendment was dropped. Both numbers are reported; the raw count remains the bar.
Anyone revisiting this needs a measure that counts blocked repeats too.

### Plan ticking is back-loaded

Run 1's plan sat at 2/6 from turn 3 to turn 8 and jumped to 6/6 in the final
turn. It passes criterion 2, but for six of nine turns the Plan panel
under-reported what was done. One observation; not acted on.

## Compatibility across makes

Five models, same task, same 65,536-token window, same settings. Four of the
five exposed an Anodex defect the baseline never could.

| make                    | loads                                                   | tool calls                     | outcome                          |
| ----------------------- | ------------------------------------------------------- | ------------------------------ | -------------------------------- |
| Qwen3.8-27B (baseline)  | clean                                                   | reliable                       | 4 clean runs, 2 clean repairs    |
| Muse-Glimmer-30B        | arch unsupported in-process, falls back to llama-server | fabricates calls as prose      | 0/6 steps in 30 turns            |
| Devstral-Small-24B      | clean                                                   | 90% blocked in a loop          | broke the build, claimed success |
| Gemma-3-27B             | clean                                                   | **was 0** - dialect unreadable | now 24 calls, still dishonest    |
| DeepSeek-R1-Distill-32B | clean                                                   | **was 4** in 30 turns          | now 19, then drifts and loops    |

### What was fixed as a result

1. **Gemma's tool_code dialect was unreadable** (`90e9573`). Gemma emits a
   fenced `tool_code` block holding a Python call - `write_plan(title=..., 
steps=[...])` - and the fallback parser knew only the Hermes/Qwen
   `<tool_call>` JSON shape. Every call it made was invisible; it could not
   produce a plan and errored at turn 2. Told "You didn't call write_plan", it
   apologised and emitted the identical block again.
2. **Triple-quoted code arguments were dropped** (`17ccf6a`). DeepSeek emitted
   the dialect correctly but passed code as a Python """ string, which is
   never JSON, so the parser abandoned the call. That is the normal shape for an
   editing tool, and two of five models use this dialect.
3. **The tool-limit soft gate had no bound** (`4bcca99`). Devstral answered it
   with 940 further calls - 632 `find_skill`, 290 `search_files` - each blocked,
   each a full round trip, 43,207 tokens for nothing.
4. **A finished run discarded its own factual record** (`f3e69a6`). Both
   Devstral and Gemma claimed success on builds their own tests had just failed;
   the settled account that contradicted them was thrown away in favour of the
   claim. Both halves are now kept.

### Still unfixed

- **A transient parse failure ends a whole run.** Muse hit one unparseable
  native call at turn 4 of 30 after 22 successful calls and the run was over, at
  1.7% of its token budget. `recoverableStop.ts` treats soft ceilings as
  turn-level and everything else as fatal; this sits closer to the former. Not
  built for, because a retry that masks a model failing _every_ turn would burn
  budget silently, and the frequency data to size it does not exist.
- **"Vision model ready" is logged immediately after "failed to load model".**
  Muse's architecture is unsupported in-process and the fallback is reported as
  success. Debugging a real load failure, those two lines are indistinguishable.
- **A model repeating an identical reply across turns is not caught.** DeepSeek
  emitted byte-identical 3,126-character replies with zero tool calls for six
  consecutive turns. The loop guard covers tool calls; the in-turn repetition
  guard covers one turn. One model, deliberately not built for.

### Criteria 1 and 5 are in tension on this model

Three runs on the baseline, same build, same settings, deliberately different
lengths:

| run                 | calls | plan | failed on                                           |
| ------------------- | ----- | ---- | --------------------------------------------------- |
| measurement tool    | 76    | 2/7  | **criterion 1** - stopped early, disclosed honestly |
| diagnostics panel   | 81    | 6/6  | none - **clean**                                    |
| shortcuts + overlay | 186   | 6/6  | **criterion 5** - 20.4 wasted per 100               |

Short runs quit before finishing; long runs finish but repeat themselves. These
are not separate problems: they are one behaviour at two run lengths, and the
two criteria sit at opposite ends of it. Run 2 landed in the middle.

This is why "three consecutive clean runs" may not be reachable by running more
runs on this model. It needs the efficiency problem solved, not more attempts.

### Verdict: the re-reads are model behaviour, not Anodex's context handling

Measured across every stored run with 60+ calls. Wasteful repeats - an identical
call with nothing in between that could have changed its answer - occur at a
roughly **constant rate of 18.6 per 100 calls**, and correlate with neither
thing Anodex controls:

| relationship              | correlation | n   |
| ------------------------- | ----------- | --- |
| retained context vs waste | **-0.15**   | 31  |
| run length vs waste       | **-0.11**   | 45  |

If eviction drove the re-reads, retaining more context would reduce them. It
does not. If it were an accumulation effect, longer runs would be worse. They
are not. Both are flat.

The mechanism was traced properly before concluding this. History does not grow
steadily - it collapses and rebuilds as compaction fires roughly every five
turns, dropping ~60% each time (33,144 -> 13,794 tokens at turn 4 of one run,
31,846 -> 12,454 at turn 10). Trimmed tool results are replaced by an evidence
descriptor ending "body trimmed; read it again if you need it", which is an
explicit invitation to re-read. That looked like the cause and is not: runs that
retained far more context wasted just as much.

**Six explanations tested and refuted**, each with the measurement that killed
it:

1. The edit echo (`6a3187b`) - anchored-edit failures 22% before, 22% after.
2. An explicit prompt instruction ("read each file once") - no effect at all.
3. History eviction via `recallWindowFraction` 0.4 -> 0.75 - waste got _worse_
   (19.4 vs 13.0-19.0), and the first comparison was confounded by run length.
4. Retained context generally - correlation -0.15 across 31 runs.
5. Run length - correlation -0.11 across 45 runs.
6. A loop-guard threshold on repeats-since-change - blocks 0.6% of calls and
   none of them in the run that actually failed criterion 5.

**Every remaining lever requires refusing a re-read**, and that was tried before
this work began: it caused the context livelock recorded in
`anodex-context-livelock-fix`, where eviction told the model to re-run tools the
coverage tracker then refused. The fix then was to supply rather than refuse.
Refusing again would trade a measured 18.6% inefficiency for a failure mode that
stops runs dead.

### Seventh theory: a richer evidence descriptor. Built, measured, reverted.

The one direction that did not involve refusing: replace the bare "3,100 chars,
body trimmed" descriptor with the result's top-level lines, so a model that has
lost a file body still knows its shape. Language-agnostic by construction -
top-level position rather than a keyword list - and tested to stay under half
the size of what it replaced.

Waste on the next long run: **19.1 per 100, against an 18.6 mean and a 20.4
comparable**. No effect.

Reverted (`a37d670`..). A descriptor is paid for out of the same budget the body
was, so ~200 characters of shape displace ~200 characters of real content. A
change that does not reduce waste and does consume budget is a net loss, and
keeping it would be accumulating machinery for its own sake.

**Measurement note:** the marker could not be confirmed from stored data. Tool
results are truncated to 2,001 characters for storage, and the descriptor is
appended to the _model-facing_ text beyond that point. The code path is
unconditional for any result over 240 characters, so it near-certainly fired,
but "near-certainly" is the honest word. Anyone retrying this should instrument
the emit first.

### Where this leaves it

Seven theories, six refuted by measurement and one built and reverted. Waste
holds at ~18.6 per 100 calls and moves for nothing Anodex controls. Every
remaining lever refuses a re-read, which caused the context livelock recorded in
`anodex-context-livelock-fix`.

The honest conclusion is that this is not fixable from Anodex's side without
trading a measured inefficiency for a failure that stops runs dead. It is a
property of how the model works, and the evidence for that is now the absence of
any correlation rather than an absence of ideas.

### A loop-guard threshold does not solve it (measured, do not rebuild)

The obvious fix - count repeats since the last durable change rather than in the
loop guard's fixed 18-entry window, reusing the rule the gathering ledger
already applies - was replayed against all 8,772 stored calls before being
built. At a limit of 8 it blocks 0.6% of calls, and what it blocks is genuine
waste: 21x `write_plan` thrash, 17x an identical `read_file_range`, 15x
`update_plan_step`, 10x `find_skill` loops.

**But it blocks nothing in the run that failed criterion 5.** Run 3's 38 wasted
calls are not one signature repeated fifteen times; they are many files each
re-read two or three times across 186 calls, and no threshold catches that
shape. The 15x `run_command` that tripped the raw count is an edit-inspect-edit
cycle - each inspection follows a write, so by the "could anything have changed"
rule it is legitimate.

A first formulation of the same rule, which let _any_ command reset the
counters, blocked nothing anywhere: the runs are full of `python -c` inspection
commands. Only a write should reset. That version is the one measured above.

### Repair from a broken workspace works

Twice, on damage caused by two different models. Both times the baseline
diagnosed from the actual traceback, fixed the code rather than deleting the
failing test, and finished with 0% workspace-tool failures. This was untested at
the start of the session.

## 2026-08-30: the small-model pairing, and what it exposed

Everything before this was a 24-32B model on a 65,536-token window. The one
configuration named by "any model, any size" and never tried was the realistic
one for modest hardware: a small model on a small window. Qwen3-4B-Instruct at
8,192 tokens, on a deliberately tiny task (one pure function plus one test
check, `scripts/ws-run-tiny.json`).

It never completed the task in three attempts. That result is about the model.
What it exposed on the way is about Anodex, and all of it is general.

### Anodex was telling non-JavaScript projects they had no code

`code_outline` maps JavaScript and TypeScript only, and answered every other
project with **"No source files found."** In a Python repository that is false,
and it reads as "there is no code here" rather than "this tool does not speak
that language". The run shows the cost directly: the model was told its project
had no source files and spent the next twenty calls hunting for code
`read_file_range` had already shown it. It now names what it passed over and
points at the tools that work.

`SKIP_DIRS` was a JavaScript list - `node_modules`, `dist`, `.next`, `.turbo` -
and every workspace walk in the app uses it. A Python project had `__pycache__`
and its virtualenv walked, searched and listed to the model as if they were the
user's work; at 8K that listing is a real fraction of everything it can hold.

`TEXT_EXT` decides what `search_files` will even open. Missing were Swift, Dart,
Lua, Scala, Elixir, Clojure, Haskell, OCaml, F#, Julia, Nim, Zig, Groovy, Perl,
R, Fortran and Objective-C, plus Terraform, Protobuf, GraphQL and CMake. A
missing language does not search badly, it **searches to nothing** - the walk
skips the file and reports "No matches found" for code that is plainly there.
The regex also required a dot, so `Makefile`, `Dockerfile` and `Gemfile` were
invisible; those now match by name.

### The fabrication check never ran on agent runs at all

`runTurn` passed hardcoded blanks where the turn's own evidence belonged:
`unverifiedPaths: []` and `blockedGathering: 0`. `GenerateOutcome.fabrication`
`Detected` documents itself as set by the bounded runner and surfaced by
unattended callers "rather than silently reporting success" - and agent runs
call `runGeneration` directly, so the flag was structurally always false on the
one path where nobody is watching. The "Possible fabrication" badge could not
appear on an agent run. The Scheduler was checked and is fine; it uses the
bounded runner.

The `blockedGathering: 0` blank was the same shape, and its repair is visible in
a later run, which now ends with "Ended early - 10 further information-gathering
call(s) were refused". That sentence had been unreachable.

### A run reported success having done nothing

Run 2 finished `done`, `flaggedTurns: 0`, with a summary saying the function
"has been successfully implemented and verified" and that the smoke test "passed
with exit code 0". It had made **no write, edit or patch call in sixteen turns**
and the function was not in the file. `finish_goal` was refused once for six
open plan steps and accepted on the immediate retry with no work in between,
which is the intended "tell once, then stop arguing" design.

Anodex's disclosure worked - the turn account underneath said "Changed nothing".
The status did not. A finish with an untouched workspace and open plan steps is
now flagged. Nothing is refused and no run finishes differently; the only thing
withdrawn is the claim of unqualified success, and that claim was Anodex's.

Note the wiring fix above would **not** have caught this run: it named bare
filenames, and `PATH_PATTERN` requires a directory separator on purpose.

### Nine turns doing nothing at all

Run 3 spent turns 22 through 30 making **no tool calls whatsoever**, then hit
the turn cap. This was already in the deferred log, skipped as one observation
on DeepSeek-R1-32B. Qwen3-4B is a second, three sizes away, so it was reopened
and fixed: three consecutive turns with no tool call now stop the run. Counted
in tool calls, not reply text - only one of the two models repeated itself, so
the repetition was incidental, and an agent turn can only act or finish through
a tool.

### Three checks that looked like bugs and were not

Worth recording, because each cost time and each will look wrong again:

- `findUnverifiedPathClaims` ignores a bare `physics.py`. Deliberate: without
  the separator requirement, `numpy.array` and `Math.random` read as fabricated
  paths, and the module records two live false accusations.
- `findUnverifiedMeasurements` ignores "57 checks". Deliberate: only numbers
  precise enough to have been measured, because a check that cries wolf gets
  ignored.
- A corrupt `.gguf` produced a genuinely good error naming the cause and the
  fix. Recorded as correct behaviour.

The pattern: the conservative checks in this codebase are conservative for
reasons that are written down next to them. Read the comment before widening
one.

### Later the same day: reporting, and the turn budget

Four more fixes after the ones above, in the order they were found.

**A run's summary described its last turn, not the run.** The account appended
to a run summary came from `lastOutcome`. A run that wrote 48 files across
sixteen turns ended with "Changed nothing - this reply only looked", because its
final turn had only re-read a file. An earlier run read correctly only by
coincidence: it genuinely had changed nothing all run. Settled calls and path
claims now accumulate across the run. Verified live: a 23-turn run now reports
"Changed `ui.py` (14 edits), `physics.py` (4 edits)" and "Plan all 7 steps
complete".

**Non-Node projects were told nothing about how they are built.** The
orientation summary - the thing that means a task starts oriented rather than
blind - was built from `package.json` alone. `projectToolchain` already knew
Cargo, Go, Python, Maven and .NET, so this reuses that table. It returns null
for Node deliberately, because a `package.json` names _real_ scripts and
convention should not talk over a better signal.

**Making the path-claim check reachable caused a false accusation.** Covered in
its own section below. Read it before adding any check of this kind.

**Turn budgets now scale to the window.** See `ANODEX_DEFERRED_BUGS.md`, the
"Turn budgets denominated in turns" entry, for the measurement and the reasoning
about why the reference point did not have to be invented.

### The false accusation, and why it matters more than the fix

Making `findUnverifiedPathClaims` run on agent turns was correct - it had been
structurally unreachable there. Judging it **per turn** was not, and the very
next run paid for it.

A Rust run that did everything right - plan 4/4, `cargo test` passing, two clean
edits, independently verified correct - was badged **"Possible fabrication"**.
Its first turn wrote a plan saying it would work in `src/lib.rs`; that turn's
only tool call was `write_plan`, so the file had not been read yet. Turn 2 read
it three times.

An agent run's opening turn is _normally_ naming the files it is about to open.
An intention is not a claim about completed work. The bounded runner never had
this problem because it judges a single reply. Claims now settle at run end
against the whole run's coverage.

`pathClaimVerification.ts` already recorded two incidents where a correct reply
was accused, and the rule drawn from them: **a false accusation on a correct run
is worse than no check at all.** This was the third. When a check is moved to a
new surface, its unit of judgement has to move with it.

### Four checks that looked broken and were right

Each cost time, and each will look wrong again to the next reader:

- `findUnverifiedPathClaims` ignores a bare `physics.py` - it requires a
  directory separator, or `numpy.array` and `Math.random` read as fabricated
  paths.
- `findUnverifiedMeasurements` ignores "57 checks" - only numbers precise enough
  to have been measured.
- `list_directory` shows `target/` while `search_files` skips it. Deliberately
  asymmetric: a listing states what is on disk, so hiding a real directory would
  make it lie; searching build output drowns the answer in copies.
- A corrupt `.gguf` produced an error naming the cause and the fix.

The conservatism in this codebase is load-bearing and its reasons are written
beside it. Read the comment before widening anything.

### Live verification on the fixed build (2026-08-30, end of session)

One run on the current build, 27B at 65,536, adding an orbit-path predictor
across `physics.py`, `render/`, `ui.py`, `main.py` and the smoke test.

**done at 11/30 turns, plan 7/7, 0 flagged, smoke test green at 61 checks (from
59), no temporary files left.** Verified against disk rather than the summary,
and then verified again from outside the model's own tests: the new
`predict_path(body, bodies, steps, dt)` returns exactly the requested points, is
pure, is deterministic, and returns `[]` for `steps <= 0`.

Worth noting what it did with a collision it was not warned about. `predict_path`
already existed with a different signature; rather than break the renderer and
three existing checks, it made the function a dispatcher and moved the old body
verbatim into `_predict_path_full`. The legacy call still works and is still
pure — checked independently. That is the behaviour the "do not rewrite what is
there" instruction asks for, and it is the first run to be checked this closely
and come back clean on every count.

## The benchmark, and the first attributable numbers

Everything measured before 2026-08-30 is **unattributable**. `AgentRun.model` is
null for every local run by design - it routes a cloud request rather than
describing anything - so six models were compared in one day and the record
cannot say which run used which. `ranWith` now records the local model and the
context window; `scripts/ws-stats.mjs` segments by it and keeps older runs under
"unattributed" rather than pooling them.

### Running it

```
node scripts/bench-reset.mjs <bench-name>     # restore the known start state
ANODEX_AGENT_AUTORUN=scripts/<bench-name>.json npm run dev
node scripts/ws-stats.mjs                     # segmented results
```

The reset matters more than it looks. The Universe Sandbox workload accumulates,
so a task re-run finds the feature already built - one "regression test" finished
in five turns and measured nothing, because an earlier session had done the work.

### First baseline: Qwen3.8-27B-UD-Q4_K_M @ 65,536

|                                |        |
| ------------------------------ | ------ |
| runs                           | 3      |
| finished                       | 100%   |
| plan complete                  | 100%   |
| flagged                        | 0%     |
| tool calls failed              | 0%     |
| repeat calls                   | 21%    |
| stopped early with budget left | 0 of 3 |

All three verified against disk and then re-verified from outside the model's
own tests:

- **bench-1** (single file, pure functions): 3 turns, 13 checks. Mode tie-breaks
  to the smallest value, all three `ValueError` paths carry messages, and
  `median` does not reorder the caller's list - which was never asked for.
- **bench-2** (multi-file package): 3 turns, 22 checks. `Money` is immutable via
  `__slots__` with assignment blocked, stores only ints, and the module contains
  no float conversion or true division - the "never use floats" constraint is
  the one that could have been violated invisibly.
- **bench-3** (fix three seeded defects): 3 turns, 5 checks. Three surgical
  fixes, `test_parser.py` untouched, no wholesale rewrite.

### What this baseline is not

Three runs on one model at one window, on tasks deliberately smaller and cleaner
than the Universe Sandbox work. It is a floor to detect regressions against, not
evidence that Anodex scores 100% at anything. The unattributed 43 runs sit at 44%
plan-complete on harder, messier tasks; the two numbers are not comparable and
the tool refuses to combine them.

## Tooling

- `scripts/ws-criteria.mjs` — scores a stored conversation against the five
  criteria. `ALL=1` for one line per conversation, `VERBOSE=1` for every failed
  call. **Start here.** Reads plan _history_, not the surviving slot.
- `scripts/ws-watch.mjs` — waits for a _new_ conversation, then polls it.
- `src/main/agents/agentAutorun.ts` — dev-only harness that starts an agent run
  from `ANODEX_AGENT_AUTORUN` (a JSON spec path) and approves its plan, removing
  the GUI from the measurement loop. Inert without the variable, refuses to arm
  in a packaged build, and **throws on an unknown project name** rather than
  falling back to a workspace-less run.
- Run specs: `scripts/ws-run-*.json`.

## Method notes that cost time to learn

- **Check provenance before acting on a number.** The 4,000-character write cap
  looked like the clearest "users cannot build what they want" limit in the
  data — 25 refusals, the same 6,201-character payload reissued eight times.
  It was **already fixed** (`fbfa1c0`, `456ae8b`, 08-23/24) and every refusal in
  the store predates the fix. Re-fixing it would have been the third patch to
  that mechanism.
- **A check that flags nothing is usually inert, not satisfied.** Criterion 4's
  first implementation ("did any command run this turn") flagged 0 of 40 claims.
  Requiring a command that _could have produced the claimed evidence_ flags 2 of
  39 and identifies both as backed earlier — so it discriminates, and the real
  answer is that these runs do not claim verification they never performed.
- **Recency is not identity.** See the three instrumentation bugs above.
- **Fixtures must reproduce the failure.** A seam-guard test failed and nearly
  had me "fix" working code; the fixture used `third()`, which
  `isSubstantialLine` correctly ignores as too short.

## What to do next, in order

Repetition is closed - see the seven-theory record above. Do not reopen it
without a new measurement that distinguishes a cause; six explanations were
refuted and a seventh was built and reverted.

1. **Push.** Commits sit unpushed on local `main` (46 as of 2026-08-30; check
   with `git rev-list --count origin/main..main`). The pre-push hook refuses the
   default branch by design; the sanctioned override is
   `ANODEX_ALLOW_MAIN_PUSH=1 git push origin main`, which skips CI, or push a
   branch and open a PR so CI runs.

2. **Plan ticking - the one substantial thing never investigated.** Every recent
   run leaves its plan one step short, and it is always the same step: the final
   "run the test and report", performed but never marked. This is the dominant
   criterion-2 failure and nothing has been measured about it. Start where the
   repetition work started: read the store. Does `update_plan_step` get called
   and fail, or never get called at all? The distinction decides whether this is
   Anodex's or the model's, and it is a different question from repetition
   because the model demonstrably _does_ the work.

3. **Validate the two unproven fixes.** The `edit_file` near-miss hint has never
   fired in a live run. The Gemma dialect reader took that model from 0 tool
   calls to 24, but Gemma has not yet completed a task.

4. **A transient parse failure ends a whole run.** Muse lost a 30-turn run at
   turn 4 to one unparseable call after 22 good ones, at 1.7% of its budget.
   Sizing a retry needs frequency data that does not exist: instrument how often
   the provider raises it before deciding, because a retry that masks a model
   failing _every_ turn burns a user's budget silently.

5. **Contexts other than 65,536.** Done for the small end - see the 2026-08-30
   section. Qwen3-4B at 8,192 was tried three times and completed nothing, which
   is the model; the Anodex defects it exposed are fixed. Still untried is the
   _large_ end: nothing has run above 65,536, and
   `DEFAULT_RECALL_WINDOW_FRACTION` withholds more the better the hardware.

6. **Re-verify the idle-turn stop on a long legitimate run.** Three consecutive
   turns with no tool call now end a run. The limit is above two so a
   think-then-act turn is safe, but this is the only change here that can end a
   run _early_, so it carries the most regression risk of anything in this
   document. A full multi-module task on the 27B baseline is the check.

### Deliberately not on this list

- **Anything that refuses a re-read.** It caused the context livelock in
  `anodex-context-livelock-fix`.
- **Widening the loop guard's window.** It would block re-running the smoke test
  after every edit, which is correct behaviour.
- **Giving `DEFAULT_RECALL_WINDOW_FRACTION` a ceiling.** The generality concern
  is real - it is the only unbounded fraction, and it withholds more the better
  the hardware - but the one experiment on retaining more history says it does
  not help and may hurt. Contraindicated until something measures large contexts
  directly.
