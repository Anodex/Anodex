# Context Epoch Runtime

This document describes Anodex's bounded recovery path for local text, local
vision, and cloud generations that reach context pressure during a tool-heavy task.

## Ownership

- `boundedChatRunner.ts` owns the decision to continue a recoverable reply and
  creates a handoff after every potentially mutating tool call is terminal.
  A read-only call that was interrupted at the boundary is safe to discard and
  reopen; an unsettled write, command, web, or MCP call blocks the checkpoint.
- `runGeneration.ts` renders the handoff into the system segment before calling
  `boundHistoryForStatelessProvider()`. The history assembler remains the sole
  owner of ordinary transcript compaction; the handoff is fixed prompt cost and
  is therefore charged before history is sized.
- `LlamaVisionService.ts` owns in-turn measurement, output-room policy, image
  reclamation, provider-facing usage calibration, and the round-zero preflight
  that decides whether a rebuild actually reclaimed room.
- `LlamaService.ts` forces a fresh native text session for every context epoch;
  otherwise its stateful KV-cache fast path could keep the context the handoff
  was intended to replace.
- `readCoverage.ts` and `turnProgress.ts` own the two cross-cycle ledgers an
  epoch has to reopen: what the model has already read, and what it has already
  done. `contextPrompt.ts` owns both the handoff's token cap and its rendering,
  deliberately together so the cap measures the block that is really emitted.

## Recovery invariants

1. A context handoff contains only structured continuation facts: the objective,
   current plan, terminal tool settlements with their identity and outcome,
   written-content digests, carried progress ordering, and a verification
   reminder. Raw arguments, raw tool results, and image bytes stay outside it.
2. The protected handoff is capped relative to the provider context window and
   rendered into the existing system prompt. It cannot be evicted by history
   compaction, and its cost is subtracted from the history budget exactly once.
   The cap is enforced against the rendered block, and sheds the oldest
   settlements first; the objective and the verification note are never shed.
3. A new epoch returns to the persisted history that began the reply; it does
   not replay the same reply's raw assistant/tool transcript. The structured
   handoff is the replacement for that material. Completed plans are also
   omitted because they are UI history, not active work. The ordinary 24/40
   cycle ceiling, total-time limit, no-progress detection, read-churn guard,
   and no-smaller-rebuild preflight bound repeated recovery; there is no lower
   arbitrary epoch count that stops a task which is still making progress.
4. A resumed epoch may spend a small, bounded number of exact recovery reads on
   evidence the epoch dropped from active context — at most one per file per
   epoch. Ordinary repeated reads stay deduplicated, and the loop guard is not
   reset. Without this the handoff's own instruction to reopen evidence is
   answered with "already read earlier this task".
5. Cross-cycle progress accounting is epoch-aware. An authorized recovery read
   counts as real activity rather than reading as a repeat, but two consecutive
   cycles that do nothing except read stop the run with a recovery-churn reason
   rather than the untrue "made no new progress". The check is by tool `kind`,
   with known observational `run_command` calls classified as reads, so using
   `Get-Content` or `Select-String` through the shell does not bypass it or
   masquerade as a workspace mutation.
6. `finish_goal`'s evidence gate is seeded from the previous epoch's ordering,
   including the monotonic call counter. Otherwise a task whose work completed
   in the previous epoch is told "nothing has been done yet this turn" and
   instructed to mutate again — duplicate work created by the transition itself.
7. The vision transport uses a context-scaled reply floor. Tool-enabled rounds
   additionally reserve enough room for one bounded write-style call; a request
   that cannot meet this contract is stopped before llama-server can emit
   truncated JSON. The early boundary is `inputLimit − reply floor − headroom`
   and the hard stop is `inputLimit − reply floor`, so the gap between them is
   exactly the headroom at every supported context size.
8. A rebuilt vision epoch is preflighted on its first round. If it did not come in
   under the fixed input of the epoch it replaces, or already sits past the early
   boundary, that is fixed-overhead dominance — further epochs would produce the
   same request — and it stops with that diagnosis instead of spending the
   remaining recovery budget.

## Vision accounting

`/tokenize` measures text and tool schemas, but not chat-template framing or
image embeddings. When llama-server supplies the structured
`usage.prompt_tokens` field, Anodex updates a bounded estimate for the _next_
round only. Message framing and image costs are learned independently so an
image-heavy round cannot inflate a later text-only estimate.

Older Anodex-injected visual-inspection images may be replaced with an explicit
placeholder when context reclaim is required. User attachments and pinned images
remain governed by their existing retention policy.

`framingTokensPerMessage` is a per-message catch-all rather than a pure framing
figure: the residual also carries the gap between `JSON.stringify(tools)` and
however the chat template renders those schemas. It reconverges every round, but
that is why its bound is load-bearing rather than cosmetic.

## Diagnostics and privacy

One matched record per provider round carries the context size, input limit,
fixed tokens, tool-schema tokens, message and image-part counts, settled call
count, active/deferred tool counts, the derived boundaries, and both the
requested and effective output allowance. Emitting these from separate places is
what made the driving incident's own numbers un-tunable — its `fixedTokens` and
its output ceiling came from different rounds.

Context diagnostics contain counts, sizes, limits, causes, and bounded runtime
state only. They must never include the handoff, prompt text, tool-result bodies,
commands, workspace contents, or image data.

## Tests

Focused coverage: threshold coherence across 4K/8K/16K/32K (the early boundary
always precedes the hard stop by exactly the headroom), protected handoff
creation with command identity and write digests, the rendered block staying
inside its own cap with the verification note intact, recovery-read grant and
re-deduplication at both the tracker and the `read_file`/`read_file_range` level,
epoch-aware progress accounting and the recovery-churn stop, progress seeding and
its monotonic counter, same-reply transcript shedding, continuation beyond three
productive epochs, safe pending-read recovery, completed-plan removal,
system-prompt rendering, tool-aware small-context floors, and separated usage
calibration.

The full unit, lint, typecheck, production-build, and Electron smoke suites
remain required release gates.
