# Context Reliability and Critical Thinking Plan

> Implementation status: completed on 2026-07-19. This document now serves as
> the architecture and acceptance-test record for the shipped reliability pass.

## Implemented Components

- `src/main/chat/GenerationBudget.ts` — shared time, tool, provider-round, and
  context-shift policies for interactive, agent, scheduler, and research turns.
- `src/main/llama/deterministicCheckpoint.ts` — bounded, GPU-free mid-turn
  checkpoint folding; model-backed summarization remains between turns.
- `src/shared/toolArtifacts.types.ts`, `src/main/tools/webSearchTools.ts`, and
  `src/main/tools/webTools.ts` — structured search/fetch artifacts and focused
  passage extraction before model-facing truncation.
- `src/main/criticalThinking/CriticalThinkingEvidenceStore.ts` — queued atomic
  per-run evidence sidecars outside `runs.json`.
- `src/main/criticalThinking/CriticalThinkingService.ts` — persisted bounded
  plan-step workflow, synthesis/validation phases, partial results, and resume.
- `src/main/criticalThinking/criticalThinkingEvidence.ts` — evidence-packet
  construction, internal citation validation, normalized quote checks, chart
  value checks, and deterministic Markdown citation rendering.
- Renderer/shared IPC updates expose researching, synthesizing, validating,
  completed, partial, stopped, and failed states without conflating them.

This document captures the proposed long-term fix for Anodex context reliability,
tool-heavy local generation, and Critical Thinking research runs. It is intended
for review by another model or engineer, so it includes the observed failure,
the suspected causes, the recommended architecture, and the tests that should
prove the system is genuinely better.

## Summary

Anodex now has several local context-compaction fixes, but the 302-minute manual
test showed that the deeper issue is not only "can the model avoid crashing when
the context is full." The deeper issue is that tool-heavy workflows need explicit
budgets, durable checkpoints, evidence storage outside the chat transcript, and
clear termination semantics.

The correct fix should make long work bounded, resumable, citation-safe, and
provider-neutral. Local context-shift hooks are useful as an emergency safety net,
but Critical Thinking should not depend on a single giant chat turn staying alive.

## Observed Failure

A manual Anodex test using chat `c_dc6651fa-977c-49fc-8c3a-61979d47b10c` took
about 302 minutes and made the app feel frozen or near-crashed.

Important facts from that run:

- The model used an 8192-token context window.
- The run made 54 tool calls.
- The run had 25 context shifts.
- It produced about 3958 output tokens.
- It repeatedly reread similar file ranges.
- Some context shifts summarized many tool results into tiny or zero-token
  summaries.
- The final-looking output was not a reliable completion signal; `eogToken` was
  being treated too much like success.

That means the current system can sometimes survive a huge turn, but survival is
not enough. The user experience was poor, the runtime was unbounded, and the
result could still be incomplete or misleading.

## Root Causes

### 1. Context Accounting Was Too Conservative in the Wrong Place

`node-llama-cpp` already reserves context shift space before calling Anodex's
custom strategy. Anodex then subtracted another large reserve inside the strategy,
while also subtracting active tool schema cost.

In an 8192-token context, that can leave only a few hundred usable tokens for the
current exchange and summary after system prompt and tool schemas are counted.
That explains "0-token summary" behavior and why the strategy sometimes returned
history that still did not fit.

Status: the immediate accounting hardening was already worked on, but future work
should keep the principle explicit: each budget category should be counted once.

### 2. Mid-Turn Summarization Can Become a Slow Loop

The current compaction path can call the large local model to summarize during
context pressure. If a summary is later shrunk away or not retained, the next
context shift may have to summarize the same evidence again.

In the manual run, repeated context shifts and repeated summarization likely
created much of the 302-minute runtime.

The invariant should be:

- if evidence is considered compacted, a durable checkpoint must remain;
- if the checkpoint cannot fit, the turn must stop with a typed limit reason;
- the system must never silently advance a cursor while deleting the summary that
  proves what was preserved.

### 3. Tool-Heavy Local Turns Are Not Bounded Enough

Local generation can auto-loop through native function calls inside a single
assistant turn. That is convenient for small tasks, but dangerous for very large
ones.

The system needs turn-level budgets:

- wall-clock time;
- total tool attempts;
- provider rounds;
- context shifts;
- no-progress loops;
- repeated tool fingerprints;
- workflow yields.

The model should not decide unilaterally to spend five hours inside one reply.

### 4. Critical Thinking Stores Evidence in the Wrong Shape

Critical Thinking's promise is citation fidelity: do not invent sources, URLs,
quotes, dates, statistics, or claims.

A chat transcript is the wrong primary store for that. It is too large, too
lossy under compaction, and too easy for a model to paraphrase incorrectly.

Critical Thinking needs a structured evidence ledger outside the transcript.
The report should be generated from that ledger, not from a long model memory of
prior web-search chatter.

### 5. `fetch_url` Needs Focused Evidence, Not Prefix Truncation

Large pages can be hundreds of thousands of characters. Returning the first few
thousand characters may omit the relevant passage entirely.

`fetch_url` should store structured artifacts:

- requested URL;
- final URL after redirects;
- status code;
- content type;
- title;
- content hash;
- focused passages;
- extraction warnings.

Search snippets should be treated as leads. Fetched passages should support final
claims.

### 6. Provider Semantics Are Inconsistent

Local, OpenAI, and Anthropic generation paths need a shared termination model.
Recent local fixes already distinguish `context-limit`, `fixed-context-limit`,
`loop-guard`, and user stops. The largest remaining gap is cloud provider round
exhaustion: OpenAI and Anthropic can hit their tool-round cap and still return a
result shaped like ordinary completion.

The app should expose structured termination reasons all the way to chat, agent,
scheduler, and Critical Thinking.

## Recommended Architecture

Do not fork `node-llama-cpp`, and do not rewrite local generation around raw
`LlamaChat` yet.

The better fix is to build orchestration above providers:

- keep using `LlamaChatSession` for ordinary local chat;
- use context-shift strategy only as an emergency compaction layer;
- add provider-neutral execution budgets;
- add workflow checkpoint/yield semantics;
- move Critical Thinking evidence into a persisted ledger;
- synthesize reports from structured evidence, not raw transcript memory.

## Implementation Plan

### Phase 1: Lock Down Context Budgeting With Tests

Much of the local context accounting has already been implemented in the recent
context commits. This phase should primarily make that accounting explicit and
well-tested, not rebuild it from scratch.

The tests should cover the single budget projection for local generation:

- system/wrapper cost;
- current prompt cost;
- tool schema cost;
- requested output reserve;
- native context-shift reserve;
- checkpoint reserve;
- history budget.

Rules:

- never subtract the same reserve twice;
- active tool schemas must be counted using the real chat wrapper;
- direct tool schemas should be selected only if reply and checkpoint room remain;
- when budgets cannot fit, fail with a typed context-limit result instead of
  pretending the user stopped the run.

Acceptance tests:

- 4096, 8192, and 32768-token contexts;
- high tool-schema count;
- long system prompt;
- long current user prompt;
- generated assistant text already in progress.

### Phase 2: Add Structured Tool Artifacts

Add an internal artifact sink to generation/tool runtime context. Do not force
full artifacts into normal chat display.

This should land before deterministic checkpoints, because checkpoints are only
valuable if they can point at durable artifact IDs or source IDs.

For web search:

- query;
- provider;
- timestamp;
- result title;
- result URL;
- snippet;
- rank.

For page fetch:

- requested URL;
- final URL;
- status;
- content type;
- title;
- hash;
- extracted passages;
- warnings;
- byte-limit/truncation metadata.

Also fix the current `sourcesFromReport` integrity hole early. The Sources panel
must not derive sources from URLs found in the model's own prose. Until the
artifact ledger fully replaces it, report-discovered URLs should be ignored or
clearly marked as unverified text, not promoted into evidence.

Acceptance tests:

- redirects preserve both requested and final URL;
- large pages keep relevant focused passages even when the relevant text is near
  the end;
- unsupported content types are recorded clearly;
- artifacts are persisted even if the model later runs out of context;
- hallucinated URLs in report prose do not become trusted sources.

### Phase 3: Replace Mid-Turn LLM Summaries with Deterministic Checkpoints

The context-shift callback should avoid expensive model summarization. It should
produce a deterministic, bounded checkpoint:

- tool name;
- essential arguments;
- status;
- short result digest;
- exact artifact IDs or source IDs;
- omitted count.

This should reuse the existing rolling-summary and cursor machinery. The change
is mainly to swap the injected mid-turn summarizer for a deterministic digest
builder, while keeping the LLM summarizer for between-turn compaction.

The checkpoint must have a minimum retained form. If that minimum cannot fit, the
turn should stop with a typed context-limit reason.

LLM summaries should remain available for between-turn compaction, where latency
is less dangerous and failures are easier to recover from.

Acceptance tests:

- checkpoint cannot shrink to zero;
- evidence cursor advances only when retained;
- old evidence is not summarized repeatedly;
- failed summarizer falls back deterministically;
- context-shift callback does not call the large generation path.

### Phase 4: Add a Provider-Neutral Execution Controller

Add a shared controller around local, OpenAI, Anthropic, agent, scheduler, and
Critical Thinking generation.

Do not create a second termination vocabulary. Extend the existing
`GenerationStopReason` path first, adding reasons such as `rounds-exhausted`,
`time-limit`, `tool-limit`, `no-progress`, and `yielded`. A discriminated union
can come later if the call sites are migrated together.

The controller should track:

- wall-clock time;
- tool attempts;
- successful tool calls;
- provider rounds;
- context shifts;
- compaction calls;
- repeated tool fingerprints;
- consecutive errors;
- no-progress loops.

Provisional limits should scale with context size and task mode:

- interactive chat: warn or pause after about 15 minutes, 32 tools, 12 provider
  rounds, or a context-size-scaled shift limit, then ask whether to continue;
- agent turn: 15 minutes or remaining outer budget, 32 tools, 12 rounds, with a
  context-size-scaled shift limit;
- scheduled task: 10 minutes, 20 tools, 8 rounds, hard limited;
- Critical Thinking step: 10 minutes, 6 tools, 8 rounds, 2 shifts, hard limited;
- Critical Thinking total run: 60 minutes unless the user explicitly extends it.

Acceptance tests:

- user stop wins over limits;
- local context limit is not mislabeled as user stop;
- OpenAI/Anthropic round exhaustion is not labeled completion;
- repeated A-B-A-B tool loops are caught;
- a single non-cancellable operation can finish, but no new work starts after a
  limit is reached.

### Phase 5: Rebuild Critical Thinking as a Persisted State Machine

Critical Thinking should not run one huge model turn for an entire investigation.
It should be a workflow with persisted phases:

- planning;
- researching;
- synthesizing;
- validating;
- completed;
- partial;
- failed;
- stopped.

Each research step should have:

- status;
- attempts;
- evidence IDs;
- findings;
- uncertainties;
- budget;
- termination reason.

The service, not the model, should own plan step status. The model can propose
findings and call tools, but the service decides whether the step is complete.

The research turn should have a small context:

- original question;
- current step;
- prior step summaries;
- current evidence packet;
- allowed tools.

It should not replay the entire transcript.

Acceptance tests:

- three-step research run succeeds with bounded turns;
- partial budget produces a clear partial report;
- stop/resume works;
- app restart resumes from persisted step state;
- local, OpenAI, and Anthropic follow the same workflow contract.

### Phase 6: Citation-Safe Synthesis

Generate the final report from the structured evidence ledger.

Suggested approach:

- use internal citation IDs like `[[S12]]` and `[[S12:P3]]`;
- reject unknown IDs;
- reject raw URLs not in the ledger;
- require exact quotes to match stored passages after normalization;
- require statistics and dates to appear in cited passages or have stored
  derivations;
- validate chart data against stored evidence;
- allow one bounded tool-free repair pass;
- remove or flag unsupported claims after repair.

Acceptance tests:

- hallucinated source ID is rejected;
- exact quote mismatch is rejected;
- quote validation tolerates Unicode and whitespace normalization differences
  such as smart quotes, non-breaking spaces, and collapsed whitespace;
- statistic without evidence is rejected;
- chart with unsupported number is rejected;
- final Markdown links are generated deterministically from the ledger.

### Phase 7: Improve Persistence and UI

Critical Thinking persistence should keep metadata in `runs.json`, but store
larger evidence artifacts separately by run ID.

Persistence should use queued async atomic writes instead of synchronous writes
on every small update.

Renderer updates should be throttled for long runs.

UI should show:

- step X/Y;
- evidence count;
- fetched page count;
- elapsed time;
- current limit;
- partial/resumable state;
- synthesizing phase separately from research narration.

The report should stream only during synthesis, not while the model is still
performing evidence collection.

Acceptance tests:

- long run does not flood renderer updates;
- partial run can be resumed;
- failed/limited/stopped states display different messages;
- evidence remains available after restart.

## What Not To Do Yet

Do not fork `node-llama-cpp`.

Do not switch the whole local engine to raw `LlamaChat` unless the public
`LlamaChatSession` path is proven impossible. That would require reimplementing
KV-cache continuity and session bookkeeping, which is risky and only helps the
local provider.

Do not rely on generic prose compaction for Critical Thinking citation fidelity.
A prose summary can be useful as navigation context, but it must not be the only
source of truth for URLs, quotes, dates, statistics, or citations.

Do not treat `eogToken` alone as proof a workflow completed. Completion should
come from the workflow contract.

## Suggested Commit Order

1. Context budget accounting acceptance tests.
2. Structured search/fetch artifacts and focused passage extraction.
3. Deterministic mid-turn checkpoints and cursor invariants.
4. Provider-neutral execution controller and extended stop reasons.
5. Critical Thinking state machine and resumable persistence.
6. Citation-safe synthesis validator.
7. UI updates for progress, limits, partial results, and resume.

## Review Questions

1. Is the execution controller the right abstraction boundary, or should limits
   live inside each provider?
2. Should Critical Thinking use the same controller as chat/agent/scheduler, or
   wrap it with stricter workflow-specific policy?
3. What is the smallest deterministic checkpoint that is still useful after a
   mid-turn context shift?
4. Should evidence artifacts be stored in JSONL, SQLite, or per-run JSON files?
5. Should focused passage extraction be deterministic keyword scoring first, with
   embedding/rerank added later, or should embeddings be included immediately?
6. What limits should be user-configurable versus hard safety rails?
7. What should the UX do when a research run is partial but has enough evidence
   to write a useful answer?
