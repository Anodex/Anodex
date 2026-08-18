# Anodex Context and Tool-Orchestration Investigation Handoff

## Purpose

This document is an independent-review handoff for the repeated stopping, context exhaustion,
tool-selection, and tool-loop failures observed in one long Anodex project conversation.

The requested review is architectural. Do not solve this by adding more regular expressions,
prompt keyword classifiers, phrase-specific retries, or model-specific exceptions. Anodex must
support many local and cloud models and must remain capable of building anything the user asks
for, subject only to explicit permissions and safety boundaries.

## Repository and incident locations

- Repository: `C:\Users\Owner\Desktop\Anodex4`
- Current branch: `main`
- Current HEAD before the uncommitted investigation changes: `c678d31d9c1d504bfcc749e2360b1f54c5ec3c28`
- Conversation ID: `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef`
- Persisted conversation:
  `C:\Users\Owner\AppData\Roaming\anodex\conversations\p_msb7m6ax_hx0wu\c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef.json`
- Project used by the failed conversation: `C:\Users\Owner\Desktop\Test Website`
- Relevant user prompt from the final retest:
  `when opening the folder and running the index.html it does not show the sandbox its just black no planets or anything`

The Anodex working tree is intentionally dirty and contains the current investigation. Preserve
those changes, review them as a work in progress, and do not reset or overwrite unrelated edits.

## Product requirement

Anodex is a provider-neutral, local-first builder:

- It must work with small and large local GGUF models, local llama-server/vision models, and cloud
  or OpenAI-compatible providers.
- The full conversation must remain saved for the user, while the model receives a bounded active
  projection.
- Long tasks must cross context boundaries without forgetting the objective, repeating completed
  mutations, or rereading the same evidence indefinitely.
- All enabled capabilities must remain reachable. Small context windows may receive a compact
  native core plus an on-demand gateway, but functionality must not disappear based on prompt
  wording.
- Mutations and external side effects must remain governed by explicit tool permissions, risk,
  workspace confinement, and confirmation—not inferred English intent.

## Confirmed failure evidence

The same conversation failed repeatedly after application restarts.

### Large feature request

Assistant message `m_1765b232-295f-4f6b-82ac-5c54837cc7cf`:

- 21,334 output tokens
- 157 tool calls
- 0 successful writes
- Fixed context: 11,751 of a 16,384-token model window
- 23 active tool schemas and 36 deferred tools
- Ended because the conversation ran out of context
- Repeated variants of reading or searching the same Universe Sandbox code

### “Start working on step 2”

Assistant message `m_d1b54dc9-bdd8-4bf3-9c61-39370d07039b`:

- 5,750 output tokens
- 31 tool calls
- 0 successful writes
- Fixed context: 9,601 tokens
- 23 active tool schemas and 36 deferred tools
- Repeated attempts to find/read the same planet data instead of progressing

### “Does not seem to be working”

Assistant message `m_0330e4c2-93b5-43fd-9ae2-3d4cc088e75e`:

- 2,701 output tokens
- 25 tool calls
- 0 successful writes
- Fixed context: 13,569 tokens
- System prompt: 3,599 tokens
- Tool schemas: 2,867 tokens
- 23 active tool schemas and 18 deferred tools
- Stopped by the repeated-action/no-progress guard

### Black-screen prompt after restart

Assistant message `m_dd730340-50ef-4d17-9377-20d29d407f3a`:

- 2,185 output tokens
- 15 tool calls
- 0 successful writes
- Fixed context: 11,893 tokens
- 23 active tool schemas and 18 deferred tools
- Repeated `Get-Content` ranges and directory listings
- Stopped by the repeated-action/no-progress guard
- One final command card was persisted as `running` even though the reply had ended

The repetition guard is containing the loop, but containment is not completion. The central
failure is that the active model begins with too little usable room and context recovery reopens a
similarly crowded context, after which it reorients and rereads instead of continuing from durable
state.

## Additional observed symptoms

- The model sometimes selected email tools during unrelated project work.
- Visible prose sometimes appeared as the first part of a sentence, followed by work/tool cards,
  followed by the remainder of the sentence. This exposed stream ordering and batching problems.
- Older unfinished plans sometimes leaked into a newer concrete request.
- Read-only shell commands were previously counted as mutation/progress because `run_command` has
  command kind even when it only executes `Get-Content` or `Get-ChildItem`.
- Recovery summaries could retain repeated process narration such as “Let me check…” instead of
  preserving only facts, decisions, completed work, and the next unresolved state.

## What has already been tried

Treat every item below as something to review, not as proof the design is now correct.

### Context projection and recovery

- Added a provider-neutral bounded chat runner around provider generations.
- Added compact context-epoch handoffs carrying the objective, bounded working facts, tool
  settlements, plan state, touched paths, verification state, and durable write hashes.
- Recovery epochs return to the persisted base history rather than replaying the full same-reply
  tool transcript.
- Added rolling compaction snapshots and bounded recall windows for stateful local text,
  stateless local vision/llama-server, and cloud providers.
- Added tool-result and executed-argument reclamation for stateless multi-round requests.
- Added protection against a rebuilt epoch that fails to reclaim room.

### Loop and progress accounting

- Added shared read coverage across bounded cycles.
- Added repeated-call/no-progress detection using actual tool identities.
- Classified observational shell commands such as `Get-Content` and `Get-ChildItem` as read-only
  effects even though they use `run_command`.
- Allowed genuinely new file ranges after recovery while stopping repeated ranges.
- Settled interrupted read calls and renderer tool cards so a completed reply cannot remain
  falsely `running`.

### Request and plan isolation

- A new concrete user request no longer automatically receives an older unfinished plan.
- Context handoffs preserve the current objective and strip some repeated “Let me…” narration.
- Plan reconciliation is limited to cases with durable work and a completion claim.

### Stream/UI work

- Mixed visible text, thinking, and tool events are batched in provider arrival order.
- Late text frames are dropped after finalization while late terminal tool statuses remain
  accepted.
- Task-phase rendering distinguishes actual work from narration more reliably.

### Wording-based experiments that should not be the architecture

Several phrase detectors and nudge prompts were added while chasing individual failures. They
looked for words resembling completion claims, future action promises, project failures, email
intent, or a fabricated user turn. This approach was rejected because it can:

- turn a diagnosis or quotation into an edit attempt;
- hide or promote tools because of an incidental word;
- behave differently across languages, domains, and model styles;
- overfit one conversation while damaging unrelated tasks;
- make prompt wording an implicit permission system.

Current work removes the new project-failure detector, removes prompt-keyword email gating and
prompt-keyword native-tool ranking, removes the vision path’s prose-nudge routing, and sets
`SEMANTIC_PROSE_ROUTING_ENABLED` to `false` in `LlamaService.ts`. Some now-disabled detector/nudge
code remains in `toolCallFallback.ts`, `intentNudges.ts`, and the disabled branch in
`LlamaService.ts`; review whether it should be deleted entirely so it cannot drift back into the
runtime.

### Current structural tool-surface experiment

- `maxDirectToolsForContext(16_384)` was reduced from 20 to 10.
- The three gateway tools remain native, so the maximum active schema count at 16K becomes 13
  instead of 23.
- Native tools use a deterministic builder-core order, independent of user/model wording.
- Every remaining enabled tool stays callable through the deferred discover/describe/call gateway.
- The local vision schema target was reduced from 28% to 18% of context.
- The node-llama-cpp text path now holds back an additional 15% bounded headroom for a tool result
  before selecting native schemas.
- Linked email capabilities remain available behind the normal tool gateway and approval system;
  keywords no longer add or remove the domain.

This structural version passes tests, but it has not yet received a real post-change replay of the
failing conversation. Do not assume the chosen percentages or direct-tool count are optimal.

## What not to do

Do not add or restore any mechanism that uses words or phrase patterns from user or assistant
prose to decide any of the following:

- whether a file should be edited;
- whether a mutation is authorized;
- whether another provider round must run;
- whether the response should be stopped or truncated;
- whether email, web, filesystem, GitHub, MCP, or another tool domain exists for the turn;
- whether a plan is active;
- whether the model “promised” an action;
- whether a statement “looks like” success, failure, approval, denial, or fabrication.

Also do not:

- solve the issue only by raising the model context size;
- merely lower the round/tool limit so failure happens sooner;
- add model-name/provider-specific exceptions;
- discard the durable transcript or completed tool settlements;
- replay non-idempotent mutations after compaction;
- make the tool catalog permanently tiny or remove the ability to build arbitrary projects;
- bypass approvals, destructive-action confirmation, workspace confinement, or external-action
  safety;
- count changing narration as progress;
- count read-only shell commands as durable mutations;
- assume every local chat is stateful—llama-server/vision is stateless and resends messages.

Natural-language retrieval and the model’s own reasoning are expected. The prohibition is against
Anodex turning phrase matches into orchestration, authorization, capability, or mutation decisions.

## Decisions that should be state-driven

Use observable execution state instead:

- provider stop reason and measured token accounting;
- exact active schema cost;
- settled tool-call IDs, statuses, kinds, touched paths, and durable hashes;
- explicit tool permission/risk configuration;
- explicit project/workspace/account/thread configuration;
- whether a call is idempotent, read-only, mutating, or externally consequential;
- whether evidence is new or repeats an already-covered path/range;
- whether a previous epoch actually reduced fixed input;
- whether the current objective and completed work are present in the durable handoff;
- explicit user Stop, approval, denial, or UI mode—not inferred prose.

## High-value code paths to inspect

- `src/main/chat/boundedChatRunner.ts`
- `src/main/chat/runGeneration.ts`
- `src/main/llama/LlamaService.ts`
- `src/main/llama/LlamaVisionService.ts`
- `src/main/llama/toolSurface.ts`
- `src/main/llama/contextAssembler.ts`
- `src/main/llama/compaction.ts`
- `src/main/llama/contextShiftStrategy.ts`
- `src/main/llama/localOutputBudget.ts`
- `src/shared/contextPrompt.ts`
- `src/shared/contextBudget.ts`
- `src/shared/prompts.ts`
- `src/main/tools/readCoverage.ts`
- `src/main/tools/loopGuard.ts`
- `src/main/tools/turnProgress.ts`
- `src/main/tools/commandEffect.ts`
- `src/main/tools/registry.ts`
- `src/renderer/hooks/tokenBatcher.ts`
- `src/renderer/hooks/useAnodexBridge.ts`
- `src/renderer/stores/chatStore.ts`

## Questions for the independent review

1. Is fixed input measured consistently across node-llama-cpp, llama-server vision, and every
   cloud/OpenAI-compatible provider?
2. Does `fixedTokens` include the same things on each transport: system prompt, summary, recent
   history, prompt, images, message framing, native schemas, and tool-call arguments?
3. Does history bounding reserve enough room for both a valid tool call and its result, plus a
   useful final answer?
4. Is the native core small enough for 4K/8K/16K models while the deferred gateway remains usable
   by weaker local models?
5. Can the gateway be simplified without restoring a huge schema surface or losing arbitrary
   capability?
6. Does a fresh epoch carry enough exact state to continue without rereading, while remaining
   much smaller than the exchange it replaces?
7. Are current summaries preserving facts and durable outcomes rather than model process
   narration?
8. Can a provider round complete a write and then lose that fact before the next epoch?
9. Are local native function-call loops crossing context boundaries inside one provider call where
   the outer runner cannot checkpoint them soon enough?
10. Are tool-result caps and protected-recent-result counts appropriate for small contexts?
11. Is the current full system prompt itself too large or repetitive for a 16K builder model?
12. Are explicit integration/UI state fields needed so domain context does not rely on injected
    text markers?

## Suggested verification matrix

Test at minimum:

- local text model through node-llama-cpp;
- local vision model through llama-server;
- one OpenAI-compatible cloud provider;
- 4K, 8K, 16K, and 32K context sizes where supported;
- a long project request requiring many reads, multiple writes, and verification;
- a diagnosis-only request that must not mutate;
- an explicit build request that must progress beyond inspection;
- email available during a coding task without being selected accidentally;
- an explicit email task still able to discover and call email tools;
- a context epoch after successful mutation, ensuring the mutation is not repeated;
- a context epoch after several reads, ensuring exact duplicate ranges are not reopened;
- app restart and replay of the same persisted conversation.

Capture per round/epoch:

- context size and input limit;
- system, history, prompt, schema, image, framing, tool-call-argument, and tool-result tokens;
- active/deferred tool counts and names;
- provider stop reason;
- tool calls attempted/settled, read identities, changed paths, and write hashes;
- pre- and post-compaction fixed tokens;
- summary/handoff size;
- whether the final task completed.

## Acceptance criteria

- The failing black-screen prompt can inspect, make an appropriate change if the model determines
  one is needed, verify, and finish without context exhaustion or repeated-read stop.
- A 16K local model begins with materially more usable room than the failing 11.9K–13.6K fixed
  contexts.
- Context recovery measurably shrinks active input and continues from the next unresolved state.
- No English keyword or regex controls mutation, continuation, stopping, or tool-domain access.
- All enabled tools remain reachable across local and cloud models.
- No completed mutation is repeated after compaction/restart.
- The transcript never ends with a tool falsely marked `running`.
- Existing typecheck, lint, formatting, unit, build, and E2E checks pass.

## Current verification status

After the current uncommitted structural changes:

- TypeScript typecheck passed.
- ESLint passed.
- Prettier check passed.
- Unit suite passed: 3,134 passed and 1 skipped.
- Production build passed.
- Electron E2E smoke suite passed: 7 of 7.
- A live replay of the failing conversation is still required.

## Prompt to give Claude

```text
Perform an independent architectural investigation of Anodex's context and tool-orchestration
failure. Read docs/CLAUDE_CONTEXT_SYSTEM_HANDOFF.md completely first, then inspect the repository
and the persisted conversation it identifies.

Do not use user or assistant wording, keywords, regular expressions, or phrase classifiers to
decide whether to mutate files, continue a turn, stop a turn, activate a plan, or expose/hide a
tool domain. Do not add another prompt-specific guard. Base orchestration only on explicit
configuration, permissions, measured context state, provider stop reasons, settled tool calls,
durable effects, and exact repeated-work identities.

The product requirement is provider-neutral: Anodex must support many local and cloud models and
must remain able to build anything the user requests. Preserve every enabled capability, using a
bounded native core and on-demand discovery if needed. Preserve the full user transcript while
giving the model a bounded active projection. Keep approvals, destructive-action protection, and
workspace confinement intact.

Review the current uncommitted changes critically; do not assume they are correct. Trace token and
schema accounting across node-llama-cpp text, llama-server vision, and cloud/OpenAI-compatible
providers. Determine why a 16K model repeatedly starts with roughly 9.6K–13.6K fixed input, uses
23 active schemas, performs dozens or hundreds of reads with no writes, and then stops. Check
whether recovery epochs actually shrink context and preserve enough exact durable state to resume
without rereading.

Deliver:
1. an evidence-backed root-cause analysis with file/line references;
2. a clear assessment of the current work-in-progress changes;
3. a simpler provider-neutral design that avoids semantic prose guards;
4. any implementation fixes you can safely make without overwriting unrelated work;
5. regressions covering local text, local vision/stateless, and cloud paths;
6. measured before/after context budgets and active/deferred tool counts;
7. remaining release risks and a live-retest checklist.

Run typecheck, lint, formatting, unit tests, production build, and E2E tests. Do not commit, reset,
discard, or push anything unless I explicitly authorize it. Preserve the dirty working tree.
```
