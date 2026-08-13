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
| —    | Re-run the real fixture and resolve H1–H4                                         | TODO (needs the app running; see "Open verification")  |
| P3   | `/goal` autonomy                                                                  | NOT STARTED (deliberately last — see "Why this order") |

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

Appended as work lands. Each entry: what changed, why, and what proves it.
