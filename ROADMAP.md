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
make tool output easier to review:

- **Structured diagnostics/test tool** — wrap common project checks (`npm test`,
  `npm run typecheck`, `npm run lint`) and return parsed failures, touched test
  files, duration, and pass/fail state instead of a raw `run_command` blob. Keep
  `run_command` for escape hatches; use this for the common verify loop.
- **Workspace outline/code-map tool** — return symbols/imports/exports for a
  file or folder so the model can orient itself without reading entire source
  files. Start with TypeScript via the compiler API or ts-morph, then expand
  only if needed.
- **Git commit-assist tool/action** — build on existing `git_status`/`git_diff`
  to produce a commit summary/message and optionally stage selected files. The
  roadmap already has the UI question open; tool-level support would make it
  more reliable than asking the model to chain raw git calls every time.
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
- **Attachment/file artifact tools** — email tools can find attachments but not
  save/open them into the workspace. A guarded `save_email_attachment` tool
  would make the email integration more useful without letting the model send or
  mutate mail silently.

Avoid near-term work on broad semantic search or vision-as-a-tool until the
larger infrastructure blockers in their existing backlog entries are resolved.

### Skills for reusable workflows

Initial markdown skills are now built: `find_skill`/`load_skill` search both
project `.anodex/skills/*.md` and personal app-data `skills/*.md`, with project
skills taking precedence. The Anodex repo seeds starter project skills for code
review, TDD feature work, bug triage, release checklist, UI polish pass,
dependency upgrade, and handoff notes.

Remaining follow-ups:

- **Pin/auto-load skills** — let the user pin project skills that should be
  suggested or loaded by default for that project.
- **Skill authoring helper** — a command/action like "save this as a skill" after
  a successful workflow, with user review before saving.
- **Library/editor UI** — the model path has searchable tools; a later UI can
  show a compact project/personal skill library and editor.

Continue to defer executable skills, remote skill sharing, and marketplace
mechanics until the markdown version proves useful and safe.

### Additional product gaps worth considering

A broader pass over README/current features suggests a few high-leverage gaps that
are not quite "tools" or "skills":

- **First-run success path** — a guided setup that gets a new user from empty app
  to "model downloaded, project opened, first useful task completed" without
  digging through Settings. This matters more than another advanced feature.
- **Context transparency** — a small "what context is the assistant using?" view
  showing active project instructions, loaded memories, selected files,
  compaction summaries, and loaded skills. Default it closed/collapsed to save
  space, opening only when the user asks or when there is a relevant warning.
  This builds trust and makes wrong answers easier to debug.
- **Checkpoint / restore UX** — complement the existing file-rollback backlog
  with visible per-turn checkpoints: changed files, before/after snapshots where
  available, and a restore action. Default checkpoint details closed/collapsed,
  with a compact changed-files summary visible. This is a safety/trust feature,
  not just a coding convenience.
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

### 1. File rollback on message edit

Editing a past user message and regenerating already truncates chat history
from that point (in scope, built). What's deferred: also _reverting the actual
file writes/edits_ the discarded turn made on disk, so editing a message
doesn't leave stray file changes from the abandoned attempt. Needs a real
snapshot-before-write mechanism (capture a file's content right before the AI
edits it, keyed to the turn) — a mini undo-stack, not a small add-on.
Deliberately scoped out of the base edit/regenerate feature to avoid building
a versioning system prematurely. If picked up: hook into the same tool-call
execution path as `ProjectMemoryStore`'s `filesTouched` tracking (already
knows which files a turn wrote to), but add actual content snapshots, which
that store doesn't currently keep.

### 2. Batch diff review for multi-file turns

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

### 3. Smarter/semantic code search

`search_files` (`fileTools.ts`) is literal, case-insensitive substring
matching only — works for "find this exact string," not "where is X handled
conceptually" on a large codebase. Would need real new infrastructure: a local
embeddings model (to stay consistent with the local-first pledge) plus a
persistent vector index of the workspace, kept in sync as files change.
Meaningfully bigger than the other backlog items — treat as a "someday," not a
small follow-up.

### 4. Vision support (multimodal image understanding)

Whether a vision-capable local model could actually _see_ an attached/dropped
image. Checked directly against `node_modules`: `node-llama-cpp` (pinned
`^3.4.0`) has zero multimodal/vision plumbing in the installed version — no API
to load a multimodal projector (`mmproj`) alongside a model, no way to pass
image bytes into a generation at all, independent of whether the model file
itself is vision-capable (e.g. LLaVA, Qwen-VL GGUFs). Genuinely blocked on
upstream capability, not just unbuilt. Two paths if picked up again: (1) check
whether a newer `node-llama-cpp` major version has added multimodal support
before building anything custom — don't assume it's still missing without
checking; (2) if not, bypass node-llama-cpp's JS wrapper and integrate
directly with llama.cpp's own native multimodal/CLIP APIs (the same machinery
`llava-cli`-style tools use) — real native addon work, categorically bigger
than anything else in this backlog. Either way also needs: UI for image
thumbnails in the composer/message bubbles (today's attach chips are
text-file-shaped, no preview), and a way to tell the user whether their
_currently loaded_ model is vision-capable at all before they try.

### 5. User-defined slash-command shortcuts

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

### 6. AI-generated commit messages

A "generate a commit message from my staged changes" action — `git_status` and
`git_diff` are already wired up as AI tools, so the underlying data already
exists. Smallest idea on this list. Could be as simple as a button somewhere
(no dedicated git-status UI surface exists yet) that sends a fixed prompt like
"Look at git diff --staged and write a concise commit message" — no new tools
or IPC needed, since `git_diff({staged: true})` already exists. The main open
question is just _where_ this button/action lives in the UI.

### 7. Auto-update against the private `Anodex/Anodex` repo

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

### 8. Renderer bundle code-splitting

Production build reports a ~1.4 MB single JS chunk. Plain perf/DX improvement,
not correctness or security — lowest priority item on this whole list.

### 9. Broader test coverage

- Tests for `ModelStatusMenu` (cloud-model quick-switch dropdown with usage
  gauges) — shipped without dedicated tests.
- E2E coverage beyond the current launch/smoke tests: settings save/load,
  model switch UI, project selection, file preview, approval prompt flow.
  Current E2E is Playwright, config in `playwright.config.ts`, tests in `e2e/`.

## Recently resolved (kept briefly for context, not action items)

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
