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

| #   | File                                             | Lines | Tests        | Status  |
| --- | ------------------------------------------------ | ----- | ------------ | ------- |
| 1   | `src/main/conversations/ConversationStore.ts`    | 322   | 0 → 11 added | ✅ done |
| 2   | `src/main/llama/LlamaService.ts`                 | 2760  | 10 → 16      | ✅ done |
| 3   | `src/main/chat/runGeneration.ts`                 | 614   | 5            | ☐       |
| 4   | `src/main/llm/OpenAiCompatibleProvider.ts`       | 544   | 0            | ☐       |
| 5   | `src/main/llm/AnthropicProvider.ts`              | 481   | 0            | ☐       |
| 6   | `src/main/email/EmailService.ts`                 | 713   | 1            | ☐       |
| 7   | `src/main/email/providers/ImapSmtpAdapter.ts`    | 919   | 0            | ☐       |
| 8   | `src/renderer/stores/chatStore.ts`               | 1244  | 1            | ☐       |
| 9   | `src/shared/ipc.ts`                              | 862   | 3            | ☐       |
| 10  | `src/renderer/features/chat/ChatCircuit.tsx`     | 956   | 0            | ☐       |
| 11  | `src/renderer/features/startup/startupEngine.ts` | 792   | 0            | ☐       |
| 12  | `src/renderer/features/email/EmailView.tsx`      | 1251  | 0            | ☐       |

Why this order: 1 and 6–7 can destroy or leak user data; 2–5 are the generation
path where a bug burns tokens or truncates a reply; 8–10 are the app's spine;
11–12 are contained UI.

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
