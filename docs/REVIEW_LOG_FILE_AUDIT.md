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
| 3   | `src/main/chat/runGeneration.ts`                 | 614   | 5 → 6 added  | ✅ done |
| 4   | `src/main/llm/OpenAiCompatibleProvider.ts`       | 544   | 0 → 5 added  | ✅ done |
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
