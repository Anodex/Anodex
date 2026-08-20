# Context OS Decision, Implementation, and Benchmark Handoff

## Status and purpose

This is the current handoff for the proposed Anodex Context OS. It began before implementation and
now records the first reviewable implementation slice and the work that remains before any default
change.

The user approved starting the work only after a durable handoff and a benchmark plan exist. The
goal is not to add another context patch. The goal is to determine, with evidence, whether a single
adaptive context system is better than Anodex's current projection path across constrained local
machines, larger local installations, vision models, and cloud providers.

### Implementation record — 2026-08-18

Implemented in the working tree, not yet promoted as the default:

- [x] Added the central `current` / `adaptive-v1` context-assembly strategy selector. Missing or
      unknown persisted values select `current`, which remains the shipped default and immediate
      rollback path.
- [x] Added the opt-in **Context assembly** setting under AI & Models. It changes only automatic
      supporting-context selection; it does not remove tools, skills, project rules, model choices,
      attachments, permissions, or canonical history.
- [x] Added a pure shared automatic-reference packer for workspace context, durable memory, and
      transcript recall. In `adaptive-v1`, those sources share one capacity-scaled allowance; unused
      allocation is deterministically redistributed. Existing retrieval and scope rules remain the
      source of relevance decisions.
- [x] Added bounded, content-free per-generation assembly reports and persisted them with assistant
      results, including every provider cycle in a bounded multi-cycle reply.
- [x] Added optional SHA-256 canonical-prefix fingerprints to new stateless ledger revisions. A
      matching snapshot still replays as before; a changed prefix rejects that derived snapshot and
      rebuilds from durable raw history. Legacy revisions remain valid.
- [x] Added focused coverage for the strategy fallback, constrained shared packing,
      redistribution, settings validation, and stale-snapshot recovery.
- [x] Ran typecheck, lint, formatting check, the full unit suite, production build, end-to-end
      suite, and `git diff --check` on this implementation tree. The full unit suite passed 3,287
      tests (one intentionally skipped), and the end-to-end suite passed 7 tests. Keep the exact command
      output with the implementation session rather than treating this summary as a live-model result.

Not completed, intentionally:

- [x] Ran the initial live local-vision benchmark batch recorded below. It establishes concrete
      regressions and a rollback decision; it is not sufficient evidence that `adaptive-v1` is
      better.
- [ ] No default change, automatic migration, or persisted-conversation rewrite has occurred.
- [ ] Cross-provider live capacity calibration and the wider local/vision/cloud matrix remain
      required before promotion.
- [ ] Local-session/manual-compaction revisions retain their proven legacy behavior. The new
      fingerprint check currently protects newly written stateless revisions; extend it only with
      matching tests and without destabilizing the local session path.

### Initial live benchmark record — 2026-08-19

**Decision: keep `current` as the default. Do not promote `adaptive-v1` from this batch.**

This batch used the exact black-screen task from the frozen benchmark, but never modified the
user's live `C:\Users\Owner\Desktop\Test Website` directory or the frozen conversation. The
fixture was a disposable copy at:

    C:\Users\Owner\Desktop\Anodex Context OS Benchmark 20260818\Solar System Fixture

Before each run, its `index.html` and `js\universe-sandbox.js` were restored from the fixture's
`Baseline Snapshot`. Every trial used a fresh Anodex chat in the `Solar System Fixture` project,
the same task text, the loaded local **Qwen3.6-27B-Q4_K_M vision** model, GPU `Auto`, temperature
`0.30`, top-p `0.90`, and Untethered permission mode. The active model was reloaded after each
context-size change. At the end of the batch, the user's original configuration was restored and
confirmed loaded: `adaptive-v1`, 16,384 tokens, GPU `Auto`, Qwen3.6-27B-Q4_K_M vision.

Static success required all of the following after the model completed:

1. `node --check js\universe-sandbox.js` succeeds.
2. `index.html` no longer loads `universe-sandbox.js` as a module and it loads
   `three.global.min.js` and `OrbitControls.global.js` first.
3. `universe-sandbox.js` has no top-level ES-module import and binds OrbitControls from the
   global Three namespace.
4. The two global scripts establish `THREE` and `THREE.OrbitControls` in a Node VM contract
   check.

For a rendering claim, static checks were not enough: a successful `inspect_visual` result was
also required. The model's prose claiming it opened a page was not counted as visual evidence.

#### 16K matched local-vision trials

| Strategy      | Fresh conversations                                                                                                          | Static result | Visual result | What happened                                                                                                                                                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current`     | `c_6c79191f-fb94-47ce-a991-8bfb9fe7d5b7`, `c_de692230-a075-4d03-8913-65aef8b51959`, `c_2a3ca3b2-e119-45fe-99aa-7b2bfc179707` | 2 / 3 pass    | 2 / 3 pass    | The two passes completed the global Three conversion and each successfully used `inspect_visual`. The third made no fixture changes because the local vision backend returned HTTP 500 while serializing an unpaired emoji surrogate from HTML input. That provider serialization defect is not an overflow result. |
| `adaptive-v1` | `c_7208f450-ecdb-4004-9c00-56a223f0f72d`, `c_0ca21261-3789-4e79-8d70-d74437eb4390`, `c_59468bca-391e-4ac6-ba72-edfdee73f33b` | 2 / 3 pass    | 0 / 3 pass    | One failure removed the module imports but left the bare `OrbitControls` reference, so the global wiring was incomplete. The two static passes did not call `inspect_visual`; their self-reported launch claims therefore receive no visual-completion credit.                                                      |

The successful `current` trials took about 164 s and 245 s; the successful adaptive static trials
took about 302 s and 132 s. That variation is too large and the sample is too small to make a
speed claim. Most importantly, adaptive did **not** improve verified completion (0 / 3 versus
2 / 3) or static success (the same 2 / 3).

`adaptive-v1` did demonstrate the intended shared-source accounting at 16K: its cycles reported
roughly 3.5K–4.2K automatic-reference characters against a 5.1K-character allowance, split
between workspace context and transcript recall. That is diagnostics evidence, not outcome
evidence; it does not outweigh the missing visual verification or the wiring failure.

#### Constrained-capacity probes

| Effective context | Strategy      | Conversation                             | Result                                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ------------- | ---------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4,096             | `adaptive-v1` | `c_44ca5ac1-a1b4-4b2c-a027-9009437a1999` | Failed before generation; fixture remained baseline. | The runtime reported that fixed instructions and active tool definitions needed 2,658 tokens while only 3,584 fit before reply space, after deferring 53 tools. Budget record: system 1,924, task 22, tool schemas 729, fixed 2,658, reserve 512; the reported effective maximum output was incorrectly still 4,096. The planner nevertheless included 3,918 automatic-reference characters (workspace 2,447 + recall 1,471).                                                          |
| 8,192             | `adaptive-v1` | `c_630be9c8-c642-447c-90a1-16577eb37b2c` | Failed; fixture remained baseline.                   | Seven assembly cycles used 3.37K–3.68K automatic-reference characters. The final context meter was 7,791 / 8,192 (95%), with 2,469 system tokens, 1,242 compact tool-schema tokens, 3,568 recent-history tokens, and 512 reserved. The model made 24 successful read calls, repeatedly reread `index.html`/the sandbox, made no edit or visual inspection, and Anodex stopped the reply for repeated actions without progress. Stats: 4,123 generated tokens, 180,564 ms, 22.83 tok/s. |

The 4K result is a **capacity-accounting defect**, not a reason to remove user capabilities. The
assembly boundary must reserve a realistic minimum reply budget from the actual input limit before
it admits automatic workspace/recall material. If fixed system, explicit instructions, current
task, and available tool schemas consume the usable window, the automatic pack must shrink to zero
and report that fact. It must never claim an output ceiling larger than the effective capacity.

The 8K result is a **continuity/decision-quality defect**, not a reason for a broad read ban. The
model had already identified the root cause and the needed global files, but later turns did not
receive a compact, actionable settled-facts/next-action handoff strongly enough to move from
inspection to edit and verification. Preserve legitimate rereads after a file changes; improve the
derived handoff so repeated unchanged evidence is recognizable and the next actionable choice is
clear. The existing no-progress stop is useful as a last resort, but stopping after 24 harmless
reads is not a successful recovery.

#### Limits of this batch

- This is a real-model regression batch, but not a statistically qualified promotion comparison.
  Trials were fresh chats yet shared one fixture project, so cross-chat recall may have included
  prior trial material. Future paired trials must use one freshly created project per trial (or
  explicitly empty recall) as well as a freshly restored fixture.
- The configured application had no cloud or compatible provider credentials. No cloud run was
  attempted, and no synthetic credential/configuration was added.
- The active model was vision-capable. A separately loaded local-text-model lane and a 32K+ lane
  have not yet been qualified. A 2K probe was deliberately not run: the measured 4K fixed prompt
  already leaves too little room to satisfy the product's minimum reply requirement.
- These runs do not alter the 16K frozen conversation baseline. Their conversation files are
  durable diagnostic records under `C:\Users\Owner\AppData\Roaming\anodex\conversations\p_msznqc2b_or81v`.

#### Required correction before the next live batch

1. Make the planner use a single exact-capacity contract: effective input limit minus fixed
   rendered cost minus a bounded minimum useful reply reserve equals the only automatic-reference
   allowance. Clamp reported maximum output to that same contract.
2. Feed the current attempt's durable objective, settled diagnosis, changed-path state, and next
   unresolved verification into every provider cycle in a bounded derived handoff. Do not use
   keyword/model/provider branching or a blanket reread prohibition.
3. Add focused tests for 4K/8K fixed-cost pressure, zero automatic allowance, output clamping,
   and an unchanged-evidence multi-cycle handoff. Preserve every tool's discoverability and the
   current rollback setting.
4. Re-run three clean 16K pairs, an 8K pair, and the constrained 4K truthful-pause case using
   isolated projects/fixtures. Then run local text, 32K+ if a model can load it, local vision, and
   each provider actually configured by the user. Do not promote until verified task completion,
   recovery quality, and no capability regression all hold.

### Correction record — 2026-08-19

Corrections 1–3 above are implemented. Correction 4 — the live re-run — is the remaining work, and
nothing here changes the default: `current` is still the shipped strategy.

**The capacity contract (correction 1).** `automaticReferenceAllowanceChars` in
`src/shared/contextPlanner.ts` is now the only source of the automatic-reference allowance. It
subtracts the reply reserve, the measured fixed prompt, the tool schemas, and the working-set floor
(`MIN_WORKING_SET_FRACTION`, the same constant the allocator already uses) from the real window, and
caps the result at the window's normal reference ceiling. It can only shrink the previous allowance,
never grow it: where there is room the cap binds and nothing changes, and where the fixed prompt has
already outgrown the window the allowance is zero and every source reports `deferred`.

`runGeneration` now composes the system prompt twice. The first pass prices everything the user
chose — rules, style, skills, plan, the request, the capped epoch handoff, the continuation brief —
with no automatic material in it, and that measurement is what the contract plans against. The
previous implementation budgeted against a fraction of the window regardless of what was already in
the prompt, which is how the 4K probe admitted 3,918 characters into a prompt with no room for them.

**The derived continuation handoff (correction 2).** `src/main/chat/continuationBrief.ts` renders the
task's settled state — objective, changed paths, the files already read and how many calls that took,
and the one outstanding verification — into the protected system segment of every continuation cycle
after the first. It is suppressed when a `ContextEpochHandoff` is present, which already says the same
thing in fuller form. Every field is derived from settled tool calls; none of it reads the model's
prose or the user's wording, and there is no reread prohibition — the 8K probe's rereads were a
symptom of not knowing what was already covered, not the fault itself.

**Whole-unit selection and truthful provenance.** The packer no longer truncates. Each source now
offers ranked indivisible units — one memory entry, one recalled conversation, the workspace summary
and its project-activity block separately — and the packer takes whole units in rank order or none at
all, which is what lets a source contribute nothing when there is no room for it. `memoryUsed` and
`transcriptRecallUsed` are sliced to the units that actually reached the prompt, so the provenance the
UI shows can no longer credit the reply with entries the packer deferred.

Sources start on an equal share of the allowance and hand back what they cannot use, in the order
workspace → memory → recall. Equal rather than tuned, deliberately: a fixed split would be a constant
fitted to whichever chat it was measured on, which this document's own anti-pattern list rules out.

**Reporting fix found while reviewing the 4K record.** The "effective maximum output was incorrectly
still 4,096" note above was a real defect, not a planner artifact:
`LlamaVisionService` initialised `effectiveMaxTokens` to the _requested_ ceiling and broke out of the
round loop on fixed-context exhaustion before ever computing the real one. It now reports the ceiling
the turn actually had.

**Deliberate gaps, so the next agent does not read them as oversights.**

- The stateless ledger fingerprint is written and checked regardless of the assembly strategy.
  Selecting `current` rolls back context _selection_, not derived-history integrity; the two are
  independent, and making a persisted integrity field come and go with a UI setting would be worse
  than either state. Phase 3's remaining item — extending fingerprint _writing_ to the local-session
  and manual-compaction paths — is unchanged and still open.
- `compactHistoryForSession` on the local path discards `seeded.stale`, so a stale rejection there is
  correct but silent. Left alone: the local path never writes fingerprints, so it can only be reached
  by a conversation compacted under vision/cloud and then continued locally, and the behaviour on
  rejection (rebuild from canonical history) is already right. It is a missing diagnostic, not a
  missing guard.
- The assembly reports are persisted on assistant messages and still have no reader. A diagnostic
  view is worth building before the next live batch, so evidence does not have to be recovered from
  conversation JSON by hand.

Gates run in this tree after the changes: `npm run typecheck`, `npm run lint`, `npm run format:check`,
`npm run test` (3,307 passed, 1 skipped), `npm run build`, `npm run test:e2e` (7 passed).

### Post-correction run — 2026-08-19, 16K local vision

One run, `adaptive-v1`, 16,384 tokens, on the `Solar System Fixture` project. Conversation
`c_630be9c8-c642-447c-90a1-16577eb37b2c` (the id is reused; the file now holds a fresh two-message
conversation, not the earlier 8K probe). Confirmed to be the corrected build: every assembly report
carries the `capacity` block and per-source unit counts, which only the corrected planner emits.

**Not a qualified comparison.** One trial, no control lane, and a 16K window rather than the 8K one
whose failure the continuation brief was built for. It is a smoke test of the corrections and a
source of one new defect, nothing more.

The capacity contract behaved exactly as designed at this size. Across all ten cycles the allowance
was 5,100 characters — the window's reference cap, which binds at 16K — against a measured fixed
prompt of 886–1,722 tokens and a 1,820-token schema reserve. Every source reported `allocated` with
zero characters omitted, so at 16K `adaptive-v1` now injects what `current` would. That is the
intended shape: no change where there is room, change only where there is not.

Run record: 86 tool calls (32 reads, 27 searches, 11 commands, 3 outlines, 5 successful edits, 4
failed edits), 17,650 generated tokens, 694 s, 10 cycles. The model reached a specific diagnosis and
made five successful edits to `index.html` and `js/universe-sandbox.js` — against the earlier 8K
probe's 24 reads and zero edits, though the window differs and one run proves nothing on its own.

**The task still failed, and the static criteria did not catch it.** All four static checks pass:
`node --check` succeeds, the globals load first, there is no top-level import, and a Node VM check
establishes `THREE` and `THREE.OrbitControls`. Rendering the fixture over a local server shows the
page is still black:

- the canvas the model appended to `#sandbox-container` has a client width of **0**, because
  `container.clientWidth` was 0 when the script ran;
- the visible `#sandbox` section's own `#sandbox-container` — the second element with that id —
  received no canvas at all, because `getElementById` returns the first;
- the model's stated root cause, that `document.getElementById('sandboxCanvas')` refers to an element
  that does not exist, is **false**: `<canvas id="sandboxCanvas">` is at `index.html:47`.

The reply closed by reporting the fix as working, on the strength of having re-read the file it had
just edited. This is the exact failure the benchmark's visual-evidence rule exists to catch, and it
confirms that static criteria alone cannot score this task.

**Why verification did not happen, from the record.** The model tried to serve the fixture with
`python -m http.server 8000`; Anodex correctly refused it as a command that never exits. It then
thought and said "I'll use `preview_html` to check the visual result instead" — and emitted no tool
call at all. `inspect_visual` was never called in the whole run. The turn then ended on the gathering
ladder refusing one further call. None of that is context assembly. It is a model that announces a
verification and does not perform it, which is the most repeated failure in this whole record: the
frozen 16K baseline, all three original `adaptive-v1` trials, and now this run.

**Correction made in response.** The continuation brief was silent in precisely this state. Its
outstanding-work line covered a change made _after_ an inspection, and a task that had changed
nothing yet — but said nothing about a change that nothing had ever checked, because "no inspection
has run" is indistinguishable from "this task is not about pixels" until you also know something was
changed. `hasVerificationOfChange` in `turnSummary.ts` now answers that question once, and both the
user-facing closing account and the model-facing brief read it. The brief now says plainly that
re-reading an edited file is not verification.

Two smaller observations, recorded rather than acted on:

- Four edits failed on stale text or stale line numbers against `js/universe-sandbox.js`, the
  guarded-edit-failure pattern already in this project's history. Worth a look, separately.
- `node` is deliberately not in `BUILD_OR_TEST_TOOLS`, so `node --check` does not count as
  verification. That is right in general — running a script is not checking it — but it does mean
  this fixture's own static criterion would not satisfy the brief. Do not widen the list to fix one
  benchmark.

### Paired 8K batch — 2026-08-19

**Decision: unchanged. `current` remains the default, and this batch does not qualify
`adaptive-v1` for promotion — but not because adaptive lost. Because the mechanism under test
never engaged.**

Six trials, alternating lanes, 8,192-token window, local Qwen3.6-27B-Q4_K_M vision, temperature
0.30, top-p 0.90, GPU Auto, Untethered. Run in a **freshly created project** (`Bench Fixture 0819`)
over a clean copy of `Baseline Snapshot`, restored between every trial. The fresh project matters:
it gives this batch an empty transcript-recall pool, so no prior attempt at the same task could be
recalled into it — the contamination the first batch explicitly flagged. Conversations are archived
under `Anodex Context OS Benchmark 20260818
uns\`, with each trial's fixture end-state beside it.

| Trial | Lane          | Cycles | Tools | Sec | Writes | Visual | Static |
| ----- | ------------- | ------ | ----- | --- | ------ | ------ | ------ |
| 1     | `current`     | 8      | 31    | 259 | 2      | 0      | 2 / 4  |
| 2     | `adaptive-v1` | 4      | 13    | 100 | 3      | 0      | 3 / 4  |
| 3     | `current`     | 8      | 29    | 220 | 2      | 3      | 3 / 4  |
| 4     | `adaptive-v1` | 9      | 33    | 229 | 2      | 0      | 3 / 4  |
| 5     | `current`     | 22     | 83    | 571 | 6      | 0      | 3 / 4  |
| 6     | `adaptive-v1` | 12     | 39    | 276 | 1      | 0      | 2 / 4  |

**Verified completion: 0 / 6.** Static criteria: `current` 2, 3, 3; `adaptive-v1` 3, 3, 2 — the same
mean, from opposite ends. No trial passed all four, so no render check was warranted: a claim of
success needs visual evidence, a static failure does not.

#### The finding that matters

The automatic-reference allowance **never bound in any adaptive cycle**. Allowance ran 4,368–4,912
characters while the sources only ever offered 2,778–4,046. The capacity contract therefore removed
nothing, and both lanes fed the model near-identical automatic context — 3,515–4,037 characters
under `current` against 3,520–4,046 under `adaptive-v1`. Whatever varies between these six runs, it
cannot be attributed to context budgeting, because the budget was not the binding constraint in a
single cycle.

The cause is in the report itself. The planner priced the fixed prompt at **886 tokens** while the
transport measured **2,533–2,600** system tokens for the same turns. Subtracting the automatic body
(~880 tokens) leaves roughly **770 tokens unaccounted** — about 9% of the whole window. Two things
make it up: the section headers and preambles `composeSystemPrompt` wraps around each reference
block, which exist only because material was admitted, and the chat-template framing the transport
adds. The first is exactly measurable before generation; the second is not.

Priced correctly, the allowance at 8K would land near 1,300 characters against the ~3,520 actually
injected — a real constraint rather than a cap that never binds. That is the next change, and until
it lands an 8K comparison of these two strategies cannot answer anything.

#### What actually failed the task

Not context. Four of the six runs left `new OrbitControls(...)` as a bare unbound reference after
correctly stripping the ES-module imports — `OrbitControls` is not a global, only
`THREE.OrbitControls` is. That is the identical incomplete-wiring failure the first batch recorded
against `adaptive-v1` at 16K, and it appeared here in both lanes. Trial 2 instead duplicated a
`(function() {` and broke `node --check`; trial 1 never edited the JS at all.

Verification remained the other constant. Only trial 3 called `inspect_visual`, three times, and its
closing account correctly reported visual verification. Every attempt at `preview_html` on this
fixture failed with **"Preview is too large after inlining local assets."** That is a tooling
blocker on a static site with local vendored libraries, independent of the context system, and it
removes the cheaper of the two verification routes on exactly the kind of project this benchmark
uses.

#### Limits of this batch

Three trials per lane at temperature 0.30 cannot resolve a small effect, and no effect should be
claimed from the wall-clock or tool-count spread — `current` ran 220–571 s and `adaptive-v1`
100–276 s, but adaptive also did less work in those runs. The single defensible conclusion is the
negative one: the capacity contract did not engage, so this batch does not compare the two
strategies at all.

### Capacity matrix — 2026-08-19/20, local vision, three windows

**Recommendation: keep `current` as the default for now. `adaptive-v1` has earned its place on
constrained windows and is measurably inert above them, but the cloud, local-text and 32K+ lanes are
untested and this document requires them before a default change.**

Nineteen live runs on the loaded Qwen3.6-27B-Q4_K_M vision model, temperature 0.30, top-p 0.90, GPU
Auto, Untethered, 40-minute turn cap. Every trial ran in the freshly created `Bench Fixture 0819`
project over a copy of `Baseline Snapshot`, restored between runs, so the transcript-recall pool
began empty and no prior attempt could be recalled into a later one. Conversations and per-trial
fixture end-states are archived under the benchmark folder's `runs4k`, `runs8k` and `runs16k`
directories.

| Window | `current`                          | `adaptive-v1`                     | Allowance behaviour      |
| ------ | ---------------------------------- | --------------------------------- | ------------------------ |
| 4,096  | **cannot start**                   | runs, 5 calls, honest pause       | binds hard — allowance 0 |
| 8,192  | 0 completions in 4 runs            | 0 completions in 3 runs           | binds late, marginally   |
| 16,384 | **completes, screenshot-verified** | **completes, code-verified only** | never binds — cap holds  |

#### 4K — the case the contract exists for

`current` refuses the turn outright: fixed input 2,672 tokens of a 3,584 limit, leaving 912 to reply
in, below the floor for one tool call. `adaptive-v1` on the same window runs: fixed input 2,196,
leaving 1,388. The whole difference is the automatic reference material — `current` injects 3,806
characters (workspace 2,292, recall 1,514), `adaptive-v1` injects **0**, and `systemTokens` falls
from 1,938 to 1,127. That 811-token gap is exactly the injected material, and it is the difference
between a window that can seat a turn and one that cannot.

Against this lane's stated bar: no crash, no fixture corruption, all 42 tools still reachable (7
active, 35 deferred — the same 42 as at 8K, nothing stripped to make the prompt fit), and a pause
that states its own state truthfully. Both sources reported `deferred`, not `unavailable` — material
existed and was refused, which is the contract working rather than nothing being available.

#### 8K — a documented negative, and not a defect

Seven runs across both lanes, zero completions, every one stopped by the recovery-churn guard. The
cause is arithmetic rather than context selection, and it is worth recording so nobody re-runs this
lane expecting a different answer.

Each cycle begins at roughly 3,700 fixed tokens and reaches 5,900 within two to four tool rounds
against a 6,073 proactive limit. A cycle therefore affords two to four calls. Re-acquiring the
two-file working set consumes them, the epoch rotates, and the handoff that survives carries an
evidence _index_ — tool, label, size — not content. The model re-reads from the same opening moves
(`List js` four times, `index.html lines 1-200` four times, `universe-sandbox.js lines 1-200` three
times in one run), the guard sees no novel read identity, and two consecutive read-only post-epoch
cycles end the reply. It never holds the file contents and the room to act at the same time.

Three candidate faults were checked and cleared with evidence rather than assumption:

- **Tools.** 36 successful reads in the audited run: zero empty, zero collapsed to evidence
  descriptors, zero truncated stubs, 301–2,001 characters each. Every repeated call returned real
  content.
- **The task ledger.** Zero refusals in all seven runs. The loop guard and the gathering ladder never
  fired.
- **The churn guard.** A change to scope its read-identity set per epoch was written and reverted: it
  broke three tests that pin a prior live failure of thirteen epochs re-reading two ranges. The guard
  is correct, and an early honest stop is better than twenty-four cycles reaching the same place.

The same task completes at 16K, so this is a working-set limit for this task and tool surface, not a
context-assembly failure. Neither strategy moves it, and the packer fix below — verified to raise
allowance utilisation from 63% to 91% — changed nothing here.

#### 16K — both lanes complete

`current`: clean finish, 7 cycles, 4 writes, two visual inspections, all four static criteria, and a
screenshot showing the Sun, eight labelled planets, orbit paths, Saturn's rings, asteroid belt and
starfield. The fix was `new OrbitControls(...)` to `new THREE.OrbitControls(...)`, the one-line
binding every earlier run missed.

`adaptive-v1`: clean finish, 9 cycles, 7 writes, all four static criteria, an equivalent fix
(`const OrbitControls = THREE.OrbitControls` bound at the top). **It took zero visual inspections**,
so by this document's own standard its completion is unverified — the code is right, and it never
checked. Independent measurement from a 1280x800 viewport found `THREE` and `THREE.OrbitControls`
present and the canvas live at 1265x800 with a working WebGL context and no console errors, but the
browser pane failed before a screenshot could be captured. Treat it as strong indirect verification,
not a verified completion.

The allowance sat at 5,100 characters — the window cap — on all nine cycles while the sources offered
3,577–4,609. The contract never bound once, so both lanes fed the model near-identical context and
the differences between these two runs are variance.

#### The static criteria are not sufficient to score this benchmark

An 8K `current` run passed all four static criteria on a page that still rendered black. The 16K run
passed the same four and renders correctly. Only the screenshot separates them. Any promotion
decision resting on the static gate alone would be resting on a false signal; the visual requirement
in this document is load-bearing and must not be relaxed for convenience.

#### Corrections to earlier records in this document

- The claim that the fixed 4:1 characters-per-token ratio caused roughly two thirds of the
  fixed-prompt undercount was **wrong**. It divided a reconstructed character count by a measured
  token count from a different run. Matched pairs put the real ratio at **4.08–4.26** — slightly
  above 4, so the fixed constant was mildly conservative, not optimistic. The undercount was almost
  entirely the uncounted section framing, now measured at 1,337 characters for a three-section prompt
  and corrected (`fixedPromptTokens` 886 to 1,157).
- A falling `automaticReferenceIncludedChars` was read as the contract binding. A `current` run with
  no contract at all swings 4,017 to 2,114 to 3,538 on its own, because the retrievers themselves
  return different amounts as workspace activity and the recall pool shift. Only `included` sitting
  _at_ the allowance is evidence of binding.
- `madeProgress === false` was used as a proxy for "the model is repeating". The churn guard keys on
  call _identity_, not content novelty; the two disagree, and the identity signal is the one that
  fires.

#### Fixes this batch produced

All are committed on `context-os-adaptive-v1`, each independently revertible.

- **Section framing priced.** `composeSystemPrompt` wraps each reference block in a heading and
  preamble that exist only because material was admitted. Leaving them out of the fixed-prompt price
  understated it by 1,337 characters.
- **Packing no longer strands the budget.** An equal share per source let small units beat large ones:
  at an allowance of 3,372 the workspace summary fitted its share and its activity block did not,
  recall packed all three of its small blocks, and 1,258 characters were left unusable — 2,114 of
  3,372 spent, for fifteen consecutive cycles. Now one unit is guaranteed to each source, then a
  priority-order fill. Verified live at 63% to 91% utilisation with the workspace kept whole.
- **Outstanding verification survives an epoch.** The continuation brief was suppressed for the entire
  remainder of a reply after the first epoch, because `contextEpoch` is assigned once and never
  cleared. At 8K, with sixteen epochs in nineteen cycles, the brief reached the model at most once.
  The epoch handoff now derives the same claim from the same settled calls.
- **A turn that cannot start explains itself.** The refusal read "need 2,672 tokens, but only 3,584
  fit" — the smaller number second, self-contradictory, and silent about the 912 tokens that actually
  ran out.
- **The reply ceiling is reported honestly.** A turn that never starts reported the _requested_
  ceiling, not the room it had. Covered by a regression test.

#### What remains before promotion

- Local text (node-llama-cpp session path) and any configured cloud provider — untested here; the
  fixed-cost pricing and the calibration path could behave differently on a transport that reports
  usage differently.
- A 32K+ window, to confirm the contract stays inert where there is room.
- Phase 3's fingerprint extension to the local-session and manual compaction paths.
- Result manifests rather than prose summaries.

The evidence so far supports promotion in principle — `adaptive-v1` is measurably identical to
`current` wherever the window has room, because the cap binds before the contract does, and strictly
better where it does not. That is a narrow claim, and the right one: this is a capacity contract, not
a better context system. It should be promoted only once the untested transports confirm the same
inertness.

### Implementation map

- `src/shared/contextPlanner.ts` is the pure strategy selector, capacity contract, shared
  automatic-reference packer, and content-free report contract. Its tests are in
  `src/shared/__tests__/contextPlanner.test.ts`.
- `src/main/chat/continuationBrief.ts` renders the derived settled-state handoff carried into every
  continuation cycle. Its tests are in `src/main/chat/__tests__/continuationBrief.test.ts`.
- `src/main/chat/runGeneration.ts` is the one generation boundary that prices the fixed prompt,
  collects automatic sources, invokes the selected strategy, passes the chosen text to the existing
  prompt composer, reports provenance from what was actually included, and writes a stateless ledger
  fingerprint when compaction produces a revision.
- `src/main/memory/MemoryRetriever.ts`, `src/main/recall/transcriptRecallContext.ts` and
  `src/main/tools/workspaceContext.ts` each expose their output as ranked whole units alongside the
  joined text they already returned. They still own every relevance decision; only the prompt
  allowance is coordinated elsewhere.
- `src/main/llama/contextAssembler.ts` owns the fingerprint calculation and refuses a mismatched
  derived stateless snapshot. It never modifies canonical history.
- `src/shared/settings.types.ts`, `src/shared/settings.defaults.ts`, `src/main/settings/SettingsStore.ts`,
  and `src/renderer/features/settings/pages/ai-models/AiModelsSettings.tsx` provide the validated,
  backward-compatible opt-in setting. The default is `current`.
- `src/main/chat/boundedChatRunner.ts`, the renderer chat store, agent runs, and scheduled runs carry
  bounded reports to persisted assistant results. The reports have no injected text or file content.

This document adds the Context OS decision and benchmark charter. It does not replace the
historical evidence in:

- docs/CLAUDE_CONTEXT_SYSTEM_HANDOFF.md
- docs/CONTEXT_COMPACTION_HANDOFF.md
- docs/CONTEXT_SYSTEM_ROOT_CAUSE.md
- docs/CONTEXT_ADAPTIVE_RUNTIME_RECOVERY_HANDOFF.md
- docs/CONTEXT_RELIABILITY_PLAN.md
- docs/CONTEXT_RELIABILITY_TESTING.md

Read AGENTS.md, README.md, ROADMAP.md, and this document before editing. Then read the three
conversation-specific handoffs above before changing chat context, compaction, tool routing, or
continuation behavior.

### Captured repository state

- Repository: C:\Users\Owner\Desktop\Anodex4
- Branch: main
- HEAD: 1c33a1be19d1617aac3898117904cb6bbb721173
- Captured working tree at handoff creation: clean; do not assume it remains clean later.
- The initial handoff task changed documentation only. The 2026-08-18 implementation record above
  describes the subsequent additive runtime/settings/test changes. It did not alter persisted
  conversation data, models, or the benchmark workspace.

Before doing any implementation work, inspect the live tree instead of trusting the snapshot:

    git status --short
    git diff --stat
    git diff --check
    git rev-parse HEAD

Other agents may be working on the context system. Preserve unrelated changes. Do not reset,
checkout, restore, or overwrite the tree wholesale.

## Product decision

Build a small Context OS only if it can be shown to be better than the current system. It is not
approved as a speculative rewrite.

The Context OS is an additive context-assembly strategy, called adaptive-v1 in this document. The
current assembly remains a supported strategy and the immediate rollback destination. The full
transcript remains the canonical record in both modes.

The work is successful only when adaptive-v1 improves or matches the current system on correctness
and task completion while reducing context-pressure failures. A more sophisticated planner that
uses more tokens, hides capabilities, or makes the benchmark less reliable is a regression.

## Non-negotiable behavior

1. Raw user and assistant conversation records remain durable truth. Summaries, ledger entries,
   recalled snippets, context epochs, and planner reports are derived projections.
2. Every existing local text, local vision, cloud, and OpenAI-compatible path remains supported.
   Do not build named 4K, 8K, 16K, or provider-specific production branches.
3. Adapt to measured effective capacity and factual provider/runtime capabilities. Hardware RAM and
   VRAM influence which model and context can load; they are not a substitute for measuring the
   usable prompt window after loading.
4. Do not silently remove user-enabled tools, project rules, assistant style, active skills,
   user attachments, or model choice to make a prompt fit.
5. Automatic supporting material may be selected, shortened, deferred, or recalled on demand.
   That is context selection, not capability removal.
6. Preserve existing permission, workspace confinement, destructive-action confirmation,
   checkpoint, citation, and tool-result integrity behavior.
7. Tool request/result relationships must remain valid. Never leave an orphan result or retain a
   result while discarding the request it answers.
8. Do not use user or assistant wording, keywords, regular expressions, or a model-name heuristic
   to decide whether to mutate, continue, stop, expose a tool domain, or activate a plan. Use
   explicit configuration, measured budget state, settled tool effects, and provider outcomes.
9. Do not introduce broad document RAG, mandatory embeddings, a graph database, or remote telemetry
   as prerequisites. They are separate experiments if evidence later proves lexical retrieval is
   inadequate.
10. New persisted fields must be optional and backward compatible. Disabling adaptive-v1 must not
    require a migration or lose a conversation.

## What exists today

Anodex already contains important pieces of the intended architecture:

- src/shared/contextBudget.ts allocates output, reference, and tool-schema budget with a scaled
  working-set policy.
- src/main/chat/runGeneration.ts composes project rules, active skills, workspace material, memory,
  transcript recall, and the user request before provider generation.
- src/main/llama/contextAssembler.ts projects and bounds model history. It supports rolling
  summaries and the stateless provider path.
- src/main/llama/LlamaService.ts has local tokenizer/session measurements, proactive compaction,
  output budgeting, and compact native tool routing with deferred-tool discovery.
- src/main/llama/LlamaVisionService.ts and the cloud paths use bounded stateless projections.
- src/shared/context.types.ts persists the context ledger, rolling snapshots, active snapshot, and
  epoch handoff while retaining the conversation transcript.
- src/main/memory/MemoryRetriever.ts, src/main/tools/workspaceContext.ts, and
  src/main/recall/transcriptRecallContext.ts each add automatic reference material.

The main remaining architectural gap is coordination. Automatic sources are individually bounded
or ranked, but do not all compete within one measured reference budget. Transcript recall,
workspace activity, and other injected material can create pressure that is not visible from a
single shared report. Cloud accounting begins with approximation while local text can measure exact
rendered cost.

Explicit instruction sources require different treatment. Project rules, assistant style, and
enabled skills are intentional user choices, not passive retrieved snippets. Adaptive-v1 must
measure and report their pressure, but must not silently discard them.

## Target design: one planner, multiple renderers

### Input contract

At the provider/generation boundary, produce a factual runtime capability and capacity record:

- provider/backend kind: local text, local vision, cloud, or compatible provider;
- effective context window for the successfully loaded model;
- measured local input limit when the backend provides it;
- rendered system, user prompt, tool-schema, image, framing, and history costs where measurable;
- required output reserve;
- supported tool/vision/structured-output features;
- only locally observed reliability facts, marked unknown when they are not known.

Never infer that a model is incapable merely because it has a small context. Weak tool calling and
small context are separate problems. A supported but weak model must remain usable, honest, and
resumable.

### Assembly order

The planner should assemble a generation in this order:

1. Provider wrapper and non-optional system rules.
2. Explicit user-controlled instructions: project rules, assistant style, enabled skills, and the
   current user request including attachments.
3. A protected output reserve sized from the effective context and the current execution mode.
4. Required near-term continuity: recent turn units and any valid tool call/result pairs.
5. A single automatic-reference pack selected from workspace material, project/global memory,
   transcript recall, activity/evidence notes, and relevant durable context facts.
6. Older history represented by a valid summary/ledger projection, with raw history still retained
   in storage.

The planner may shrink automatic reference material first. It must not solve pressure by hiding
tools, deleting history, discarding settled mutations, or overriding explicit instructions.

### Shared automatic-reference packer

Create a pure, tested packer with inputs from each automatic source. It receives the actual
remaining reference allowance and returns:

- selected source fragments and stable source identifiers;
- per-source estimated token/character cost;
- rank/relevance and freshness reason;
- omitted/deferred fragments and why they did not fit;
- the final estimate and budget remaining.

Initial ranking can use the current lexical behavior and existing scopes. Do not introduce a new
retrieval database in the first version. The only important property is that every automatically
injected source competes for the same allowance.

The packer must preserve scope rules: project material stays in project scope; global memory and
cross-conversation recall remain subject to their existing explicit settings.

### Context ledger and compaction

Keep the current ledger/snapshot model. Add only optional integrity metadata to new revisions:

- strategy version;
- fingerprint of the canonical history prefix covered by the revision;
- assembly/capability version if required to diagnose a stale projection.

If a fingerprint does not match after a branch, restore, or transcript change, regard the derived
summary as stale and reassemble from canonical persisted history. This is a recovery decision, not
a refusal and not data loss.

### Local, vision, and cloud behavior

- Local text: use actual tokenizer/session/wrapper accounting when available. Existing compact
  native tool routing remains capability preserving because deferred tools remain discoverable and
  callable.
- Local vision: use the same planner but count image inputs and vision tool-schema cost. Do not
  confuse text token estimates with vision input cost.
- Cloud and compatible providers: begin with the current supported configured context limit and
  conservative estimate. Capture returned usage/context-limit outcomes locally when a provider
  exposes them, then refine headroom estimates per provider/model version. If no usage is supplied,
  use the existing fallback rather than rejecting the request.

No provider-specific behavioral fork should decide what a user is allowed to do.

### Planner report

For every generation, produce a bounded local diagnostic record. It must store metadata and source
identities rather than duplicate private message/file contents. It should contain:

- strategy and version;
- effective capacity and output reserve;
- fixed prompt cost, history cost, tool-schema cost, image/framing cost where known;
- selected automatic sources and omitted counts;
- compaction/recovery decision and source revision;
- provider stop/overflow outcome;
- actual provider usage when returned.

Expose this only through an appropriate diagnostic/developer view at first. It is evidence for
evaluation, not a new user-facing restriction.

## Reversibility design

Implement strategy selection in one central assembly boundary:

- current: today's context construction and history projection;
- adaptive-v1: the new capacity record plus automatic-reference packer;
- invalid/missing setting: current.

The selector must be read per generation. Reverting adaptive-v1 must route the next generation
through current without deleting summaries, changing model settings, moving conversations, or
rewriting history.

All adaptive-v1 persistence is additive. Old conversations without planner data must behave exactly
as they do today. New planner reports must be disposable diagnostics, not required conversation
state.

## Benchmark charter: supplied conversation

### Frozen benchmark identity

The supplied conversation is a high-value primary regression benchmark. It is not sufficient as
the only release benchmark.

- Conversation ID: c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef
- Title: Build Solar System Website
- Project ID: p_msb7m6ax_hx0wu
- Conversation file:
  C:\Users\Owner\AppData\Roaming\anodex\conversations\p_msb7m6ax_hx0wu\c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef.json
- Captured file size: 19,287,157 bytes
- Captured SHA-256:
  CBF146240E2FD2C4BDCB51FD3FE0C734D2A15EFCB4266270CE4684C90F6ABF74
- Captured last-write time, UTC: 2026-08-19T04:22:03.7191354Z
- Messages: 80 total; 40 assistant messages
- Recorded tool calls: 1,251 total; 1,117 successful, 133 errors, 0 denied

Do not edit, sanitize, archive, restore, or delete this conversation while it is a benchmark. Its
hash is the evidence identity. If it changes, create a new baseline record instead of silently
replacing this one.

### Why it is valuable

This is real data from the product, not a synthetic toy:

- a 16,384-token local context;
- long multi-turn project history;
- summaries, context ledger revisions, memory, transcript recall, tools, and checkpoints;
- hundreds of reads/commands/writes across failures and recoveries;
- historic context exhaustion, repeated-read/no-progress behavior, guarded-edit failures, mutation
  safety incidents, and a later successful completion documented in the existing handoffs.

It therefore tests the exact interactions the Context OS is meant to improve: fixed prompt
pressure, automatic recall, compaction, tool continuity, multi-cycle execution, and safety after
recovery.

### Current target task and observed baseline

Use this exact latest user request as the headline task:

    when opening the folder and running the index.html it does not show the sandbox its just black no planets or anything

The latest corresponding assistant response is:

- Message ID: m_4a2dd6bc-d7b6-435e-a859-220ff4aa97aa
- Context size: 16,384
- Input limit: 15,872
- System/wrapper cost: 3,952 tokens
- Prompt cost: 40 tokens
- Active tool-schema cost: 1,580 tokens
- Fixed input: 11,805 tokens, or about 74% of the usable input limit
- Effective output limit: 3,457 tokens
- Active/deferred tool count: 13 / 47
- Generated tokens: 12,327
- Duration: 481,601 ms
- Tool calls: 51 total; 47 successful, 4 errors
- Tool mix: 26 reads, 13 commands, 12 writes
- Successful edits: 8 replace_lines calls affecting index.html and js/universe-sandbox.js
- Memory records used: 1
- Transcript recall excerpts used: 7

The response identified and changed file:// module-loading behavior, but it explicitly reported that
visual inspection did not complete. It is therefore a useful baseline with partial task progress,
not proof that the task was fully solved. Adaptive-v1 must not receive credit merely for reaching
the same unverified state.

### Restorable pre-run fixture

The latest response has a file checkpoint:

- Checkpoint:
  C:\Users\Owner\Desktop\Test Website\.anodex\checkpoints\c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef\m_4a2dd6bc-d7b6-435e-a859-220ff4aa97aa.json
- Captured size: 122,915 bytes
- Captured SHA-256:
  A7BEBFCAA0723997B0D1C30AA005EDC4C8D060D6F5DBAB81CFE46C1D66D953FF
- Changed paths: js/universe-sandbox.js and index.html
- Restored paths when captured: none

The checkpoint contains the before/after versions required to restore the two files to the state
before this assistant response. The live project directory is not a Git repository.

Never restore this checkpoint into C:\Users\Owner\Desktop\Test Website for benchmarking. Work on a
disposable full copy of that directory. In that copy, use the checkpoint restore mechanism to
reconstruct the pre-response state, verify the two file hashes/state, and only then run a fresh
conversation. This avoids overwriting the user's current website and avoids comparing a new planner
against an already-fixed workspace.

### Benchmark limitations

This conversation must be one primary regression, not the only benchmark:

- Model generations are nondeterministic; exact call counts are not a correctness oracle.
- The conversation carries old summaries and prior repairs. Reusing it directly for a new
  generation would contaminate the comparison.
- The baseline configuration must include model GGUF/version, sampler settings, context setting,
  GPU layers/device, system RAM, GPU VRAM, tool settings, active skills, project rules, and app
  build. Those details were not all captured in the persisted chat.
- The task has external visual behavior. Static source inspection alone cannot prove success.

## Controlled comparison procedure

### Do this before any adaptive-v1 live run

1. Record the current Anodex commit, working-tree diff, application build, model/provider
   configuration, context setting, RAM/VRAM, GPU layers, and enabled capabilities.
2. Confirm the conversation and checkpoint SHA-256 values above. If either differs, record a new
   baseline rather than overwriting the old values.
3. Make two disposable copies of C:\Users\Owner\Desktop\Test Website. Do not use the live user
   workspace.
4. In each copy, restore the latest-response checkpoint to obtain the same pre-response state for
   index.html and js/universe-sandbox.js. Inspect the restore result and save a hash manifest for
   the full fixture. Do not use force restore if the copied state conflicts; find the cause first.
5. Start a brand-new project conversation for each lane. Do not reuse the 80-message live
   conversation as the active chat.
6. Use the exact task text above and the same model/provider, sampling settings, context size, tool
   settings, project rules, and active skills in both lanes.

### Lanes

- Control lane: current strategy.
- Candidate lane: adaptive-v1 strategy.

The model is inherently stochastic. Run at least three fresh, clean-fixture trials per lane before
claiming a difference. If the local runtime supports a repeatable seed without changing ordinary
production behavior, record it and use paired seeds. Otherwise report variation rather than
pretending a single run is definitive.

### Capture for every run

- Fixture manifest hash and conversation ID;
- application commit/build and full model/provider configuration;
- effective context and measured input limit;
- per-cycle fixed prompt/history/tool/image/framing/output values;
- active and deferred tool names/counts;
- selected/omitted automatic reference source counts and planner rationale;
- number of tool calls by kind/status, unique read identities, successful writes, and changed paths;
- compactions/recovery epochs and their before/after size;
- provider stop reason, wall time, generation tokens, output limit, and errors;
- visual verification result, file parse/build/test result, and manual task outcome;
- final task status: verified complete, partial with next action, paused/recoverable, or failed.

Do not use the model's prose alone to score completion. The black-screen task needs visual evidence
after the change, plus a recorded source/runtime check appropriate to the project.

### Pass/fail decision for this benchmark

adaptive-v1 passes this benchmark only when it:

1. preserves all successful current safety behavior and does not corrupt the fixture;
2. reaches a verified rendered result or an honest, durable partial state;
3. does not increase repeated identical/overlapping evidence reads without a concrete reason;
4. does not reduce tool, model, or workflow availability;
5. matches or improves success rate across the paired trials;
6. does not materially worsen median wall time or tool-error rate;
7. reports why context was selected or deferred when it behaves differently.

A clean finish with an unverified claim is not a pass. More tool calls are not evidence of better
work. Fewer calls are not evidence of better work unless the requested result is actually verified.

## Wider release matrix

The supplied task proves a valuable 16K local tool-heavy case. Before changing the default,
supplement it with:

| Environment                               | Required outcome                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 4K local constrained model                | No crash, no context corruption, truthful pause/recovery, all enabled tools still reachable.      |
| 8K local tool-heavy task                  | Useful progress and durable continuation without a repeat-read loop.                              |
| 16K current benchmark                     | The controlled black-screen comparison above.                                                     |
| 32K+ local model                          | Broader useful context or fewer recoveries without a correctness regression.                      |
| Local vision                              | Images, visual inspection, and tool context use the same budget contract.                         |
| Each configured cloud/compatible provider | Current behavior is preserved; returned usage is used when available, fallback works when absent. |
| Non-mutating diagnosis task               | No action continuation or edits are inferred from prose.                                          |
| Long project task with writes             | Completed mutations survive compaction/restart and are not repeated.                              |

The exact named sizes are test fixtures, not product branches. Production adapts from the measured
capacity record.

## Implementation phases

### Phase 0 — lock the comparator before changing behavior (partially complete)

- [x] Add pure fixtures representing current and candidate assembly inputs and expected output shape.
- [x] Define the planner-report schema as optional diagnostic data.
- [x] Add an explicit strategy selector defaulting to current; `adaptive-v1` is opt-in only after
      its focused tests passed.
- [x] Add pure tests that run current and candidate assembly against identical inputs.
- [x] Capture the initial live local-vision trial records. See “Initial live benchmark record —
      2026-08-19”; the promotion-quality rerun remains pending because this batch found defects.

Exit condition: current behavior is reproducible in tests and live baseline data is frozen.

### Phase 1 — unify capacity accounting (foundation complete; transport calibration remains)

- [x] Reuse the existing effective configured context window at the shared generation boundary; it
      remains capacity-scaled rather than branching by machine tier.
- [x] Allocate automatic references from the existing context-budget allocation, whose output
      reserve is calculated first.
- [x] Add constrained and normal-capacity packing coverage with no RAM/VRAM/model-name branch.
- [x] Plan the automatic-reference allowance from measured fixed prompt cost, the tool-schema
      reserve, the reply reserve and the working-set floor, rather than from a fraction of the
      window. See `automaticReferenceAllowanceChars` and the correction record above.
- [x] Record that capacity on every `adaptive-v1` assembly report, so an included-character count can
      be read against the capacity it was chosen under.
- [ ] Join provider-returned usage into the capacity record for local vision and every
      stateless/cloud transport. The record is currently planning-side only: the transports still
      report their own measured costs separately in `ContextBudgetUsage`.
- [ ] Calibrate conservative provider estimates with controlled live measurements where providers
      disclose usage.

Exit condition: a single diagnostic report can explain the budget for every supported transport.

### Phase 2 — build the automatic-reference packer (first production slice complete)

- [x] Route workspace snippets, durable memory, and transcript recall through one shared packer.
- [x] Preserve existing scope and retrieval behavior; the packer coordinates only their prompt
      allowance.
- [x] Keep skills/rules/style outside the packer as protected user-controlled instructions.
- [x] Record stable automatic-source identifiers, included/omitted sizes, and selection state without
      duplicating source content.
- [x] Test constrained selection, deterministic redistribution, unknown capacity fallback, and the
      total allowance.
- [x] Select whole ranked units rather than truncating a rendered section, and let a source
      contribute nothing when the window cannot seat even its first unit.
- [x] Report retrieved memory and transcript-recall provenance from the units that actually reached
      the prompt, so the UI cannot credit deferred material.
- [ ] Add any future automatic source (for example activity/evidence material) only through this
      packer, with scope and relevance tests. Do not create a competing allocator.

Exit condition: automatic context has one total budget and no source silently escapes it.

### Phase 3 — make derived history integrity-aware (stateless path complete; local-session extension pending)

- [x] Store an optional canonical-prefix fingerprint on new stateless ledger revisions.
- [x] Detect a stale stateless derived summary after a transcript edit and rebuild from canonical
      history without touching that history.
- [x] Preserve old conversations and legacy snapshots by making the field optional.
- [ ] Extend the same integrity contract to locally session-managed/manual compaction only after
      targeted regression coverage proves it does not disturb the proven local path.
- [ ] Exercise the live local text, vision, and cloud reconstructions in the release matrix.

Exit condition: stale context projections are recoverable and never become the only history.

### Phase 4 — enable adaptive-v1 as an opt-in experiment (automation complete; live evaluation pending)

- [x] Run the entire automated gate listed below.
- [x] Expose `adaptive-v1` as an explicit opt-in setting while retaining `current` as default.
- [x] Fix the defects the first batch found, and only those. See the correction record above.
- [x] Re-run the controlled lanes now the corrections have landed. Done for local vision at 4K, 8K
      and 16K — see the capacity matrix above. The wider matrix (local text, cloud, 32K+) remains.
- [ ] Add a third lane to a later batch: `current` plus a transcript-recall budget, with no strategy
      change. Deferred rather than dropped — the 4K result now shows the contract doing something a
      recall budget alone could not, since it also refuses workspace material, but the comparison is
      still the cheapest test of whether the strategy earns its surface area.
- [ ] Record result manifests, not only prose summaries.
- [ ] Fix only evidence-backed regressions. Do not tune allocation shares from one run.

Exit condition: adaptive-v1 meets the benchmark criteria and has no capability regression.

### Phase 5 — guarded promotion with immediate rollback (rollback implemented; promotion intentionally blocked)

- [x] Keep current selectable and make rollback a per-generation settings change.
- [x] Start opt-in; do not silently migrate existing conversations.
- [ ] Promote only after evidence across constrained local, typical local, vision, and cloud cases.
- [ ] Retain the comparator and current strategy until `adaptive-v1` has sustained evidence of
      superiority.

Exit condition: the default can change without making the old path unrecoverable.

## Test expectations

For each implementation phase, run focused unit tests first. Before a reviewable milestone, run:

    npm run typecheck
    npm run lint
    npm run format:check
    npm run test
    npm run build
    npm run test:e2e
    git diff --check

Do not claim any command passed unless it was run in the current tree. Separate unit/mock evidence
from live-model results.

Relevant existing test seams include:

- src/shared/**tests**/contextBudget.test.ts
- src/shared/**tests**/contextProjection.test.ts
- src/shared/**tests**/contextSignals.test.ts
- src/main/llama/**tests**/contextAssembler.test.ts
- src/main/llama/**tests**/rollingSummary.test.ts
- src/main/llama/**tests**/compaction.test.ts
- src/main/llama/**tests**/contextShiftStrategy.test.ts
- src/main/chat/**tests**/runGeneration.test.ts
- src/main/chat/**tests**/boundedChatRunner.test.ts
- src/main/memory/**tests**/MemoryRetriever.test.ts

Add focused tests near the source of each new pure behavior. Do not use only one enormous integration
test to prove budgeting.

## Explicit anti-patterns

Do not ship any of these as the Context OS:

- a larger static context-size default presented as a solution;
- a model-name, provider-name, or prompt-keyword special case;
- an automatic tool/model/skill disablement to make a budget fit;
- a summary that replaces the raw transcript;
- a second independent context allocator inside each source retriever;
- arbitrary schema/reference percentages tuned solely to this one chat;
- an opaque retry loop after provider completion;
- a destructive benchmark reset of the live Test Website workspace;
- a success metric based only on token count, fewer calls, or model self-report.

## Recommended next-agent prompt

Read AGENTS.md, README.md, ROADMAP.md, docs/CONTEXT_OS_HANDOFF.md, and the existing context
handoffs cited at the top. Do not edit runtime code until you have verified the current repository
state and frozen the benchmark artifacts named in CONTEXT_OS_HANDOFF.md.

Implement no patch in isolation. Build the Context OS as an additive adaptive-v1 assembly strategy
with current as the default and rollback path. Preserve raw transcripts, tool-call continuity,
existing permission/mutation safety, all enabled tools, user-selected skills/rules, and provider
neutrality. Adapt only automatic supporting context according to measured effective capacity.

Use the supplied 16K conversation only as a primary regression benchmark. Recreate the latest
black-screen task in fresh conversations against disposable checkpoint-restored workspace copies,
with current and adaptive-v1 compared under matched settings. Run multiple trials and record
evidence. Do not use the user's live Test Website directory as a test fixture. Do not declare
adaptive-v1 better unless it meets the success, verification, non-regression, and rollback criteria
in this document.

## Current conclusion

The supplied chat is the right first benchmark because it is a real, high-pressure 16K tool-heavy
run with preserved history, checkpoints, failures, repairs, and incomplete verification. The
correct experiment is not to regenerate inside the same conversation or workspace. It is to freeze
the record, restore the pre-run state into disposable copies, and compare fresh current versus
adaptive-v1 runs under matching configuration.

Only then can Anodex answer the important product question: does the Context OS genuinely improve
real work, or should the current system remain the default?
