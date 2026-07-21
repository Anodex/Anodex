# Runtime Reliability Review — Log & Plan

**Scope:** commits `7ff76e0..HEAD` (14 commits). Skeptical correctness review + fixes.
**Started:** 2026-07-20. This file is the resume point if the session is cut short —
every item gets checked off (`[x]`) as it completes, with findings recorded inline.

## Plan

### Phase 0 — Baseline

- [x] Run `npm run typecheck` (baseline) — clean
- [x] Run `npm run lint` (baseline) — clean
- [x] Run `npm test` (baseline) — 141 files / 1383 tests, all pass

### Phase 1 — Read & review each area (diff + surrounding code)

- [x] A. Bounded task continuation — reviewed runner loop, recoverable-stop set, history/context threading, scheduler+agent wiring. Sound; interactions noted under H.
- [x] B. Read-coverage tracker — found F1 (no invalidation on write) + F4 (partial-line edge, accepted).
- [x] C. Path-claim verification guard — found F3 (URL/absolute-path false positives) + deleted/renamed-path false "fabricated" (fixed together).
- [x] D. Local output budgeting — `localOutputBudget`, `modelResultBudget`, `generationDiagnostics`, LlamaService wiring, thoughtTokens sub-budget: all consistent; found stale doc reference in `chat.types.ts` (fixed).
- [x] E. Renderer freeze fix — found F2 (late rAF flush duplicates reply tail after finalize). TokenBatcher/memoization otherwise sound; tool-activity late flush is intentionally still applied (terminal statuses must not be lost).
- [x] F. Critical Thinking changes — service/runner/structured-phase/report-contract reviewed (wave scheduler terminates: every `run()` call either spends a round or terminates the step; candidate scoring never lets a worse repair win). `criticalThinkingFallbackReport.ts` (citation-safe deterministic floor) and `criticalThinkingResearchOutput.ts` (bounded, defensive JSON parsing) both sound.
- [x] G. Web tools headers (browser-like headers, justified in-comment) + generation stop messages — fine.
- [x] H. Cross-feature interaction pass — A×B (agent runs write files constantly → F1 was worst there), B×C (mutated paths vs claims), E×store (F2), bounded runner test suite covers loop/coverage-sharing/claim-note mechanics.

### Phase 2 — Fix confirmed issues

- [x] F1: `ReadCoverageTracker.noteMutation`/`hasInteracted` + `runGuardedTool` hook (`helpers.ts`), covers move source via checkpointChanges; tests added (readCoverage.test.ts, helpers.test.ts).
- [x] F2: streaming guard in `chatStore.appendToken`/`appendThinkingToken`; new `chatStore.test.ts` incl. pinning that late tool-activity still applies.
- [x] F3: lookbehind in `PATH_PATTERN` + `hasInteracted` early-skip before `stat` in `findUnverifiedPathClaims`; tests added (URLs, absolute paths, deleted-path claims).
- [x] Stale doc reference `boundedThoughtTokenBudget` → `criticalThinkingSynthesisLimits().thoughtTokens` (chat.types.ts).
- [x] Targeted tests green (80/80 in the four touched suites).
- [x] Re-run FULL typecheck / lint / tests after fixes — typecheck clean, lint clean, 142 files / 1405 tests all pass (+22 new); prettier applied to touched files.

### Phase 3 — Report

- [x] Final summary to user (found / fixed / why)

## Findings

(appended as discovered; ❗ = confirmed bug, ⚠ = risk/smell, ℹ = note)

- ❗ **F1 — Read coverage never invalidated on write.** `ReadCoverageTracker` has no
  invalidation; write tools (`write_file`, `edit_file`, `patch_file`, delete/move in
  `mutationTools.ts`) never touch `ctx.readCoverage`. Within one bounded task (or even
  one one-shot generation — providers create a call-scoped tracker), read → edit →
  re-read returns "already read in full earlier this task — nothing new here", so the
  model cannot verify its own edits and its beliefs go stale → the exact
  "edit_file: text not found" failure this work was meant to eliminate.
  Fix: add `ReadCoverageTracker.invalidate(path)`; call from `runGuardedTool`'s
  success path for non-read touches + checkpoint changes.
- ❗ **F2 — Late rAF token flush duplicates reply tail.** `useAnodexBridge` batches
  tokens into a `requestAnimationFrame` flush; `chatStore.sendMessage`'s finalize
  (invoke resolution, not rAF-gated) replaces `message.content` with the full final
  content. A buffered final frame of tokens then flushes AFTER finalize and is
  appended again (`appendToken` has no streaming guard) → duplicated tail text +
  stray text block. Pre-batching, IPC ordering made this impossible.
  Fix: `appendToken`/`appendThinkingToken` ignore messages with `streaming !== true`.
- ❗ **F3 — Path-claim regex false-positives on URLs and absolute paths.**
  `PATH_PATTERN` in `pathClaimVerification.ts` is unanchored: `github.com/x/y/z.ts`
  matches starting at `com/…`, `/usr/lib/foo.so` matches `usr/lib/foo.so` — both then
  flagged "likely fabricated" in a visible note appended to the reply. Fix: add a
  lookbehind rejecting matches preceded by `[\w./\\-]`.
- ⚠ **F4 — read_file_range partial-line coverage**: when a single line exceeds the char
  budget, the truncated line is recorded as covered, so its remainder can never be
  served by this tool again this task. Accepted: the result explicitly says the line
  was cut; alternatives loop. Logged, not fixed.
- ℹ **F5 — read_file reads the whole file into memory before size checks** (pre-existing
  behavior, unchanged by this range; the 60KB "disk-safety ceiling" comment is
  aspirational). Not in scope.

## Fixes applied

All uncommitted on `main` as of this log's last update; full gate green after each.

1. **F1** — [readCoverage.ts](../src/main/tools/readCoverage.ts): new `noteMutation(path)`
   (clears full-file/range coverage AND the same-file read-attempt counter) and
   `hasInteracted(path)` (read OR mutated). [helpers.ts](../src/main/tools/helpers.ts):
   `runGuardedTool` success path calls `noteMutatedReadCoverage` with the declared
   non-read touches plus checkpoint changes (the latter is what carries a move's
   source path). Independent of `projectId`, unlike project-memory touches.
   Known gap (documented in-code): `run_command` can mutate files invisibly.
2. **F2** — [chatStore.ts](../src/renderer/stores/chatStore.ts): `appendToken` /
   `appendThinkingToken` drop tokens for a message whose `streaming !== true`.
   Tool-activity late flushes still apply on purpose (terminal statuses update
   existing cards in place; blocking them would freeze cards at "running").
3. **F3** — [pathClaimVerification.ts](../src/main/tools/pathClaimVerification.ts):
   `PATH_PATTERN` gains `(?<![\w.\\/-])` so URL/absolute-path fragments never match;
   `findUnverifiedPathClaims` skips any path `hasInteracted` reports true for,
   before `stat` — so honest "I deleted/renamed X" claims are never called fabricated.
4. **Docs** — [chat.types.ts](../src/shared/chat.types.ts) `thoughtTokens` comment now
   points at the function that actually exists.

## Verdict on the architecture ("if you find a much better way… make it")

No wholesale rework is warranted. The load-bearing designs in this range —
deterministic tool-layer coverage backstops instead of trusting model memory,
validate-then-check-stop-reason ordering (`runStructuredPhase`), breadth-first
research waves, candidate scoring that never lets a worse repair win, and a
citation-safe deterministic fallback report — are the right shapes for these
problems. The bugs found were seam bugs between incrementally-built pieces
(coverage×writes, batching×finalize, regex×URLs), not design flaws.
