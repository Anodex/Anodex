# Visual Runtime Evidence — Implementation Log

> **Purpose.** This is a resumable work log. If the engineer (human or AI) working
> on it stops mid-way, the next one should be able to read this file top to bottom
> and continue without re-deriving anything.
>
> Started: 2026-08-13. Base commit: `46b506e`.
> Driving incident: chat `c_fa3b6587-d9f0-430b-9dde-0d8e5a0593ef`
> (project `p_msb7m6ax_hx0wu`, workspace `C:\Users\Owner\Desktop\Test Website`).

## How to resume

1. Read "Status board" below. Anything not `DONE` is open work.
2. Read "Findings that drive the design" so you do not re-litigate settled facts.
3. Run `npm test` and `npm run typecheck` to confirm the tree is green before
   continuing.
4. Pick the next `TODO` in priority order. Do not reorder — the sequencing is
   deliberate and explained in "Why this order".

## Status board

| ID   | Change                                                                            | Status                                                 |
| ---- | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| P0.2 | Structural external-asset policy (import maps + declared assets + host denylist)  | DONE                                                   |
| P0.1 | Loopback inspection server (workspace-confined, ephemeral, torn down)             | DONE                                                   |
| P0.3 | Runtime diagnostics from HTML inspection (console/errors/network/canvas/WebGL)    | DONE                                                   |
| P0.4 | Wire P0.1–P0.3 into `inspect_visual` + surface diagnostics to the model           | DONE                                                   |
| P1.1 | Semantic loop-guard key (paraphrase-resistant)                                    | DONE                                                   |
| P1.2 | Escalating read-coverage refusal                                                  | DONE                                                   |
| P1.3 | Platform-aware command guard (Windows `grep`, `findstr \|`, empty-result warning) | DONE                                                   |
| P2.1 | Plan state machine (no reversal, no no-op churn)                                  | DONE                                                   |
| P2.2 | Visual-verification gate in `boundedChatRunner`                                   | DONE                                                   |
| P2.3 | Skip plan reconciliation when the cycle did no real work                          | DONE                                                   |
| P4.1 | `LlamaService` channel boundary (stop promoting bulk thinking to content)         | DONE                                                   |
| —    | `/goal` verification stopgap (not P3)                                             | DONE                                                   |
| —    | Re-run the real fixture and resolve H1–H4                                         | TODO (needs the app running; see "Open verification")  |
| P3   | `/goal` autonomy                                                                  | NOT STARTED (deliberately last — see "Why this order") |

Test count at the end of this work: **2,982 passing, 1 skipped** across 269
files, up from 2,935 at the base commit. Typecheck and lint clean.

## Why this order

The inspection harness is both the fix and the measuring instrument. Until it can
serve a real page and report runtime errors, every other improvement makes Anodex
fail _faster_ rather than _succeed_. Loop guards, plan rules, and prompt tuning all
assume the model can obtain evidence; P0 is what makes that true.

`/goal` autonomy is last on purpose: it raises the blast radius of a model that has
already demonstrated it will edit on unproven hypotheses. The P2 verification gates
must exist before autonomy is granted.

## Findings that drive the design

These are verified, not hypotheses. Do not re-investigate.

1. **`inspect_visual` manufactured the blank canvas.** It base64-encoded the page
   into a `data:text/html` URL and installed a `webRequest.onBeforeRequest` blocker
   that cancels every `http/https/file/ws` request absent from an allowlist built by
   regex-scanning `src=`/`href=` attributes. The project's three.js URLs live inside
   the `<script type="importmap">` JSON body, so the allowlist was **empty**.
   `import * as THREE from 'three'` was cancelled at the network layer; the module
   body never ran; the canvas was blank in every inspection regardless of project
   code. The four _classic_ scripts were inlined from disk and ran fine — exactly the
   observed "everything renders except the sandbox" signature.
2. **`data.startAngle` was never the active fault.** Zero occurrences in the file.
   `planet.angle` is set (lines 144, 216) and read (line 788).
3. **`updateClickRipples` exists** (defined 489, called 853). **`animate()` at 872 is
   inside the IIFE** (closed at 873). Neither was a real defect.
4. **The model's own searches produced false negatives.** `grep` failed loudly on
   Windows (recoverable), but `findstr` invoked with _grep_ alternation (`\|`) failed
   **silently** — exit 0/1 with empty output — on `sandbox-container`, `sandboxCanvas`,
   `getElementById`, `canvas`, and `section`, all of which exist. Anodex handed the
   model fabricated evidence and let it reason from it.
5. **`run_command` cannot host a server.** Default timeout is 60s (the model passed
   `timeoutMs: 5000` itself). `exec` + timeout kills any long-lived process. A shell
   _can_ technically detach (`start /b`), but there is no managed lifecycle — no
   ownership, port discovery, teardown, or log capture.
6. **53% of the failing turn was zero-yield.** 27 of 51 calls returned no new
   information. `inspect_visual` was called exactly once, at position 0, and never
   again — the `solar-system` `sectionId` follow-up the tool itself advertises was
   never used.
7. **`update_plan_step` had no state machine.** `completed → in_progress` was legal
   and identical repeats were unlimited, which is the plan churn in the final reply.
8. **The visible "Let me…" narration is a deliberate code path**, not a sanitizer
   gap: `LlamaService.ts` promoted the thinking segment into visible content whenever
   a round produced no answer text. Phrase-stripping would have deleted legitimate
   prose while leaving the real cause in place.

## Still unproven (do not assert these)

The user's blank canvas **in their own browser** has not been explained. P0 proves
the _inspection_ screenshot was invalid; it does not prove the real-browser failure
shares that cause. These remain live hypotheses, indistinguishable without P0:

- **H1 (most likely)** — page opened over `file://`; Chrome blocks module scripts
  from origin `null` by CORS while classic scripts still run. Same signature.
- **H2** — CDN unreachable (offline/blocked/jsdelivr failure). Same signature.
- **H3** — genuine init-path exception. There is **no `try`/`catch` anywhere** in the
  873-line file, so the first throw silently kills everything after it, `animate()`
  included.
- **H4** — WebGL context creation failure.

## Open verification

`P0` is unit-tested but has not been exercised against the real project, which needs
the Electron app running. The next engineer should:

1. Launch Anodex, open project `p_msb7m6ax_hx0wu`.
2. Ask it to inspect `index.html`.
3. Confirm the tool result now contains a **Runtime diagnostics** block.
4. Read the answer off that block — it resolves H1–H4 directly.

Do not edit `C:\Users\Owner\Desktop\Test Website`. That project is a controlled
fixture; only Anodex itself may modify it.

## Change log

Branch: `fix/visual-runtime-evidence`, from `46b506e`. Tree is green at every
commit (`npm test`, `npm run typecheck`, `npx eslint src`).

### `2aee64a` — inspection harness (P0)

| File                                          | Change                                                                                                                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/tools/inspectionServer.ts` (new)    | Loopback static server: ephemeral port on `127.0.0.1`, per-inspection UUID token prefix, `GET`/`HEAD` only, every path through `resolveInWorkspace`, `no-store`, sockets destroyed on close. |
| `src/main/tools/externalAssetPolicy.ts` (new) | Structural declaration parsing + private-address denylist.                                                                                                                                   |
| `src/main/tools/pageDiagnostics.ts` (new)     | Two-channel runtime evidence collection and formatting.                                                                                                                                      |
| `src/main/tools/visualInspectionTools.ts`     | `captureHtmlPreviews` serves over HTTP instead of a `data:` URL; injects the collector; records blocked requests; appends diagnostics to the tool result.                                    |

Three details that are load-bearing and easy to regress:

1. **Import-map keys ending in `/` are prefix mappings.** `three/addons/` →
   `…/examples/jsm/` means `OrbitControls.js` is requested at a URL that appears
   verbatim nowhere in the document. An exact-URL allowlist alone still blocks
   it. `DeclaredAssets.prefixes` exists for this.
2. **The MIME table is not cosmetic.** A browser refuses `<script type="module">`
   served as `application/octet-stream`. Getting `.js` wrong reproduces the
   original blank canvas through a new route.
3. **Declaration is necessary but not sufficient.** A workspace page declares its
   own URLs, so a purely declaration-based rule would be an SSRF primitive —
   `http://127.0.0.1:11434`, router admin pages, cloud metadata. Hence
   `isPrivateNetworkTarget`, with one exception for the inspection server's own
   origin. Residual DNS-rebinding risk is documented in the module comment and is
   **not** closed; closing it needs resolution-time filtering.

### `20f42b6` — wasted-effort and evidence honesty (P1)

| File                                      | Change                                                                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/tools/loopGuard.ts`             | Paraphrase check: queries reduced to meaningful terms (camelCase split, stop words dropped, sorted), compared by **subset relation**. Blocks only; force-abort stays on exact repetition. |
| `src/main/tools/readCoverage.ts`          | `recordCoverageRefusal()` — task-wide counter, reset by `noteMutation`.                                                                                                                   |
| `src/main/tools/fileTools.ts`             | `coverageRefusalResponse` ladder: note → name alternatives → throw (error status) → abort at 6.                                                                                           |
| `src/main/tools/commandGuidance.ts` (new) | Pre-execution compatibility/syntax refusal + empty-search-result ambiguity note.                                                                                                          |
| `src/main/tools/commandTools.ts`          | Wires both guidance checks into `run_command`.                                                                                                                                            |
| `src/main/tools/helpers.ts`               | Passes `spec.args` to `checkLoopGuard` at both call sites.                                                                                                                                |

Two subtleties worth preserving:

- The semantic window reset must run **before** the no-query early return, or a
  mutation (which carries no query) never clears it. This was a real bug caught
  by its own test.
- POSIX shells on Windows (Git Bash, WSL) genuinely provide coreutils, so the
  Unix-command redirect must not fire there. `checkCommandCompatibility` is
  shell-aware, not merely platform-aware.

### `fdcf53e` — verification gate, plan rules, channel boundary (P2, P4)

| File                                      | Change                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/chat/boundedChatRunner.ts`      | `describeMissingVisualVerification` — flags a visual success claim with no successful `inspect_visual` **after the last mutating call**. `canReconcilePlan` now requires a successful non-plan tool call. |
| `src/main/tools/planTools.ts`             | `rejectIllegalTransition` — refuses no-ops and `completed → in_progress`. `pending → completed` stays legal.                                                                                              |
| `src/main/llama/thinkingChannel.ts` (new) | `shouldPromoteThinkingToAnswer` / `appendThinking`.                                                                                                                                                       |
| `src/main/llama/LlamaService.ts`          | Per-round `toolActivityCount` snapshot; promotion decision routed through the new helper.                                                                                                                 |

**Ordering is the point of the visual gate.** Presence of an `inspect_visual`
call proves nothing — the incident had one, at position 0, before the edit. The
check is `index > lastMutationIndex`.

**The thinking fix is structural, never textual.** Phrase-stripping "Let me…"
was proposed, reviewed, and rejected: those phrases occur in legitimate prose,
so matching them deletes real answers while leaving the actual cause — a
deliberate promotion path — in place. Segment _size_ is deliberately not a
criterion either; a long answer emitted inside think tags is rare but real, and
refusing it would trade a messy reply for an empty one. Oversized reasoning is a
budgeting concern owned by the existing `thoughtTokens` sub-budget.

### Uncommitted at time of writing

`src/renderer/lib/slashCommands.ts` — `/goal` expansion now forbids reporting a
goal met without post-edit `inspect_visual` evidence. This is a **stopgap that
narrows the harm of the P3 mismatch, not P3 itself**. Its test
(`ChatComposer.attach.test.tsx`) was loosened from a verbatim string match to a
shape assertion so future prompt edits do not require a test edit.

## Remaining work

### P3 — `/goal` semantics (NOT STARTED, deliberately last)

The defect: `/goal` sets a persistent goal marker that reads as "keep working
until done", but expands to a single interactive turn with no completion
mechanism. The user in the driving incident wrote "don't stop till its done and
completely working" and received one turn. That is a product mismatch, not a
bug in any one function.

The machinery already exists and should be reused rather than rebuilt:
`finish_goal` is a registered tool (Agent-only today), `AgentRunService` already
runs bounded goal-directed loops, and `agentPrompts.ts` has a goal-aware
`CONTINUE_PROMPT`.

Recommended shape:

1. `/goal <text>` starts a bounded goal run in the chat thread: register
   `finish_goal`, raise the cycle budget, require each cycle to end with either
   `finish_goal` or a stated blocker.
2. Gate `finish_goal` on **evidence**, not assertion — for a visual goal, a
   successful `inspect_visual` after the last mutating call. The predicate is
   already written and tested as `describeMissingVisualVerification`; extract it
   rather than duplicating the logic.
3. Goal bar shows live state (`active` / `blocked` / `finished`) plus a stop
   control and a visible cap (wall clock + cycles).

Ship this **only** with step 2 in place. Autonomy without the evidence gate
raises the blast radius of a model that has already shown it will edit on
unproven hypotheses.

### Deferred, needs its own review

- **General background-service tool** (`start_service` / `stop_service` /
  `read_service_logs`). The inspection-owned server covers the visual case
  without exposing a general capability. A general one has real lifetime and
  orphaned-process concerns and should not ride along on this branch.
- **DNS-rebinding filtering** for the asset policy (see P0 note 3).
- **Yield-based generation budget** — counting _information returned_ rather
  than _calls attempted_ in `GenerationBudget.beforeTool`. The P1 ladder covers
  the read case specifically; the general version is still open.
