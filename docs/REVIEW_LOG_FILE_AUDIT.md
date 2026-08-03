# File-by-file audit log

A slow, deliberate pass over the highest-risk files in the codebase. One file at a
time, read completely — not sampled, not delegated to a subagent, not inferred from
tests passing. Each file is checked for correctness bugs first, then for
organisation and documentation.

Ordered by risk, which is roughly `(damage if wrong) × (untested) × (centrality)` —
not by size. Line counts are from `git ls-files`, measured 2026-08-02.

The "Tests" column counts test files that actually import the module. The first
version of this table was built by looking for `<Basename>.test.ts` and was wrong
for four rows — `LlamaService.ts` alone has ten, including a substantial
`generateContextShiftRecovery.test.ts`. Corrected in place while reviewing file 2.
The order is unchanged: damage-if-wrong still dominates the ranking.

**Working rule:** a file is only ticked off when it has been read end to end, every
issue found is either fixed or explicitly recorded below as a deliberate
non-change, and the suite still passes.

## Progress

| #   | File                                             | Lines | Tests         | Status  |
| --- | ------------------------------------------------ | ----- | ------------- | ------- |
| 1   | `src/main/conversations/ConversationStore.ts`    | 322   | 0 → 11 added  | ✅ done |
| 2   | `src/main/llama/LlamaService.ts`                 | 2760  | 10 → 16       | ✅ done |
| 3   | `src/main/chat/runGeneration.ts`                 | 614   | 5 → 6 added   | ✅ done |
| 4   | `src/main/llm/OpenAiCompatibleProvider.ts`       | 544   | 0 → 5 added   | ✅ done |
| 5   | `src/main/llm/AnthropicProvider.ts`              | 481   | 0 → 4 added   | ✅ done |
| 6   | `src/main/email/EmailService.ts`                 | 713   | 1 → 2 added   | ✅ done |
| 7   | `src/main/email/providers/ImapSmtpAdapter.ts`    | 919   | 0 → 18 added  | ✅ done |
| 8   | `src/renderer/stores/chatStore.ts`               | 1244  | 1 → 5 added   | ✅ done |
| 9   | `src/shared/ipc.ts`                              | 862   | 3 → 10 added  | ✅ done |
| 10  | `src/renderer/features/chat/ChatCircuit.tsx`     | 956   | 0 (see below) | ✅ done |
| 11  | `src/renderer/features/startup/startupEngine.ts` | 792   | 0 → 6 added   | ✅ done |
| 12  | `src/renderer/features/email/EmailView.tsx`      | 1251  | 0 (see below) | ✅ done |

Why this order: 1 and 6–7 can destroy or leak user data; 2–5 are the generation
path where a bug burns tokens or truncates a reply; 8–10 are the app's spine;
11–12 are contained UI.

## Round two — the next twelve, by the same rule

Round one's twelve are done and its cross-cutting items are closed. Re-measured
2026-08-02 across everything not yet reviewed, ranked the same way: damage if
wrong, times untested, times centrality — not size. Test counts are files that
mention the module, checked against the real test tree rather than a filename
guess (the mistake that made round one's first table wrong).

| #   | File                                                                          | Lines | Tests | Status  | Why it ranks here                                           |
| --- | ----------------------------------------------------------------------------- | ----- | ----- | ------- | ----------------------------------------------------------- |
| 1   | `src/main/tools/fileTools.ts`                                                 | 748   | 1 → 4 | ✅ done | The model's whole read view of the workspace                |
| 1b  | `src/main/tools/commandTools.ts`                                              | 130   | 1 → 3 | ✅ done | Runs arbitrary shell commands                               |
| 2   | `src/main/tools/mutationTools.ts`                                             | 509   | 2 → 6 | ✅ done | The write path proper                                       |
| 3   | `src/main/tools/emailTools.ts`                                                | 1238  | 1 → 3 | ✅ done | Sends real mail on the user's behalf — irreversible         |
| 4   | `src/main/checkpoints/CheckpointStore.ts`                                     | 436   | 4 → 8 | ✅ done | The undo for all of the above                               |
| 5   | `src/main/llama/LlamaVisionService.ts`                                        | 1257  | 1     | ☐       | Local vision transport, never read end to end               |
| 6   | `src/main/llama/contextShiftStrategy.ts`                                      | 979   | 2     | ☐       | Mid-generation context surgery                              |
| 7   | `src/main/criticalThinking/CriticalThinkingService.ts`                        | 2024  | 3     | ☐       | Largest unreviewed file; long unattended runs               |
| 8   | `src/main/criticalThinking/CriticalThinkingResearchRunner.ts`                 | 1398  | 1     | ☐       | Drives the research loop                                    |
| 9   | `src/main/tools/webTools.ts`                                                  | 598   | 3     | ☐       | Fetches untrusted content the model then acts on            |
| 10  | `src/main/email/providers/MicrosoftAdapter.ts`                                | 528   | 2     | ☐       | The unreviewed third mail adapter                           |
| 11  | `src/renderer/features/chat/ChatComposer.tsx`                                 | 690   | 0     | ☐       | Every message starts here                                   |
| 12  | `src/renderer/features/settings/pages/ai-models/ProviderConnectionsPanel.tsx` | 867   | 0     | ☐       | Handles API keys                                            |
| 13  | `src/main/tools/helpers.ts`                                                   | 501   | 26    | ☐       | Best-covered module in the tree; read at the user’s request |

Why 1–4 lead: round one's worst findings were all in code that persists, moves
or sends the user's data — a failed write destroying a conversation, an
empty-subject thread resolving to the whole mailbox, a background refresh erasing
a live turn. The tool layer is the same class of code with the model's hand on
it, and it is the least covered part of the app.

`helpers.ts` (501 lines) is on the list at the user's request, placed last: 26
test files exercise it, by far the best-covered module in the tree, so it is
the least likely to be hiding anything — but it is also the layer every tool
runs through, which is a fair reason to read it anyway.

## Open cross-cutting items

Real findings that span several files, so fixing them inside one file's row
would create a fresh inconsistency rather than remove one. Listed here so they
survive the pass that found them; each is also written up under the file it came
from.

| Item                                                        | Found in | Status            |
| ----------------------------------------------------------- | -------- | ----------------- |
| Round text concatenated with no separator (4 transports)    | 4        | ✅ fixed          |
| No timeout on API-key verify clients (all providers)        | 4        | ✅ fixed          |
| Empty turns can leave consecutive same-role messages        | 4        | ✅ fixed          |
| `splitHistoryByTokenBudget` cuts without regard for pairing | 5        | ✅ fixed          |
| `AnodexApi` mixes `Result<T>` and bare-`T` returns          | 9        | assessed — no fix |
| No Sent copy is filed after an SMTP send                    | 7        | ✅ fixed          |
| `unarchive` cannot resolve an already-archived thread       | 7        | ✅ fixed          |
| `save_email_attachment` does not disclose an overwrite      | R2.3     | ☐                 |

---

## 1. `src/main/conversations/ConversationStore.ts` — done

Every conversation the user has ever had lives here, as JSON files under
`userData/conversations/`. It had no test file at all.

### Bugs fixed

**1.1 A failed write during a project move destroyed the conversation.**
`save()` removed the old file _before_ writing the new one. If the write then
threw (disk full, permissions, antivirus lock), the old file was already gone and
nothing had replaced it. Reordered to write first, then remove the stale file. The
failure mode is now a duplicate file rather than a hole.

**1.2 Deleting a project left `activeConversationId` pointing at a deleted chat.**
`deleteByProjectPermanent()` cleared the cache and the files but never touched the
persisted active-conversation state — unlike its two siblings `deletePermanent()`
and `archiveByProject()`, which both do. Reachable from `ProjectStore.ts:172`:
delete a project while one of its chats is open and the app restarts pointing at a
record that no longer exists.

**1.3 A failed state write left memory and disk permanently disagreeing.**
`setState()` assigned `this.stateCache` before `writeFileSync`. On a write failure
it rethrew, but the in-memory cache kept the new value for the rest of the process
lifetime while disk kept the old one. Cache is now assigned only after the write
succeeds.

**1.4 Corrupted conversation files vanished silently.**
`readFile()` ended in a bare `catch { return null }` — no log, no signal. A chat
that failed to parse simply stopped existing from the user's point of view. It also
did no shape validation: `sanitizeConversationTranscript` calls
`conversation.messages.map(...)`, so a file containing `null`, `[]` or `{}` threw
inside the sanitizer and hit the same silent catch; a file with messages but no
`id` would have been cached under the key `undefined`. Now validates that the
parsed value is an object with a non-empty string `id` and an array of messages,
and logs a warning naming the file on every rejection path.

**1.5 `init()` reset the conversation cache but not the state cache.**
Asymmetric, and wrong if `init()` is ever called twice — the second init would keep
the first's active-conversation id while pointing at a different `userData`
directory. Production calls it once (`main/index.ts:110`); tests do not.

**1.6 `deleteArchived(ids)` did not check that the ids were archived.**
It is reachable from the renderer over IPC and forwards straight to
`deletePermanent`, so a wrong id list permanently destroys live conversations. The
method's name states a precondition that nothing enforced. It now skips
non-archived ids and logs them.

### Cleanups

- `getState()` did not cache the fallback result, so with no state file on disk —
  the first-run case — every call re-hit `existsSync` + `readFileSync`. Now caches
  the default too.
- Three sites computed `Date.now()` twice in one object literal, so `archivedAt`
  and `updatedAt` could differ by a millisecond on the same archive. Single `now`.
- `removeFile()` now passes `{ force: true }` to `rmSync`, so an already-absent
  file is not logged as a failure.

### Deliberate non-changes

- **Mutating the cache while iterating it** (`deleteAll`, `archiveByProject`,
  `restoreByProject` all call `save()` inside `for...of` over the same Map). This
  is safe: `save()` only ever `set`s an id that already exists, and per spec an
  in-place update of an existing key is not revisited by an active iterator. Left
  as is, with a comment.
- **`assertSafeId` does not block Windows device names** (`CON`, `NUL`, `AUX`) or
  cap length. Both are unreachable — ids are generated by the app, never supplied
  by the user — and the regex already blocks the traversal characters that matter.

### Tests added

`src/main/conversations/__tests__/ConversationStore.test.ts` — 11 tests. A partial
mock of `node:fs` lets a write to a chosen path be made to fail on demand, which is
the only way to exercise the failure ordering in 1.1 and 1.3.

Every test was run against the pre-fix file to confirm it actually catches
something. Six failed, one per bug, and were then verified green against the fix.
The remaining five describe behaviour that was already correct and pass either way:
path-safety rejection, the project-move happy path, archive/restore round-tripping,
other projects surviving a project deletion, and `archivedAt === updatedAt` — that
last one is a regression guard only, since the two `Date.now()` calls it replaced
almost always landed in the same millisecond anyway.

---

## 2. `src/main/llama/LlamaService.ts` — done

2,760 lines, the largest file in the repo: engine init, model load/unload, chat
sessions, the whole streaming generation loop, compaction, and the summarizer
helpers. Well covered by tests for _generation behaviour_ and almost not at all
for _engine lifecycle_, which is where all three real bugs were.

### Bugs fixed

**2.1 A throw during turn setup wedged the engine until the app restarted.**
`generateInternal` sets `this.generating = true` early, and its `finally` only
covers the decode loop. Three separate `catch (error) { this.generating = false;
… throw }` blocks had been added ahead of that — around `buildToolFunctions`,
`ensureSession`, and the proactive compaction — but the region after them was
covered by nothing: `boundFunctionsForTurn` and `measureContextBudget` both throw
(`'No model context is loaded.'`, `'node-llama-cpp has not finished loading.'`, or
anything the chat wrapper raises while rendering). A throw there left the flag set
for the rest of the process.

The consequence is worse than a stuck spinner. Every later turn then failed the
`if (this.generating)` check with `GENERATION_IN_PROGRESS_ERROR` — and both
`AgentRunService` (line 333) and `CriticalThinkingService` (line 1393) special-case
that exact message as _transient contention_, so an agent run reverted itself to
`needs-review` on every attempt rather than reporting a fault. Nothing clears the
flag: `loadModel`/`unload` never touched it either.

Replaced the three ad-hoc catches with one authoritative reset in `generate()`'s
`finally`. It holds the model lock for the entire call, so by the time it returns —
however it returns — nothing is generating.

**2.2 `loadModel()` and `unload()` disposed the native model with no lock.**
Both are public entry points that call `disposeModel()`, disposing the context,
sequence and model. Neither took `modelLock`, and both are reachable straight from
IPC while a reply is streaming — `Models.load` (`model.handlers.ts:100`),
`Models.unload` (`:113`), and `Models.delete` (`:122`). Disposing a `LlamaContext`
mid-decode is a native crash, not a catchable error, which is the exact hazard the
lock's own doc comment describes; its list of "public entry points" simply omitted
these two.

Both now take the lock and delegate to private `loadModelInternal` /
`unloadInternal` — the mutex is a plain FIFO with no reentrancy, so the internal
split is what keeps `loadModel`'s own `unload` call from deadlocking. `loadingModel`
is still set synchronously before the first await, so a genuine duplicate load
still fails fast instead of queueing and loading twice.

**2.3 `getLlamaBackend()` could start two native backends.**
`this.llama ??= await nlc.getLlama()` evaluates the nullish check _before_ the
await, so two callers arriving during initialisation both saw `undefined` and both
initialised a backend. The method's own doc comment says a second independent
backend is "a real, avoidable risk, not just a style preference" — the code did not
achieve what it documented. Reachable: `EmbeddingService.ts:82` calls it to index a
workspace in the background, which can overlap the startup model load.

Now memoises the promise rather than the resolved handle — the shape `getModule()`
was already using correctly ten lines below — and clears it on rejection so one
failed probe doesn't poison every later call.

**2.4 The post-fallback abort check missed the loop guard.** After running a
fallback tool call the loop checked only `params.signal`, not `genController`,
which is what the loop guard aborts through. A guard firing during that call bought
one more full `promptWithMeta` round before anything noticed. Self-correcting (the
round returns `stopReason: 'abort'`), so this was wasted work rather than wrong
output.

**2.5 A refused load reported the engine as broken and killed the working
session.** _Deferred out of the original pass as a UI question (see the struck
entry under Deliberate non-changes) and resolved afterwards._

`loadModelInternal` refuses when `describeInsufficientMemory` finds too little
free RAM, and did so with `setState({ status: 'error', model: info, error })` —
before `await this.unloadInternal()`. So the engine advertised `status: 'error'`
carrying the _refused_ model's `ModelInfo` while `this.model`, `this.context` and
the live session all still belonged to the previous, perfectly healthy model.
`generateInternal` gates on `this.status !== 'ready'`, so the user could no longer
send a message: a refusal that deliberately changed nothing cost them their
session, recoverable only by re-loading the old model by hand.

**The decision.** Neither the status nor the error field is the right home for
this. `status` describes the engine, and the engine is exactly what a refusal
does not touch — the preflight exists precisely so nothing is disturbed. But
demoting the refusal to a toast alone (the other option on the table) loses the
only durable copy of a message the user has to act on: it names the model, the
context size, the RAM required and the RAM free, and asks them to go close
applications — which they cannot do while reading a toast that has already
faded.

So the refusal is now recorded _beside_ the status, not in it: a new
`EngineState.refusedLoad` (`{ model, reason }`, see `RefusedModelLoad` in
`shared/model.types.ts`). `status`, `model` and `error` are left untouched, so
the previous model stays loaded, stays `'ready'`, and keeps generating. The throw
still becomes a toast through `model.handlers.ts:96` exactly as before — nothing
about the immediate feedback changed.

**What the Models tab shows.** The engine panel's status pill and model name
carry on telling the truth about what is loaded. Above the sub-tab strip, a
warn-toned callout (`LoadRefusalCallout.tsx`) says what didn't load, why, and —
the part the old behaviour actively lied about — that _nothing changed_ and which
model is still running. It offers **Try again** (re-loads the refused model under
whatever the settings say now, so freeing RAM or lowering the context size in
Advanced makes the retry meaningful) and **Dismiss**. Warn rather than danger is
deliberate: this is "that didn't happen", not "something broke".

It sits at page level rather than inside `EnginePanel`, where it was first put.
Live testing caught that immediately: the refusal was provoked from **Advanced**
by raising the context size to 131,072, which reloads the active model through
`reloadActiveModelIfSafe` — leaving the explanation rendered on the **Models**
tab, which the user was not looking at. Both routes to a refusal have to reach
the same notice, so it belongs to the page, not to either tab.

**And the retry has to actually retry.** The same live test found a second,
older bug next door: `reloadActiveModelIfSafe` bailed on
`engine.status !== 'ready'`, so once a load hadn't taken, changing the context
size did nothing at all. That is precisely backwards — the refusal message tells
the user to lower the context size or switch to CPU-only, and then doing exactly
that was ignored, leaving them to work out on their own that they also had to go
and re-click Load. It now targets `engine.refusedLoad?.model ?? engine.model`
(the pending refusal wins, being the more recent intent) and no longer requires
a ready engine, so adjusting a setting after a refused or failed load _is_ the
retry. It still stands down while a load is in flight or a reply is streaming.

The fix above is what makes the common case work at all: because a refusal now
leaves `status` at `'ready'`, lowering the context size reloads the still-live
model instead of hitting a `status === 'error'` dead end.

The record is cleared on the next load attempt, on unload
(`Models.dismissLoadRefusal` → `llamaService.dismissRefusedLoad()`), and when the
refused model file is deleted — a "couldn't load X" notice must not outlive X.
`dismissRefusedLoad()` deliberately does not take the model lock: it touches no
native resource, so dismissing a notice still works mid-reply.

### Documentation fixed

- Two doc comments were attached to the wrong symbols. A block describing
  `cleanThreadDigest` ("Trims a digest down to the one sentence the row has space
  for") sat directly above `answerLines`, which has its own comment immediately
  after it; and `INSTRUCTION_ECHO_RE`'s block sat above `REASONING_PREAMBLE_RE`,
  likewise. Both made an editor's hover show documentation for a different symbol.
  The digest rationale was merged into `cleanThreadDigest`'s existing comment
  rather than duplicated; the regex comment was moved to its regex.
- `GENERATION_IN_PROGRESS_ERROR`'s doc claimed callers "can recognize this
  contention case". Since `generate()` began holding the model lock for the whole
  turn, contention makes a caller _wait_, so — once 2.1 is fixed — nothing throws
  it at all. Documented as the belt-and-braces guard it now is. See the follow-up
  below.

### Deliberate non-changes

- **`session.promptWithMeta(prompt, promptOptions as never)`.** Casting to `never`
  disables type checking on the entire options object, so a misspelled option would
  silently do nothing. Real smell, but the cast is load-bearing against
  node-llama-cpp's overloads and unpicking it risks changing behaviour invisibly.
- **`runFallbackToolCall` indexes `functions[call.name]` unchecked.** Safe:
  `detectFallbackToolCall` is handed exactly `Object.keys(functions)`, and even if
  it weren't, the resulting `TypeError` lands inside the existing `try` and becomes
  an error string — which is what the "never throws" contract promises.
- ~~**`loadModel` refusing on low memory sets `status: 'error'` with the _new_
  model's info while the _previous_ model is still loaded and working.**~~
  **Resolved — see 2.5 above.** Left deferred here because it needed a decision
  about what the Models tab should show for "refused, previous model still fine",
  which is a UI question rather than a correctness one. That decision has now been
  made and implemented.

### Tests added

`src/main/llama/__tests__/engineLifecycle.test.ts` — 9 tests covering lifecycle
rather than generation output. Four were confirmed to fail against the pre-fix file
(one per behavioural bug, including one asserting the _wedge_ specifically: a
second turn succeeds after a first turn's setup threw). Two pass either way and are
labelled as regression guards in the file — idle contention reporting, and
retry-after-failed-backend-init, which only guards the new memoisation.

The last three came with 2.5 and all three fail against its pre-fix file: the
previous model stays `'ready'` and still generates through a refusal, the refusal
is recorded against the model that _didn't_ load, and it clears on dismissal and
on unload. They drive the real `loadModel()` rather than pre-seeded private state —
a `sizeBytes` of 2^60 refuses on any machine without faking `os.freemem()`, and a
`getModule` whose GGUF read rejects drops `describeInsufficientMemory` into its
documented file-size fallback, so no real `.gguf` is needed.

### Dead-code fallout, resolved

Making the model lock cover the whole turn left `GENERATION_IN_PROGRESS_ERROR`
unreachable, and its two consumers holding recovery paths that could never run.
Chased down rather than left:

- **`CriticalThinkingService.runIsolatedGeneration` was a polling loop** — catch
  the busy error, sleep 500ms, retry, forever. The model lock already queues
  contending callers in FIFO order, which is what the polling existed to
  achieve, so it collapses to a direct call. `LOCAL_BUSY_RETRY_MS` and
  `waitForRetry` went with it; nothing tested any of it.
- **`AgentRunService`'s branch was hiding a live bug.** It reverted a
  plan-reviewed run to `needs-review` instead of a terminal `'error'`, because
  `approvePlan()` only accepts `needs-review` — a terminal error strands the
  approved plan and the planning turns that paid for it. That reasoning holds
  for _every_ failure, but the branch only covered the one error anyone had hit.
  So a plan-reviewed run that died on a network error or a crashed model still
  stranded its plan. Generalised to any cause, with `lastError` recorded so the
  run card says why it bounced, and deliberate stops excluded. Deleting the
  branch would have removed the only escape hatch and left the real bug behind.
- **`LlamaService` kept the guard, dropped the export.** The check is now an
  invariant — `generate()` is the only caller and holds the lock across the
  call — so it throws a plainly internal message instead of a constant two
  services pattern-matched on. That matching is what let a leaked flag disguise
  itself as ordinary busyness and be retried against forever.

Three tests added in `src/main/agents/__tests__/agentRunRecovery.test.ts`; two
were confirmed to fail against the pre-change service. The third — a run with no
plan to protect still failing terminally — passes either way.

---

## 3. `src/main/chat/runGeneration.ts` — done

One assistant turn, end to end: system prompt composition, tool-context
assembly, history bounding, the provider call, then the bookkeeping afterwards.
Every turn in the app goes through it, cloud and local. Five suites import it,
but all five drive it through `BoundedChatRunner`/`AgentRunService`/Critical
Thinking and assert on their own concerns — the only thing tested directly was
the pure `resolveHistoryBounding` helper. The body had no direct coverage at
all, and all four bugs were in the body.

### Bugs fixed

**3.1 A turn that changed real files left no trace in project memory unless it
ran to completion.** The recording was gated on `hadToolActivity &&
!outcome.stopped && activeProject`. Everything it records is a _completed_ tool
outcome — a file written, a command run, a verification parsed — and how the turn
ended afterwards unwrites none of it. The gate dropped precisely the long,
productive turns a bounded stop is designed to preserve: `rounds-exhausted`,
`tool-limit`, `time-limit`, `context-limit` and `provider-error` all report "the
completed tool work above was preserved", and then this ledger discarded it.

It matters because `projectMemoryStore` feeds `buildWorkspaceContext`, which is
injected into the _next_ turn's system prompt. So after a long turn that hit its
round budget half-way through a refactor, the next turn had no record that any of
those files had been touched. `recordEvent` already returns early on an event
carrying no real outcome, so the gate bought nothing that wasn't already covered.
Dropped `!outcome.stopped`.

**3.2 The llama-server vision transport's input tokens were recorded as
`prompt.length / 4`.** `runGeneration` falls back to
`llamaService.countPromptTokens` when a transport reports no input figure, and
that method measures only the user's new prompt text — documented, and correct,
on the grounds that "the local engine reuses the KV cache turn-over-turn rather
than rebilling the full context like a cloud API". True of the node-llama-cpp
engine; false of the llama-server transport, which re-sends the entire
conversation on every round and had already measured it exactly with the model's
own `/tokenize`. It simply never reported it. Fixed at the source —
`LlamaVisionService` now returns `inputTokens: measured.fixedTokens` — so the
existing `??` chain resolves correctly with no branch in the caller, and the text
path keeps the proxy that is right for it.

**3.3 Usage recorded against a model the gauge never asked about.**
`recordGeneration` keys on `modelDescriptor.id` — the model that actually ran —
while `getTodayTokensForModelIds` queried the shipped _catalog_. Any id the
catalog omits is spend the daily-cap gauge can never see. Not reachable through
today's settings UI (the model picker is a `SelectControl` bound to the same
catalog) but nothing enforces it: catalogs ship with the app while the configured
model is persisted settings, so a model retired in a later release silently stops
counting for anyone still pointed at it. Azure already queried its own resolved
id; the rest now do too.

**3.4 A turn billed for input but reporting no output recorded neither.** The
whole recording block was gated on `outcome.stats.tokens > 0`, which is output
only. A cloud turn that sent a large prompt and came back empty cost real input
tokens and contributed none of them to the daily-cap tally. Now gated on either
half being non-zero.

### Documentation fixed

- The comment above the `inputTokens` fallback said the local engine "has no
  billed figure of its own", which stopped being true of the vision transport
  once it gained real measurement. Rewritten around the actual dividing line —
  whether a transport re-sends the conversation each request — which is the same
  line `resolveHistoryBounding` already documents thirty lines above.
- `cloudModelIdsForUsageQuery`'s comment explained the Azure special case but not
  the invariant underneath it (the id recorded and the ids queried must agree).

### Deliberate non-changes

- **`activeModelDescriptor` ignores `providerOverride.model` for Azure**, while
  every sibling branch honours it. Correct rather than an oversight:
  `AzureOpenAiProvider` also ignores `modelOverride` and always calls the
  configured deployment, so honouring it here would attribute usage to a model
  that did not run.
- **`execution.stopReason` is read after `execution.dispose()`.** Safe: `dispose`
  only clears the timer and removes the outer-signal listener; the reason is a
  plain field it never touches.

### Tests added

`src/main/chat/__tests__/runGeneration.test.ts` — 7 tests, the first direct
coverage of the function body. The harness stubs each collaborator to the least
that lets a turn complete and scripts the provider per test, including firing
tool activity _during_ the turn the way a real provider reports it.

Three were confirmed to fail against the pre-fix file, one per behavioural bug
(3.1, 3.3, 3.4). The other four pass either way and are regression guards: no
tool activity records nothing, a general chat with no project records nothing, a
transport-reported input figure is preferred over the proxy, and the proxy is
still used when there is none.

3.2 is covered in `LlamaVisionService.test.ts` instead, where the transport that
had to change already has a harness — also confirmed failing against the pre-fix
service.

---

## 4. `src/main/llm/OpenAiCompatibleProvider.ts` — done

The generic Chat-Completions adapter: eight vendors (Google, xAI, DeepSeek,
Mistral, Groq, OpenRouter, Kimi, Qwen) plus Azure, which reuses its
`runChatCompletionsLoop`. 544 lines with no tests at all.

### Bugs fixed

**4.1 Every tool parameter was sent to the model as mandatory.**
`toParametersSchema` overwrote each tool's declared `required` list with
`Object.keys(properties)`. The comment justified it: node-llama-cpp's GBNF
grammar always requires every declared property regardless of the schema (a real
limitation), "so every Anodex tool is written assuming that behavior".

The tools falsify that premise. Every one declares a narrow `required` list that
matches its handler's non-optional arguments exactly, and the optional ones are
typed `?` with documented defaults behind `??`. `search_code` declares
`required: ['query']` and resolves `args.limit ?? DEFAULT_TOP_K`. `git_status`
declares no required list at all, because its only parameter is an _optional_
subdirectory — forcing it made the model name a directory on every call. Three
tools (`git_status`, `git_diff`, `git_commit_summary`, plus `code_outline`) are
entirely optional; checked each one before relaxing, and no tool anywhere has a
genuinely-required argument missing from its declared list.

Forcing them mandatory does not get better arguments out of a model. It gets an
invented value for a parameter that should have been omitted, and the documented
default then never applies.

**The same defect was in three providers, with the same comment.**
`AnthropicProvider.toInputSchema` and `OpenAiProvider.toParametersSchema` were
byte-for-byte the same mistake. `OpenAiProvider`'s comment even states the
principle it was breaking — it declines `strict: true` because that "would
misrepresent real optionality" for nested fields, while doing exactly that at
the top level. `LlamaVisionService` had already been fixed independently, with a
comment explaining why, and the fix had not been carried across.

Rather than patch it three more times, the rule now lives once in
`src/main/tools/toolParameterSchema.ts`, and all four transports call it. A
policy about how Anodex describes its tools to a model belongs in one place;
having it four times over is what let one mistake ship four times. The
node-llama-cpp text path is deliberately not a caller — it hands `params` to
node-llama-cpp untouched and never renders JSON Schema.

### Deliberate non-changes

- **Round text is concatenated with no separator.** `content += delta` across
  tool rounds, so a model that narrates before a call and answers after it
  produces `Let me search.Found 3 results.` The node-llama-cpp path solved this
  with `appendContent` (joins with a blank line); all three cloud providers and
  the vision transport still do not. Real, and worth one shared fix across four
  transports rather than a fourth divergent one — recorded here so it is not
  lost, to be done as its own change.
- **No timeout on the verify client.** `verifyOpenAiCompatibleKey` builds a
  client with the SDK default (10 minutes), so a black-holed endpoint leaves
  "Test connection" spinning. Every provider's verify path does the same, so
  fixing it in one is a new inconsistency; same treatment as above.
- **`buildMessages` skips a turn with no text and no images**, which can leave
  two consecutive `user` messages when an assistant turn ended empty (an errored
  or stopped turn is still persisted into history, and `chatStore` maps every
  message through without filtering). Most OpenAI-compatible endpoints accept
  that; Mistral and Google's compat layer have historically required strict
  alternation. Flagged rather than changed: reshaping messages for eight vendors
  on an unreproduced hypothesis is riskier than the bug. Note that file 3's fix
  makes an empty assistant turn slightly more likely, since more turns now end
  `stopped`.

### Tests added

`src/main/llm/__tests__/chatCompletionsLoop.test.ts` — 6 tests, the first
coverage this loop has had: the tool schema it puts on the wire, that it omits
`tools` entirely for a tool-free turn, that an unknown tool name / a throwing
handler / unparseable arguments each come back as a tool _result_ rather than
ending the turn (and that unparseable arguments are never repaired and run), and
that the final round refuses to execute tools it has no round left to consume.

`src/main/tools/__tests__/toolParameterSchema.test.ts` — 4 tests on the extracted
rule itself, including the two shapes drawn from real tools.

Four of these fail against the pre-fix schema — two in each new file plus the
pre-existing vision assertion, which is what confirms all four transports now
share one behaviour.

---

## 5. `src/main/llm/AnthropicProvider.ts` — done

481 lines, no tests. Its schema defect was fixed under file 4 (it was one of the
three copies), so this pass covered the rest of the file.

### Bugs fixed

**5.1 A compacted conversation could open with an orphaned assistant reply.**
`splitHistoryByTokenBudget` keeps as many recent turns as fit, walking backwards,
and cuts at whatever index that lands on — nothing aligns the cut to a
user/assistant pair. Since turns alternate, roughly half of all cuts land
immediately after a user turn, leaving its assistant reply as the first
surviving turn. `historyToMessages` then replayed it verbatim, so the
conversation opened with an answer to a question the model could no longer see.

`historyToMessages` now drops the leading run of assistant turns. Only the
leading run: an assistant turn anywhere after the first user turn is ordinary
conversation. What was cut is already represented in the rolling summary, so
nothing is lost that the model doesn't still have.

Worth being precise about the blast radius, because I could not verify it
end-to-end from here: whether Anthropic's API rejects a leading assistant
message outright is not stated in the SDK's own types or docs, and there is no
live key in this environment to try it against. The fix is correct under either
answer — an orphaned reply is wrong to replay whether or not the API tolerates
it — which is why it was made rather than filed. It only fires when history
exceeds the model's window (200K for Claude), so it is rare and severe rather
than common.

**5.2 Two doc comments outlived the code they described.** `toInputSchema` and
OpenAI's `toParametersSchema` were reduced to one-line passthroughs when the
shared renderer landed under file 4, but both kept their original blocks
explaining why they force every property to be required — the opposite of what
they now do. My own oversight in that commit. `toInputSchema` was a passthrough
adding nothing but a type annotation the shared return type already satisfies,
so it is gone entirely; OpenAI's kept the half of its comment that is still true
(why it declines `strict: true`).

### Findings recorded elsewhere

- **Anthropic merges consecutive same-role turns.** Its SDK documents this
  explicitly: "Consecutive `user` or `assistant` turns in your request will be
  combined into a single turn." That resolves the open cross-cutting item from
  file 4 for this provider — the empty-turn skip cannot break anything here. The
  item stays open for the OpenAI-compatible vendors, where Mistral and Google's
  compat layer are the actual concern.
- **The real root of 5.1 is in `splitHistoryByTokenBudget`**, which every
  stateless transport shares. Fixing it there — aligning the cut to a user
  boundary — would remove the whole class rather than its Anthropic symptom.
  Added to the open items table; not done here because it changes history
  selection for every provider including the local vision path, which deserves
  its own change and its own tests.

### Deliberate non-changes

- **`if (toolResults.length === 0) break` runs after the assistant message is
  pushed**, which would leave a `tool_use` block with no matching
  `tool_result`. Unreachable — the branch is only entered when
  `stop_reason === 'tool_use'`, which guarantees at least one such block — and
  harmless if it ever were, since the loop breaks and `messages` is discarded
  rather than sent.
- **`captureRateLimitHeaders` reads `stream.response` on `connect`.** The SDK
  types it `Response | null | undefined`, so the guard is real and the
  best-effort contract in its comment holds.

### Tests added

`src/main/llm/__tests__/anthropicMessages.test.ts` — 4 tests, the first coverage
this provider has had, all on what it puts on the wire: a leading assistant turn
is dropped, a whole leading run is dropped, assistant turns after the first user
turn survive untouched, and a history consisting only of orphans still sends the
current prompt. Three fail against the pre-fix file; the fourth (assistant turns
mid-conversation surviving) is the regression guard that stops the fix
overreaching.

---

## 6. `src/main/email/EmailService.ts` — done

The single entry point for everything email: account linking, reading,
searching, drafting, sending, and batch mailbox actions across Gmail, Outlook and
plain IMAP. The first file in this pass where a bug leaks data rather than
burning tokens.

### Bugs fixed

**6.1 Abandoned drafts were kept for the life of the process.** `createDraft`
holds a draft in an in-memory `Map` so `send_email` can be handed an id instead
of restating the whole message. Nothing ever removed one except a successful
`send` quoting that id — so every draft the user thought better of, or that a
model produced and never sent, stayed until the app closed.

That is not just a leak of memory but of content: a draft carries its
recipients, subject, body, and its attachments as base64. Both the model
(`create_email_draft`, `emailTools.ts:436`) and the Email page
(`email.handlers.ts:276`) can create them freely, so the growth is unbounded in
the ordinary case rather than a pathological one.

Now pruned on write: drafts older than an hour are dropped, and a hard cap of 50
evicts oldest-first as a backstop for a burst inside that window. Pruning on
write rather than on a timer is deliberate — a background interval in the main
process outlives every window and is not worth it for a bounded map. An expired
id fails at `send` with "Email draft not found", which is the right outcome:
better a legible refusal than sending an hour-old message the user has
forgotten writing.

**6.2 `searchAll` queried accounts it knew had no credentials.** It is the one
path that reaches an adapter without going through `resolve`, which exists
precisely to refuse early when `emailAuthStore.hasCredentials` is false. A
linked-but-disconnected account was therefore called anyway, failed inside
`Promise.allSettled`, and logged a warning on every cross-account search —
generic noise standing in for the specific "reconnect this account in Settings"
message `resolve` would have given. Now filtered before dispatch.

**6.3 `previewBatch` passed `NaN` through to the provider.** It clamped its limit
inline with `Math.min(Math.max(1, Math.floor(limit)), MAX_EMAIL_RESULTS)`, and
every step of that is also `NaN`. The file already had `normalizeLimit`, which
rejects a non-finite limit and is what every other read path uses; the second
clamp is gone.

### Deliberate non-changes

- **`applyBatch` does not cap `threadIds`.** Its ids come from `previewBatch`,
  which does cap, and the user approves the resolved list before it runs. A
  caller passing thousands of ids directly would sit in a long sequential loop,
  but nothing reaches it that way today.
- **`getStatus().sendRequiresApproval` is hardcoded `true`.** Correct as
  written — approval is enforced in `emailTools.ts`, and the field reports a
  policy rather than reading one.

### Verified, not bugs

- **Credentials are cleared on every account-removal path.**
  `EmailAccountStore.remove` calls `emailAuthStore.clear(accountId)`, so the
  rollbacks in `connectOAuth` and `connectPassword` — both of which store a
  token or password _before_ verifying — do not strand a live credential when
  verification fails. There is a `pruneTo` for orphans besides.
- **`prepareReply` hardcoding `bcc: []` drops nothing.** `EmailReplyRequest` has
  no `bcc` field; the caller cannot supply one.
- **`prepareForward` is deliberately unthreaded** and fetches the parent's
  attachments before the size cap is checked, so an oversized forward fails with
  a reason naming the limit rather than as an opaque provider rejection at send
  time. Both are load-bearing and documented in place.

### Tests added

`src/main/email/__tests__/EmailService.drafts.test.ts` — 7 tests on draft
retention and account/input handling: a draft survives the handoff it exists
for, an aged-out draft is collected by the next write, a recent one is not,
eviction is oldest-first and keeps the newest, a credential-less account is not
queried, a non-finite batch limit is refused before any adapter call, and an
oversized one is clamped rather than refused.

Four fail against the pre-fix file. The other three describe behaviour that was
already correct and pass either way.

---

## 7. `src/main/email/providers/ImapSmtpAdapter.ts` — done

919 lines, no tests, and the only adapter that touches a real password: generic
IMAP + SMTP for every provider without a first-class API (iCloud, Fastmail,
Proton Bridge, corporate Exchange, self-hosted). IMAP has no thread primitive,
so a "conversation" is a derived subject match — and three of the four bugs come
straight out of that derivation being used to decide what to move.

### Bugs fixed

**7.1 A message with no subject produced a thread that matched the whole
mailbox.** `encodeThreadId` base64-encoded the normalised subject, so an empty
subject encoded to the empty string. `getThreadMessages` decodes that back and
runs `client.search({ header: { subject: '' } })` — and IMAP SEARCH HEADER is a
_substring_ test, which every subject satisfies. So a subject-less message's
thread resolved to every message in INBOX and Sent, capped only by
`THREAD_WINDOW` (60).

That is not just a display problem. `resolveTargets` builds the set of messages
`applyFlag` and `move` act on out of exactly this call, so archiving one
subject-less notification would relocate up to 60 unrelated messages, and
`mark_read` would clear the inbox's unread state. Subject-less mail is ordinary
— automated notifications and bare replies both produce it.

A subject-less message now gets a thread of its own keyed by its message id
(`msg.<id>` alongside the existing `subj.<encoded>`), and `getThreadMessages`
resolves that to the single message. `decodeThreadId` also _rejects_ a legacy
empty `subj.` id rather than searching on it — those ids were mintable before
this fix and can still be persisted on a chat linked to an email thread.

**7.2 Stacked reply prefixes split one exchange into several threads.**
`normalizeSubject` stripped one prefix (`/^\s*(re|fwd?|aw|sv)\s*:\s*/gi` — the
`g` flag did nothing, since `^` without `m` only matches at position 0). Clients
accumulate prefixes, so "Re: Re: Quarterly report" kept a "Re: " and encoded to
a different thread id than "Quarterly report". A long exchange fragmented as it
grew, exactly when the thread view matters most. The prefix group now repeats.

**7.3 Archiving a conversation emptied the user's Sent folder into the
archive.** `getThreadMessages` deliberately searches Sent as well as INBOX, so
the reader sees both halves of an exchange. `applyFlag`'s archive branch then
handed that whole set to `move`, which relocated the account's own replies out
of Sent along with the inbox copy. Archiving is about the copy in the inbox;
the Sent mailbox is now excluded from the move.

**7.4 A display name containing a comma sent as two recipients.** `send()`
pre-formatted the From header as `${displayName} <${address}>`. A name like
"Doe, John" flattens into something an RFC 5322 parser reads as two addresses.
Now passed structurally so nodemailer does the quoting.

### Deliberate non-changes

- **`parseMessageId` decodes an invalid base64url mailbox to garbage rather than
  throwing**, since `Buffer.from` never rejects. The uid half is validated, and
  a garbage mailbox name fails at SELECT with a clear server error.
- **A message-keyed (`msg.`) thread cannot be un-archived.** Its id encodes a
  mailbox and a uid, and an IMAP move changes both, so the id is stale the
  moment the message is archived. This is a property of uid-based ids rather
  than of this code — every `messageId`-targeted operation shares it — and the
  failure is a clear "was not found in INBOX" rather than a wrong action.

### Tests added

`src/main/email/providers/__tests__/ImapSmtpAdapter.test.ts` — 12 tests over the
thread-identity helpers, exported for the purpose. Nine were confirmed to fail
against the pre-fix file; the three that pass either way cover behaviour that
was already correct (single-prefix stripping, subjects that merely begin with
those letters, whitespace collapsing).

### 7.5–7.6 The two items originally deferred, now fixed

Both were written up above as feature-sized rather than repairs. Taking them on
directly rather than leaving them queued:

**7.5 A sent message is now filed in Sent.** After a successful SMTP send the
message is APPENDed to the server's Sent folder with `\Seen`. Three details
carry the weight:

- The copy is composed through nodemailer, not `buildMimeMessage`. That builder
  exists for Gmail's API, which adds `From`, `Date` and `Message-ID`
  server-side, so its output would file here as a headerless message.
- The `Message-ID` is now generated up front and pinned into the mail options,
  so the filed copy carries the same one that was delivered. Threading and the
  duplicate check below both key on that header.
- Filing is best-effort and cannot fail a send. The mail is already delivered by
  the time this runs, so every failure is logged and swallowed — reporting a
  filing problem as a failed send would invite the user to send twice.

Servers that file their own copy (Gmail over IMAP, which is a large share of the
accounts reaching this adapter) would otherwise end up with two, so the Sent
folder is searched for the `Message-ID` first. That check is inherently racy
against a server still filing its own copy, so a duplicate remains possible; the
thread view already dedupes on the same header.

**7.6 `unarchive` resolves against the archive.** A thread is normally looked up
in INBOX + Sent, which is exactly where an archived thread is not — so
`unarchive` resolved to nothing and threw "That conversation has no messages",
meaning it could never undo an archive. Thread lookup now takes an explicit set
of mailboxes (`threadMessagesIn`), the reading path passes INBOX + Sent as
before, and `unarchive` passes the archive folder. The common read path is
unchanged, which was the concern that had it deferred.

Six more tests in `ImapSmtpAdapter.mailbox.test.ts`, against a fake IMAP server
that models SEARCH HEADER as the substring test it really is. Three fail against
the pre-fix file. Of the three that pass either way, one is the archive/Sent
guard from 7.3, and two — the duplicate check and the filing-failure path — pass
vacuously before the fix, because no append existed to be skipped or to fail.

---

## 8. `src/renderer/stores/chatStore.ts` — done

1,244 lines, one test file: the renderer's mirror of every conversation, and the
only place a turn in progress exists at all. That last point is what both bugs
turn on — `sendMessage` persists a turn once, at completion, so between those two
moments the user's message and the reply streaming into it live nowhere but this
store.

### Bugs fixed

**8.1 Refreshing the conversation list mid-turn destroyed the turn.**
`refreshConversations`, `restoreConversation` and `deleteConversationPermanent`
each did `set({ conversations })` with what `anodex.conversations.list()`
returned — replacing the array wholesale with what is on disk. On disk, an
in-flight turn does not exist yet.

The failure is silent from end to end. The streaming assistant message vanishes
from state; `appendToken`'s own guard then drops every later token, because it
correctly declines to write to a message it cannot find; and when `chat.send`
finally resolves, the finalize step does `messages.find((m) => m.id ===
assistantId)`, gets nothing, and returns early. `persistConversation` then writes
the conversation back **without** the turn. The user's message and the whole
reply are gone, with no error anywhere.

This is not a corner case. `useAnodexBridge` calls `refreshConversations()` from
both `onTasksChanged` and `onRunsChanged`, and `AgentRunService` broadcasts once
per turn — so leaving an agent run going in the background while chatting was
enough to erase the chat. `projectStore` refreshes on every project
create/update/delete too.

Loaded conversations are now laid over the current ones by `preserveInFlight`,
which keeps any conversation holding a streaming message — including one absent
from the loaded list, which stays until its turn finishes rather than being
pulled out from under a live reply. Conversations created elsewhere still appear,
which is the whole reason the refresh exists.

**8.2 An IPC-level rejection left the bubble streaming forever.**
`sendMessage` awaited `anodex.chat.send(...)` with no boundary. A handler error
comes back as `{ ok: false }` and is handled, but a _rejection_ — the channel
gone, the main process dead, a request field that failed to serialize — skipped
everything after it: the finalize `set()` never ran, so the message kept
`streaming: true` for the rest of the session, its quarantined tail was never
released from `pendingToolPayloadByMessage`, the conversation was never
persisted, and the conversation's queued messages never drained. The call is now
wrapped, and a rejection becomes an ordinary `err(...)` result that flows into
the existing error branch.

### Cleanups

- `appendToken` guarded `if (message?.streaming !== true) return` and then
  `if (message && convo)`. The second condition can never be false — the message
  was found by walking that conversation — so it only obscured the flow.

### Deliberate non-changes

- **`stopGeneration` stops `activeId`, not the conversation that is generating.**
  Switching chats mid-reply and hitting Stop would target the wrong one. Not
  currently reachable: the Stop control and its keyboard shortcut are both gated
  on the active conversation streaming. Recorded because the store method itself
  does not enforce what its callers happen to guarantee.
- **`editMessage` returns `{ status: 'completed' }` even if the regeneration it
  triggers fails.** The edit itself — branch, checkpoint rollback, persist — did
  complete, and `sendMessage` surfaces its own failure, so the status is about
  the right operation.
- **`pendingToolPayloadByMessage` is a module-level map** cleared on finalize and
  on tool activity. A turn that never finalizes used to leak an entry; 8.2 is
  what made that possible, and fixing it closes the leak too.

### Tests added

Four in the existing `chatStore.test.ts`, covering the refresh path. Two fail
against the pre-fix store — the preserved streaming turn, and the still-
generating conversation missing from disk. The other two pass either way and
guard the refresh's actual purpose: taking the loaded version when nothing is
streaming, and still picking up a conversation an agent run created elsewhere.

**8.2 has no automated test.** Reaching `sendMessage`'s send call from a unit
test means standing up the settings and model stores for `ensureChatReady`, plus
the notification and chime paths the result branches touch — more harness than
the eight-line change warrants, and the existing file's mock is deliberately
minimal so an unexpected bridge call fails loudly. Stated here rather than left
to look covered.

---

## 9. `src/shared/ipc.ts` — done

862 lines and no runtime logic beyond the `IpcChannel` map: a channel table plus
the `AnodexApi` type. So "correctness" here is drift, not behaviour — and the
useful audit is mechanical rather than a read for logic errors.

### What was already sound

The half of the contract TypeScript can prove is proven. The preload bridge is
declared `const api: AnodexApi`, so a missing, misspelt or wrongly-typed method
there is a compile error, and excess-property checking rejects a preload-only
extra. Nothing to add.

The channel half was checked exhaustively against the real source. All 188
channels: no duplicate strings, every one namespaced, every one referenced in
both main and preload, every preload `invoke` backed by an `ipcMain` handler, and
no hardcoded channel literal anywhere bypassing the map. The file lives up to its
own doc comment.

### Fixed

**9.1 `VerifyProviderKeyRequest.provider` restated a union it already imported.**
It listed the same eleven ids as `CloudProviderId`, which is imported twelve
lines above for `getUsageSnapshot`. Adding a provider meant editing this list
too, in a file that otherwise has no reason to change. Now `provider:
CloudProviderId` — structurally identical (both typecheck configs confirm), and
`local` stays correctly absent since there is no key to verify.

### Tests added

`src/shared/__tests__/ipcContract.test.ts` — 7 tests that read the real `src/main`
and `src/preload` sources rather than a fixture, so drift fails on the commit
that introduces it.

These pass against current code by construction, so each guard was verified by
deliberately introducing the drift it claims to catch:

| Mutation                                    | Caught by                                    |
| ------------------------------------------- | -------------------------------------------- |
| Point `Chat.stop` at `'models:list'`        | never reuses a channel string                |
| `ipcMain.handle('bogus:channel', …)`        | routes every registration through IpcChannel |
| Retarget `Conversations.getState`'s handler | main-process reference + handler-for-invoke  |

The duplicate-string guard is the one that matters most: Electron keeps only the
last handler registered per channel, so two entries sharing a string means one
feature silently stops working with no error at either end.

### Deliberate non-changes

Both were re-examined afterwards, on the question of whether either is worth
acting on. Neither is, and the evidence is recorded here so nobody has to
re-derive it.

- **`AnodexApi` mixes `Result<T>` and bare-`T` returns** — 85 against 82, with no
  visible rule. A bare method rejects on any main-side throw, pushing the burden
  onto each call site. That produces 31 fire-and-forget `void anodex.…()` calls
  with no `.catch`, which is the concrete exposure; every one was triaged. The
  handlers behind them are trivial — `win.minimize()`, `shell.openPath`, a Map
  lookup — so a rejection is not realistically reachable, and where it is, the
  cost is a console warning rather than lost work. The likeliest-looking one,
  `tools.respondConfirmation` (a silent failure there would hang a tool call
  after the user clicked Approve), resolves to
  `pendingConfirmations.get(id)?.(response)`, which cannot throw. No live
  instances; normalising 167 signatures is not justified by this.

  **Correction to an earlier version of this entry**, which cited `chatStore`'s
  8.2 as an instance of this hazard. It is not. `chat.send` returns
  `Result<ChatResult>` and still needed a `try`/`catch`, because its rejection
  came from the _IPC layer_ — channel gone, process dead, a field that failed to
  serialize — not from a handler throwing. That failure mode is identical under
  both conventions, so normalising them would not have prevented 8.2. The two
  concerns are orthogonal.

- **Main-side handler return types are not tied to `AnodexApi`.** `ipcMain.handle`
  accepts any return value, so a handler could return a shape the renderer's type
  says is impossible, with nothing complaining until runtime. All 188 channels
  were checked for a real mismatch: **zero**. (Two candidates —
  `models.discover` and `models.fetchTopModels` — were false positives; both
  delegate to functions that do return `Result<…>`, one call deeper than a
  handler-body scan can see.) Entirely theoretical, and closing it means a typed
  `handle()` wrapper across every handler file. Not worth it against a bug class
  that has never occurred here.

---

## 10. `src/renderer/features/chat/ChatCircuit.tsx` — done

956 lines of canvas animation: the "Silicon Bloom" chat background. Almost all
of it is one `useEffect` closure driving a `requestAnimationFrame` loop, so the
defects available here are not logic errors but stuck input state, artifacts,
and unbounded growth. Four of each kind, all found by reading rather than by
running.

### Bugs fixed

**10.1 A release outside the window left the drag running forever.** `probe.down`
was cleared only by `pointerup` on `window`, and a button released outside the
window never delivers one. The flag stayed set, so when the cursor came back the
player trace went on routing itself to it with nothing held down — and the only
way out was to press and release again inside the window. Now `pointercancel` is
handled too, and `pointermove` ends the drag when it sees `event.buttons === 0`.

Ending it takes a new `allowTap` argument: a real release seeds a bloom for a
press that never moved, a rescued one does not, because by then the pointer is
no longer where the user decided anything.

**10.2 The reduced-motion still opened on a frozen crowd of sparks.**
`growInstantly` fast-forwards 900 frames without drawing, and `stepGrowth`
spawns a spark on ~30% of them. Nothing decays those, because decay happens in
`drawSparks` — so the still was drawn with all ~260 (`MAX_SPARKS`) alive at once,
plus every seed ring. A single real frame never shows more than a handful. Both
pools are now cleared before the still is drawn: it should be the board, not a
snapshot of the board being drawn.

**10.3 A hand-routed trace grew without limit.** The player trace is created with
`targetSegs: Number.MAX_SAFE_INTEGER` — that is what lets it follow the cursor
for as long as the drag lasts — so a long drag grew one polyline unboundedly.
Every frame then re-stroked all of it twice (glow pass and core pass), and each
packet riding it walked the whole `cum` array linearly to place itself. Capped at
1,200 points, roughly 17,000px of routed path: past any deliberate gesture, and
still cheap to draw.

**10.4 Click-seeding had no ceiling at all.** `autoSpawn` respects `traceCap()`,
but `seedBloom` — click and drag seeding — pushed unconditionally, by design:
it is the user's board. "Ignores the cap" and "has no limit" are different
things, though, and rapid clicking reached the second. Now bounded at 1.5× the
auto-router's cap.

Traces already fading are excluded from that count. Getting this wrong is easy
and worth recording: `regrow()` fades the whole board and reseeds 600ms later,
long before any of it is actually gone, so counting fading traces would have let
a busy board find no room on regrow and leave nothing behind. The first version
of this fix had exactly that defect.

### Deliberate non-changes

- **`motionDisabled` is read at render time and the effect keys only on the
  in-app setting**, so flipping the OS reduced-motion preference mid-session
  updates neither the Pause button nor the running scene until something else
  re-renders. Real, but it is a background animation reacting late to a rare
  OS-level toggle, and wiring a media-query listener for it is more moving parts
  than the symptom is worth.
- **`pointAt` scans `cum` linearly per packet per frame.** A binary search would
  be strictly better, but 10.3 bounds the worst case, and at ordinary trace
  lengths the scan is a handful of comparisons.

### Tests: none, deliberately

Every fix lives inside a `useEffect` closure that needs a real 2D context —
`ChatCircuit` returns early when `getContext('2d')` is null, which is exactly
what jsdom gives. Covering any of this means stubbing a full fake canvas context,
`ResizeObserver` and `matchMedia`, then asserting on calls into that stub: a
large, brittle harness measuring whether the mock was driven, not whether the
board looks right. The value is not there, and pretending otherwise would be
worse than the honest gap.

Verified by reading, and offered to the user as manual checks instead (drag off
the window and release; enable reduced motion; drag a long path; click rapidly).

---

## 11. `src/renderer/features/startup/startupEngine.ts` — done

The canvas engine behind the startup overlay: a polar starfield that inhales
toward the mark and tears into a hyperspace tunnel. Pure DOM/canvas, no React,
792 lines, no tests. It runs before anything else is on screen, which is exactly
when the app is competing for memory with model loading.

### Bugs fixed

**11.1 Every `window.resize` rebuilt the entire field, unconditionally.**
`resize()` reseeds ~1,260 stars and calls `buildNebula()`, which allocates an
offscreen canvas of 1.5× the largest viewport dimension and draws five radial
gradients, a linear band, and 420 baked micro-stars into it. Measured:

| Viewport  | Nebula canvas | Bytes  |
| --------- | ------------- | ------ |
| 1440×900  | 2160²         | 18 MB  |
| 1920×1080 | 2880²         | 32 MB  |
| 2560×1440 | 3840²         | 56 MB  |
| 3440×1440 | 5160²         | 102 MB |

Nothing debounced the handler and nothing checked whether the size had actually
changed. Electron emits several resize events around window show/restore that do
not change it at all, so an ordinary launch paid that cost two or three times
over before the overlay had finished its first beat; dragging a window edge paid
it per event, with the discarded canvases piling up until GC caught them.

Two guards, which between them make the common cases free:

- `resize()` returns immediately when width, height _and_ device-pixel ratio all
  match what is already applied. That is the entire Electron show/restore case.
- `buildNebula()` reuses an existing texture that is already big enough. It is a
  decorative backdrop drawn centred at two scales, so an oversized one is
  indistinguishable from an exact one — which means shrinking a window now costs
  nothing, and growing one only pays when it passes the largest size yet seen.

**11.2 `resize()` cleared `heroes` but not `comets` or `motes`.** All three hold
absolute screen coordinates from the previous viewport; the two that were left
carried on drawing against geometry that no longer existed. `heroes` was already
being cleared here, so this was an inconsistency rather than a judgement call.

**11.3 `destroy()` left the nebula canvas referenced.** The instance becomes
collectable once its listeners are removed, so this was never a true leak — but
it is the one field big enough to be worth not waiting for GC, and the overlay
unmounts at precisely the moment the app wants that memory back for the model.
Nulled explicitly.

### Deliberate non-changes

- **The `error` phase keeps the frame loop running indefinitely.** The field
  coasts to a stop but continues to twinkle behind the recovery dialog, so this
  is a live backdrop rather than a spinning loop drawing an unchanging image.
  Bounded by user action, and stopping it would freeze the scene mid-crossfade.
- **`calmFinish()` does not cancel the frame loop.** It runs for the 600 ms of
  the crossfade and is then torn down by `destroy()` on unmount. Freezing the
  field under a fading overlay would look worse than the frames cost.
- **`handlePointerMove` can produce `NaN` if it fires while the viewport is
  0×0.** Not reachable: a hidden window emits no pointer events, and a restore
  fires `resize` before any pointer move. Left rather than adding a guard to a
  hot path for a state that cannot occur.

### Tests added

`src/renderer/features/startup/__tests__/startupEngine.test.ts` — 6 tests. The
suite runs in the `node` environment, so the narrow DOM surface the engine
touches (canvas 2D context, `window` listeners, `document.createElement`,
`requestAnimationFrame`) is stubbed in the file rather than pulling in a DOM
implementation for one test. Offscreen canvas construction is counted directly,
which is what makes the rebuild behaviour observable at all.

Three fail against the pre-fix file: a no-op resize does no work, shrinking
reuses the existing nebula, and a pure device-pixel-ratio change is handled
without rebuilding it. The other three — one build on construction, a genuine
growth rebuilds, and `destroy()` unregisters — pass either way.

---

## 12. `src/renderer/features/email/EmailView.tsx` — done

1,251 lines: the mail page and everything on it — command bar, mailbox strip,
thread list with its folded bulk runs and digest sweep, the reader, and the
resizable assistant rail. Six components in one file, no tests.

### Bugs fixed

**12.1 Picking a mailbox left the old search text in the box.** The search input
holds its own state, seeded once from the store (`useState(storedQuery)`), and
nothing synced it afterwards. `selectMailbox` sets `query: ''` in the store, so
choosing a folder cleared the search _behind_ the box while the box went on
showing the query — over a listing that was no longer filtered by it. Worse, the
× that clears a search is gated on the store's value, so it disappeared at the
same moment: the stale text could not be dismissed, only selected and deleted,
and pressing Enter re-ran a search the reader thought they had left. The input
now follows the store. Typing is unaffected — only submitting moves the store,
and syncing back what was just submitted is a no-op React bails out of.

**12.2 Two async handlers swallowed an IPC rejection.** `handleOpenWebmail` and
`AttachmentChip.handleSave` both check `result.ok`, which covers a handler
returning a failure — but not a rejection at the IPC layer, which is a different
path (see 9's write-up). Both are invoked as `void handler()`, so one escaped as
an unhandled rejection with nothing said to the user. `handleSave` was the worse
of the two: its `try`/`finally` re-enabled the button and reported nothing, so a
failed save read as "I clicked Save and nothing happened". Both now report.

**12.3 The account menu floated away from its trigger.** It is portalled to
`document.body` and positioned from a `DOMRect` captured when it opened, which
nothing updated. Resizing the window or scrolling an ancestor moved the button
and left the menu behind, over unrelated chrome. It now closes on either —
the honest response for a transient menu, rather than re-anchoring something
that is about to be dismissed anyway.

### Checked and found correct

- **Quiet-run expansion survives a refresh.** `expandedRuns` is keyed by run id,
  and ids are `quiet:${firstThread.id}` — deliberately derived from content, so
  a refresh that did not change a run keeps it open. Worth stating because
  index-derived ids here would silently reopen the wrong run.
- **`friendlyMailboxName` handles both namespace conventions** — Gmail's
  `[Gmail]/Sent Mail` and dotted `INBOX.Archive` — and `orderMailboxes` ranks on
  the friendly name, so the ordering matches what is displayed.
- **`ThreadRow`'s reveal animation is mount-gated** by `hadDigestOnMount`, so
  returning from a thread does not replay every row's reveal at once.

### Tests: none, and the reason is structural

The repo has no DOM test environment: no `@testing-library/react`, no jsdom or
happy-dom. Its one component test renders with `renderToStaticMarkup` from
`react-dom/server`, which does not run effects at all — so 12.1 and 12.3, both
of which _are_ effects, cannot be reached by the approach already in use here.
Covering them means adding a DOM stack and a first-of-its-kind harness for this
project, to test three lines of state sync and a pair of listeners. Recorded as
a gap rather than papered over.

Manual checks offered instead: type a search, run it, then click another
mailbox (the box should clear); open the account menu and resize the window (it
should close); save an attachment.

---

## Closing the cross-cutting items

The four items that outlived the file they were found in, done as one change
rather than four divergent ones — which is why they were deferred in the first
place.

**Round text ran together across tool rounds.** `content += delta` accumulated
into one turn-wide buffer, so a model that narrates before a call and answers
after it produced `Let me search.Found 3 results.` Only the node-llama-cpp path
had solved this, with a private `appendContent`.

That helper is now `@shared/roundText`'s `appendRoundText`, and all five
transports fold per round through it — the three cloud providers and the vision
transport gained a per-round buffer, and `LlamaService` dropped its private copy
so there is one definition rather than five.

The vision transport needed more than a buffer swap: it rewound `content` by
exactly the round's length to strip a fallback call, arithmetic that only held
while the two were concatenated verbatim. It now edits the round's own text
before the fold, which is both correct and simpler. Its round buffer is folded at
the top of the next iteration and once after the loop, so every `break` path
keeps the round it was in rather than needing a fold at each exit.

Three existing tests asserted a trailing space that the trim now removes; they
were about preserving earlier rounds' work, and the space was incidental.

**Verify clients had no timeout.** Both SDKs default to ten minutes — reasonable
for a generation, useless for a reachability check, so a black-holed endpoint
left "Test connection" spinning indistinguishably from a slow provider. All four
paths now use one shared 15-second ceiling. Azure needed care: its client factory
is shared with real generation, where a short ceiling would abort long legitimate
replies, so the timeout is an opt-in parameter only the verify path passes.

**Empty turns broke strict alternation.** A turn with no text and no images is
skipped when building the request — an assistant turn that errored or was
stopped is still persisted into history, so this is ordinary — which left the two
user turns either side of it adjacent. Consecutive same-role messages are now
merged rather than dropped or padded with a placeholder: nothing is lost, and the
result is what the conversation actually was. Anthropic does this server-side,
which is why only the OpenAI-compatible path needed it.

The first version of this merged inside `buildMessages`, and the new test caught
that it misses the commonest case: the current prompt is pushed _after_ that, so
history ending on a user turn plus the prompt is itself an adjacent pair. Merging
now happens once the prompt has joined the list.

**`splitHistoryByTokenBudget` cut mid-pair.** The root of 5.1, shared by every
stateless transport. The budget walk stopped wherever it ran out and, since turns
alternate, roughly half of all cuts landed immediately after a user turn —
leaving that turn's assistant reply as the first surviving one. The cut is now
aligned to a user turn, never down to nothing: a single kept assistant turn stays,
because an orphan is a smaller problem than an empty history.

`AnthropicProvider`'s own drop of leading assistant turns (5.1) is now redundant
but kept as defence in depth, and its tests still pass unchanged.

Two `contextAssembler` tests asserted how many fold-back passes the pass needed.
Alignment legitimately removes one — the orphan no longer survives the first
split, so there is nothing to fold back — and the outcome is identical with one
fewer model call. Rather than contort a fixture into forcing a pass, the test that
no longer exercises the fold-back now documents that, and the fold-back's own
assertions (a rolling update of the previous summary, not a fresh one) moved to
the fixture that still does exercise it.

### Tests added

Six: two on the round separator (text joined across rounds; a tool-only round
contributing nothing), three on cut alignment, one on strict alternation. The
orphan and alternation tests were confirmed to fail against their pre-fix files.

---

## R2.1 `src/main/tools/fileTools.ts` — done

748 lines: `list_directory`, `read_file`, `search_files`, `find_files`,
`get_file_info`, `read_file_range`, `read_multiple_files`.

**A correction to this round's own ranking.** It was placed first as the file
"the model writes, edits and deletes the user's files through". It is not — every
tool here is read-only, and the write path is `mutationTools.ts` and
`directoryTools.ts`. The ranking reasoning was wrong even though the placement is
defensible: this is the model's entire view of the workspace, and what it reads
decides what it then does.

### Bugs fixed

**R2.1.1 A line returned only in part was recorded as fully read.**
`read_file_range` bounds output to the active context budget, and a single line
too long to fit is returned truncated with `partialLastLine: true` and a note
saying so. It then recorded coverage across the whole served range including that
line. `ReadCoverageTracker.recordRange` is inclusive, so every later request for
that line short-circuited as "already read earlier this task" — the rest of it
was unreachable for the remainder of the task. `read_multiple_files` had the same
bug in its own truncation path.

Coverage is what the model has actually seen, so a cut line is no longer counted.

**R2.1.2 An exhausted budget produced an inverted range and no content.**
When nothing fit, `includedLines` was empty, `actualEnd` became `start - 1`, and
the result announced "lines 5-4 of 200" with an empty body — which reads as a
broken tool rather than an exhausted budget. It now says so plainly.

**R2.1.3 `search_files` accepted an empty query.** `find_files` rejects one;
this did not, so an empty needle matched every line of every text file and
returned whichever 100 the walk reached first, at full scan cost.

**R2.1.4 Overflow counts were floors reported as totals.** Both walks stop at a
hard cap (200 matches for search, 400 paths for find), so "… 100 more matches"
was the arithmetic of the cap rather than the truth — there might be thousands.
That is the difference between "nearly done" and "narrow your query". Now marked
`+` with a note that the scan stopped early.

### Deliberate non-changes

- **`countLines` counts a trailing newline as an extra line** (`"a
"` → 2).
  Conventionally wrong, but `read_file_range` splits identically, so the numbers
  agree with each other and with the line numbers the model is given. Changing
  one without the other is what would actually cause harm.
- **`get_file_info` decodes up to 10 MB to count lines.** Heavy for a metadata
  call, but bounded, documented, and the count is the useful part of the answer.

### Tests added

Three, all confirmed to fail against the pre-fix file: the partial-line coverage
rule, the exhausted-budget message, and the empty-query rejection. The overflow
phrasing is not covered — it is a wording change with no behavioural edge.

---

## R2.2 `src/main/tools/mutationTools.ts` — done

509 lines: `write_file`, `edit_file`, `patch_file`, `delete_file`, `move_file`.
The tools that change the user's files, each behind a prepare/confirm/commit
gate.

### Bugs fixed

**R2.2.1 `edit_file` and `patch_file` silently corrupted files that were not
valid UTF-8, unrecoverably.** They are the only tools here that read a file as
text, transform the string, and write that string back. Node replaces every
invalid byte sequence with U+FFFD on decode, so on a latin-1 source file — or
anything carrying a stray byte — that round trip rewrote bytes the edit never
referred to.

The existing binary guard does not catch this. `isLikelyBinary` keys on NUL
bytes and a control-byte ratio, and a latin-1 file has neither, so it is
classified as text and decoded lossily. And because the checkpoint stores the
same lossy string as its `before` state, restoring the turn could not recover
the original either — the bytes were gone from both the file and its undo.

Both tools now re-encode the decoded text and compare it against the bytes
actually on disk, refusing the edit when the round trip is not exact. That test
is precise rather than heuristic: it rejects invalid encoding without rejecting
non-ASCII content, so a file full of accents or emoji stays editable.

**R2.2.2 A move that destroyed an existing file did not say so.** `rename`
replaces its target outright, and the approval card read only "Move A to B" —
omitting the one consequence the user most needed to weigh, that B's current
contents were about to be gone. It now states the overwrite and the size of what
is being replaced.

**R2.2.3 The staleness check for `edit_file`/`patch_file` was weaker than
everywhere else.** The other three tools re-read the file as a `Buffer` and
compare bytes; these two compared decoded strings, behind a blanket
`.catch(() => null)` that turned any read failure — a permissions error, a path
that became a directory — into the misleading "the file changed since this edit
was proposed". All five now use the same byte-exact check.

### Deliberate non-changes

- **`write_file` overwriting an existing file is `risk: 'safe'`.** Unlike a
  move, its confirmation carries a real diff of before and after, so the
  overwrite is visible at the moment of approval. The exception is a binary
  target, where the diff is suppressed — narrow enough to note rather than
  reshape the risk model around.
- **`diffOrUndefined` returns nothing above 50,000 characters**, so a large-file
  edit is approved without a diff. Deliberate: a full before/after copy of a
  huge file bloats the persisted conversation for a diff nobody can read in a
  chat bubble. The confirmation still shows the old and new text.

### Tests added

Four. Three were confirmed to fail against the pre-fix file: the two encoding
refusals, and the move disclosure. The fourth — a valid UTF-8 file containing
accents and an em dash still being editable — passes either way, and exists to
stop the encoding guard overreaching into ordinary non-ASCII text.

---

## R2.3 `src/main/tools/emailTools.ts` — done

1,238 lines: every email capability the model has. Reading, searching,
attachments, drafting, sending, replying, forwarding, flagging, batch cleanup.

The security design here is the strongest in the codebase and worth saying so:
send, reply and forward all resolve the real message _before_ the approval card
is built, so the user approves the email rather than a description of it;
outgoing attachments are confined to the workspace or files the user attached
themselves; and every path that surfaces someone else's content — an image, a
document — frames it explicitly as text a sender chose, never an instruction.
Those are the right instincts and none of them needed changing.

### Bugs fixed

**R2.3.1 `send_email` approved one message and sent another.** The prepare step
resolves `draftId` into the real draft and merges in attachments loaded from
`attachmentPaths`, and the card shows that merged message — exactly as its own
comment describes. The commit step then called `emailService.send({ ...message,
draftId: args.draftId })`, and `EmailService.send` treats a present `draftId` as
"ignore everything else, send the stored draft". So the attachments the card had
just listed were dropped on the way out.

The commit now sends the approved message and omits `draftId` entirely, which is
what resolving before the prompt was for. The draft's own `accountId` is carried
explicitly, because `send` applied that precedence itself from the draft it
looked up and no longer sees it — without that, a draft written for a second
mailbox would have gone out from the default one. `save_email_draft` had the
same latent account bug and got the same fix.

**R2.3.2 `loadAttachments` read a file before checking its size.** The cumulative
`MAX_ATTACHMENT_TOTAL_BYTES` check ran against `data.length` _after_
`readFile`, so a multi-gigabyte file was pulled into the main process in full and
only then rejected — the ceiling protected the provider, not this machine. Sized
with `stat` first now.

### Deliberate non-changes

- **`save_email_attachment` does not disclose that it will overwrite an existing
  workspace file** — the same gap fixed for `move_file` in R2.2.2. It is a
  smaller version of it: the write is checkpointed, so it is undoable, and
  closing it means converting the tool from `runGuardedTool` to the
  prepare/confirm form so the card can know whether the path exists. Worth
  doing, listed under open cross-cutting items rather than bundled here.
- **`manage_email` and `move_email` accept neither `threadId` nor `messageId`**
  and render "Archive message undefined" on the card before the adapter rejects
  the call. Cosmetic — it fails safely — but the card should not show
  `undefined`.

### Tests

The existing draft test was updated: it asserted `send` receives
`draftId: 'draft-1'`, which was the bug encoded as an expectation. It now asserts
the resolved content and account travel instead, and that `draftId` does not —
and it fails against the pre-fix file.

One test added, and it is worth being precise about what it does not do: it
checks that attachments ride along in the send call, and it **passes against the
pre-fix code too**. The tool always put them in the request; what discarded them
was `EmailService.send` one layer below, which this file's tests mock. So the
discard itself is verified by reading, not by a test, and the updated test above
is what actually pins the fix. Labelled that way in the file rather than left
looking like proof.

---

## Round two, 1b. `src/main/tools/commandTools.ts` — done

130 lines, and the only tool that runs arbitrary shell commands on the user's
machine. Small enough to hold in one piece, which is the point of reading it
next to `fileTools.ts` rather than after the large files.

### Bugs fixed

**1b.1 A command that hit the timeout was reported to the model as
`Exit code null`.** Node kills a timed-out child with `SIGTERM`, and for
anything killed by a signal `error.code` is `null`, not a number. The old
classifier asked `typeof error.code !== 'undefined'` — and `typeof null` is
`'object'` — so `null` was passed straight through into
`` `Exit code ${code}` ``. Confirmed against Node rather than assumed:

| Ending          | `error.code`                        | `killed` |
| --------------- | ----------------------------------- | -------- |
| timeout         | `null`                              | `true`   |
| `maxBuffer` hit | `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` | —        |
| exit 3          | `3`                                 | —        |

The model was therefore told nothing about _why_ the command stopped, in the one
case where the reason is the whole story. The most likely response to
"Exit code null" is running the identical command again and spending the timeout
a second time. The `maxBuffer` case was only marginally better: a cryptic
constant, with no mention that the process had been killed or the output cut.

`runShell` now classifies the three ways a run can be killed — the caller's own
abort signal first (an abort and a timeout both surface as a killed process),
then `maxBuffer`, then any other kill as the timeout — and the result leads with
what happened and what to do differently: raise `timeoutMs`, or filter the
output. `code` is only reported when the command actually exited on its own.

**1b.2 A killed run was recorded as a failed verification.**
`parseRunCommandVerification` feeds `ProjectRecallEvent.verification`, and it
matched `exit null` as "not zero, therefore failed". "The tests failed" and "the
tests never finished" are different claims and only one of them was supported by
what happened — the first is also the one that would mislead a later turn
reading the project ledger. Killed runs now carry a reason as their `detail`
(`timed out`, `output limit`, `stopped`), which the parser declines rather than
scoring.

**1b.3 The approval card hid the timeout whenever the model did not name one.**
`describeCommand` only appended `Timeout: N ms` when `timeoutMs` was defined, so
the default 60 s — the case the person approving did not choose, and the one
most likely to surprise them when a build is killed part-way — was the one never
shown. Always shown now.

### Verified, not bugs

- **The process tree really is killed.** A timed-out `node` grandchild under the
  shell wrapper was the obvious candidate for an orphan, and an orphan of
  `npm test` would be a much worse bug than the reporting one. Checked directly
  with `Win32_Process` after a forced timeout: zero survivors. The `EBUSY` that
  surfaced while writing the test is Windows releasing the directory handle
  after the process is already gone, not a live process holding it.
- **`cwd` is never the app's own directory.** `runShell` takes
  `ctx.workspaceRoot` typed as a plain `string`, which would be a serious
  mis-scoping if a `null` could reach it — but `registry.ts:205` only registers
  this tool inside `if (ctx.workspaceRoot)`, and `WorkspaceToolContext` narrows
  the field to non-null.
- **No command is ever auto-approved.** `classifyCommandRisk` returns
  `'destructive'` for its pattern list and `'sensitive'` for everything else —
  never `'safe'` — so every command goes through the approval gate regardless of
  how harmless it looks.

### Tests

`src/main/tools/__tests__/commandTools.test.ts` — 3 added (15 total). Two fail
against the pre-fix file: a real command run with a 1 s timeout now says it timed
out instead of `Exit code null`, and the approval card shows the default timeout.
The third — the parser declining a killed run — passes either way, because the
old code never produced those `detail` strings for it to see; it is a contract
guard for the new ones, and is labelled as such rather than counted as proof.

One harness change came with them: the `afterEach` cleanup is now best-effort.
These tests spawn real processes into the temp workspace, and on Windows a
directory that has just hosted a killed child stays locked briefly after it
exits. Failing a passing test over temp-directory housekeeping would be
reporting the wrong thing.

---

## Round two, 4. `src/main/checkpoints/CheckpointStore.ts` — done

436 lines: the undo for everything files 1–3 can do to a workspace. Every
`write_file`, `edit_file`, `patch_file` and `run_command` side effect is recorded
here, and this is the only path back.

### Bugs fixed

**4.1 One damaged checkpoint file failed writes that had already succeeded.**
`readFile` did a bare `JSON.parse`, and `list()` was the only one of its five
callers that guarded against a throw — its own comment says "one damaged
checkpoint should not hide the rest of the project history". The other four
inherited nothing, and the consequences ran in the worst possible direction:

- `recordChange` reads the existing checkpoint _after_ `runGuardedTool` has
  written the file to disk (`helpers.ts:369` runs `spec.run()`, then `:378`
  records). A throw there reported a `write_file` that genuinely succeeded as a
  failure — and the likeliest response to that is writing it again. Once one
  file was damaged, every later write to the same message failed the same way.
- `getSummary` is called unguarded at the end of every turn
  (`runGeneration.ts:624`), so a single bad file failed whole turns after all
  their tool work was already done.
- `restore`/`inspect`/`undoRestore` surfaced a raw `SyntaxError` rather than a
  sentence about checkpoints.

`readFile` now returns `null` for anything unusable and moves the file aside as
`.corrupt` — it stops poisoning every later read, and this is the undo system,
so the bytes are kept rather than silently overwritten.

**4.2 A file that parsed but was not a checkpoint became a garbage history
entry.** The change list and `restoredPaths` were validated; the identity fields
were not. `{}` is valid JSON, so it survived `JSON.parse` and produced an entry
with `undefined` for its message id and `createdAt`, which then sorted as `NaN`
against every real entry in `list()`. `normalizeCheckpoint` now requires the
conversation id, message id and a finite `createdAt`, and rejects the file
otherwise.

**4.3 A restore that failed part-way recorded that nothing had been restored.**
`restore`, `undoRestore` and `rollback`'s inner loop all wrote files one at a
time and persisted the result only after the loop finished. A write that threw
mid-loop — a file open in an editor on Windows, a permission, a full disk — left
some files correctly put back on disk while the checkpoint still claimed none of
them were. The retry then ran `hasStateConflict` against those files, found the
_before_ state where it expected the _after_ state, and reported a conflict on
precisely the files that had already been restored correctly.

All three now persist from a `finally`, through a shared `persistProgress` that
swallows its own write failure — called from a `finally`, it must not replace
the real error (the write that failed) with a less useful one about recording it.

### Verified, not bugs

- **Restore cannot escape the workspace.** `writeState` and `readState` both go
  through `resolveInWorkspace`, which rejects `..` traversal _and_ calls
  `assertRealPathInside` for symlinks — so a hand-edited checkpoint naming
  `../../../etc/passwd` is refused rather than written.
- **`sanitizeId` collapsing distinct ids onto one filename** (`a.b`, `a/b` and
  `a_b` all become `a_b`) is unreachable: conversation and message ids are
  generated by the app as `m_<base36>_<random>` and already contain nothing the
  regex touches. It is doing its real job, which is blocking traversal in a path
  segment.
- **`writeState` leaves empty parent directories behind** after restoring a
  deletion. Cosmetic, and removing directories on the undo path is a good deal
  riskier than leaving them.

### Tests

`src/main/checkpoints/__tests__/CheckpointStore.test.ts` — 4 added (19 total),
all four confirmed failing against the pre-fix file: a corrupt file no longer
fails a completed write (and is moved aside), `getSummary` reports no checkpoint
rather than throwing, `{}` is rejected instead of becoming a history entry, and
a restore that fails part-way records the files it did put back.

The partial-failure test makes the write fail for real rather than by mocking —
`node:fs` exports cannot be spied on under ESM — by recording `nested/second.ts`
and putting a regular _file_ at `nested`, so the `mkdirSync` for its parent
fails exactly the way a locked file or a full disk would.
