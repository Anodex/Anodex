# Anodex — Roadmap

This is the single source of truth for **what's planned but not built yet**, for
whoever (human or AI) picks up the next piece of work. `README.md` documents
_current_ features and how they should behave; `AGENTS.md` documents
conventions/architecture for making changes. This file documents _intent_ —
what's coming, what's in progress, and what's deliberately deferred and why —
so two sessions don't independently build the same thing differently, and so
a feature idea raised once doesn't get silently lost.

**If you start work on something here, update this file in the same change** —
move it to "In progress" with a one-line pointer to the relevant files, and
move it to `README.md` once it's real and working. If you decide _not_ to build
something after reading this, leave the entry and its reasoning alone rather
than deleting it — the reasoning is often as valuable as the idea.

## In progress

Actively being built (uncommitted work in the working tree as of 2026-07-10).
If you're picking up other work, avoid these files unless you're the one
building the feature — check with the user first.

- **Email integration** — `src/main/email/` (`EmailAuthStore.ts`,
  `EmailService.ts`, OAuth-flow-shaped: a local HTTP server for the OAuth
  callback), `src/renderer/features/email/EmailView.tsx`,
  `src/shared/email.types.ts`. Not yet documented in `README.md` — do that once
  it lands.
- **Scheduled / recurring AI tasks** — `src/main/scheduler/`
  (`SchedulerService.ts` runs generations via the same `runGeneration`/
  `LlamaService` path as normal chat, `SchedulerStore.ts`, `recurrence.ts` for
  cron-like scheduling, `keepAwake.ts`), `src/renderer/features/scheduler/`
  (`SchedulerView.tsx`, task editor, task report). `src/shared/scheduledTask.types.ts`.
  Also not yet in `README.md`.

## Planned / backlog

Raised, discussed, and deliberately deferred — not started. Ordered roughly by
priority, not chronologically.

### Tooling review: higher-leverage assistant tools

A pass over the current tool system found the foundation is strong: tools are
workspace-confined where possible, mutating actions are approval-gated, calls are
visible in the transcript, diffs/HTML previews are surfaced inline, and the
catalog is parity-tested against runtime registration. The biggest opportunities
are not "more random tools," but tools that reduce repeated multi-call loops and
make tool output easier to review. Settings → Tools now includes a compact tool
health dashboard (enablement, project readiness, web search, approvals), collapsed
availability details for conditional tools, and keeps the searchable full catalog
collapsed by default.

Remaining tool-side opportunities:

- **Git commit-assist tool/action** — build on existing `git_status`/`git_diff`
  and `git_commit_summary`; the remaining question is whether to add guarded,
  selected-file staging or keep commits as an explicit user action.
- **Batch file-change review** — already listed below as a bigger approval-flow
  feature. It remains the best UI-side improvement for tool-heavy turns: group
  proposed edits into one review instead of modal/card fatigue across many
  sequential `write_file`/`edit_file` calls.
- **Tool result search/filter in transcript** — keep the current compact cards,
  but add a small per-turn affordance to filter failed calls, changed files, and
  verification commands. This preserves Anodex's minimal chat composer while
  making long tool runs scannable after the fact.
- **Safer command presets** — provide first-class preset buttons or model tools
  for install/test/lint/build/dev-server tasks, with command templates stored
  per project. This gives users predictable approvals without weakening the
  existing shell risk model.
  Latest review notes:

- `run_project_check`, `code_outline`, `git_commit_summary`, and
  `save_email_attachment` are built and cataloged; they are no longer backlog
  items.
- Normal chats now support persisted per-tool opt-outs in Settings → Tools.
  Disabled schemas are omitted entirely, while agent and scheduled runs retain
  their explicit allowlists. Local generation now also measures the real
  wrapper-rendered tool cost and keeps task-relevant schemas native while
  deferring the rest behind a compact discover/describe/call gateway
  (`src/main/llama/toolSurface.ts`). The gateway now also caps direct schemas
  by context size and respects negated read-only instructions, preventing an
  8K audit from spending nearly half its context on unrelated tool schemas.
  Local reply budgets are clamped against the same measured fixed input, with
  a quarter-context ceiling for tool-enabled turns, so a user setting equal to
  the full context cannot strand an unfinished native function call.
  Broader embedding/RAG routing remains
  deferred; the deterministic budget router solves the measured context-floor
  failure without adding an indexing dependency.
- The Settings tool catalog is searchable and reports cataloged tools rather than
  implying every conditional/email/web tool is active in the current chat.
- Tool health now has compact collapsed availability details for project, web,
  Gmail, and memory conditions; keep future work in this area focused on clear
  setup actions rather than more catalog metadata.

Avoid near-term work on broad semantic search until the larger infrastructure
blockers in its existing backlog entry are resolved.

### Skills for reusable workflows

Initial markdown skills are now built: `find_skill`/`load_skill` search both
project `.anodex/skills/*.md` and personal app-data `skills/*.md`, with project
skills taking precedence. The Anodex repo seeds starter project skills for code
review, TDD feature work, bug triage, release checklist, UI polish pass,
dependency upgrade, and handoff notes. The composer can suggest relevant skills,
and projects can pin skills that are auto-loaded into chat/agent prompts.

Remaining follow-ups:

- **Skill authoring helper** — assistant replies that used tools expose a subtle
  **Draft skill** action that opens reviewable markdown directly in the compact
  active project's sidebar settings, where it can be edited and saved as a
  project skill.
- **Library/editor UI** — Settings → Skills manages project skills and personal
  skills together, while personal skills still work without requiring an active
  project and can be pinned to the active project. Both include search, markdown
  editing, starter templates, and duplicate/delete actions.
- **Draft-to-editor handoff** — built: the assistant footer opens generated
  markdown directly in the project skill editor. Future polish can add a
  project/personal scope chooser before opening the editor.

Continue to defer executable skills, remote skill sharing, and marketplace
mechanics until the markdown version proves useful and safe.

### Additional product gaps worth considering

A broader pass over README/current features suggests a few high-leverage gaps that
are not quite "tools" or "skills":

- **First-run success path** — a guided setup that gets a new user from empty app
  to "model downloaded, project opened, first useful task completed" without
  digging through Settings. This matters more than another advanced feature.
- **Context transparency** — first compact version built in the composer: a
  collapsed-by-default row summarizes active project instructions, pinned skills,
  selected files, compaction summary state, and tool availability. Future passes
  can add per-turn memory/past-chat details and warning states without making the
  composer heavier by default.
- **Checkpoint / restore UX** — complement the existing file-rollback backlog
  with visible per-turn checkpoints: changed files, before/after snapshots where
  available, and a restore action. Default checkpoint details closed/collapsed,
  with a compact changed-files summary visible. This is a safety/trust feature,
  not just a coding convenience.
  First and second passes shipped: assistant turns that mutate text files
  persist per-message snapshots under `.anodex/checkpoints`; the assistant
  footer opens a changed-file review with before/after diffs, selective restore,
  and conflict detection for files edited again after the turn. The Workspace
  Dock now includes project-wide checkpoint history and conflict-checked undo
  restore. Binary files overwritten, deleted, moved, or saved from email are
  snapshotted byte-for-byte. Editing an earlier user message now restores all
  discarded checkpoints newest-first before truncating and regenerating, with
  an explicit keep-newer/restore-all conflict review. Future polish can move
  very large binary payloads into sidecar blob storage.
- **Model capability labels** — surface which models are good at tool use,
  coding, long context, JSON/tool-call reliability, and speed. Reliability
  scoring exists; the missing piece is turning it into actionable guidance at
  model-pick time.
- **Shareable support bundle** — one button to collect app version, hardware,
  model, recent diagnostics, failed tool calls, and logs into a redacted local
  report. Useful while the app is private and support is hands-on.
- **Conversation-to-work artifact** — promote useful outputs into durable docs:
  plan summary, implementation notes, decision record, release notes, or
  `ANODEX.md` update. This keeps valuable chat work from disappearing in a long
  transcript.
- **Project health dashboard** — lightweight panel combining git status, latest
  test/check result, open TODOs from plans, recently changed files, and active
  scheduled/agent runs. Keep it in the Workspace Dock, not the composer.
- **Animation / motion polish system** — first production pass built across chat
  messages, tool phase groups, tool rows, approval cards, diffs, current-request
  rail, sidebar rows, and composer overlays. Notes live in
  `docs/ANIMATION_EXPLORATION.md`. Keep future motion restrained, token-based,
  and accessible via existing reduced-motion handling.
- **AI experience improvements** — the first visual sample set was discarded;
  revisit this with a different direction before implementation. Better next
  candidates are likely less dashboard-like and more embedded in the existing
  chat/workspace flow: checked outcomes inside each assistant turn, subtle
  context provenance on demand, and project-state guidance in the Workspace
  Dock rather than new standalone panels.

### 1. Batch diff review for multi-file turns

Today, when a turn touches several files, each `write_file`/`edit_file` call
gets its own separate `ToolConfirmModal` approval, one at a time, as the model
calls them sequentially. Idea: a single "review everything this turn changed"
view — closer to a PR review — showing every pending diff at once with
approve/deny per-file or all-at-once, instead of a modal-per-call sequence.
The diff-preview infrastructure (`ToolCallDiff`, `DiffView.tsx`, `diffRows.ts`)
is directly reusable for rendering each pending change. The harder part is the
approval flow itself: today `runGuardedTool`'s `ctx.confirm()` blocks that
specific tool call until answered, and tool calls execute sequentially inside
node-llama-cpp's own loop — batching approvals means either (a) holding
multiple pending confirm requests open simultaneously and resolving them out
of order as the user reviews, or (b) a bigger architecture change where the
model proposes all edits before any execute. (a) is the smaller change and
fits the existing per-call confirm design.

### 2. Smarter/semantic code search

`search_files` (`fileTools.ts`) is literal, case-insensitive substring
matching only — works for "find this exact string," not "where is X handled
conceptually" on a large codebase. Would need real new infrastructure: a local
embeddings model (to stay consistent with the local-first pledge) plus a
persistent vector index of the workspace, kept in sync as files change.
Meaningfully bigger than the other backlog items — treat as a "someday," not a
small follow-up.

### 3. Vision support (multimodal image understanding)

Completed. Anodex now uses a two-path local engine: text-only GGUFs keep the
existing `node-llama-cpp` lifecycle, while a model paired with a matching
`mmproj` starts an Anodex-owned, pinned `llama-server` runtime with llama.cpp's
`libmtmd` multimodal support. The process binds only to `127.0.0.1`, uses a new
random API key and ephemeral port per load, has no visible web UI, and is
stopped by the normal model unload/app shutdown lifecycle.

The model scanner hides projector GGUFs as model components, automatically
pairs a sole sibling projector, and persists explicit pairings when several
exist. Hugging Face discovery excludes `mmproj` from main-model selection,
selects a compatible projector, and downloads both files. The installed-model
table provides a manual projector picker and Vision badge. The composer accepts
up to four bounded PNG/JPEG/GIF/BMP images as true OpenAI-compatible multimodal
content parts and keeps image bytes out of persisted conversation JSON.
Uploaded images also render inline in the user message. Reopened conversations
load the pixels from the persisted attachment path, while missing files degrade
to an unavailable-image card instead of breaking the transcript. Available
uploaded and inspected images open in a shared fullscreen viewer with bounded
50%-300% zoom, Escape/backdrop close, keyboard shortcuts, focus restoration,
and responsive mobile layout.

The same attachment path now maps images into OpenAI Responses API input-image
parts and Anthropic base64 image blocks when a cloud provider is selected.
Recent image attachments are reopened from metadata when still available;
current-turn images take priority within the four-image bound. The
provider-aware composer no longer incorrectly blocks cloud images.

Image-capable providers also receive `inspect_visual`, a read-only workspace
tool that can reopen a PNG/JPEG/GIF/BMP output or render an HTML page to a
sandboxed, network-blocked 1280x800 screenshot. Tool-produced images enter the
next provider round out-of-band instead of becoming base64 prompt text. The
queue is capped at four inspections per response, in addition to the existing
provider-round and repeated-call guards, so visual revision cannot loop
without bound. Successful inspections auto-expand their image beneath the tool
card in the transcript, including after the chat is reopened. Preview bytes are
stored as main-owned conversation assets while persisted tool calls retain only
sandboxed references; base64 data and all preview metadata remain excluded from
model-history replay. Permanently deleting a conversation removes its preview
assets. Text-only local models never receive the tool.

Keep future work focused on measured compatibility additions (more media
formats or model families), not a second vision transport. Preserve loopback
isolation, bounded payloads, the existing guarded Anodex tool handlers, and the
text-only `node-llama-cpp` path.

### 4. User-defined slash-command shortcuts

Type `/test` and it expands to a full prompt like "run the test suite and
summarize any failures"; `/review` triggers a structured code-review prompt;
etc. — the same pattern Claude Code itself uses. Needs: (1) a small settings
surface for defining shortcuts (name → expansion text, maybe per-project or
global), (2) composer-side detection of a message starting with `/name` before
send, expanding it into the real prompt text. Low-medium effort — no new
IPC/main-process work needed if shortcuts are stored in existing `AppSettings`
(or per-project `instructions`-adjacent state) and expansion happens
client-side in `chatStore.ts`/`ChatComposer.tsx` before `sendMessage` is
called.

### 5. AI-generated commit messages

A "generate a commit message from my staged changes" action — `git_status` and
`git_diff` are already wired up as AI tools, so the underlying data already
exists. Smallest idea on this list. Could be as simple as a button somewhere
(no dedicated git-status UI surface exists yet) that sends a fixed prompt like
"Look at git diff --staged and write a concise commit message" — no new tools
or IPC needed, since `git_diff({staged: true})` already exists. The main open
question is just _where_ this button/action lives in the UI.

### 6. Auto-update against the private `Anodex/Anodex` repo

Auto-update itself is fully built and working (`src/main/updates/
UpdateService.ts`, GitHub-provider `electron-updater`, manual Check/Download/
Restart flow in Settings → About) — what's blocked is specifically letting an
_installed, packaged_ copy of Anodex check/download releases from a private
repo, since that requires a token and the repo isn't public. A fine-grained
GitHub PAT (`anodex-releases`, Contents: Read/write, expires ~2027-07-05) is
saved locally in the gitignored `.env` — safe for _publishing_ releases from
the developer's own machine, but a prior attempt to bake it into the packaged
app via `autoUpdater.setFeedURL({..., token})` was deliberately reverted: that
token would travel inside every distributed copy, extractable by unpacking the
ASAR (Electron apps aren't sealed). Update checks against the private repo
currently fail closed (a caught, logged warning, not a crash) — intentional,
not a bug, until one of these is chosen:

1. **A separate public "releases-only" repo** (e.g. `Anodex/Anodex-releases`)
   — keep source private, push built installers to a public repo on release.
   Lowest effort, no backend needed.
2. **A small server-side relay** (e.g. a Cloudflare Worker) holding the real
   token, app calls the relay instead of GitHub directly — more moving parts,
   only worth it if there's a real reason to keep releases private too.
3. **Make `Anodex/Anodex` itself public** when ready to stop treating it as
   private — simplest, and was always the implied eventual path ("private for
   now").
   Explicitly low priority — "we will hold off... this will prob be the last
   thing we figure out."

### 7. Renderer bundle code-splitting

Production build reports a ~1.4 MB single JS chunk. Plain perf/DX improvement,
not correctness or security — lowest priority item on this whole list.

### 8. Broader test coverage

- Tests for `ModelStatusMenu` (cloud-model quick-switch dropdown with usage
  gauges) — shipped without dedicated tests.
- E2E coverage beyond the current launch/smoke tests: settings save/load,
  model switch UI, project selection, file preview, approval prompt flow.
  Current E2E is Playwright, config in `playwright.config.ts`, tests in `e2e/`.

## Recently resolved (kept briefly for context, not action items)

- **Detailed local-model Critical Thinking reports (2026-07-22)** — corrected the
  per-round page-limit overflow, expanded broad-plan attempt budgets, strengthened
  authoritative-source selection, constrained local structured phases, and added
  bounded retry/query recovery for malformed output. Final synthesis now scales its
  output budget to the active context and recovers broad failed drafts through
  independently validated per-step sections plus a constrained overview. Richer
  evidence fallbacks and persisted synthesis diagnostics prevent a short model
  fragment from hiding or discarding a successful research run. Follow-up live
  testing also added collapsed-table number recognition, unit-alias validation,
  authority-ordered synthesis evidence, per-section deterministic salvage,
  cited-only source lists, non-repeating overview fallback, and a dedicated
  validated chart-selection phase. A final quality pass now classifies source
  strength, repairs weak-only central claims, fills repeated searches from explicit
  evidence gaps, accepts well-supported steps with preserved caveats, checks
  sections for contradictions and overbroad absence claims, ranks fallback
  passages by relevance, and bounds the final limits section.

- **Context reliability and bounded Critical Thinking (2026-07-19)** — replaced
  GPU-backed mid-turn summaries with deterministic checkpoints, added durable
  structured search/fetch artifacts and focused passage extraction, introduced
  shared generation budgets and typed provider-limit stops, and rebuilt Critical
  Thinking as persisted adaptive research rounds. Query selection and evidence
  assessment now use short isolated model phases; bounded search and fetch work
  runs directly with cancellation and concurrency limits; the service verifies a
  fetched-evidence floor before accepting sufficiency. Incomplete rounds and
  evidence resume without replaying a giant transcript, while final synthesis
  remains evidence-led and citation-validated. See
  `docs/CRITICAL_THINKING_ARCHITECTURE.md` and
  `docs/CONTEXT_RELIABILITY_PLAN.md` for the architecture and acceptance criteria.

- **Checkpoint / restore UX first pass** - assistant file mutations now create
  per-message checkpoints and expose a restore action from the completed
  assistant turn.

- **Checkpoint / restore safety and review (2026-07-16)** - added changed-file
  classification, before/after preview, per-file selection, partial restore
  tracking, and explicit conflict warnings before newer work can be overwritten.

- **Checkpoint history and undo restore (2026-07-16)** - added project-wide
  history to the Workspace Dock and a conflict-checked way to reapply files from
  the AI turn after restoring them.

- **Binary checkpoint coverage (2026-07-16)** - binary overwrites, deletes,
  moves, and saved email attachments now preserve exact bytes, use byte-level
  conflict detection, and show size metadata instead of exposing encoded
  payloads as fake text diffs.

- **Message edit rollback (2026-07-16)** - editing an earlier user message now
  rolls discarded assistant checkpoints back newest-first before truncating the
  chat and regenerating. Conflict review can preserve newer files or explicitly
  restore all discarded changes, and compacted context is invalidated when its
  summarized history is edited.

- **Critical Thinking core workflow (2026-07-16)** — shipped the renamed,
  Anodex-native deep-research surface with editable plan review, web-only
  execution, live plan/activity/source progress, stop support, persisted reports,
  linked citations, evidence-cited bar/line/pie charts, PDF export, and focused
  source/persistence tests. Connected sources and mid-run follow-up steering are
  deliberate future passes.

- **Security/dependency hardening pass (2026-07-10)** — settings patch schema
  validation, API keys moved to OS credential storage (`safeStorage`), SSRF
  filter gaps closed, Electron `sandbox: true`, tool-approval scoping, and a
  full `npm audit` clear-out (Electron 33→40, Vite/Vitest/electron-vite/
  electron-builder majors) are all done. Also found and fixed a `.gitignore`
  bug (`models/` with no leading slash) that had silently excluded
  `src/main/models/` — a real source directory — from version control since
  it was written, alongside the intended downloaded-GGUF-weights exclusion.
- **In-app model downloads, hardware-aware recommendations, per-model
  reliability scoring, token-activity usage page** — all shipped, documented
  in `README.md`.
