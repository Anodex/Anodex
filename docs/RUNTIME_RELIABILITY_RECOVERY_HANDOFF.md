# Runtime Reliability Recovery Handoff

> Status: implementation plan only. No production behavior described as a proposed
> change in this document has been implemented yet.
>
> Prepared: 2026-07-20, after inspecting the persisted failed Critical Thinking run
> `critical_mrt8pexs_eab6v`, the fresh failed project chat
> `c_738ddaee-dc7b-4bf3-b855-388ed72bb013`, the installed `node-llama-cpp` source,
> and the current Anodex implementation at commit `7ff76e0`.

## Purpose

This is a code-grounded handoff for fixing two runtime failures that remain after
the 2026-07-19 context-reliability and evidence-first Critical Thinking work:

1. Critical Thinking successfully creates a research plan, but still marks the run
   failed and discards the plan when the local generation later reaches its output
   limit.
2. A genuinely fresh 8,192-token project chat can complete many useful read calls,
   but reaches the context-shift safety budget before it can produce the requested
   final answer.

The plan deliberately separates confirmed defects from conditional architecture
work. The goal is to apply the smallest change that proves sufficient, while still
having a clean path to bounded multi-cycle execution if a single normal chat turn
cannot complete a complex task on a small local context.

## Executive Decision

The failures are not caused by stale chat history, a broken Tavily configuration,
or the new evidence store. Both occurred in fresh, isolated work. The common
boundary problem is that Anodex still lets one `LlamaChatSession` generation own too
much workflow control in two places:

- Critical Thinking planning still uses the native function auto-loop even though
  research itself was correctly moved into Anodex-owned isolated phases.
- Ordinary chat still asks the native function auto-loop to execute and remember an
  entire multi-tool task inside one assistant turn.

The recommended order is:

1. Fix artifact-commit semantics and Critical Thinking planning.
2. Bound model-facing tool results against the actual context budget.
3. Rerun the exact 8K audit and Critical Thinking tests.
4. Only if the audit still cannot finish, extract a shared bounded continuation
   primitive from the existing Agent run loop and use it for interactive chat.

Do not start with a raw `LlamaChat` rewrite, a `node-llama-cpp` fork, a larger
context-shift allowance, or a blanket context-size recommendation.

## Confidence and What Is Not Yet Proven

### Confirmed with runtime data and source

- Critical Thinking produced three successful six-step `write_plan` calls before
  being marked failed.
- The failed Critical Thinking run persisted `plan: null`, zero evidence, and the
  error `This step reached its safe local output-token limit; saved evidence can be
resumed.`
- `CriticalThinkingService.runPlanning()` extracts the latest successful plan and
  then immediately fails on `result.stopped` before persisting the plan.
- The installed `LlamaChatSession.promptWithMeta()` continues its internal loop
  after a successful function result. A successful plan tool call is not a terminal
  workflow boundary.
- The fresh failed chat contained only one user and one assistant message. Old
  conversation history was not the cause.
- That chat completed 19 successful read calls, took about four minutes, and ended
  with the typed `context-shift-limit` presentation.
- Its measured fixed context cost was 4,037 tokens against a 7,373-token local
  input limit, leaving about 3,336 tokens for the active exchange before shifts.
- `read_file_range` can return up to 60 KiB and `read_multiple_files` up to 200 KiB
  to the model because they override the generic 4,000-character cap.
- An 8,192-token interactive turn is hard-aborted after the ninth context shift.
- The targeted automated tests pass while these real failures remain, proving a
  test-coverage gap rather than a generally broken suite.

### Strongly supported but must be measured during implementation

- Oversized file-read results are the dominant reason the fresh audit required so
  many shifts. The code permits this, the task repeatedly paged a large file, and
  the measured shift count confirms pressure, but the full transient native tool
  results are not persisted verbatim, so their exact per-call token counts are not
  available after the run.
- Reducing model-facing result size should materially reduce shift frequency and
  latency. The exact optimal fraction of remaining context must be measured with
  the real wrapper/tokenizer rather than chosen by character-count intuition.
- A normal chat continuation layer may still be needed for genuinely long tasks.
  It should be implemented only if the exact audit still reaches a typed limit
  after artifact semantics and tool-result budgeting are corrected.

### Not claimed

- This plan does not claim every possible local model will produce valid research
  JSON.
- It does not claim an 8K context can hold a complete repository audit in one
  native turn.
- It does not claim a larger context is useless; a larger context improves quality
  and throughput when hardware permits, but it is not a correctness requirement.

## Reproduction Record

### Critical Thinking planning failure

Persisted run:

```text
Run ID: critical_mrt8pexs_eab6v
Provider: local
Status: failed
Question: why do be stings hurt so bad and what happens with each type of bee or wasp
Duration: 26,730 ms
Generated tokens: 716
Plan field: null
Evidence count: 0
Activities: 3
Last error: This step reached its safe local output-token limit; saved evidence can be resumed.
```

All three activities were successful `Plan: Bee and Wasp Sting Pain Research`
events with six steps. Planning completed useful work; the orchestration later
overwrote the outcome with a generation-limit interpretation.

Current control flow:

```text
runPlanTurn()
  -> native write_plan succeeds one or more times
  -> latestPlan(result.calls) returns a valid plan
  -> result.stopped is true because generation later hit token limit
  -> finishPlanningStop()
  -> persisted plan remains null
```

### Fresh project chat failure

Persisted conversation:

```text
Conversation ID: c_738ddaee-dc7b-4bf3-b855-388ed72bb013
Messages: 2
Tool calls: 19, all successful
Duration: 240,896 ms
Generated tokens: 1,012
Observed rate: 4.2 tokens/second
Context size: 8,192
Input limit: 7,373
Fixed tokens: 4,037
Effective output cap: 2,048
Displayed termination: bounded context-compaction budget
```

The model listed directories, generated several outlines, and then read consecutive
150-line ranges from `LlamaService.ts`. It never reached the requested cross-file
audit or final report.

Current control flow:

```text
one LlamaChatSession prompt
  -> tool result
  -> model chooses another tool
  -> result no longer fits
  -> deterministic context shift
  -> repeat until shift count > 8
  -> GenerationBudget aborts
  -> partial assistant message receives a red error
```

## Root Causes

### R1. A valid artifact is treated as invalid when generation later stops

`CriticalThinkingService.runPlanning()` computes a valid plan before checking
`result.stopped`, but the stop check wins. The same ordering pattern exists in the
new query and assessment phases: they return early on `result.stopped` before
parsing potentially complete JSON.

This violates the workflow invariant that service-validated durable artifacts are
more authoritative than a provider's trailing termination metadata.

Correct invariant:

> If the requested artifact is complete, validates against the phase contract, and
> the user did not explicitly stop the phase before acceptance, persist the artifact
> before interpreting a recoverable provider limit.

This does not mean accepting arbitrary truncated text. A plan, query set,
assessment, or report must pass its own parser/validator first.

### R2. Critical Thinking planning still uses the legacy native tool loop

The research runner correctly uses short, tool-free, isolated model calls. Planning
is the exception: it exposes `write_plan` to `LlamaChatSession` and waits for the
whole native loop to finish.

The installed library subtracts generated tokens after each function-call round and
then continues. A successful tool call does not return control to
`CriticalThinkingService`. The local guard eventually aborts the repeated loop.

Planning is a proposal, not an external side effect. It does not need a native tool
loop. Returning bounded JSON and letting the service create the `Plan` is simpler
and consistent with the rest of Critical Thinking.

### R3. Model-facing tool output is not tied to the measured context budget

Anodex measures the wrapper, system prompt, current prompt, and active schemas, but
that measurement currently controls schema routing and generated output only. It
does not constrain the next tool result.

The generic helper cap is 4,000 characters, but large file tools can override it
with disk-oriented limits of 60 KiB or 200 KiB. Disk safety limits and model context
limits are different concerns and must not share one setting.

Correct invariant:

> Every tool may retain a complete durable artifact, but the text injected into the
> active model exchange must fit a runtime budget derived from the active provider's
> remaining context and required reply/checkpoint reserve.

### R4. The context-shift budget is a hard abort with no task continuation contract

`GenerationBudget.recordContextShift()` calls `stop('context-shift-limit')` after
the configured count. That protects the app from five-hour turns, but it does not
give the task a finalization or continuation phase.

The current UI correctly distinguishes the stop from a user Stop, yet still renders
it as a red error. Completed reads are visible, but there is no first-class way to
continue the original objective from a bounded checkpoint.

### R5. Tests cover components, not the reproduced orchestration contracts

The current suite tests plan prompts, parsers, the research runner, output budgeting,
context-shift fitting, and generation recovery. There is no dedicated
`CriticalThinkingService` planning test that combines a successful plan call with a
recoverable terminal stop. There is also no integration test where context-aware
file reads and repeated native calls must result in a final answer or resumable
yield.

## Alternatives Considered

| Alternative                                          | What it helps                                     | Why it is not the primary fix                                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Increase context from 8K to 32K                      | Fewer shifts and better repository coverage       | A single file result can still be 60 KiB and a batch can be 200 KiB. It makes correctness hardware-dependent.                                                                                          |
| Raise or remove the shift limit                      | Lets one turn run longer                          | Recreates the 302-minute, near-frozen behavior the guard was added to prevent.                                                                                                                         |
| Reduce file result sizes only                        | Likely fixes most shift pressure                  | Does not fix Critical Thinking's discarded plan or guarantee completion of truly long tasks. It is required but may not be sufficient.                                                                 |
| Reorder only the Critical Thinking stop check        | Immediately preserves the current successful plan | Correct hotfix, but leaves repeated plan tool calls and the same artifact-loss pattern in query/assessment phases.                                                                                     |
| Keep `write_plan` but abort after first success      | Prevents repeated planning calls                  | Aborting from inside the native handler has subtle session-history behavior and still makes planning depend on the tool auto-loop. Tool-free JSON is cleaner here.                                     |
| Route every large chat prompt directly to Agent mode | Reuses an existing multi-turn loop                | Silent mode switching is surprising, creates a separate conversation/run, and changes approval/background semantics. It is useful as an explicit UX option, not a universal hidden redirect.           |
| Add a new chat-only cycle engine                     | Can finish complex chat tasks                     | Risks duplicating `AgentRunService`. If needed, extract a shared primitive from Agent instead.                                                                                                         |
| Switch all local generation to raw `LlamaChat`       | Gives per-function-call control                   | Requires owning chat history and KV-cache reconciliation, helps only local models, and has a higher silent-corruption risk. Reserve it for proof that supported session APIs cannot meet requirements. |
| Fork or patch `node-llama-cpp`                       | Could alter auto-loop behavior directly           | Creates update fragility around private state and is unnecessary for the confirmed fixes.                                                                                                              |
| Tell users to shorten prompts                        | Avoids pressure                                   | The test prompt is a reasonable product request. The system should bound or continue it honestly.                                                                                                      |

## Proof-Driven Implementation Sequence

The phases below are ordered so each one can prove whether the next, larger phase is
necessary. Do not combine them into one giant commit.

## Phase 0: Add Regressions Before Changing Behavior

### Objectives

- Reproduce the plan-discard bug in a deterministic service-level test.
- Capture the current tool-output/context mismatch in pure tests.
- Preserve the runtime measurements above as fixtures or explicit test cases.

### Changes

1. Add `src/main/criticalThinking/__tests__/CriticalThinkingService.test.ts`.
2. Make the service's generation dependency injectable or expose a narrow test
   constructor/factory. Do not mock the entire Electron process.
3. Simulate a planning result containing one or more successful `write_plan` calls,
   `stopped: true`, and `stopReason: 'token-limit'`.
4. Assert the current test fails because the plan is lost. Then implement Phase 1.
5. Add pure tests showing that a 60 KiB `read_file_range` result can exceed the
   model-facing budget calculated for the recorded 8K context.

### Required cases

- Valid plan + `eogToken` -> `needs-review`.
- Valid plan + `token-limit` -> `needs-review` after the fix.
- Valid plan + `context-shift-limit` -> `needs-review` after the fix.
- User Stop -> `stopped`, even if a provisional plan appeared.
- No valid plan + recoverable stop -> one bounded retry or a clear planning failure.
- Invalid plan output -> never enters `needs-review`.
- Persistence flush failure -> remains an explicit failure, never false review-ready.

### Exit gate

The regression must fail on the current code and pass only after Phase 1. If it
passes before production changes, the test is not exercising the real service
contract.

## Phase 1: Make Critical Thinking Planning Service-Owned

### Decision

Replace native `write_plan` planning with a tool-free structured phase. Keep the
ordinary `write_plan` tool for chat and Agent workflows.

### New structured contract

Prompt for JSON only:

```json
{
  "title": "Short research plan title",
  "steps": ["Concrete evidence-gathering step"]
}
```

Validation rules:

- title is non-empty and bounded;
- 3 to 7 non-empty steps;
- duplicate or trivially repeated steps are removed;
- no report-writing step;
- step titles are bounded using the existing plan limits;
- IDs and `updatedAt` are created by the service, not trusted from model text.

### Files

- `src/main/criticalThinking/criticalThinkingPrompts.ts`
  - Replace the tool-call planning prompt with strict JSON instructions.
  - Add a bounded repair prompt that includes validation errors, not the full prior
    transcript.
- `src/main/criticalThinking/criticalThinkingResearchOutput.ts`
  - Add `parseResearchPlan()` or move all structured phase parsers into a new
    single-purpose `criticalThinkingStructuredOutput.ts`.
- `src/main/criticalThinking/CriticalThinkingService.ts`
  - Replace `runPlanTurn()` with a tool-free isolated planning call.
  - Parse before applying non-user stop semantics.
  - Persist exactly one planning activity and one plan.
  - Flush the run before broadcasting `needs-review` as durable success.
- `src/main/criticalThinking/__tests__/CriticalThinkingService.test.ts`
  - Cover service lifecycle, activity deduplication, stop precedence, and flush.
- `src/main/criticalThinking/__tests__/criticalThinkingPrompts.test.ts`
  - Update the obsolete assertion that planning requires `write_plan`.

### Termination rules

- `signal.aborted` with a real user reason always produces `stopped`.
- A syntactically and semantically valid plan is accepted after a recoverable
  provider limit because the artifact proves phase completion.
- Invalid or incomplete output gets at most one isolated repair attempt.
- A second invalid result becomes `failed` with a planning-specific message.
- Planning never creates evidence or starts web I/O before review.

### Exit gate

Using the real 8K local model and the bee/wasp question:

- one plan activity appears;
- exactly one 3-7 step plan is persisted;
- status reaches `needs-review`;
- no evidence sidecar is created before approval;
- Stop during planning still stops;
- planning completes within 90 seconds on the current hardware.

Do not proceed to live research testing until this passes.

## Phase 2: Share Artifact-First Structured Phase Semantics

### Problem

Query selection and coverage assessment currently check `result.stopped` before
parsing the returned JSON. Synthesis similarly marks any stopped draft Partial
before determining whether it is actually a complete, valid report.

### Design

Introduce a small shared helper local to Critical Thinking, not a new provider
framework. Suggested responsibilities:

```ts
interface StructuredPhaseResult<T> {
  value: T | null
  valid: boolean
  content: string
  stats: GenerationStats
  stopReason?: GenerationStopReason
  userStopped: boolean
}
```

The helper should:

1. run one isolated, tool-free generation;
2. retain raw bounded content for diagnostics;
3. parse and validate the phase artifact;
4. classify a real user Stop separately;
5. accept valid output before interpreting recoverable termination;
6. optionally run one bounded repair when configured;
7. return typed information to the service/runner without directly mutating run
   state.

### Reasoning-output budget

The loaded local model is reasoning-tuned. Hidden thought tokens currently share
the same `maxTokens` allowance as required JSON. The installed library exposes
thought/comment budgets. Add optional provider-generation fields only if wrapper
tests confirm they work for the active Qwen wrapper:

- `thoughtTokens` or equivalent optional phase budget;
- visible/comment token allowance where supported;
- total hard cap retained as the final safety boundary.

Do not assume every wrapper supports separate budgets. Unsupported providers should
fall back to the existing total cap and a larger schema-appropriate allowance.

### Files

- `src/main/criticalThinking/CriticalThinkingService.ts`
- `src/main/criticalThinking/CriticalThinkingResearchRunner.ts`
- `src/main/criticalThinking/criticalThinkingResearchOutput.ts`
- optional new `src/main/criticalThinking/criticalThinkingStructuredPhase.ts`
- `src/shared/chat.types.ts` only if provider options genuinely need a typed
  reasoning budget
- `src/main/llama/LlamaService.ts` and cloud providers only if that option is added

### Required cases

- Valid query JSON ending exactly at `token-limit` is accepted.
- Invalid query JSON still uses the deterministic fallback query.
- Valid assessment JSON ending at `token-limit` is evaluated through
  `assessmentIsSufficient()`.
- Model-proposed sufficient without the evidence floor remains `continue`.
- User Stop never commits a newly generated assessment.
- A token-limited synthesis draft is validated. If validation proves it complete,
  it may complete; otherwise it remains Partial.
- A stopped repair never replaces a complete original draft unless the repair itself
  validates.

### Exit gate

Run a complete mocked three-step provider-neutral workflow plus a real local single
step. No valid artifact may be lost solely because `stopped` is true.

## Phase 3: Introduce Runtime Model-Facing Tool Result Budgets

### Objective

Separate three concepts that are currently conflated:

1. bytes safe to read from disk;
2. complete data retained as a local artifact or recoverable source;
3. bounded text injected into the active model context.

### Budget input

Calculate a `ModelToolResultBudget` after the active wrapper and tool surface are
known. It should include at least:

```ts
interface ModelToolResultBudget {
  contextSizeTokens: number
  inputLimitTokens: number
  fixedTokens: number
  minimumReplyReserveTokens: number
  minimumCheckpointReserveTokens: number
  maxTokensPerResult: number
  maxTokensAcrossActiveCycle: number
}
```

For local models, use the real tokenizer. For cloud providers, use provider token
usage helpers if available or a conservative character estimate. The budget must
be provider-neutral at the tool-helper boundary.

### Budget rules

- Never use disk byte limits as model text limits.
- Reserve space for a useful answer or checkpoint before allowing another large
  result.
- Clamp tool-specific requested caps to the runtime cap. Tool code may request a
  smaller cap, never a larger one.
- Prefer complete lines, records, matches, or passages over prefix slicing.
- Always state what was omitted and how to request the next segment.
- Persist enough identity to reproduce an exact read without keeping a huge copy in
  the conversation.
- Recalculate remaining cycle allowance after each successful result.
- When no useful projection fits, return a typed bounded message and request a yield
  instead of injecting an empty or misleading result.

Do not hard-code a final per-result fraction until the recorded 8K context is tested.
A reasonable initial experiment is to reserve at least 1,024 tokens for
checkpoint/finalization and cap one result to no more than 20-25% of the remaining
exchange room. The committed value must be justified by wrapper/tokenizer tests.

### Tool runtime changes

- `src/main/tools/types.ts`
  - Add a read-only result-budget projection to `ToolRuntimeContext`.
- `src/main/chat/runGeneration.ts`
  - Pass provider/context budget information into the runtime after it is known.
  - If exact local measurement currently occurs too late, move tool-result projection
    to the Llama tool wrapper rather than duplicating estimates earlier.
- `src/main/llama/LlamaService.ts`
  - Own exact tokenizer-based enforcement for the local provider.
  - Record per-call projected/full token or character counts for diagnostics.
- `src/main/tools/helpers.ts`
  - Clamp `modelResultCap` against runtime allowance.
  - Preserve the current UI detail and artifact sink independently.

### File tool behavior

#### `read_file_range`

- Read the requested bounded disk range.
- Select the largest prefix of complete lines that fits the runtime model budget.
- Report the last line actually returned, not the requested `endLine`.
- Return the correct `nextStartLine` for the first omitted line.
- Handle a single over-budget line with an explicit partial-line marker and byte/hash
  metadata; never imply the line was complete.

#### `read_file`

- Prefer a compact file header plus a bounded beginning only for small files.
- For larger source files, return file metadata and recommend `code_outline`,
  `search_files`, or targeted `read_file_range` calls.

#### `read_multiple_files`

- Allocate the active result budget across requested files.
- Return a bounded excerpt or outline per file.
- Report skipped files and why.
- Never return a 200 KiB model message merely because reading 200 KiB from disk is
  safe.

#### `code_outline`, search, command, Git, web and MCP results

- Apply the same hard runtime ceiling.
- Use tool-specific structured truncation so JSON, lines and identifiers remain
  valid.
- Web search/fetch keep their existing full structured artifact before projection.
- Command output retains exit code and a useful tail/head policy rather than an
  arbitrary prefix only.

### Workspace read artifacts

Do not copy entire source files into conversation JSON. Add a compact artifact or
checkpoint record containing:

- workspace-relative path;
- requested and actually returned range;
- file size and modification time;
- content hash for the returned range or whole file where affordable;
- bounded excerpt/digest;
- truncation/continuation metadata.

A later cycle may reread the range from disk. If the hash changed, mark the prior
artifact stale rather than trusting it silently.

### Required tests

- 4K, 8K and 32K budgets.
- The exact recorded fixed-token values: context 8,192, input limit 7,373, fixed
  4,037.
- One 60 KiB range cannot exceed the runtime model allowance.
- One extremely long line is labeled partial honestly.
- `nextStartLine` matches the first omitted complete line.
- Batch allocation is deterministic and bounded.
- Full web artifacts remain available after model projection.
- Tool-specific cap overrides cannot bypass runtime safety.
- Cloud contexts receive a larger but still finite projection.

### Exit gate: rerun before building continuation

Rerun the exact architecture-audit prompt at 8K. Record:

- distinct files inspected;
- full and projected result sizes;
- context shifts;
- total tools;
- wall-clock time;
- whether a final report was produced;
- renderer responsiveness.

If it inspects at least 12 distinct files, produces the requested report, uses no
more than the current shift budget, and finishes within 15 minutes, do not build a
new automatic chat cycle controller. Proceed only with the UX cleanup in Phase 5.

If it still reaches a recoverable limit before finalization, Phase 4 is proven
necessary.

## Phase 4: Reuse Agent's Outer-Turn Continuation for Long Interactive Tasks

### Why reuse instead of duplicate

`AgentRunService` already classifies context, shift, token, tool, round and time
limits as recoverable turn stops. It persists each turn and starts another outer
turn until the goal finishes or its run budget expires. The missing capability is
an interactive adapter and a stronger bounded checkpoint/artifact contract.

Extract a small provider-neutral primitive from Agent rather than importing the
whole Agent service into chat or creating a second loop.

### Proposed shared abstraction

Suggested name: `BoundedTaskContinuation` or `TaskCycleController`.

Responsibilities:

- own attempt-level wall-clock, turn and tool budgets;
- classify recoverable vs terminal stop reasons;
- persist a compact checkpoint after every cycle;
- construct the next bounded continuation prompt;
- prevent duplicate side effects using completed call identity and checkpoint hashes;
- run a separate tool-free finalization cycle;
- expose progress without owning renderer-specific UI;
- allow user Stop to terminate immediately;
- allow user Resume to reset attempt budgets while retaining lifetime work.

It must not own Critical Thinking search/fetch policy. Critical Thinking keeps its
domain-specific persisted runner and may share only low-level stop classification
and structured-phase utilities.

### Interactive behavior

Prefer explicit, understandable UX:

- Short tasks remain a normal single chat turn.
- On a recoverable bounded stop with useful work, persist `paused` rather than a red
  generic error.
- Offer `Continue from checkpoint`.
- Optionally offer `Continue automatically for this task` before beginning the next
  cycle.
- Offer `Run as Agent` as a separate choice when the user wants background autonomy.
- Do not silently move the conversation to Agent mode.

If product direction requires automatic continuation by default, cap it to the
existing interactive 15-minute attempt budget and show every cycle transition.

### Persisted task checkpoint

Add a backward-compatible optional structure to the assistant message or
conversation context:

```ts
interface TaskContinuationCheckpoint {
  version: 1
  originalUserMessageId: string
  objective: string
  cycle: number
  plan?: Plan
  completedToolFingerprints: string[]
  inspectedArtifacts: string[]
  changedFileHashes: Record<string, string>
  verifiedFindings: string[]
  remainingWork: string[]
  lastStopReason: GenerationStopReason
  createdAt: number
}
```

Every field must be bounded. Do not store hidden chain-of-thought. Findings are
navigation context, not proof of file state; exact paths/hashes/artifacts remain the
authoritative layer.

### Safe boundary and finalization

The native session may stop after a completed tool call or during response
generation. The controller must use persisted terminal tool activities, not assume
the session retained a result in KV cache.

For the next cycle:

- start from a fresh local session or compact persisted outer-turn history;
- include the original objective, bounded plan, checkpoint and selected artifacts;
- exclude the giant raw native tool transcript;
- tell the model exactly which side effects are already complete;
- block a mutation with the same fingerprint when its target hash still matches.

When work is sufficient, run a separate tool-free finalization call. Its output
budget must not have been consumed by earlier function arguments or hidden thought
tokens.

### Files likely involved

- `src/main/chat/GenerationBudget.ts`
- `src/main/chat/runGeneration.ts`
- new `src/main/chat/TaskCycleController.ts`
- `src/main/agents/AgentRunService.ts`
- `src/main/agents/agentPrompts.ts`
- `src/shared/chat.types.ts`
- `src/shared/context.types.ts` or a new shared task-continuation type
- `src/main/conversations/ConversationStore.ts` normalization path
- `src/renderer/stores/chatStore.ts`
- `src/renderer/features/chat/MessageBubble.tsx`

### Required tests

- A recoverable shift limit pauses, not fails.
- Continue starts a new bounded cycle with the original objective.
- A valid final answer from the finalization cycle completes normally.
- A write/command completed before a yield is never repeated automatically.
- A changed target hash blocks stale replay assumptions.
- User Stop wins during work, checkpointing and finalization.
- App restart retains a resumable checkpoint.
- Old conversations without checkpoint fields still normalize.
- Agent and interactive chat use the same recoverable-stop classifier.
- Critical Thinking remains independent of workspace-task cycles.

## Phase 5: Correct Termination and UI Semantics

### Problem

`runGeneration()` currently overwrites a provider outcome with any non-user
execution stop reason, and `chatStore` renders several bounded outcomes as message
errors. That is appropriate for an unrecoverable failure, but not for a durable
paused task or a valid artifact produced before a recoverable limit.

### Required state distinction

Do not overload `error` for all outcomes. Preserve backward compatibility while
adding an explicit bounded status, for example:

```ts
type AssistantCompletionState = 'completed' | 'partial' | 'paused' | 'stopped' | 'failed'
```

Rules:

- `completed`: final contract satisfied.
- `partial`: useful answer exists but validation or workflow coverage is incomplete.
- `paused`: durable checkpoint exists and work can continue.
- `stopped`: user explicitly stopped.
- `failed`: no safe continuation or usable result.

### UI

- Replace the red error for a resumable limit with a neutral/amber paused card.
- Show completed tool count, cycle count, and stop reason in plain language.
- Add `Continue from checkpoint` when available.
- Keep `Run as Agent` as an explicit alternative.
- Critical Thinking planning failures should say planning failed; research limits
  should remain Partial/resumable; user Stop should remain Stopped.
- Never tell the user to increase context as the only remedy. It can be an optional
  performance suggestion.

### Observability

Log and optionally retain a compact diagnostic summary per generation:

- context size/input limit/fixed tokens;
- requested and effective output tokens;
- tool name plus full/projected result sizes;
- context shift count and time spent per shift;
- folded call count and retained checkpoint tokens;
- provider rounds;
- final stop reason and completion state;
- cycle number when continuation is active.

This data should be suitable for a future redacted support bundle. Do not log file
contents, secrets, API keys or hidden reasoning.

## Phase 6: End-to-End and Real-Model Acceptance

### Automated gate

Run after every commit that changes shared types or orchestration:

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
npm run test:e2e
git diff --check
```

Use changed-file Prettier checks if the repository-wide formatting backlog remains.

### Critical Thinking manual test

Context: 8,192. Active provider: local. Search: configured Tavily provider.

Prompt:

```text
Compare the strongest current evidence on why honey-bee, bumblebee, yellowjacket,
paper-wasp, and hornet stings differ in pain, tissue effects, allergic risk, and
repeat-sting behavior. Prefer medical, university, government, and primary sources;
separate well-supported findings from uncertainty and include practical emergency
warning signs. Use evidence current through July 2026.
```

Pass criteria:

- planning produces one editable plan and reaches review;
- no search begins before approval;
- query and assessment phases are isolated and tool-free;
- valid structured output is not lost on a recoverable provider limit;
- evidence sidecar grows only after approved search/fetch work;
- Stop and Resume retain evidence and round ownership;
- synthesis is tool-free and citation-validated;
- result is Complete or honestly Partial, never false Complete or planning Failed
  after a successful plan.

### Project chat manual test

Use the existing architecture-audit prompt from
`docs/CONTEXT_RELIABILITY_TESTING.md` at 8,192 tokens.

Pass criteria after Phase 3:

- every tool result obeys the runtime model budget;
- displayed range metadata is truthful;
- at least 12 distinct TypeScript files are inspected;
- no exact or semantic range crawl consumes the whole attempt;
- UI remains responsive;
- a final report is produced within 15 minutes, or a durable paused checkpoint is
  offered without a red failure;
- Continue does not repeat completed mutations;
- a short new chat still works afterward.

### Provider matrix

Repeat structured Critical Thinking and continuation contract tests with mocked and,
where credentials exist, live:

- local 4K;
- local 8K;
- local 32K;
- OpenAI configured model;
- Anthropic configured model.

Cloud providers do not need local context shifts, but they must still honor tool,
round, time, structured-output and resume semantics.

### Performance acceptance

On the current machine and 27B Q4 model:

- fresh short structured phases should not degrade to long-context token rates;
- context shifts per bounded cycle should stay low and explainable;
- no automatic attempt exceeds 15 minutes in interactive chat;
- Critical Thinking active attempts retain their existing pinned policy limits;
- renderer updates remain throttled and interactive during inference/network work.

## Suggested Commit Sequence

1. `test: reproduce artifact loss after recoverable generation stops`
   - New failing service and tool-budget regressions only.
2. `fix: make critical-thinking planning structured and artifact-first`
   - Tool-free plan JSON, parsing, plan persistence, planning activity cleanup.
3. `fix: preserve valid structured research output across bounded stops`
   - Shared phase helper, query/assessment/synthesis ordering, targeted tests.
4. `feat: budget model-facing tool results against active context`
   - Runtime budget type, enforcement, diagnostics, provider tests.
5. `fix: make file-read projections bounded and truthful`
   - Line-aware ranges, batch allocation, compact workspace read artifacts.
6. Conditional: `feat: add resumable bounded task continuation`
   - Only after the Phase 3 real-model exit gate proves it necessary.
7. Conditional: `feat: surface paused chat tasks and continue actions`
   - Renderer state, restart/resume E2E, explicit Agent option.
8. `docs: update reliability contracts and manual acceptance results`
   - Update README, ROADMAP, architecture and testing docs only after behavior is
     implemented and manually verified.

Each commit should leave lint, typecheck and targeted tests green. Do not postpone
all tests until the final UI commit.

## File-by-File Handoff Checklist

### Critical Thinking

- `CriticalThinkingService.ts`
  - remove native tool-loop dependency from planning;
  - commit validated plan before recoverable termination classification;
  - preserve user Stop precedence;
  - validate stopped synthesis drafts before discarding them.
- `CriticalThinkingResearchRunner.ts`
  - parse query/assessment output before recoverable-stop handling;
  - keep service evidence sufficiency gate authoritative;
  - preserve checkpoint-before-phase-advance invariant.
- `criticalThinkingPrompts.ts`
  - strict JSON plan and repair prompts;
  - no `write_plan` requirement for Critical Thinking.
- `criticalThinkingResearchOutput.ts`
  - add bounded plan parsing;
  - keep query/assessment parsing defensive.
- `CriticalThinkingStore.ts`
  - no destructive migration;
  - add defaults only if new persisted status/checkpoint fields are necessary.

### Generation and tools

- `GenerationBudget.ts`
  - keep hard safety limits;
  - share recoverable-stop classification with Agent/chat;
  - distinguish paused/yielded state from unrecoverable failure.
- `runGeneration.ts`
  - do not blindly overwrite a validated completion artifact with a recoverable
    execution reason;
  - provide tool-result budget inputs;
  - preserve provider-neutral semantics.
- `LlamaService.ts`
  - continue using supported `LlamaChatSession` APIs;
  - enforce exact tokenizer-based local result projections;
  - expose reasoning budgets only after wrapper verification;
  - keep context shift as emergency safety, not workflow orchestration.
- `tools/types.ts` and `tools/helpers.ts`
  - clamp model result projections;
  - keep durable artifacts/UI details separate;
  - never let a tool override above the runtime cap.
- `fileTools.ts`
  - separate disk byte limits from model output limits;
  - return truthful line continuation metadata;
  - bound batches.

### Agent, conversation and renderer

- `AgentRunService.ts`
  - extract reusable continuation classification/loop only if Phase 4 is needed;
  - preserve existing Agent behavior and budgets.
- shared conversation/chat types
  - add bounded optional state with defensive normalization;
  - old files must load unchanged.
- `chatStore.ts`
  - preserve paused state and checkpoint;
  - expose explicit continuation action;
  - keep queued user messages working.
- `MessageBubble.tsx`
  - render paused/partial separately from red errors;
  - keep user Stop quiet and distinct.

## Risks and Mitigations

### Risk: accepting genuinely truncated JSON

Mitigation: never accept based on stop reason or non-empty text. Require parser and
semantic validation success.

### Risk: user Stop commits work the user intended to cancel

Mitigation: user Stop remains highest precedence. Previously completed external tool
effects cannot be undone automatically, but newly proposed plan/query/assessment
artifacts from the stopped phase are not promoted.

### Risk: smaller tool projections reduce model understanding

Mitigation: return complete bounded structures, retain artifacts, provide accurate
continuation, and use targeted search/outline tools. Measure task completion rather
than maximizing raw bytes.

### Risk: continuation repeats writes or commands

Mitigation: persist terminal tool identity, target hashes and checkpoint IDs. Default
to asking/rechecking when state changed. Never infer that an interrupted native
session forgot whether a side effect occurred.

### Risk: shared continuation refactor breaks Agent

Mitigation: extract pure stop classification and checkpoint construction first,
leave Agent tests unchanged, then adopt the primitive in chat behind dedicated
tests.

### Risk: adding too many persisted fields bloats conversations

Mitigation: bound all checkpoint arrays/text and use sidecar artifacts for large
payloads. Store identifiers and hashes in the conversation.

### Risk: reasoning budget options behave differently across wrappers

Mitigation: feature-detect or wrapper-test. Fall back to a total token cap. Do not
make Critical Thinking correctness depend on a Qwen-only option.

## Explicit Non-Goals

- No `node-llama-cpp` fork.
- No patching installed `node_modules`.
- No raw `LlamaChat` migration in this recovery pass.
- No removal of safety budgets.
- No generic prose summary as Critical Thinking evidence.
- No automatic trust in model-written URLs, file-state claims or completion prose.
- No silent conversion of normal chat into background Agent mode.
- No claim that `eogToken` alone means a workflow completed.

## Definition of Done

This recovery is complete only when all of the following are true:

1. The reproduced bee/wasp run creates exactly one durable reviewable plan on the
   real 8K local model.
2. Valid plan/query/assessment/report artifacts are never lost solely because a
   recoverable provider limit followed them.
3. User Stop remains distinct and authoritative.
4. Every model-facing tool result is bounded against the active context; disk byte
   limits cannot bypass it.
5. File range and batch metadata truthfully describe what the model saw.
6. The exact architecture audit either completes within the interactive attempt
   budget or becomes a resumable paused task with useful preserved work.
7. Resume/continuation cannot replay completed mutations silently.
8. Critical Thinking research remains isolated, evidence-led, bounded and
   citation-validated.
9. Local, OpenAI and Anthropic paths share termination semantics.
10. Automated tests, build, E2E and documented real-model acceptance all pass.

## Instructions for the Implementing Engineer or Model

1. Start from a clean tree and read `AGENTS.md`, `README.md`, `ROADMAP.md`,
   `docs/CRITICAL_THINKING_ARCHITECTURE.md`, and this document.
2. Reinspect the persisted reproduction data if it is still available; do not rely
   only on this summary.
3. Implement Phase 0 and prove the regression fails before changing production
   code.
4. Keep commits phase-scoped and reviewable.
5. Run targeted tests after every change and the full automated gate before each
   handoff.
6. Perform the Phase 3 exit-gate audit before deciding whether Phase 4 is needed.
7. Do not mark the old manual criterion of `finishes or stops within 15 minutes` as
   sufficient. The revised criterion is `finishes or pauses with a durable,
user-continuable checkpoint`.
8. Record real-model timings, context shifts, result projections and final status in
   the eventual implementation handoff.
9. Update architecture/docs only after the behavior and manual tests are real.
10. If a proposed shortcut violates an invariant above, stop and document the
    tradeoff rather than silently weakening safety or evidence fidelity.
