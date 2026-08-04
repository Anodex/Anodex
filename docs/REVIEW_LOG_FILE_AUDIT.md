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

| #   | File                                                                          | Lines | Tests   | Status  | Why it ranks here                                           |
| --- | ----------------------------------------------------------------------------- | ----- | ------- | ------- | ----------------------------------------------------------- |
| 1   | `src/main/tools/fileTools.ts`                                                 | 748   | 1 → 4   | ✅ done | The model's whole read view of the workspace                |
| 1b  | `src/main/tools/commandTools.ts`                                              | 130   | 1 → 3   | ✅ done | Runs arbitrary shell commands                               |
| 2   | `src/main/tools/mutationTools.ts`                                             | 509   | 2 → 6   | ✅ done | The write path proper                                       |
| 3   | `src/main/tools/emailTools.ts`                                                | 1238  | 1 → 3   | ✅ done | Sends real mail on the user's behalf — irreversible         |
| 4   | `src/main/checkpoints/CheckpointStore.ts`                                     | 436   | 4 → 8   | ✅ done | The undo for all of the above                               |
| 5   | `src/main/llama/LlamaVisionService.ts`                                        | 1257  | 1 → 3   | ✅ done | Local vision transport, never read end to end               |
| 6   | `src/main/llama/contextShiftStrategy.ts`                                      | 979   | 2 → 3   | ✅ done | Mid-generation context surgery                              |
| 7   | `src/main/criticalThinking/CriticalThinkingService.ts`                        | 2024  | 3 → 4   | ✅ done | Largest unreviewed file; long unattended runs               |
| 8   | `src/main/criticalThinking/CriticalThinkingResearchRunner.ts`                 | 1398  | 1       | ✅ done | Drives the research loop                                    |
| 9   | `src/main/tools/webTools.ts`                                                  | 598   | 3 → 6   | ✅ done | Fetches untrusted content the model then acts on            |
| 10  | `src/main/email/providers/MicrosoftAdapter.ts`                                | 528   | 0 → 5   | ✅ done | The unreviewed third mail adapter                           |
| 11  | `src/renderer/features/chat/ChatComposer.tsx`                                 | 690   | 0 → 8   | ✅ done | Every message starts here                                   |
| 12  | `src/renderer/features/settings/pages/ai-models/ProviderConnectionsPanel.tsx` | 867   | 0 → 7   | ✅ done | Handles API keys                                            |
| 13  | `src/main/tools/helpers.ts`                                                   | 501   | 44 → 47 | ✅ done | Best-covered module in the tree; read at the user’s request |

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
| `save_email_attachment` does not disclose an overwrite      | R2.3     | ✅ fixed          |

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

---

## R2.5 `src/main/llama/LlamaVisionService.ts` — done

1,257 lines: the llama-server transport, which every local model with a
multimodal projector runs on — text-only chats included, since `LlamaService`
routes the whole turn here the moment a projector is loaded.

Its context accounting is the most careful in the codebase and deserves saying
so: it measures with the model's own tokenizer, _adds_ estimates for the two
things `/tokenize` structurally cannot see (chat-template framing, projector
image cost) rather than omitting them, and reclaims in-turn room from old tool
results in graduated tiers rather than dropping them. None of that needed
changing.

### Bugs fixed

**R2.5.1 A first-round failure threw away text the user had already watched
arrive — and I introduced it.** When the cross-cutting round-separator change
moved this transport from `content += delta` to a per-round buffer folded at the
round boundary, the guard below the stream became wrong:

```
if (!content && !hadAnyToolAttempt) throw described
```

While streaming wrote straight into `content`, a round that produced text before
failing self-evidently had something to keep. Once the fold moved to the
boundary, round 0's text lived only in `roundContent`, so `content` was still
empty at the catch and the turn threw — discarding the reply mid-flight instead
of reporting a stop with it intact. I added exactly this fold to the catch of
all three cloud transports and did not carry it here.

The existing "keeps the work of earlier rounds when a later one fails" test
could not catch it: it fails a _later_ round, by which point the earlier rounds
have already folded.

**R2.5.2 History images were selected oldest-first.** `buildMessages` walks
history forwards and spent the four-image budget as it went, so on a
conversation with more than four pictures the model received the earliest ones
and never saw the one just sent. A follow-up question about a screenshot was
answered against screenshots from five turns earlier. The carried set is now
chosen by walking backwards before rendering — which is what the cloud
transports' `reopenRecentHistoryImages` does, and what its name says.

### Deliberate non-changes

- **`outputTokens` falls back to a character estimate only when the total is
  still zero.** A server that reports usage on round 0 but not on round 1 leaves
  round 1's output uncounted. Stats-only, and it needs a server that reports
  inconsistently across rounds within one turn.
- **The truncated-tool-call recovery pushes a `user` message after a `user`
  message** when it fires on round 0. llama.cpp's templates tolerate it, and the
  alternative — synthesising an assistant turn for a round whose only output was
  an unparseable call — would put invented content in the transcript.

### Tests added

Two, both confirmed to fail against the pre-fix file. The mock harness gained
the ability to stream chunks _and then_ fail, which is the real shape of
llama-server being killed part-way through a reply and the only way to exercise
what happens to text the user has already seen. Image selection is covered by
partially mocking only the disk read, so the selection logic itself stays real.

---

## R2.6 `src/main/llama/contextShiftStrategy.ts` — done

979 lines replacing node-llama-cpp's default context-shift strategy, which
throws outright when a turn's own system prompt plus latest exchange cannot be
shrunk further. Two levels: whole older exchanges folded into a rolling summary,
and — for a single oversized turn — the function calls _inside_ one model item
trimmed in five graduated passes.

The correctness reasoning here is the most careful in the codebase. Fit
decisions use full costs while summarizer chunking uses preview costs, and the
doc explains that conflating them was a real bug. Metadata is validated
field-by-field because node-llama-cpp hands back a _foreign_ shape after any
shift where it fell back to its own strategy. `foldIntoRollingSummary` is
documented as never returning empty precisely because callers advance durable
coverage cursors after it. I went looking for a data-loss path through the
coverage cursor and there isn't one — the read-side guard in `readMetadata`
refuses a cursor without its summary, which makes a failed fold self-correcting
on the next shift.

### Bug fixed

**R2.6.1 One shift re-tokenized the same strings tens of thousands of times.**
`totalCost()` sits in the _loop condition_ of each of the five trim passes, so
every pass is O(parts²) in tokenizer calls. `fitExchange` then re-runs the whole
trim once per refinement pass, again per binary-search probe, and again after
every evidence fold — and the strings being measured are overwhelmingly the same
untouched ones each time.

Measured rather than assumed, on the shape this module's own doc cites (one
model item, 38 tool calls, 2 KB results — the failed Critical Thinking run):

|        | tokenizer calls | characters tokenized |
| ------ | --------------- | -------------------- |
| before | 9,586           | 3,731,566            |
| after  | 118             | 139,517              |

All of it inside node-llama-cpp's generation loop, mid-turn, while the user
waits — and this module exists _because_ of that exact shape, so the worst case
is the expected case. Fixed by memoising `countTokens` for the duration of one
shift: `tokenizer` is pure for the session, the cache dies with the call, and it
is bounded so a pathological history degrades to today's behaviour rather than
becoming a memory problem instead of a time one. No algorithm changed.

### Deliberate non-changes

- **`newestExchangeTrimDetails` sets both `trimmedUserMessage` and
  `trimmedAssistantResponse` when the item counts differ.** They cannot differ —
  the trim passes never add or remove items — so this is unreachable defensive
  code that would mislabel if it ever fired. Left alone: making it reachable-
  correct means guessing at a case that does not occur.
- **The refinement loop and the binary search both re-derive the fitted history
  from scratch** rather than narrowing incrementally. With counting memoised
  this is cheap, and the from-scratch derivation is what makes each probe
  independent — worth more than the saving.

### Tests added

One, confirmed to fail against the pre-fix file: 31,348 tokenizer calls against
a bound of 1,000, on the same pathological shape. The bound is deliberately
loose — it pins the order of magnitude, not a count, so ordinary changes to the
trim passes stay free. It also asserts the result still fits, so the guard
cannot be satisfied by simply measuring less.

---

## Round two, 7. `src/main/criticalThinking/CriticalThinkingService.ts` — done

2,024 lines and the largest file in the audit: planning, breadth-first research
waves, single-pass synthesis, hierarchical recovery, a consistency review, chart
selection, and a deterministic fallback — all inside runs that go unattended for
up to an hour.

The file is unusually well documented. Nearly every branch carries the live
failure that produced it ("a run holding 53 verified sources and 119 evidence
artifacts finished with an empty report because the model spent its entire
output budget on hidden reasoning"), and its governing principle is stated
repeatedly: a run that gathered evidence must never finish with nothing to show
for it. The bug below is the one place that principle is not applied.

### Bug fixed

**7.1 Hierarchical recovery discarded every section it had finished the moment
a later stage was cut short.** `runHierarchicalSynthesis` builds one
citation-checked section per research step, then reviews them for consistency
and asks for a cross-section overview. Four stages can end on a
non-recoverable stop — a section, a section repair, the consistency pass, the
overview — and all four returned `candidate: null`, throwing away the sections
already written.

The cost is concentrated by when this path runs at all. Hierarchical recovery
is only entered _after_ a draft has already failed validation and consumed part
of the budget, so the run's time limit landing part-way through is the ordinary
case rather than an exotic one. A run that produced good sections for five of
six steps therefore contributed nothing, `candidate` stayed as the failed draft,
and the report fell through to the deterministic bullet-dump — with the real
sections sitting complete and unused in a local `Map`.

The overview case is the clearest: the line immediately after that early return
assembles a report with `overview: null`, and `assembleHierarchicalReport`
already skips steps with no section and already synthesises its own summary and
conclusion when it has none. The salvage path existed and was simply not reached.

All four exits now assemble whatever sections exist and return that. Nothing is
forced: the caller scores the result against the existing draft with
`chooseBetterReportCandidate`, so a thin partial loses rather than replacing a
better report, and the stop reason still travels with it so the run is reported
`partial` rather than `completed`.

### Verified, not bugs

- **`activeRunId` cannot leak on the early return in `runResearch`.** The
  `!initialRun.plan` guard returns before `activeRunId` is ever assigned, so the
  missing `clearActiveRun()` on that path clears nothing that was set. Both
  `runPlanning` and `runResearch` assign it synchronously before their first
  `await`, so the `if (this.activeRunId) throw` guards in `start`/`approve`/
  `resume` cannot be raced by the `void`-invoked call that precedes them.
- **The research and synthesis timers cannot both be live.** `runResearch`
  clears the research timer before re-arming for synthesis, and the `finally`
  clears whichever is current. Synthesis is guaranteed its reserve even when
  research overruns, which is the documented intent.
- **`run.plan!` in `runSynthesis`** is a non-null assertion on a value re-read
  from the store rather than the one already checked. Reachable only if `plan`
  were cleared mid-run, which nothing does — `approve` and `resume` both write it
  before starting. Left alone rather than restructured for a state that cannot
  occur.

### Tests

`CriticalThinkingService.test.ts` — 1 added (29 total), confirmed failing
against the pre-fix file: two finished sections survive an overview that is cut
short by the run's time limit, the assembler supplies its own overview in place
of the one that never arrived, and the run is still reported `partial` because
it genuinely was cut short.

The existing suite is strong here — 28 tests already covering the draft/repair/
hierarchical/chart/fallback paths, several named after the exact live failures
in the handoff docs. The gap was narrow and specific: every test drove stages
that completed, so nothing exercised a stage that stopped part-way.

---

## Round two, 8. `src/main/criticalThinking/CriticalThinkingResearchRunner.ts` — done

1,398 lines executing one plan step as persisted, resumable phases: choose
queries, search, read, assess. Every phase is checkpointed, every network
operation is cancellable and concurrent, and the whole thing is written so that
a dead round cannot unwind the investigation — the failure this file exists to
prevent.

That discipline holds throughout. The bug is in what it hands back.

### Bug fixed

**8.1 A run could be resumed but would do no research.** `pauseStep` and
`limitStep` mark a step `'limited'` for every termination reason except a user
Stop. That includes the run-level budgets — `time-limit`, `tool-limit`,
`evidence-limit`, `rounds-exhausted` — which say nothing about the step being
exhausted, only that the _run_ ran out.

`CriticalThinkingService.runResearchWaves` treats `'limited'` as terminal, and
`resume` rebuilt only `status`, `report`, `synthesisDiagnostics` and
`lastError`; step statuses were never cleared, and `createStepStates` is called
only from `approve` and planning. So the ordinary case — a long run that hits
its research time budget and finishes `partial` — presented a Resume button
that skipped every step, found `pendingIndexes` empty, returned immediately, and
went straight to re-synthesising the same evidence into the same report.

The fresh budget was already there: `runResearch` resets `usage` to zeros on
every call. Only the statuses were holding it shut.

`resume` now reopens every step that did not complete. Safe rather than
optimistic: the per-step lifetime cap is checked inside `run()` against
`spentRoundCount(step)`, which derives from persisted `rounds` — preserved here —
so a step that genuinely used its whole allowance re-limits itself immediately
without spending anything. Completed steps keep their findings and are never
revisited.

The fix lands in `CriticalThinkingService.ts` (file 7) because that is where
`resume` lives, but it belongs to this file's row: the runner is what assigns
`'limited'`, and reading it is what made the asymmetry visible.

### Verified, not bugs

- **`createLinkedTimeout` distinguishes its own timeout from an outer abort.**
  `timedOut()` is what lets `abortReason()` report `time-limit` rather than
  `user`, the outer signal's reason propagates through, and `dispose()` clears
  the timer _and_ removes the listener — so a step that finishes early leaves
  nothing armed.
- **`everyOperationFailed` requires `results.length > 0`**, so a round that
  attempted nothing is not misread as a round where everything failed. Its
  callers `limitStep` rather than throwing, which is the specific guard against
  a dead round unwinding the run.
- **Search and fetch counters increment inside the worker, not when the batch is
  reserved.** A timeout can stop the queue before every reserved item starts;
  charging unstarted work would silently consume the next step's budget.
- **`spentRoundCount` derives the per-step cap from persisted rounds**, not a
  per-invocation counter — required for correctness under the wave scheduler,
  which calls `run()` repeatedly for the same step.
- **`readRound` captures `run`/`step` once and uses them inside the concurrent
  fetch workers**, where `searchRound` re-reads through `this.deps.getRun()`.
  Inconsistent, but not a bug: the captured values are the question text, the
  step title and the step id, none of which can change while a single round's
  fetches are in flight.

### Tests

No test was added to this file's own suite. The behaviour the fix changes is
`resume`'s, so the test lives with it in `CriticalThinkingService.test.ts` — a
run whose second step was limited by `time-limit` comes back researchable while
the completed first step keeps its finding. Confirmed failing against the
pre-fix file.

That is also the honest description of this file's coverage: one suite exercises
the runner directly, and it is thin relative to 1,398 lines of budget and
termination logic. Nothing further was added here because nothing further was
found to be wrong — the gap is worth noting rather than filling speculatively.

---

## Round two, 9. `src/main/tools/webTools.ts` — done

598 lines fetching arbitrary URLs at the model's request. It ranks here because
it is the boundary where untrusted content enters, and the bug found is not the
one that ranking implies.

### Bug fixed

**9.1 A response whose body was never read stalled the fetch for 30 seconds and
then reported a timeout that had not happened.** `fetchUrl` follows redirects
manually, one hop at a time, pinning each hop's connection to a pre-validated
address through its own `undici.Agent`. Each hop's `finally` calls
`dispatcher.close()`, which waits for the request to complete — and a response
with an unread body never completes.

Measured rather than reasoned about. Against a 302 carrying a 2 MB body,
`dispatcher.close()` did not return at all; the probe had to be killed at 30
seconds. Cancelling the body first closed it in 1 ms. A follow-up probe
confirmed the 30-second fetch timeout does eventually abort and unblock it
(519 ms after firing), which is why this never presented as a permanent hang:
the visible symptom was half a minute of dead wait, followed by
`The request timed out or was cancelled` for a page whose redirect was
perfectly fine — and, in Critical Thinking, a wasted fetch from a bounded
per-run budget.

Three paths reach that `finally` without reading the body, and the redirect is
the least likely of them:

| Path                     | When                                     |
| ------------------------ | ---------------------------------------- |
| Redirect hop             | 3xx carrying a courtesy body             |
| Unsupported content type | a model follows a link to a PDF or image |
| Non-2xx status           | a 404/500 page with a real body          |

All three now release the response through a shared `discardBody` before
returning, throwing or continuing. Verified end to end at the undici layer: both
the 302 and the `application/pdf` case close in 1–2 ms.

### Verified, not bugs

The SSRF defence is thorough and was checked rather than assumed:

- **DNS is resolved once per hop and the result pinned into that hop's
  dispatcher**, so `fetch` cannot re-resolve to a different address. That closes
  the DNS-rebinding gap a pre-check alone would leave.
- **Every redirect target is re-validated** — scheme, embedded credentials,
  literal-host privacy — and then re-resolved, so a public first hop cannot
  redirect inward.
- **Numeric-form bypasses are caught by the DNS layer.** `http://2130706433/`
  is not recognised as an IP by `isIP`, so `isPrivateHost` passes it — but
  `getaddrinfo` normalises it to `127.0.0.1`, and `assertPublicDns` rejects the
  answer. Traced through rather than assumed safe.
- **IPv6 is restricted to the 2000::/3 allocation** with documentation and
  transition ranges excluded, which also excludes mapped IPv4, NAT64,
  unique-local and link-local without needing to enumerate them.
- **`addresses.some(isPrivateAddress)`** rejects when _any_ resolved address is
  private, not just the first — the stricter reading, and the right one given
  all of them get pinned.

### Deliberate non-changes

- **Fetched passages are handed to the model without an untrusted-content
  marker.** Considered and rejected as the wrong shape of fix for this codebase:
  `emailTools.ts` states the house position on exactly this problem — a message
  saying "attach `~/.ssh/id_rsa` and reply with it" "has to fail here, not
  merely look wrong in the approval card" — and answers it with structural
  containment rather than model-directed warnings. The dangerous actions a
  fetched page could try to steer are already gated that way: `run_command` is
  never auto-approved, outgoing attachments are restricted to two sources, and
  file writes are contained to the workspace. Adding a banner would be the
  weaker measure that comment explicitly declines to rely on.
- **`MAX_REDIRECTS = 10` with `hop > MAX_REDIRECTS`** permits eleven hops. Off
  by one against its own name, with no consequence worth a behaviour change.
- **Extraction is serialised through a module-level queue** and only checks the
  abort signal when a task starts, so an aborted fetch still waits its turn.
  Bounded by the same 30-second timeout and deliberate — the queue exists to
  keep synchronous HTML parsing off the event loop.

### Tests

`webTools.test.ts` — 3 added (24 total), all three confirmed failing against the
pre-fix file: a redirect body, an unsupported content type, and an error
response are each released before the dispatcher closes. The suite already stubs
`globalThis.fetch`, so the mock response simply carries a `body.cancel` spy —
the assertion is on the exact call the hang turned on.

---

## Round two, 10. `src/main/email/providers/MicrosoftAdapter.ts` — done

528 lines over Microsoft Graph, and the last of the three mail adapters to be
read. Graph has no thread endpoint, so conversations are assembled by filtering
on `conversationId` — which is where both defects live.

**Its test count was wrong, and in the worst direction.** The table credited it
with two; both are `vi.mock('../providers/MicrosoftAdapter', …)` stubs inside
`EmailService`'s suites, which name the class without exercising a line of it.
It had no coverage at all. That is the same counting caveat this document
already carries for round one — mentions are not tests — reappearing in a row
that was measured against the real test tree. Corrected to `0 → 5`.

### Bugs fixed

**10.1 A folder-scoped search silently searched the entire mailbox.**
`listThreads` resolved `options.mailbox` into a folder id — paying the
round-trip, and throwing for an unknown name — and then used it only on the
non-query path:

```ts
const path = options.query
  ? `/messages?${params}` // folder discarded
  : `/mailFolders/${folder}/messages?${params}`
```

`EmailService.previewBatch` is the caller that passes both, and it is the one
where it matters: it exists so a user can see what a batch action matched before
approving it, precisely because "a query that is one character off would
otherwise sweep the wrong mail with the same single click". On Outlook, asking
to archive everything matching a query _in one folder_ previewed matches from
every folder, and `applyBatch` then acted on exactly those ids.

Graph does support `$search` inside a folder, so the scope simply belongs on
both paths. Guarded against over-correcting: with no mailbox named, a query
still searches the whole mailbox and a plain listing still means the inbox.
Narrowing ordinary search to the inbox would have been a regression dressed as
a fix, and there is a test pinning each of those.

**10.2 A bulk action on a long thread silently acted on the first 50 messages.**
`targetMessageIds` expanded a thread target through `getThreadMessages`, which
caps at `$top: 50` because it fetches bodies for the reading pane — a sensible
limit for reading, and the wrong one for archiving. A mailing-list thread past
50 messages was part-moved, and the result string reported the count it _had_
moved as though that were the whole conversation.

Thread targets now resolve through their own ids-only query at a 500 ceiling.
Keeping the two separate is the point: the reader wants few messages with
bodies, a bulk action wants every id and no bodies.

### Verified, not bugs

- **`unarchive` can find an archived thread here.** The sibling adapter had
  exactly this defect (fixed in `3181e07`), so it was the first thing checked.
  Graph's `/me/messages` spans folders, and `targetMessageIds` filters on
  `conversationId` without a folder segment — so a thread sitting in Archive
  resolves normally and the move back to the inbox works.
- **Sent mail is filed.** `send` sets `saveToSentItems: true`, which is the
  other defect the IMAP adapter had.
- **`resolveFolderId` short-circuits the well-known names** before listing
  folders, so the common cases cost no extra request, and an unknown name fails
  with the available folders named rather than a bare rejection.
- **`fetchInlineImages` swallows its own failure and returns `[]`**, so a
  missing inline image degrades the rendered body instead of failing the read.

### Tests

`src/main/email/providers/__tests__/MicrosoftAdapter.test.ts` — 5 tests, the
first this adapter has had, asserting the requests it puts on the wire (Graph
mocked at `fetch`, as `webTools.test.ts` does). Two fail against the pre-fix
file — the folder-scoped search and the 120-message thread action. The other
three are the guards that stop the first fix overreaching: unscoped search stays
global, a bare listing stays on the inbox, and a thread that resolves to nothing
is still refused.

## Round two, 11. `src/renderer/features/chat/ChatComposer.tsx` — done

690 lines, no tests, and the first renderer file in this review. Every message
the app sends starts here. The two defects are both in the gap between what the
component decides and what it applies.

**Renderer tests here cannot drive a component.** The vitest environment is
`node` and there is no Testing Library or jsdom; the existing `.test.tsx` files
under `features/chat/__tests__` use `renderToStaticMarkup`, which runs one
initial render — no effects, no refs, no events. So a fix whose whole substance
is _sequencing across an await_ could not be verified in place. `attachFiles`
moved to `src/renderer/lib/attachments.ts` as `intakeAttachments`, taking its
list access and file reads as parameters. That is what made the interleaving
testable, and it thins the component by ~60 lines.

### Bugs fixed

**11.1 Two attachment passes racing each other doubled the cap and produced
duplicate React keys.** `attachFiles` read the list once, before its loop:

```ts
let currentCount = attachments.length
const seenPaths = new Set(attachments.map((a) => a.path))
for (const { path, name } of candidates) {
  if (currentCount >= MAX_ATTACHMENTS) { … }
  if (seenPaths.has(path)) continue
  const result = await anodex.attachments.readFile(path)   // yields
```

Correct for one pass. There is nothing that limits it to one. `handleDrop` and
`handleAttachClick` both call it as `void attachFiles(…)`, and it awaits an IPC
read per file — so a second drop, or the picker, starts its own pass while the
first is parked. `attachments` is a `useState` closure value, so both passes
measure the list as it was before either added anything:

- **The cap is enforced twice against the same zero.** Ten files dropped twice
  gave twenty attachments. Measured: the pre-fix algorithm admits 20 where the
  limit is 10.
- **The same file clears both passes' duplicate checks.** This is the damaging
  one. `path` is the list's React key (`key={attachment.path}`) _and_ the only
  thing `removeAttachment` filters on — so two entries sharing a path render as
  duplicate keys, and clicking remove on either deletes both.

The fix mirrors the list in a ref written synchronously at each commit, and
re-reads it _after_ the await rather than only before. Everything from that
re-read to the commit runs without yielding, so it is the one point where the
list a decision is made against is still the list it is applied to.

While in there, the overflow notice was corrected. `Only the first 10 files were
added` was wrong in both directions: it claimed ten additions when the list was
already full and none were added, and still said ten when two of five had fit.
It now names the limit — the one thing it actually knows — once per pass rather
than once per skipped file.

**11.2 While generating with text typed, there was no way to stop, and nothing
said so.** The send controls are a three-way:

| State                       | Button |
| --------------------------- | ------ |
| `generating && !hasContent` | Stop   |
| `generating && hasContent`  | Queue  |
| otherwise                   | Send   |

Typing a correction mid-reply — exactly when a user wants to interrupt — swaps
Stop out for Queue. `useGlobalKeyboardShortcuts` does keep Esc-to-stop live
inside the composer, deliberately and with a comment saying why, so the
capability is there. It just was not discoverable: the generating hint read
`Enter to queue for after this reply · Shift+Enter for a new line · …` and never
mentioned it. The hint now names the binding, read from
`settings.keyboard.shortcuts.stopGeneration` so a remapped shortcut is not
advertised as Escape.

### Assessed, not changed

- **`Escape` clears the composer while slash suggestions show**, and its
  `preventDefault` also blocks Esc-to-stop for that keystroke. Bounded to
  near-nothing: `getSlashCommandSuggestions` returns matches only for a bare
  `/word` with no whitespace, so at most a few characters are lost, and a second
  Esc stops generation. Giving the menu its own dismissed-state to close instead
  is a feature change, not a fix.
- **`chatStore.compactConversation` and `stopGeneration` do not wrap their
  `ipcRenderer.invoke` calls**, so an IPC-level rejection becomes an unhandled
  rejection with no toast — the exact failure `sendMessage` already documents and
  guards at `chatStore.ts:613`. Real, but it is a `chatStore` defect found from
  next door; recorded here rather than fixed under file 11.
- **`dragCounter` is not reset on `dragend`.** Enter/leave/drop already balance
  it in every path the OS actually produces.
- **The internal-drag `JSON.parse` is guarded but the `getAbsolutePath` promise
  after it is not.** The payload is written by Anodex's own Files panel, so a
  malformed shape is not reachable from outside the app.

### Tests

`src/renderer/lib/__tests__/attachmentIntake.test.ts` — 8 tests, the first
coverage this logic has had. Three fail against the pre-fix algorithm
(re-inserted verbatim to check, then reverted): the duplicate-path race, the cap
race (20 vs 10), and the overflow wording. The other five pin the behaviour the
fix had to preserve — text and image intake, a failed read reported once without
ending the pass, an already-attached path skipped, images refused without a
vision model, and the image cap holding independently of the overall cap.

## Round two, 12. `src/renderer/features/settings/pages/ai-models/ProviderConnectionsPanel.tsx` — done

867 lines, no tests, twelve providers. Both defects are places where the panel
displays something it never actually checked.

### Bugs fixed

**12.1 Eight providers share one conditional slot, so switching between them
carried the previous one's state over.** The detail pane is four sibling
conditionals — `local`, `openai`, `anthropic`, `azure` — plus one that covers
all eight simple cloud providers:

```tsx
{
  isSimpleCloudProvider(selected.id) && <div className={styles.providerFields}> … </div>
}
```

Switching `openai → anthropic` moves between two different slots, so React
unmounts one and mounts the other. Switching `google → xai` does not: same
position, same element type, no key, so React reconciles it as the same subtree
and keeps its children's state alive. Two components in there hold state:

- **`DailyCapInput` seeds its text once, at mount** — it has no resync effect,
  unlike `MaxResponseTokensRow` twenty lines above it, which does. So a daily
  token cap of 50,000 entered under Google was still sitting in the field under
  xAI, whose real cap was null or something else entirely. Nothing writes, so
  the mismatch just persists as a wrong number on a spend-limit control; edit
  the field at all and the new value is committed to the provider from a
  starting point that was never theirs.
- **`ApiKeyField` auto-verifies once per mount.** With no remount, selecting a
  different provider never triggers it: a saved, valid key reads "Unverified"
  until the user clicks Test. Its in-flight `checking` flag carries over too, so
  switching mid-check showed the new provider's dot as "Checking…" for the
  previous provider's request.

Fixed at the root with `key={selected.id}` on the shared block, which restores
the unmount/mount the other four slots get for free. The key was preferred over
adding a resync effect to `DailyCapInput`: the effect would fix only the cap
display, leave both `ApiKeyField` symptoms, and introduce a
commit-round-trip-versus-typing race the component does not currently have.

The API key text itself was never at risk — `ApiKeyField` renders `value`
straight from settings with no local draft, so no key was ever shown under
another provider's name.

**12.2 The "Active provider" card claimed "Ready" without checking anything.**
It was the literal string:

```tsx
<span className={styles.providerReady}>
  <span /> Ready
</span>
```

`providerConnected` already exists in this file and is what the catalog list and
the detail pane both use; this card simply did not call it. Clearing the active
provider's API key is doable a few rows below without changing which provider is
active, and left the card saying Ready while `ChatComposer` disabled itself and
told the user to add a key. It now reads `providerConnected(active.id, settings)`
and says "Not connected" otherwise, in `--danger` — the active provider missing
its credentials blocks chat outright rather than being a soft warning. The dot's
halo moved from a hardcoded `var(--success)` mix to `currentColor` so the
modifier only has to set the text colour.

### Assessed, not changed

- **`MaxResponseTokensRow`'s toggle loses the previous number.** Turning it off
  commits `null`, so turning it back on always restores
  `DEFAULT_MAX_RESPONSE_TOKENS` — the doc comment's "if the provider has never
  had one" describes an intent the toggle cannot deliver, since it destroys the
  old value on the way out. Cosmetic, and holding the old value across an off
  state needs somewhere to keep it.
- **`parseDailyCapInput` silently ignores `0`, negatives, and non-numeric
  text** — no commit, no message, the field keeps showing what was typed. It
  errs toward not writing a bad cap, which is the right side to err on.
- **Clearing a daily cap works.** `null` is a real stored value here, not a
  removal sentinel — `REMOVABLE_SETTING_PATHS` is a deliberate allowlist
  (`lastModelPath`, `visionProjectorPaths.*`) precisely so settings like this
  one keep a meaningful `null` through the merge. Checked because the reverse
  has bitten this project before.
- **`connectedCount` counts `local`**, which is always connected, so a fresh
  install reads "1 connected · 12 providers". Accurate rather than misleading.

### Tests

`src/renderer/features/settings/pages/ai-models/__tests__/ProviderConnectionsPanel.test.tsx`
— 7 tests, the first this panel has had. Three fail against the pre-fix badge:
a cloud provider with an empty key, one with a whitespace-only key, and Azure
with a key but no deployment. The other four pin what must not change — local
and a keyed cloud provider still read Ready, Azure reads Ready once all three
of its fields are set, and both simple cloud providers render through the one
slot that 12.1 is about.

**What is not covered.** 12.1 is a reconciliation behaviour, and this project's
renderer tests run under `environment: 'node'` with no Testing Library and no
jsdom — `renderToStaticMarkup` performs a single render with no effects, no
refs, and no re-render, so component state cannot be carried across a prop
change to observe the bug or the fix. The test above asserts only the structural
condition that makes it possible. Verifying the fix itself means opening
Settings → AI & Models, setting a daily cap on one simple cloud provider,
selecting another, and seeing the field empty rather than carrying the first
provider's number. Adding a DOM test environment would close this gap for the
renderer generally and is worth its own decision, not a side effect of this file.

## Round two, 13. `src/main/tools/helpers.ts` — done

501 lines, and the best-covered module in the tree at 44 tests before this pass
— read at the user's request precisely because good coverage is not the same as
having been read. One bug, in the one path the existing tests did not reach.

### Bug fixed

**13.1 A `prepare()` failure was reported on a card the user was not
watching.** `runReadTool` and `runGuardedTool` both open with the same line:

```ts
const id = ctx.claimPendingToolCallId?.(spec.name) ?? randomUUID()
```

That claims the provisional card `PendingToolCallTracker` puts on screen while
the model is still _generating_ a file write's parameters, so the real
running/success/error emits resolve the card in place. `runGuardedToolWithPrepare`
did it everywhere except its own `prepare()` catch, which minted a fresh
`randomUUID()`.

The overlap is total, which is what makes it reachable rather than theoretical:

| Provisional cards (`TRACKED_TOOLS`)     | `runGuardedToolWithPrepare` users                                   |
| --------------------------------------- | ------------------------------------------------------------------- |
| `write_file`, `edit_file`, `patch_file` | `write_file`, `edit_file`, `patch_file`, `delete_file`, `move_file` |

All three tracked tools go through this function, and `prepare()` is where
their input validation lives — a path outside the workspace, a missing file,
an `oldText` the file does not contain, which is `edit_file`'s single commonest
failure. Every one of those produced **two** cards: the provisional one the user
had watched stream in, left unclaimed and swept at the end of the round as
"Interrupted", plus a second one carrying the actual reason. The card attached
to the call they were watching was the one that did not say what went wrong.

Fixed by claiming the id here too. Exactly one claim happens on either path —
this one on failure, `runGuardedTool`'s on success — so nothing is left for the
sweep and nothing is double-claimed by a later call of the same tool.

### Assessed, not changed

- **Plan bookkeeping satisfies `finish_goal`'s "real action" precondition, and
  the two sides of that disagree in the source.** `markProgress` sets
  `progress.madeChange` for any successful call whose `kind` is not `'read'`,
  which includes `write_plan` and `update_plan_step` (`kind: 'plan'`).
  `finish_goal`'s own refusal message enumerates what should count — "creating
  or editing a file, running a command, sending an email, etc." — and writing a
  plan is not on it. So a model that calls `write_plan` and then `finish_goal`
  clears a guard that exists to stop exactly that: a completion claim with no
  action behind it. **Left alone deliberately.** `helpers.test.ts:252` already
  pins the current behaviour by name ("runReadTool marks progress for a non-read
  kind (e.g. `write_plan`)"), so this is someone's stated intent rather than an
  oversight, and narrowing it is a behaviour change for the user to decide. If
  it should change, the fix is one clause in `markProgress` excluding
  `kind === 'plan'`; `'web'` should keep counting, since a search is real work
  for a research goal.
- **A denial's reason does survive history replay.** The `denied` emit sets
  `detail` and no `result`, but `rememberToolCallForModel` reads
  `result ?? detail ?? ''`, so `Denied: <reason>` is what a later turn sees.
  Checked rather than assumed, because the reverse would mean the model retrying
  something the user had told it not to do.
- **`runGuardedToolWithPrepare` runs `prepare()` before `beforeTool` and the
  loop guard**, so a budget-exhausted or looping call still pays for its
  validation, and a `prepare()` failure is reported instead of "Blocked:
  execution budget reached". `prepare()` is read-only by contract, so this costs
  a little work and a less precise message, not correctness.
- **`truncateModelResult` reports `bytes`** where `String.length` counts UTF-16
  code units. Wrong for any non-ASCII result, but it is a note to the model
  about size, not a value anything computes from.

### Tests

`helpers.test.ts` — 3 added (47 total). One fails against the pre-fix file: a
`prepare()` rejection emitting under a fresh UUID instead of the claimed
`provisional-2`. The other two are the guards around it — the success path still
resolves the same provisional card end to end, and a call with nothing
pre-emitted still falls back to a fresh id.

## Cross-cutting, closed: `save_email_attachment` did not disclose an overwrite

The last open row in the cross-cutting table, raised while reviewing
`emailTools.ts` (R2.3) and left for its own change because the fix is a
restructure rather than a line.

`save_email_attachment` writes an attachment to a caller-supplied workspace
path, and its approval prompt said only where the file was going:

```ts
confirmDetail: `Save attachment ${args.attachmentId} from message ${args.messageId} to ${args.path}`
```

Every other workspace write discloses what it is about to destroy — the
mutation tools build a real before/after diff and the confirm card renders it.
This one could not: an attachment is binary, so there is no diff to show, and
the prompt therefore read identically whether the path was free or held
something the user cared about. "Save attachment to report.pdf" is a materially
different request depending on which, and only one of them is undoable without
reaching for the checkpoint.

Converted from `runGuardedTool` to `runGuardedToolWithPrepare`, which exists for
exactly this — computing what the prompt needs before the prompt is shown. The
`prepare()` step resolves the destination and reads it; the prompt now ends with
either `This replaces the existing 4.0 KB file at that path.` or `No file exists
at that path yet.` Sizes are formatted for a person here rather than as the raw
byte counts the rest of the file gives the model.

**Two deliberate choices inside the conversion.**

The attachment is still fetched in `run()`, after approval, not in `prepare()`.
Fetching it earlier would let the prompt name the real filename and size, but it
would also spend a request against the user's mailbox for a call they may be
about to deny. The overwrite question is answerable from the destination alone.

Reading the destination during `prepare()` opens a gap that did not exist when
everything happened in `run()`: the user is looking at a description of a file
that something else — their editor, a build step — can change while they decide.
Approving then writes over content the prompt never described, and the
checkpoint records the vanished content as `before`, so an undo restores a
version that was never on disk at write time. `assertFileStateUnchanged` closes
it, the same guard `write_file` and the other mutation tools already use.

That guard was private to `mutationTools.ts`, so it moved to a new
`src/main/tools/fileState.ts` rather than being imported across peer tool
modules or copied. Pure move, no behaviour change, and its doc comment now
explains the failure it prevents instead of just restating the check.

### Tests

`emailTools.test.ts` — 3 added (38 total), all three confirmed failing against
the pre-fix file: the overwrite disclosure with its size, the create-case
wording, and a destination edited while the confirm prompt was up being refused
with the file left as the editor wrote it.
