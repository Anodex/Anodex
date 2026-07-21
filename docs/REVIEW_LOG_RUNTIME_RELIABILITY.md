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
  served by this tool again this task. The coverage recording stays (the alternative
  loops); the partial note now names `search_files` as the way to inspect the rest.
- ❗ **F5 — unbounded in-memory disk reads** (pre-existing, fixed in follow-up):
  `read_file` decoded a file of any size before its budget check; `read_file_range`
  and `get_file_info`'s line counting decoded whole files with no ceiling at all.
  Fixed: `read_file` rejects on `stat` alone above 3× the char budget (UTF-8 can't
  decode to fewer than 1 UTF-16 unit per 3 bytes); line tools cap at 10 MB
  (`MAX_LINE_TOOL_SOURCE_BYTES`) with an honest redirect to `run_command` /
  `lineCount: null`.
- ⚠ **F6 — naive `Next startLine` hint** (fixed in follow-up): the continuation hint
  pointed blindly at `actualEnd + 1`, which can sit inside an already-covered island —
  sending the next call straight into an "already read" short-circuit and wasting a
  round trip. Now points at the next genuinely-uncovered line, or says every remaining
  line was already read.
- ❗ **F7 — out-of-band file changes invisible to coverage** (fixed; was the "run_command
  known gap" accepted under F1): a file changed by a command side effect (formatter,
  codegen, git), or by the user's own editor mid-task, kept its stale coverage — reads
  were short-circuited against content that no longer exists. Fixed with
  `ReadCoverageTracker.reconcileMtime`: read tools stat first (they all needed the stat
  anyway or cost one extra cheap stat) and reconcile the observed mtime before trusting
  or extending coverage; a changed mtime drops that file's coverage + attempt counter.
  Dropped-as-stale reads still count as `hasInteracted` so the path-claim check never
  accuses the model of "never reading" a file it genuinely read pre-change.

## Fixes applied

First three committed as `8927b28` (F1), `99af113` (F2), `24e517e` (F3), docs as
`866491a`; F4–F6 follow-up hardening committed after. Full gate green after each.

1. **F1** — [readCoverage.ts](../src/main/tools/readCoverage.ts): new `noteMutation(path)`
   (clears full-file/range coverage AND the same-file read-attempt counter) and
   `hasInteracted(path)` (read OR mutated). [helpers.ts](../src/main/tools/helpers.ts):
   `runGuardedTool` success path calls `noteMutatedReadCoverage` with the declared
   non-read touches plus checkpoint changes (the latter is what carries a move's
   source path). Independent of `projectId`, unlike project-memory touches.
   The `run_command` gap originally accepted here was later closed by F7.
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
5. **F5/F6/F4-note** — [fileTools.ts](../src/main/tools/fileTools.ts): byte-size
   precheck in `read_file` (3× char budget, rejectable from `stat` alone);
   `MAX_LINE_TOOL_SOURCE_BYTES` (10 MB) bound on `read_file_range` and
   `get_file_info` line counting; coverage-aware `Next startLine` continuation;
   partial-line note names `search_files`. Tests in `fileTools.test.ts`
   ("bounded disk reads and coverage-aware continuation").
6. **F7** — [readCoverage.ts](../src/main/tools/readCoverage.ts) `reconcileMtime`
   (+ `invalidatedReads` feeding `hasInteracted`); wired into `read_file`,
   `read_file_range`, and `read_multiple_files` in
   [fileTools.ts](../src/main/tools/fileTools.ts) right after their `stat`, before
   any coverage decision. Chosen over blanket invalidation after every
   `run_command` (which would destroy the tracker's dedup value on read-heavy
   audits that also run tests) and over command-string classification (unreliable):
   the mtime check is exact, catches editor/git changes too, and costs one stat
   that two of the three tools already performed.

## Remaining accepted non-fixes (final)

- **Partial-line coverage recording stays** (F4): not recording a budget-cut line
  would re-serve the identical truncated prefix until the loop guard fires (3 wasted
  round trips); recording it moves forward with an honest "cut short" note that now
  names `search_files`, and F7's mtime reconcile clears it whenever the file changes.
- **No architectural rework**: the designs in this range are the right shapes for
  their problems; every defect found was a seam between incrementally-built pieces,
  and all seams found are now closed.

## Verdict on the architecture ("if you find a much better way… make it")

No wholesale rework is warranted. The load-bearing designs in this range —
deterministic tool-layer coverage backstops instead of trusting model memory,
validate-then-check-stop-reason ordering (`runStructuredPhase`), breadth-first
research waves, candidate scoring that never lets a worse repair win, and a
citation-safe deterministic fallback report — are the right shapes for these
problems. The bugs found were seam bugs between incrementally-built pieces
(coverage×writes, batching×finalize, regex×URLs), not design flaws.
