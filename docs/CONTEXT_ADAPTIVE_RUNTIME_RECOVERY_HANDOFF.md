# Context-Adaptive Runtime Recovery Handoff

## Purpose

This document is the implementation handoff for the two real-model exit-gate
failures observed on July 20, 2026 after the uncommitted runtime-reliability work
described in `RUNTIME_RELIABILITY_RECOVERY_HANDOFF.md`.

It is intentionally narrower and more prescriptive than the earlier design document.
The earlier work fixed several real defects, but the two live tests proved that the
runtime is still unable to finish a long project-chat task and that Critical Thinking
can finish research while producing an unusably small final report.

The goal is not merely to turn the red or amber status into green. The goal is:

1. useful, bounded progress across supported context sizes and model capabilities;
2. durable checkpoints before every recovery boundary;
3. a substantive, citation-valid Critical Thinking report;
4. no duplicate side effects when work resumes;
5. honest Partial/Paused states when the requested result cannot be completed;
6. shared infrastructure where behavior is genuinely shared, without forcing
   Critical Thinking into a chat-style native tool loop.

Do not treat passing mocked unit tests as completion. The exact live tests in this
document are mandatory exit gates.

## Scope correction: 8K is a regression canary, not the architecture

The failures documented here happened with an 8,192-token local context, so the exact
8K configuration must remain a reproducible regression fixture. It is not Anodex's
target context size and must not become a hard-coded product tier.

Anodex must support two independent axes:

1. **Context capacity**: the usable token window after the wrapper, system prompt,
   active schemas, user request, history, and required output reserve are rendered.
2. **Model capability**: tool-calling reliability, structured-output reliability,
   reasoning-segment support, instruction following, speed, and memory pressure.

A small-parameter model can expose a large context and still be unreliable at tool
calling. A large model can expose a small context and still need multiple durable
cycles. Do not infer capability from context size or parameter count alone.

The implementation must therefore be capability-driven rather than keyed to `4096`,
`8192`, or any other named context tier. Named sizes belong only in tests.

### Required runtime capability profile

Introduce or extend a read-only capability description at the provider/generation
boundary. Keep it factual and measurable:

```ts
interface ModelRuntimeCapabilities {
  provider: 'local' | 'anthropic' | 'openai'
  contextWindowTokens: number
  measuredInputLimitTokens?: number
  supportsNativeTools: boolean
  supportsStructuredGrammar: boolean
  supportsThoughtSegments: boolean
  supportsCommentSegments: boolean
  supportsParallelToolCalls: boolean
  recommendedParallelToolCalls: number
  structuredOutputReliability?: 'unknown' | 'low' | 'medium' | 'high'
  toolCallingReliability?: 'unknown' | 'low' | 'medium' | 'high'
}
```

Do not pretend all fields can be known from model metadata. Populate static provider
facts where available and update reliability classifications only from bounded,
versioned local observations. A model-name heuristic may be a conservative hint, not
the sole source of truth.

### Context-adaptive behavior contract

The same orchestration invariants apply at every size, but the amount of work per
cycle changes dynamically:

| Effective capacity | Expected adaptation                                                                     |
| ------------------ | --------------------------------------------------------------------------------------- |
| Very constrained   | Minimal schemas, one small action, aggressive checkpointing, concise artifact packet    |
| Constrained        | One or a few actions per cycle, explicit output reservation, frequent continuation      |
| Comfortable        | Larger batches and evidence packets, fewer continuation cycles                          |
| Large              | Broader in-cycle work when useful, while retaining the same hard bounds and checkpoints |

These are behaviors, not numeric tiers. The resolver must use measured available
capacity and capabilities for the current request.

### Universal support contract

For every supported model/context combination, Anodex must:

- avoid crashes, silent context corruption, and unbounded loops;
- preserve completed tool work and evidence;
- never present unfinished work as complete;
- reduce active tools, batch width, evidence packet size, and per-cycle work when
  capacity is constrained;
- pause or continue from durable state when a single generation cannot finish;
- explain when the selected model is not reliably capable of the requested workflow;
- keep permission, citation, and mutation-safety guarantees unchanged.

Full completion cannot be guaranteed for every model. A weak model may not reliably
produce valid tool calls or structured output at any context size. "Support" means
safe, honest, resumable behavior and the best attainable result. Full completion is
required in acceptance tests only when that model/capability combination has been
shown capable of the workflow.

## Handoff prompt

Use this prompt with the implementation agent:

> Read `AGENTS.md`, `README.md`, `ROADMAP.md`,
> `docs/RUNTIME_RELIABILITY_RECOVERY_HANDOFF.md`, and
> `docs/CONTEXT_ADAPTIVE_RUNTIME_RECOVERY_HANDOFF.md` completely before editing. Verify this
> handoff against the current dirty working tree and preserve all existing
> uncommitted changes. Implement the phases in order with regression tests
> first. The two 8K failures are reproducible canaries, not the product architecture:
> build one capability-driven runtime that derives budgets, tool routing, batch
> width, evidence size, required visible output, and continuation behavior from the
> active provider/model capabilities and the measured rendered context. Do not add
> hard-coded 4K/8K/16K/32K production branches. Keep Critical Thinking on its
> evidence-first domain runner; share the bounded task runner only across Project
> Chat, Agent, and Scheduler where execution semantics match. Preserve permission,
> citation, evidence, checkpoint, Resume, and mutation-idempotency invariants. Keep
> commits phase-scoped. Run the full automated gate and the documented representative
> context/model live matrix. Do not declare completion from mocked tests or from the
> 8K case alone; record measured live results, skipped matrix cells, and any capability
> limitations explicitly.

## Current repository state

At the time of this handoff, `HEAD` is:

```text
7ff76e0 Build evidence-first critical thinking research
```

The follow-up implementation is still uncommitted and spans Critical Thinking,
local generation, tool-result budgeting, file tools, and renderer stop messaging.
There is also an untracked earlier handoff document.

Before editing:

```powershell
git status --short
git diff --stat
git diff --check
```

Preserve all existing changes. Do not reset, restore, or rewrite them wholesale. Work
from the current dirty tree and keep changes phase-scoped so each fix can be reviewed
independently.

## What the current uncommitted work successfully fixed

The live failures do not invalidate all of the current work. Preserve these changes:

- Critical Thinking planning is now tool-free structured JSON instead of relying on
  `write_plan` inside a native `LlamaChatSession` function loop.
- Valid plan/query/assessment output can be parsed before a recoverable content-size
  stop is classified.
- User Stop and orchestration limits remain distinct from provider output limits.
- Model-facing tool results now receive a runtime context-aware budget.
- `read_file_range` reports only lines actually returned.
- `read_file` and `read_multiple_files` no longer use disk-oriented byte caps as if
  they were model-context budgets.
- Bounded replies render as a notice instead of a false fatal error.

Those fixes address real bugs and should remain covered by their new tests.

## Executive diagnosis

The two exit gates failed for different reasons.

### Project chat

The local model reached the 2,048-token output ceiling before completing its first
tool call. No read tool executed, so there was no useful artifact from which to
continue.

This was not a context-shift crash and not contamination from old chat history. It
was a new conversation with two messages. The persisted assistant message contains
only:

- 135 visible response characters;
- 159 thinking characters;
- 2,035 reported output tokens;
- zero completed tool calls;
- `stopReason: token-limit`;
- `effectiveMaxOutputTokens: 2048`.

The native `promptWithMeta()` result itself reported `maxTokens`. Inspection of the
installed node-llama-cpp source confirms that response chunks contain incremental
tokens, so this is not caused by Anodex summing cumulative response chunks. The large
difference between displayed characters and output tokens is consistent with
non-visible native output, most likely an unfinished function-call section or
function parameters. Anodex does not currently retain enough bounded diagnostics to
identify that attempted call.

The current safe ceiling prevented a crash, which is good, but converted the task
into a deterministic no-progress stop, which is not sufficient.

### Critical Thinking

Critical Thinking successfully planned and gathered real evidence, then failed in
two separate layers:

1. sequential adaptive research exhausted the lifetime fetch budget before four of
   seven plan steps started;
2. final synthesis produced only a 175-character uncited draft, and its repair did
   not recover it.

The Citation Validator correctly rejected the final text. The bug is not that the
run was marked Partial. The bug is that the system spent meaningful time and gathered
14 verified pages but could not turn those durable artifacts into a useful report.

## Exact live evidence

### Environment

- Provider: local
- Model:
  `Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-GGUF-Qwen3.5-27B.Q4_K_M`
- Context size: 8,192 tokens
- Input limit: 7,373 tokens
- Project: Anodex4

### Project-chat exit gate

Prompt:

```text
Perform a read-only architecture audit of this project. Inspect the main source
directories and at least 12 relevant TypeScript files covering local generation,
context handling, web tools, Critical Thinking, cloud providers, IPC, and tests.
Use the read tools, do not edit files or run destructive commands, avoid rereading
the same range, and finish with the generation flow, context flow, tool flow,
five strengths, five risks, and exact supporting file paths.
```

Observed log:

```text
Clamped local output budget to measured context capacity {
  requestedMaxTokens: 8192,
  effectiveMaxTokens: 2048,
  fixedTokens: 4047,
  inputLimitTokens: 7373,
  hasFunctions: true
}

Generation round complete {
  round: 0,
  wrapper: 'QwenChatWrapper',
  stopReason: 'maxTokens',
  responseTextLength: 135,
  segmentContentLength: 159,
  tokenCount: 2035
}
```

Persisted conversation:

```text
C:\Users\Owner\AppData\Roaming\anodex\conversations\
p_mrra1t8b_z6s2v\c_af008f92-cc31-4755-b403-dc9d78a8175c.json
```

The assistant only announced that it would explore the source directories. It did
not inspect a file and did not produce the requested audit.

### Critical Thinking exit gate

Run:

```text
critical_mrthgfnz_noo33
```

Question:

```text
Compare the strongest current evidence on why honey-bee, bumblebee, yellowjacket,
paper-wasp, and hornet stings differ in pain, tissue effects, allergic risk, and
repeat-sting behavior.
```

Persisted data:

```text
C:\Users\Owner\AppData\Roaming\anodex\critical-thinking\runs.json
C:\Users\Owner\AppData\Roaming\anodex\critical-thinking\evidence\
critical_mrthgfnz_noo33.json
```

Observed result:

- status: `partial`;
- 7 planned steps;
- only the first 3 steps started;
- 22 successful searches;
- 36 fetch attempts: 21 successful and 15 failed;
- 14 verified sources;
- 43 total evidence artifacts;
- 12,567 model output tokens across the run;
- 382,972 ms of model generation time;
- approximately 13 minutes 55 seconds from creation through persisted finish;
- final report length: 175 characters.

Final report:

```markdown
# Comparative Analysis of Hymenoptera Stings: Honey Bees, Bumblebees,

# Yellowjackets, Paper Wasps, and Hornets

## Executive Summary

This report synthesizes available evidence
```

Final validation error:

```text
Citation validation remained incomplete: Material report text has no evidence
citation: This report synthesizes available evidence The report contains no evidence
citation markers.
```

## Confirmed code defects and gaps

### P0-A: The tool-enabled local output ceiling is unnecessarily restrictive

File:

```text
src/main/llama/localOutputBudget.ts
```

Current behavior:

```ts
const toolAwareCeiling = input.hasFunctions
  ? Math.max(1, Math.floor(input.contextSize * 0.25))
  : availableTokens
```

For the live 8K turn:

```text
available measured tokens = 7373 - 4047 = 3326
quarter-context ceiling    = 2048
effective output limit     = 2048
```

The real tokenizer/wrapper measurement already supplies the usable capacity. The
quarter-context rule throws away 1,278 measured tokens without reference to the
actual fixed prompt. It was added as protection against a malformed unfinished
function call, but in the live test it stopped a legitimate task before one tool
completed.

Required contract:

- The total hard maximum must never exceed measured available capacity.
- Preserve an explicit safety reserve where needed, but derive it from measured
  capacity rather than applying a second fixed quarter-context ceiling.
- A malformed first call must stop safely.
- A normal first read call must have enough room to finish.
- Do not solve this by restoring an unbounded or user-requested 8,192-token output.

Suggested initial formula to test, not blindly assume:

```ts
const measuredAvailable = Math.max(1, input.inputLimitTokens - input.fixedTokens)
const safetyReserve = functions ? boundedFunctionSafetyReserve(measuredAvailable) : 0
const safeCeiling = Math.max(MIN_FUNCTION_OUTPUT, measuredAvailable - safetyReserve)
```

Use the real-model test to tune the reserve. The implementation must retain a hard
stop below the native context boundary.

### P0-B: Anodex does not constrain reasoning separately from required output

Files:

```text
src/shared/chat.types.ts
src/main/llama/LlamaService.ts
src/main/criticalThinking/CriticalThinkingService.ts
src/main/criticalThinking/CriticalThinkingResearchRunner.ts
```

The installed `LlamaChatSession.promptWithMeta()` accepts:

```ts
budgets: {
  thoughtTokens?: number
  commentTokens?: number
}
```

The Qwen wrapper uses a `thought` segment, and the library closes that segment when
its budget is reached. Anodex currently passes only the total `maxTokens`. Therefore
hidden reasoning, visible prose, and native function-call generation compete for the
same small total allowance.

Required implementation:

1. Add optional internal generation controls for thought and visible/comment
   budgets. Keep them optional so cloud providers and wrappers without segment
   support remain compatible.
2. Thread them only through the local provider into `promptWithMeta({ budgets })`.
3. Keep the total hard `maxTokens` as the outer safety limit.
4. Use phase-specific profiles rather than one global split.

The following values are only starting observations for the reproduced 8K fixture,
subject to wrapper tests. They must not be stored as the production policy:

| Phase                  |            Total cap | Thought cap |         Required-output goal |
| ---------------------- | -------------------: | ----------: | ---------------------------: |
| Query JSON             |                  512 |       64-96 |                 at least 256 |
| Coverage JSON          |                1,024 |     128-192 |                 at least 512 |
| Planning JSON          |          1,024-1,536 |     128-192 |                 at least 640 |
| Report synthesis       | measured 2,500-3,200 |     256-384 |               at least 1,800 |
| Report repair          | measured 2,500-3,200 |     192-320 |               at least 1,800 |
| Interactive tool turn  |    measured capacity |     256-512 | enough for one complete call |
| Tool-free finalization |    measured capacity |     256-384 |  majority reserved for prose |

These numbers are starting hypotheses. Write wrapper-level behavioral tests and use
the exact local model to confirm them. If `commentTokens` does not govern function
sections, retain the total hard cap and add the continuation/no-progress behavior
described later.

Production must resolve the profile from measured capacity:

```ts
interface GenerationChannelBudget {
  maxTotalOutputTokens: number
  maxThoughtTokens?: number
  maxCommentTokens?: number
  minRequiredOutputTokens: number
  reservedFunctionTokens?: number
}

function resolveGenerationChannelBudget(
  phase: GenerationPhase,
  capabilities: ModelRuntimeCapabilities,
  measured: MeasuredContextBudget
): GenerationChannelBudget
```

Required invariants:

- all allocations sum to no more than measured available capacity;
- minimum required output is protected before optional thought or batch capacity;
- values scale continuously with capacity rather than switching on exact context
  sizes;
- unsupported segment budgets are omitted, not emulated inaccurately;
- constrained capacity reduces work per cycle before it removes the required answer
  reserve;
- an impossible allocation returns a typed pause/incompatibility result instead of
  starting a generation that cannot satisfy its phase contract.

### P0-C: Unfinished native calls are not observable enough to diagnose or recover

File:

```text
src/main/llama/LlamaService.ts
```

At a bounded stop, record diagnostic metadata, not sensitive content:

```ts
interface LocalGenerationDiagnostics {
  visibleTokens: number
  thoughtTokens: number
  functionParameterTokens: number
  unfinishedFunctionName?: string
  unfinishedFunctionParameterChars?: number
  completedToolCalls: number
  contextShifts: number
}
```

Requirements:

- Do not persist hidden chain-of-thought text.
- Do not persist raw function arguments, secrets, file contents, or command text.
- The pending-call tracker may expose the bounded name, call index, character count,
  and completion state.
- Log this structure at the bounded stop and optionally store it in development-only
  generation diagnostics.
- A completed tool card must still settle normally; an interrupted provisional card
  must not remain spinning.

This is necessary to distinguish:

- excessive thought;
- oversized function parameters;
- invalid tool syntax;
- response prose consuming the cap;
- a genuinely too-small output budget.

### P0-D: Critical Thinking spends lifetime budget greedily by step

Files:

```text
src/main/criticalThinking/CriticalThinkingService.ts
src/main/criticalThinking/CriticalThinkingResearchRunner.ts
src/main/criticalThinking/criticalThinkingResearchPolicy.ts
```

Current policy:

```text
maxRoundsPerStep: 3
maxQueriesPerRound: 3
maxPagesPerRound: 4
maxRoundsPerRun: 18
maxSearchesPerRun: 24
maxFetchesPerRun: 36
```

Current orchestration completes or limits step 1 before step 2, then step 2 before
step 3. At the maximum, three steps can consume all 36 fetch attempts:

```text
3 steps × 3 rounds × 4 pages = 36 fetch attempts
```

That is exactly what the live run approximated. A seven-step plan can therefore be
valid but operationally impossible under the scheduler.

Required contract:

- Every approved plan step receives a first-pass opportunity before any step spends
  its second adaptive round.
- Reserve enough remaining round/search/fetch capacity for every untouched step.
- Failed fetches still count toward the lifetime attempt budget.
- Verified-source lifetime bounds remain authoritative.
- Resume resets attempt-level counters as currently documented, but it must not
  always restart spending on the first limited step.

Recommended design: breadth-first research waves.

```text
Wave 1: one bounded round for every pending step
Coverage checkpoint
Wave 2: allocate additional rounds to the largest remaining material gaps
Coverage checkpoint
Wave 3: use any remaining budget only where it can change the report
Synthesis
```

At each allocation decision, compute:

```text
untouchedSteps
remainingRounds
remainingSearches
remainingFetches
minimumReservedRounds   = untouchedSteps
minimumReservedSearches = untouchedSteps × minimumQueriesPerFirstRound
minimumReservedFetches  = untouchedSteps × minimumPagesPerFirstRound
```

Do not start an adaptive round if it would spend the reservation for untouched
steps. If the approved plan is impossible even with minimum first passes, fail at
approval with an actionable policy message or deterministically reduce per-step
first-pass width; do not silently starve later steps.

The planner should also receive a policy-derived step range. Do not always request
3 to 7 steps without considering the current research policy.

### P0-E: Synthesis input and output are budgeted with approximations that leave too

little visible report space

File:

```text
src/main/criticalThinking/criticalThinkingSynthesisBudget.ts
```

Current behavior reserves 25% of the nominal context for total output and estimates
prompt tokens using three characters per token plus a generic system reserve. The
local generation layer later measures the real wrapped prompt and may clamp output
again. A reasoning model can then consume most of the remaining allowance before
writing the report.

Required contract:

- Build the synthesis packet against the same measured context reality used by
  local generation.
- Reserve a minimum visible-output budget before filling the evidence packet.
- Prefer fewer high-value passages over a larger evidence packet that leaves no
  answer space.
- Keep source diversity and all plan findings represented when possible.
- Cloud providers may continue using provider-specific conservative estimates, but
  the local provider should use the real tokenizer/wrapper.

Preferred seam:

```ts
interface ModelPhaseBudget {
  maxPromptTokens: number
  maxTotalOutputTokens: number
  maxThoughtTokens?: number
  minVisibleOutputTokens: number
}
```

Expose a read-only local preflight measurement or a packet-builder callback that can
measure the exact rendered request before generation. Do not instantiate a second
competing session or decode during preflight.

### P0-F: A worse repair can overwrite the better original draft

File:

```text
src/main/criticalThinking/CriticalThinkingService.ts
```

Current behavior:

```ts
} else if (repair.content.trim()) {
  draft = repair.content.trim()
}
validation = validateResearchReport(draft, artifacts, run.sources)
```

Any nonempty clean or recoverably-stopped repair replaces the original before the
service knows whether it improved the result.

This violates the earlier handoff requirement:

> A stopped repair never replaces a complete original draft unless the repair itself
> validates.

Required implementation:

```ts
const originalCandidate = evaluateReportCandidate(originalDraft, ...)
const repairedCandidate = evaluateReportCandidate(repairDraft, ...)
const selected = chooseBetterReportCandidate(originalCandidate, repairedCandidate)
```

Candidate scoring must be deterministic and validation-led. Suggested ordering:

1. valid beats invalid;
2. fewer high-severity safety/citation issues beats more;
3. greater required-section coverage beats less;
4. more cited substantive blocks beats fewer;
5. greater plan-topic coverage beats less;
6. only then use bounded substantive length as a tie-breaker.

Never select solely because the repair is newer or nonempty.

Persist bounded validation diagnostics for both attempts so the selection is
auditable.

### P0-G: Citation validation is not a report-completeness validator

File:

```text
src/main/criticalThinking/criticalThinkingEvidence.ts
```

The current validator correctly checks source IDs, passages, quotations, raw URLs,
numeric claims, chart data, and citation coverage. Preserve all of it.

It does not enforce the requested report structure or a minimum useful answer. A
tiny sentence with one valid citation could pass.

Add a separate report-contract validator. Do not mix report quality heuristics into
the evidence-safety validator.

Suggested result:

```ts
interface ReportContractResult {
  valid: boolean
  issues: ReportContractIssue[]
  substantiveBlocks: number
  citedSubstantiveBlocks: number
  representedStepIds: string[]
  missingStepIds: string[]
  sections: {
    executiveSummary: boolean
    findings: boolean
    conclusion: boolean
    limits: boolean
    sources: boolean
  }
}
```

Minimum requirements should be context- and evidence-aware, not a single arbitrary
character count:

- nonempty descriptive title;
- executive summary with at least one evidence citation when it makes material
  claims;
- organized findings with multiple substantive blocks when multiple evidence areas
  exist;
- explicit coverage of every completed or limited plan step, including a clear
  statement when evidence is insufficient;
- limits/open questions section;
- sources section;
- conclusion or bottom line;
- at least one valid internal citation in every substantive block;
- no unfinished heading or visibly truncated final sentence.

A Partial research run can still have a contract-valid report. It must accurately
describe incomplete evidence rather than pretending all planned work completed.

### P0-H: There is no deterministic useful fallback after two failed synthesis calls

Critical Thinking already owns structured, durable inputs:

- question;
- approved plan;
- per-step findings;
- uncertainties;
- coverage assessments;
- verified sources;
- focused evidence passages.

If synthesis and one repair both fail, the service should not expose a 175-character
fragment as the primary report.

Build a deterministic safe fallback from service-owned artifacts:

```markdown
# Research result: <bounded plan title>

## Status

The investigation is partial because <bounded service-owned reasons>.

## Findings by research step

### <step title>

<validated stored finding or explicit no-supported-finding message>
<citations selected from that step's fetched evidence>

## Limits and open questions

<stored uncertainties and untouched steps>

## Sources

<verified source markers rendered deterministically>
```

Important constraints:

- Do not transform an uncited model finding into a factual claim merely because it
  was stored. Pair it only with evidence that actually supports it, or present it as
  an unresolved research note.
- Prefer deterministic excerpts from verified passages where a safe finding cannot
  be reconstructed.
- Clearly label incomplete and untouched steps.
- The fallback itself must pass citation rendering and safety validation.

This is not a replacement for good synthesis. It is the final user-value floor.

## Phase 4 is now required, but must be built after the P0 corrections

The earlier handoff made the shared continuation runner conditional on the 8K live
audit. That exit gate failed. Therefore bounded continuation is now required.

However, simply rerunning the same prompt after `token-limit` would likely repeat the
same malformed or oversized first call. The continuation runner must change the
shape of work.

### Shared architecture

Use one generation kernel and two orchestration families:

```text
LlamaService / cloud providers
        |
        +-- BoundedTaskRunner
        |      +-- Project chat
        |      +-- Agent
        |      +-- Scheduler
        |
        +-- CriticalThinkingResearchRunner
               +-- planning
               +-- breadth-first research waves
               +-- evidence checkpoints
               +-- synthesis/repair/fallback
```

Email remains a tool/workflow capability used by the applicable runner. Projects are
context and persistence boundaries, not separate model engines.

### BoundedTaskRunner contract

The runner should execute multiple small provider turns around durable task state.
It must not recreate the entire native function transcript on every cycle.

Suggested state:

```ts
interface BoundedTaskState {
  version: 1
  objective: string
  phase: 'orient' | 'execute' | 'verify' | 'finalize' | 'paused' | 'complete'
  completedActions: CompletedTaskAction[]
  inspectedArtifacts: InspectedArtifact[]
  pendingActions: PendingTaskAction[]
  findings: BoundedTaskFinding[]
  openQuestions: string[]
  lastStopReason?: GenerationStopReason
  noProgressCount: number
  cycleCount: number
  updatedAt: number
}
```

All fields must have count and character limits. Do not persist hidden reasoning.

### Cycle behavior

1. Load the durable task state.
2. Select one small next action or a tightly bounded batch.
3. Route only the tools required for the current phase.
4. Execute at most the cycle tool budget.
5. Persist completed tool artifacts and task state.
6. If the objective is sufficiently covered, run a tool-free finalization call with
   a fresh output budget.
7. On a recoverable stop with progress, start another cycle from the durable state.
8. On no progress, narrow the next cycle or pause with an actionable Continue state.
9. Never repeat a mutation solely because the previous model turn stopped.

### Tool routing for the live audit

The first orientation cycle should not expose every project tool. For a read-only
architecture audit, begin with a minimal read surface such as:

```text
list_directory
search_files
code_outline or equivalent index lookup
read_file_range
read_multiple_files only after concrete paths are known
```

Mutation, command, email, and unrelated MCP tools should not consume schemas or
confuse the local model when the user explicitly requested read-only work.

After paths are known, the execution cycle can expose targeted read tools. The final
cycle is tool-free.

### Recovery classification

Continue automatically only when:

- the stop reason is recoverable;
- at least one new durable artifact or bounded state transition occurred;
- time/cycle budgets remain;
- the next action differs from the failed action;
- no user Stop occurred.

Pause instead of looping when:

- no durable progress was made;
- the same tool/action fingerprint failed repeatedly;
- the next action requires new approval;
- the output budget was consumed by an unfinished call twice;
- the wall-clock or cycle budget was reached.

### Mutation safety

For write-capable tasks:

- persist successful tool call fingerprints;
- include target path and before/after hashes where applicable;
- prevent the same mutation from replaying when the target still matches the known
  after-state;
- never infer that a mutation succeeded from model prose;
- preserve existing permission and confirmation behavior.

## Implementation phases

### Phase 0: Preserve and extend regressions

Before production changes, add tests that fail for the newly observed behavior.

Required tests:

1. `localOutputBudget` demonstrates the live 8K numbers and proves that safe measured
   capacity is not unnecessarily reduced to 2,048.
2. Local prompt options forward thought/comment budgets when supplied.
3. Generation diagnostics distinguish response, thought, and function-parameter
   tokens without persisting content.
4. A worse nonempty repair does not replace the original draft.
5. A recoverably stopped invalid repair does not replace a better original.
6. Report-contract validation rejects the exact 175-character live report.
7. A seven-step plan under the default policy cannot let early adaptive rounds spend
   the reservation for untouched steps.
8. Resume advances fairly instead of restarting unlimited spending on the first
   limited step.
9. Deterministic fallback produces a useful Partial report from verified evidence.

Do not mock away the behavior under test. Unit tests may mock model text, but the
budget allocator and candidate-selection tests must exercise production functions.

### Phase 1: Generation channel budgets and diagnostics

Implement P0-A through P0-C.

This phase must also establish the provider/model capability profile and the adaptive
channel-budget resolver. Do not scatter context-size checks across callers. The
resolver owns allocation; callers describe their phase and minimum artifact needs.

Files likely involved:

```text
src/shared/chat.types.ts
src/main/llama/localOutputBudget.ts
src/main/llama/LlamaService.ts
src/main/llm/LlmProvider.ts or the active provider abstraction
src/main/llm/LocalProvider.ts if present
src/main/llama/__tests__/*
```

Exit gate:

- the exact audit prompt completes at least one read tool call on its first bounded
  cycle;
- diagnostic counts explain every consumed output category;
- no context-shift crash;
- no unbounded generation;
- unit/property tests cover a range of measured capacities rather than only 8,192;
- unsupported channel-budget capabilities fall back safely.

### Phase 2: Fair Critical Thinking budget scheduler

Implement P0-D and policy-aware planning.

Files likely involved:

```text
src/main/criticalThinking/CriticalThinkingService.ts
src/main/criticalThinking/CriticalThinkingResearchRunner.ts
src/main/criticalThinking/criticalThinkingResearchPolicy.ts
src/main/criticalThinking/criticalThinkingPrompts.ts
src/shared/criticalThinking.types.ts if persisted scheduling metadata is needed
src/main/criticalThinking/CriticalThinkingStore.ts for defensive normalization
```

Persist only the minimum scheduling metadata needed for safe Resume. Any new field
must receive a defensive default for older runs.

Exit gate:

- every step in the seven-step live plan gets a first research round before an early
  step receives a third;
- global counters remain exact;
- failed fetches count;
- evidence checkpoints precede phase advancement;
- Resume does not discard or duplicate evidence.

### Phase 3: Measured synthesis and monotonic repair

Implement P0-E through P0-G.

Files likely involved:

```text
src/main/criticalThinking/criticalThinkingSynthesisBudget.ts
src/main/criticalThinking/criticalThinkingEvidence.ts
src/main/criticalThinking/CriticalThinkingService.ts
src/main/criticalThinking/criticalThinkingPrompts.ts
src/main/criticalThinking/__tests__/*
```

Exit gate:

- synthesis receives a guaranteed visible-output allowance;
- the exact 175-character fragment fails the report contract;
- an invalid repair cannot degrade the persisted draft;
- a valid token-limited report can still be accepted;
- citation, quote, number, URL, chart, and passage validation remain unchanged or
  stricter.

### Phase 4: Deterministic Partial-report fallback

Implement P0-H.

Exit gate:

- when both mocked synthesis attempts are empty, truncated, or invalid, the user
  still receives a structured Partial report;
- the fallback identifies untouched and limited plan steps;
- no unsupported factual claim is promoted from navigation-only findings;
- source links render safely.

### Phase 5: Shared bounded task continuation

Extract and reuse Agent's existing recoverable-stop classification and outer-turn
continuation behavior. Do not clone it into chat.

Files likely involved:

```text
src/main/agent/AgentRunService.ts
src/main/chat/runGeneration.ts
src/main/chat/GenerationBudget.ts
src/main/chat/* new bounded task runner/state modules
src/main/ipc/chat.handlers.ts
src/main/scheduler/SchedulerService.ts
src/shared/chat.types.ts
src/renderer/stores/chatStore.ts
src/renderer/features/chat/*
```

Critical Thinking must continue to use its own research runner. Do not route it
through the shared native function-call continuation loop.

Exit gate:

- exact audit prompt inspects at least 12 distinct TypeScript files;
- exact ranges are not reread;
- requested final audit is produced;
- no more than the configured total task cycles;
- no more than 15 minutes on the current hardware, or a durable user-continuable
  pause with useful progress;
- UI remains responsive;
- Continue resumes from task state, not from the giant raw tool transcript.

### Phase 6: UX and telemetry

Present different bounded outcomes accurately:

- `Paused — safe output limit reached; Continue is available`;
- `Partial research — some plan areas remain uninvestigated`;
- `Partial report — evidence was preserved but synthesis validation failed`;
- `Stopped by user`;
- genuine fatal failure.

Show concise development diagnostics in logs, not in normal user-facing prose.

## Required automated tests

### Local generation

- exact live budget arithmetic;
- requested cap below measured cap remains respected;
- measured cap below requested cap clamps safely;
- thought/comment budget forwarding;
- wrapper without segmented budgets remains functional;
- incomplete function params produce bounded diagnostics;
- user abort wins over token-limit reporting;
- no duplicate tool execution on retry/continue;
- tool-free finalization has no function schemas.

### Critical Thinking scheduler

- 3-step, 7-step, and policy-constrained plans;
- breadth-first first pass;
- adaptive second pass only after reservations;
- failed-search and failed-fetch accounting;
- evidence lifetime limit;
- Stop during each phase;
- Resume with partially completed round;
- Resume after run-level budget pause;
- older persisted run normalization.

### Synthesis

- valid clean report;
- valid report ending on token-limit;
- invalid original plus valid repair;
- better invalid original plus worse invalid repair;
- valid original plus invalid repair;
- recoverably stopped incomplete repair;
- user-stopped repair;
- report-contract section coverage;
- untouched-step disclosure;
- deterministic fallback;
- citation/quote/number/raw-URL/chart regression suite.

### Bounded task runner

- progress followed by recoverable stop continues;
- zero progress followed by token-limit narrows or pauses;
- repeated action fingerprint pauses;
- successful mutation is never replayed;
- approval-required next action pauses;
- finalization uses a fresh tool-free budget;
- cycle/time/tool limits are enforced across outer turns;
- renderer restart reloads durable state.

## Mandatory live-test matrix

Automated tests are necessary but not sufficient.

The matrix crosses context capacity with model capability. Do not record one model at
one context size as proof that the runtime is generally adaptive.

Minimum context fixtures, where supported by the selected model/backend:

```text
4K
8K
16K
32K
largest practical configured local context
configured cloud-provider context
```

Minimum model capability fixtures:

```text
small/weak local tool caller
medium local model
current 27B reasoning-distilled model
non-reasoning local model, if available
Anthropic provider
OpenAI provider
```

Not every Cartesian-product cell needs a long manual run. Automated budget and
orchestration tests cover the full range; manual tests must include representative
constrained, current, and comfortable configurations. Record skipped cells and the
reason.

### Test A: exact project audit at 8K

Use the exact prompt from this document in a brand-new Anodex4 project chat.

Pass criteria:

- first useful tool call completes;
- at least 12 distinct TypeScript files are inspected;
- no repeated range crawl;
- generation, context, and tool flows are explained;
- five strengths and five risks are included;
- conclusions include exact file paths;
- no context crash;
- no false success;
- final report within 15 minutes, or durable Pause with useful checkpoint and a
  successful Continue that later finishes.

Capture:

```text
contextBudget
visible/thought/function-parameter token counts per cycle
active tool names
completed and interrupted tool calls
context shifts
cycle count
wall time
final status
```

### Test B: exact Critical Thinking question at 8K

Use the exact Hymenoptera question from this document.

Pass criteria:

- one reviewable plan;
- every approved step receives research coverage or an explicit policy-based reason
  why it could not;
- fetched passages, not search snippets, support citations;
- substantive report, not a fragment;
- all material blocks cite valid evidence;
- limits identify incomplete species comparisons and missing evidence;
- Complete only when all plan requirements and report validation pass;
- otherwise useful Partial with deterministic fallback if model synthesis fails;
- Stop/Resume preserves evidence.

### Test C: small-context pressure

Repeat representative chat and Critical Thinking tests at 4K if the model supports
it. Expected behavior may be a durable Pause or more cycles, but never a crash,
fabricated completion, or useless empty report.

The same test with a weaker model must verify honest capability degradation. If the
model repeatedly cannot emit a valid tool call or structured artifact, Anodex should
pause with an actionable model-capability explanation rather than looping.

### Test D: larger contexts

Repeat at 16K and 32K. The scheduler and runner should need fewer recoveries without
changing correctness. A larger context is an optimization, not the correctness fix.

Verify that increased capacity is actually used: larger contexts may activate a
broader relevant tool surface, larger safe read batches, or larger evidence packets,
but must retain output reserves and hard limits.

### Test E: cloud providers

Run the structured Critical Thinking phases and synthesis on Anthropic and OpenAI.
Local-only thought budgets must not leak into unsupported provider requests. Fair
research scheduling, validation, repair selection, and deterministic fallback must
remain provider-independent.

### Test F: interruption and restart

- Stop during planning;
- Stop during search;
- Stop during fetch;
- Stop during assessment;
- Stop during synthesis;
- close/reopen the app after a checkpoint;
- Continue/Resume;
- verify no duplicate mutations, searches, or evidence records.

## Commands before each commit

Run targeted tests during implementation, then the complete gate:

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run build
npm run test:e2e
git diff --check
git status --short
```

If E2E requires a prior build, run the build first as documented in `AGENTS.md`.

Do not claim `test:e2e` passed if it was not actually run. Record any environmental
blocker explicitly.

## Commit sequence

Keep the work reviewable. Suggested sequence:

1. `test: capture live 8k generation and synthesis regressions`
2. `fix: reserve local output for required model channels`
3. `fix: expose bounded local generation diagnostics`
4. `fix: allocate critical research budgets fairly across steps`
5. `fix: measure synthesis space and preserve the better report draft`
6. `feat: provide deterministic partial research reports`
7. `feat: add shared resumable bounded task continuation`
8. `test: add live-model acceptance records and recovery coverage`
9. `docs: document bounded task and critical research runtime contracts`

Do not squash all phases into one opaque commit before review.

## Documentation updates required

Update these after implementation:

```text
README.md
ROADMAP.md
docs/CRITICAL_THINKING_ARCHITECTURE.md
docs/RUNTIME_RELIABILITY_RECOVERY_HANDOFF.md or a final implementation record
```

Document:

- one generation kernel versus the two orchestration families;
- context/output/channel budget ownership;
- breadth-first Critical Thinking budget allocation;
- report candidate selection and deterministic fallback;
- task checkpoint and continuation semantics;
- provider-specific behavior;
- live acceptance results.

## Definition of done

This recovery is complete only when all of the following are true:

1. The exact 8K project audit makes real tool progress and produces the requested
   result or a durable, successfully resumable pause.
2. The exact 8K Critical Thinking run produces a substantive citation-valid report
   or a useful deterministic Partial report.
3. Every approved research step receives a fair first-pass allocation.
4. Hidden reasoning cannot consume the entire allowance needed for required JSON or
   report prose.
5. An unfinished function call cannot crash the context or trigger an infinite
   retry.
6. A worse repair never replaces a better original report.
7. Report safety validation and report completeness validation both pass before a
   run is Complete.
8. All evidence and task checkpoints survive Stop, Resume, app restart, and renderer
   refresh.
9. No completed mutation can be replayed by continuation.
10. Local, Anthropic, and OpenAI paths preserve their supported behavior.
11. The full automated gate passes.
12. The live-test evidence is recorded rather than summarized as “tests pass.”
13. Production budgeting contains no special-case branch whose correctness depends
    on the context being exactly 4K, 8K, 16K, or 32K.
14. A capability profile, measured context budget, and phase contract are sufficient
    to derive tool routing, batch width, evidence size, reasoning allowance, required
    output reserve, and continuation behavior.
15. Representative small, medium, and large local models degrade honestly according
    to observed capability; a weak model cannot cause a crash, infinite retry, false
    completion, or evidence corruption.
16. Increasing context capacity improves efficiency without changing citation,
    permission, mutation, persistence, or completion correctness.

## Final implementation warning

Do not address these failures by only:

- raising context size;
- raising the context-shift count;
- raising `maxTokens` without a measured hard boundary;
- hiding the Partial warning;
- accepting a tiny cited report;
- retrying the same native prompt indefinitely;
- putting Critical Thinking back into a shared `LlamaChatSession` tool loop;
- creating five independent model engines for Chat, Agent, Scheduler, Email, and
  Critical Thinking.

The correct architecture is a shared provider/generation kernel, a shared bounded
task runner where execution semantics match, and a separate evidence-first Critical
Thinking research runner. Both consume one measured runtime-capability and budget
contract. The live 8K failures are sufficient evidence to build the missing seams,
but they are not the boundary of the design.
