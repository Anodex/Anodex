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

Add new findings here.

### 2026-09-04: the confirmation card says "Apply file change?" for things that are not files

**Seen:** approving a `delete_scheduled_task` call in the GUI. The card is
correct in every other respect -- it is badged DESTRUCTIVE and shows the task it
resolved (name, schedule, next run, prompt) -- but its header reads "Apply file
change?" for the removal of a Scheduler task. Nothing about a file is involved.

**Evidence:** `ToolConfirmCard.tsx` picks the header from `KIND_CONFIG[kind]`,
and every mutating tool declares `kind: 'write'`, so any non-file write gets the
file wording. This is not new and not specific to the delete tool: creating a
reminder with `schedule_task` has always said the same thing.

**Why it matters more than a typo:** it is the wording on a destructive
confirmation. A user reading "Apply file change?" while deleting standing work
is being told the wrong thing about what they are approving.

**Why it was left:** `ToolConfirmRequest.title` already carries a specific title
(here, `Delete scheduled task "Interval test"`), and the email-draft branch in
the same component already demonstrates overriding the header. So the fix is
small -- prefer the request's own title when the write is not a file change. But
that header is shared by file writes, commands, MCP calls and web searches, and
changing it blind means changing every confirmation card in the app. It wants
one pass with eyes on each card type, not a one-line change at the end of an
unrelated piece of work.

**Where to start:** `src/renderer/features/chat/ToolConfirmCard.tsx` around
`KIND_CONFIG`; `request.diff` is the existing signal that a write really is a
file change.

### 2026-09-03: 4096 is unsupported on the vision transport, and not by a tunable margin

**Seen:** a 27B at 4096 on `LlamaVisionService` produced nothing on all twelve
turns of the chat script, every one stopping at `fixed-context-limit`. The same
window on `LlamaService` was fixed in `d94abfa`; this path was not.

**Measured, which is what settles it:**

- Input limit at 4096 is 3,584 (`contextSize - RESERVED_TOKENS`).
- The `minDirectTools` floor of ten tools costs **2,086 schema tokens** in this
  transport's own units (`JSON.stringify(toOpenAiTools(...)).length / 4`).
- Prompt and messages measured 1,620-2,000 depending on the turn.
- 2,086 + ~1,620 = ~3,706, already past 3,584 **before any output reserve at
  all**. The turn is then refused by a second gate that wants `minimumOutput`
  (1,280, from `MIN_TOOL_CALL_OUTPUT_TOKENS`) left over.

**Two fixes were tried, measured, and reverted:**

1. A schema ceiling as a share of the input limit, like the one that fixed
   `LlamaService`. It cannot work here: not binding at 8K needs a share of at
   least 2,086/7,680 = **0.272**, and fixing 4K needs at most about
   900/3,584 = **0.251**. There is no single fraction, because the floor's
   absolute cost is more than half of 4096's whole input limit.
2. Capping `minimumViableOutputTokens` so the 1,280 tool-call floor cannot take
   31% of a small window. It moved the gate (1,280 to 1,024) and 4K still
   produced nothing on twelve of twelve turns, while weakening an invariant
   backed by a real failure (a reply ceiling below one JSON call truncates it
   and llama-server 500s on its own parse).

**Why it was left:** the only fixes that would work are design changes, not
constants — dropping the tool floor entirely below some window so 4096 runs
gateway-only, and/or an ultra-compact prompt tier below the current 24K
threshold, since the compact chat prompt alone is roughly 44% of a 4096 window.
Either deserves its own measurement rather than being smuggled in behind a
tuning change.

**Where to start:** `scripts/chat-matrix.mjs` now carries a `qwen27b-4k` row, so
`node scripts/chat-matrix.mjs <out> qwen27b-4k --script scripts/chat-script-hard.json
--criteria scripts/chat-hard-criteria.mjs` reproduces it in about two minutes,
and the grader states plainly when a run produced nothing.

### 2026-09-03: memory capture cannot be measured against the live store

**Seen:** a hard-rubric criterion asked whether chat called `remember_fact` for
each of two facts the user states in one sentence ("I'm Merlin, and I strongly
prefer short answers"). The 27B called nothing and replied "Already on file,
Merlin -- name and short answers both saved."

**Evidence:** it was right. `%APPDATA%/anodex/memory/global.json` already holds
both facts from earlier runs, and the Memory section is injected into every
prompt. From the log, a model correctly declining to re-store what it already
knows is indistinguishable from one that failed to store anything at all.

**Why rewriting the prompts does not fix it:** whatever new facts the script
states, the first run stores them and every repeat run is back in the same
position. The stimulus is spent on first use, so the criterion is valid at most
once per machine.

**Why it was left:** the fix is a harness that owns its own memory store --
pointing the app at a scratch `userData` for the run, or clearing and restoring
the store around it. Clearing the user's real memory to make a test pass is not
acceptable, and the alternative is a real piece of harness work rather than a
criterion tweak. The criterion was removed with its reasoning left in place in
`scripts/chat-hard-criteria.mjs` rather than weakened until it passed.

**Where to start:** `chat-matrix.mjs` already owns each app instance it starts
and writes settings between runs; a per-run `--user-data-dir` is the natural
place to extend it. `persists-identity` in `chat-criteria.mjs` still covers the
outcome, and `applies-preference` covers the behaviour without touching state.

### DECIDED, NOT A BUG -- 2026-09-04: pointing Anodex at LM Studio or Ollama is a non-goal

**Superseding an earlier entry here** that called this a gap "close to free" and
worth building. It was neither, and the entry was wrong to invite it.

**The gap is real:** no shipped provider takes a user-supplied base URL, so a
local OpenAI-compatible server (LM Studio, Ollama -- both installed on this
machine) cannot be used. `OpenAiCompatibleProvider.ts` already speaks the
protocol, which is what made it look cheap.

**Why we are not doing it.** Anodex _is_ the llama.cpp integration. Running a
local model through the OpenAI-compatible path would route it via the **cloud**
provider, skipping everything the local transports do -- tool-surface
budgeting, context accounting, the output and tool floors. That would be a
third way to run a local model with different rules from the two that already
exist, and the two that already exist diverging is the direct cause of several
bugs fixed on 2026-09-03 (see [[anodex-two-local-transports]] and the 4096
entries below). Adding a third makes that worse.

There is also a correctness problem: `renderRuntimeSection` would tell the model
it is running "over the network -- not locally on the user's machine" for
something on localhost. That section exists to make a privacy claim truthfully.

**What the real case would have been**, for whoever revisits it: reusing models
already downloaded into Ollama without duplicating them, and letting Ollama
handle GPU offload. Modest, and it does not outweigh a third budgeting path.

**The lesson worth keeping:** this was proposed because the provider shape
existed and the apps were installed -- availability, not a measured need. That
is the same reasoning this file exists to argue against.

### FIXED 2026-09-02: chat claims it runs locally even when a cloud provider is answering

**Fixed in `1af6f74`.** The four core prompts dropped the claim; `composeSystemPrompt`
now renders a "Where you are running" section assembled from the provider
actually answering (including a per-run override), and a caller that cannot know
omits it so the prompt makes no claim at all. Four regression tests.

**Seen:** a chat on DeepSeek, asked to confirm the connection, replied "This is
the Anodex assistant running locally on your machine, and the DeepSeek
connection is working fine." The first clause is false -- nothing was running
locally; DeepSeek answered over the network.

**Evidence:** `prompts.ts` opens all four prompts with the claim as a constant --
`CHAT_PROMPT`: "You are Anodex, a local AI assistant running on the user's own
machine", and the same in `COMPACT_CHAT_PROMPT`, `CODING_AGENT_PROMPT` and
`COMPACT_CODING_AGENT_PROMPT`. Prompt choice keys off context size and
compactness, never off `provider.active`, so a cloud run is handed a system
prompt asserting it is local and repeats it on request.

**Why it matters beyond the wording:** "runs locally on your machine" is the
privacy claim the whole app is sold on. Stated by a model whose tokens are
leaving the machine, it is the one kind of wrong answer a local-first tool
cannot afford -- a user who believes it will paste something into a cloud chat
they would not have.

**Where to start:** the identity line has to be assembled, not a constant. The
prompt builder already takes settings; branch the opening sentence on
`provider.active === 'local'` and say plainly which provider is answering when
it is not. The "What Anodex is" section below it stays true either way. Cheap
fix, and it is a prerequisite for named personalities changing the assistant's
displayed name (see the work queue) -- both need one place that assembles who
the assistant is.

### FIXED 2026-09-02: the sidebar model selector hides nine of the eleven cloud providers

**Fixed in `1b118e3`.** Driven off the new `shared/providerCatalog`, so a provider
added there appears without touching the menu. Azure handled as its own case.
Also fixed on the way: with local selected and nothing loaded the menu collapsed
to a dead link even with a provider linked. Five tests.

**Seen:** with a cloud provider linked in Settings -> AI & Models -> Providers,
the model status menu above the user info in the sidebar does not offer it. Only
local models, Claude and OpenAI appear.

**Evidence:** `ModelStatusMenu.tsx` types its quick-switch as
`type CloudProvider = 'anthropic' | 'openai'`, and the dropdown body renders
exactly two provider sections, gated on `anthropicKeySet` and `openaiKeySet`.
The nine others -- google, xai, deepseek, mistral, groq, openrouter, azure,
kimi, qwen -- have no section at all. The file's own header comment admits this
and calls the extension "a reasonable follow-up, not done here".

**Not a labelling bug.** The _footer_ is already correct for all eleven:
`AnyCloudProvider`, `CLOUD_PROVIDER_LABELS` and `anyCloudProviderState` cover
every provider including Azure's `{resourceName, deploymentName}` shape, so an
active DeepSeek shows as "DeepSeek -- <model>". What is missing is the ability
to _pick_ one without going into Settings.

**Where to start:** everything needed already exists.
`ProviderConnectionsPanel.tsx` already enumerates all eleven with a
`SIMPLE_PROVIDER_MODELS` record mapping each id to its curated catalogue
(`GOOGLE_MODELS`, `XAI_MODELS`, `DEEPSEEK_MODELS`, `MISTRAL_MODELS`,
`GROQ_MODELS`, `OPENROUTER_MODELS`, `KIMI_MODELS`, `QWEN_MODELS`). Lift that
record into shared and drive the dropdown from it:

1. Widen `CloudProvider` to `AnyCloudProvider` and `selectCloudModel` to write
   `{ provider: { active: id, [id]: { model } } }` generically.
2. Render one section per provider whose `anyCloudProviderState(...).apiKeySet`
   is true, iterating the shared catalogue record -- no per-provider JSX.
3. Azure is the exception on purpose: its model _is_ the deployment name, so it
   has no list to switch between. Show it as a single selectable row, not a
   catalogue.
4. `useLiveCloudModels` early-returns the catalogue for anything but `openai`,
   so it can be called uniformly; live discovery for other providers is a
   separate question, not part of this fix.
5. `ProviderUsageGauges` is only wired for anthropic/openai
   (`useProviderUsageStore` snapshots). Render gauges where a snapshot exists
   and omit them elsewhere rather than blocking the section on usage data.

**Watch for:** the ordering. With several providers linked the dropdown becomes
long; `sortActiveFirst` orders within a section, but the active provider's
section should also come first.

### DEFERRED: a skill can be pinned or deleted, but not kept and hidden

Anodex will ship with demo skills (currently five), and users create their own.
There is no way to keep a skill and stop it being offered: the options are
pinned, unpinned-but-still-findable, or deleted.

**Most of this already exists, and the scope is smaller than it looks.** A
`togglePinned` control is already in Settings -> Tools & Skills and in Projects
settings, and pinning already gates the expensive path: a skill's instructions
enter the system prompt _only_ when it is pinned to a project
(`runGeneration.ts`, `activeProject.pinnedSkillNames.length > 0`), and
`pinnedSkillNames` starts empty. So shipping five demo skills does **not** put
five skills in every prompt. It puts none there.

What is missing is one flag — "keep this skill, do not offer it" — respected by
`find_skill`, with a checkbox beside the existing pin toggle. One field on the
skill record, one filter in `skillTools.ts`, one control. Not a subsystem.
**Do not rebuild pinning.**

**Do not gate `find_skill` on something being pinned.** It was considered and it
does not work in either state: with nothing pinned the tool disappears and no
skill can ever be discovered, and with something pinned that skill's
instructions are already in the prompt, so the tool's only remaining value is
finding the skills that are _not_ pinned — exactly the ones the gate would hide.
The useful gate is on the store being empty, not on pinning.

**Why it is deferred rather than fixed.** Nothing is broken: the costly path is
controlled, and pin, unpin and delete all work today. The worst case from a
demo skill is a model finding and loading one irrelevant skill — a wasted call,
not a wrong answer.

### FIXED and verified: a small window made re-reading necessary, and the loop guard made it impossible

**Verified, not inferred.** The refused calls in the 4B runs carry exactly one
distinct title each — `Read test_stats.py lines 1-200` refused 181 times, `Read
ledger/money.py lines 1-200` refused 6 times. Same file, same range, every time:
genuine byte-identical repeats, not different ranges being conflated.

**Why the model repeats:** the reads _succeeded_. Calls 5 and 7 both returned
the whole of `stats.py` (25 lines); calls 3 and 8 both returned the whole of
`test_stats.py` (68 lines). At 8,192 tokens those results are evicted within a
turn or two, so the model no longer has what it read and asks again. Rational
given its memory, not faulty reasoning.

**Why that becomes terminal:** reads are marked `rereadable`, so repeats are
normally allowed — but `LOOP_GUARD_ABORT_AFTER` is 6, and once `shouldAbort`
trips the count never decreases. That exact read is refused for the rest of the
run. The model needs the file, cannot retain it, and Anodex stops showing it.

**Not fixed, deliberately.** The obvious remedy — let the read through when the
content is no longer in the window — is the livelock this codebase has already
been burned by: a model that re-reads a file it cannot hold makes no progress
either, it just fails more slowly. `refusedRunReason` now ends these runs in
about five turns, which bounds the cost of the honest answer: _this file does not
fit in this window alongside the work._

**Where to start, if reopening:** decide it from the context budget rather than a
call count — a re-read is waste when the content is still in the window and a
necessity when it is not. `allocateContextBudget` knows the working set; nothing
connects that to the loop guard today.

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

### The gathering deadlock, reopened and fixed (was #10, second half)

The first half — the guard counting its own refusals — was fixed earlier. The
deadlock underneath was left open with an explicit condition: **reopen only with
a run where the model demonstrably needed a refused read to proceed.**

That run happened. A 4B model at an 8,192-token window, on `bench-1`, wrote a
`test_stats.py` with an indentation error and then could not repair it:

- **76** `read_file_range` calls refused with "You have made 34
  information-gathering calls without changing anything"
- editing blind as a result: 2 × "the text to replace was not found", 3 ×
  "line N does not match expectedFirstLine"
- those failures are no-ops, so they never reset the streak, and the refusals
  continued
- the run ended honestly reporting it "cannot access or read the content of
  `test_stats.py` despite its presence in the workspace"

Its `stats.py` was **correct** — verified independently against the tie-break,
all three `ValueError` paths and non-mutation. Only the test file was broken,
and the guard prevented the repair.

**Fixed** by having an edit that fails on a stale view earn one read back.
`StaleFileViewError` is a distinct error type rather than a message match — the
messages are Anodex's own and would rot silently if reworded. The gathering
streak itself is untouched: the credit is spent on the next read, so a model
that goes back to gathering without changing anything is blocked again at once,
and a model that keeps failing edits cannot hold the guard open.

This is not a loosening on a hunch. The guard's premise is that the model
already has what it is asking for, and these errors are Anodex's own evidence
that it does not.

**Worth knowing:** the first wiring missed the catch block that actually runs.
`replace_lines`, `edit_file` and `patch_file` all fail through
`runGuardedToolWithPrepare`, a third catch block, and the ledger tests passed
against unchanged behaviour until an end-to-end test drove the real tool.

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

**Found by reading it instead.** The Start button is disabled whenever the form
is invalid, and said nothing about why. A click on a disabled button does
nothing, submits nothing and logs nothing, which is exactly the report.

**Correction.** The first version of this entry blamed a cleared budget field,
reasoning that `Number('')` is `0`. That is true of a number input, and these
are `RangeControl` sliders with a minimum of 1 and a clamped seed — a budget
cannot reach a blocking value from the form at all. The one reachable cause is a
missing goal, including a whitespace-only one, which looks filled in. The budget
checks are kept as defence for programmatic callers and are documented as such.

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
- ~~**The multi-language fixes.**~~ **Validated in production 2026-08-31.** The
  `bench-5` Rust runs produced seven `search_files` / `code_outline` /
  `find_files` calls against `.rs` sources, and `code_outline` answered with the
  new message verbatim: _"No JavaScript or TypeScript files here, and
  code_outline maps only those…"_ Before the fix that same call said "No source
  files found" — telling a model with a Rust file in front of it that the
  project had no code.
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

- **Completion rate, measured by plan steps.** Of 43 stored runs: 19 finished
  with a complete plan, 10 never finished, and **14 finished with plan steps
  still open**. All 14 stopped voluntarily with more than 20% of every budget
  left — most with 70–99% of their tokens unspent — and every one showed the
  same pattern: **exactly one open-step refusal, then an accepted finish.** The
  warning was delivered 14 times and closed a plan 0 times.

  The obvious remedy is to make that warning persist until something changes.
  It was built, tested, and **reverted before shipping**, because it is
  contradicted by other evidence in this file: `update_plan_step` works and
  models simply stop calling it, so an open plan step is not evidence the work
  is undone. The run that finished 1/7 had done much of its work. Pressing
  harder would refuse correct runs on data already known to be unreliable, and
  `agentTools.test.ts` marks that boundary explicitly — "the bar this must not
  raise".

  **The deeper finding is that plan completion does not measure completion.** It
  measures bookkeeping the model performs inconsistently. Anodex cannot know a
  task's real success criteria, so it cannot measure completion in general —
  which is why the work went into reporting honestly instead.

  **Reopen with:** a measurement that separates "work not done" from "step not
  ticked", by checking the workspace against each open step. Without that
  separation, any pressure applied at `finish_goal` is applied blind.

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

## Email, chat and context — 2026-09-02

Measured with `scripts/chat-matrix.mjs` (`--script`/`--criteria` for email) and
the autorun harnesses. What was fixed is in git; these are the ones left.

- **Two local transports, separate budget rules.** `LlamaService`
  (node-llama-cpp) and `LlamaVisionService` (llama-server, used by any model
  with an mmproj — including the 27B). They size the native tool surface with
  different functions: `toolSurfaceBudgetTokens`-style measurement against the
  shared allocation on one, `max(900, contextSize * 0.18)` on the other. A
  result measured on the 27B says nothing about the path `LlamaService`
  governs, and vice versa. Not unified because the two measure different
  things — one counts prompt plus schemas through the real tokenizer, the other
  estimates schema JSON — and reconciling them is a change worth making
  deliberately with both benchmarks green, not in passing. Check
  `[llama:vision]` vs `[llama]` in a log before attributing any result.

- **Tool-discovery thrashing on weaker models.** With most of the catalogue
  deferred at 8K, models that cannot find `find_available_tool` loop on whatever
  they can see. Measured on devstral-24B running the email script: 135 calls in
  a single turn, and in a later run 24 calls of `find_skill` ending in "I cannot
  find a skill to search for an email by subject" while `search_email` sat one
  gateway call away.

  Seen again 2026-09-05, same model and script: six identical
  `list_email_accounts` calls in one turn until the loop guard stopped it, and
  the run ended at turn 2 of 7.

  **Checked as an Anodex bug and it is not one.** `boundToolSurface` seeds its
  selection with the gateway (`selected = { ...gateway.functions }`), so
  `find_available_tool` was in the surface the whole time and the model never
  called it. The loop guard did fire, correctly, with a message naming the
  repetition.

  What _was_ Anodex's was the diagnosis: the `Tool surface routed` log printed
  only `directToolNames`, so it read "direct: [4 tools], deferredCount: 22" and
  looked exactly like a model stranded with no way to reach the other 22. Fixed
  — the line now names the gateway tools separately, because "could not
  discover" and "did not try to discover" are different faults and only one of
  them is ours.

  The remaining behaviour is the model's. `find_skill` already says skills are
  not tools and names `find_available_tool`; the effect of that redirect is
  still **unmeasured**, and single-run comparison of a high-variance model is
  noise. Needs repeats before anyone claims it helped.

- **A 4B stopped calling `anodex_status`.** qwen4b answered "I don't have
  access to your schedule or task list right now" while the tool was resident —
  confirmed resident by the new tool-surface log line, so it is behaviour, not
  availability. Scored 10/10 on the same script in other runs. Left alone: no
  fix suggests itself that is not a prompt nudge aimed at one model.

- **Email tools never exercised:** `move_email`, `batch_email`,
  `read_email_attachment`. The first two relocate real mail in bulk and were
  not run against a live mailbox on judgement; the third simply has not been.

- **Critical Thinking is unverified end to end.** It plans, approves, runs
  every step, records the run and reports honestly that it finished without a
  fetchable source — but has never been observed producing a report on this
  machine, because SearXNG is down and starting it needs a password. Two bugs
  found while testing it are fixed (`6eaf28a`, `cbd9113`); the surface itself
  still needs one clean run.

- **The search backend, not Anodex, is bounding Critical Thinking quality.**
  Measured 2026-09-04 on this machine: a general-intent query returns 0 results
  (brave, duckduckgo, google cse and startpage all rate-limited or CAPTCHA'd);
  a scholarly-intent query returns 10 results, **all 10 from arxiv.org**, with
  six engines unresponsive including both scholar engines. Runs 53-61 therefore
  researched a consumer heat-pump retrofit question -- needing manufacturer
  datasheets, AHRI listings, tariffs and owner complaints -- against an
  arxiv-preprint-only corpus, and the coverage assessment reported
  `insufficient` on 100% of rounds. Reading the rationales, **it was right every
  time**.

  The invisibility is now fixed (`SearchOptions.onDegraded`): a degraded search
  is reported on the round's search activity instead of reading as an absence
  of evidence. The underlying search is not, and cannot be from inside Anodex --
  SearXNG has no index of its own and scrapes from the user's IP. It needs an
  API-backed provider (Brave, Google and Tavily are all already supported) or
  for the rate limits to clear.

  **This still qualifies every Critical Thinking quality number measured on
  2026-09-04.** The budget, verdict, chooser and recovery fixes rest on
  arithmetic, unit tests and a 48-run replay and stand on their own; the report
  quality those runs reached is bounded by an arxiv-only corpus and should be
  re-measured once the backend serves the general web again.

- **The coverage assessment never returns `sufficient`.** Across the last six
  Critical Thinking runs: 56 assessments, **0 parse failures, 0 `sufficient`,
  56 `continue`**. Every step therefore spends its full round budget rather
  than stopping when it has enough.

  Checked as an Anodex defect first, and it is not one. The parser accepts the
  token (`validVerdict`), the gate permits it
  (`verdict === 'sufficient'`, no answer-blocking gaps, two verified sources),
  and the prompt argues against over-strictness in as many words: "Judge the
  evidence you have, not the evidence you could imagine. A step is answered
  when a careful reader would accept the finding, not when nothing further
  could be learned... optional follow-up literature is not, by itself, a reason
  to continue." Nothing is being discarded — zero parse failures means the
  model is genuinely choosing `continue` each time.

  It is also not stuck. With the search backend fixed, `evidenceBasis` moved
  from 100% `insufficient` on the arxiv-only runs to mostly `multiple-sources`
  on run 62, so the model is responding to better evidence; it just will not
  declare a step closed while it can still name something it wants.

  Left alone because the only available fix is a prompt nudge aimed at one
  model's judgement, and the cost is unproven: run 62 completed all seven steps
  and produced the best report on record while never returning `sufficient`.
  Worth revisiting if a run is ever seen exhausting its round budget on a step
  that was plainly answered.

- **A tool result can consume the room the reply needed, and recovery does not
  rescue it.** Measured 2026-09-05 at 8,192 on qwen27b, twice, on the email
  script's last turn:

      TURN 7/7 | 34s | 0 chars | 2 call(s) | stop=context-limit | tools: read_email
      fixedTokens 6,015 -> 6,313 -> 6,388   gate 6,697 (7,680 - 983 reserved)
      epoch: 0

  The turn fit until `read_email` returned; its result took the remaining room
  and the turn ended before the model wrote anything. The user is not left with
  silence — `describeGenerationStop` renders "This reply ran out of context
  space while working" — but they do not get their answer.

  The same shape ended the hard chat rubric's turn 12 in one of three runs, so
  it is not specific to email.

  `boundedChatRunner` has context recovery for exactly this, and it did not
  fire: `epoch: 0` throughout. The likely cause is `recoveryChurnDetected`,
  which blocks recovery after consecutive cycles that produced no novel
  content — correct in itself, since a run that recovers repeatedly without
  progress should stop, but it means the _first_ such turn gets no compaction
  either.

  Not fixed. The agent received the same recovery today and it needed a
  progress-based bound to stop it grinding (`FRUITLESS_EPOCH_LIMIT`); doing the
  equivalent surgery on chat's churn detection is a delicate change to the
  surface with the most traffic, and it deserves its own session with room to
  measure repeats. **It does not occur at 65,536**, where the fixed input is a
  fraction of the window — so for anyone running the context their hardware
  supports, this is invisible.

  Worth noting what it cost in measurement terms: `handles-a-bad-id` reported a
  _consistent_ failure across both passes, which reads as "this model reliably
  invents a message for a bad id" when the model never got to speak. The rubric
  now reports that turn `N/A` rather than `FAIL`.
