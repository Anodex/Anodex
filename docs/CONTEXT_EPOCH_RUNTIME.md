# Context Epoch Runtime

This document describes Anodex's bounded recovery path for a local vision
generation that reaches context pressure during a tool-heavy task.

## Ownership

- `boundedChatRunner.ts` owns the decision to continue a recoverable reply and
  creates a handoff only after every observed tool call is terminal.
- `runGeneration.ts` renders the handoff into the system segment before calling
  `boundHistoryForStatelessProvider()`. The history assembler remains the sole
  owner of ordinary transcript compaction; the handoff is fixed prompt cost and
  is therefore charged before history is sized.
- `LlamaVisionService.ts` owns in-turn measurement, output-room policy, image
  reclamation, and provider-facing usage calibration.

## Recovery invariants

1. A context handoff contains only structured continuation facts: the objective,
   current plan, terminal tool settlements, and a verification reminder. Raw
   arguments, raw tool results, image bytes, and command bodies remain outside
   the handoff.
2. The protected handoff is capped relative to the provider context window and
   rendered into the existing system prompt. It cannot be evicted by history
   compaction, and its cost is subtracted from the history budget exactly once.
3. The runner creates at most three context-recovery epochs for a reply. A
   non-terminal tool call prevents checkpoint creation rather than risking a
   malformed tool-call/result history.
4. A recovery-only cycle cannot keep a task alive forever: two consecutive
   cycles that do nothing except read recovery material stop instead of consuming
   the full goal-cycle budget.
5. The vision transport uses a context-scaled reply floor. Tool-enabled rounds
   additionally reserve enough room for one bounded write-style call; a request
   that cannot meet this contract is stopped before llama-server can emit
   truncated JSON.

## Vision accounting

`/tokenize` measures text and tool schemas, but not chat-template framing or
image embeddings. When llama-server supplies the structured
`usage.prompt_tokens` field, Anodex updates a bounded estimate for the _next_
round only. Message framing and image costs are learned independently so an
image-heavy round cannot inflate a later text-only estimate.

Older Anodex-injected visual-inspection images may be replaced with an explicit
placeholder when context reclaim is required. User attachments and pinned images
remain governed by their existing retention policy.

## Diagnostics and privacy

Context diagnostics contain counts, sizes, limits, causes, and bounded runtime
state only. They must never include the handoff, prompt text, tool-result bodies,
commands, workspace contents, or image data.

## Tests

The focused tests cover protected handoff creation, system-prompt rendering,
tool-aware small-context floors, separated usage calibration, normal history
bounding, and existing vision reclaim behavior. The full unit, lint, typecheck,
production-build, and Electron smoke suites remain required release gates.
