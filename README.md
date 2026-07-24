<div align="center">

# Anodex

**A local-first AI assistant for coding help and general chat.**

Runs open-weight models on your own machine — private, fast, and offline-capable.

</div>

---

## What Anodex is

Anodex is a desktop app (Windows/macOS/Linux, built on Electron) that runs a
local LLM directly on your machine via `node-llama-cpp` (llama.cpp bindings).
There is no cloud round-trip and no account required for the core experience —
model weights, conversations, projects, and settings all live in local files
on disk. It's built for two overlapping use cases: a general-purpose chat
assistant, and a coding assistant with real, sandboxed access to a project
folder.

## Chat

- Streaming responses, rendered with syntax-highlighted code blocks (a curated
  `highlight.js` subset, themed to match the app rather than a stock look).
- Two kinds of conversation: **general chat** (no file/workspace access) and
  **project chat** (scoped to a selected folder, with file/command tools
  enabled).
- A visible **task-phase indicator** (Inspecting / Editing / Verifying /
  Responding) derived from a message's own tool-call sequence, so you can see
  at a glance what a turn is actually doing. Tool-heavy turns use subtle motion
  on phase headers, running rows, and diff/approval reveals so long work feels
  live without adding bulky cards.
- **Context compaction**: long conversations don't crash when they outgrow the
  model's context window. Between turns, older history is summarized on a
  separate isolated context. During an active tool-heavy turn, a bounded,
  deterministic checkpoint retains exact tool/source identifiers without
  recursively invoking the model. Proactive compaction remains the primary
  path, with the mid-turn shift as a last-resort safety net. Small contexts
  cap full native tool schemas and defer the rest through the tool gateway so
  checkpoints and working text retain usable space. Local output is also
  capped to the wrapper-measured room remaining after instructions and tools,
  preventing unfinished function arguments from consuming the whole window.
- Every generation has provider-neutral time, tool-call, provider-round, and
  context-shift limits. Tool limits soft-block additional calls so the model
  can still return useful partial work; context-shift budget stops are distinct
  from a true hard context ceiling and from a user Stop.
- **Attachments**: drag a file into the composer to attach it to your next
  message (not sandboxed to a project — you chose the file explicitly).
  Image-capable local, OpenAI, and Anthropic models receive PNG/JPEG/GIF
  attachments as real multimodal content rather than prompt text. Uploaded
  images render inline in the user message and reopen from their original path
  without storing image bytes in conversation JSON. Select any available chat
  image to open a fullscreen, keyboard-accessible viewer with zoom, drag-to-pan,
  copy, and save controls.
- Desktop notifications and a short AI-generated toast summary when a reply
  finishes while the window isn't focused.
- A "jump to latest" button appears when you've scrolled up during a long or
  streaming reply.
- Built-in slash-command shortcuts in the composer: `/test`, `/review`,
  `/refactor`, and `/summarize` expand into reusable prompts for common
  workflows.
- Assistant turns that change project files keep a compact checkpoint. The
  message footer opens a review dialog with created/modified/deleted labels,
  before/after diffs, and selective restore. Files changed again after the AI
  turn are flagged and excluded from the default selection so newer work is
  never overwritten without an explicit choice. Binary files overwritten,
  deleted, moved, or saved from email are retained byte-for-byte and reviewed
  by file size. Editing an earlier user message rolls discarded assistant
  checkpoints back newest-first before regenerating; conflicts can keep newer
  files or explicitly restore the earlier state.

## Projects

- A project is a selected folder plus a name, optional per-project
  instructions, and its own chat history.
- **Persistent project memory**: Anodex keeps a running ledger of recently
  touched files and task summaries per project (`ProjectMemoryStore`), so a
  _new_ conversation in the same project still has ambient context about
  prior work — not just its own chat history.
- The assistant can also record durable notes into a project's own
  `ANODEX.md` file via the `update_project_notes` tool, when you approve it.
- Switching between a project chat and a general chat correctly resets
  workspace/tool scoping — nothing about one leaks into the other.

## Critical Thinking

Critical Thinking is Anodex's dedicated deep-research workflow for questions
that need more than a quick web lookup:

- It first produces a structured research plan that you can edit and approve
  before any web research begins.
- The approved run is structurally limited to web search, public-page reading,
  and updating its own plan. It cannot edit project files, run commands, send
  email, save memory, or call connected MCP tools.
- Search queries, pages read, sources found, plan progress, and report writing
  stay visible while the run works; you can stop it at any time.
- Each approved plan step runs as a small, adaptive sequence of isolated model
  phases: choose focused queries, search and fetch directly with bounded
  concurrency, then assess whether the fetched evidence closes the step's
  remaining gaps. No research phase replays one enormous tool transcript.
- Local planning, query selection, and coverage assessment use constrained JSON
  output, one bounded retry, and compact deterministic query recovery when a
  smaller model still cannot satisfy the structure contract.
- Research rounds, coverage decisions, findings, selected URLs, and exact web
  artifacts are checkpointed between phases. A stopped, limited, or
  app-interrupted investigation can resume from the unfinished round and reuse
  evidence it already fetched.
- The service, not the model alone, decides when a step is sufficiently covered.
  A model-proposed `sufficient` verdict is accepted only with no remaining gaps
  and a minimum fetched-source basis. After two productive rounds, the service
  can also finish a step with preserved caveats when it has four distinct
  verified pages, at least two scholarly/official sources, a substantive finding,
  and no answer-blocking conflict. Optional literature gaps therefore do not make
  every otherwise reportable step look failed or exhaust all rounds.
- Per-step, per-attempt, search, fetch, wall-clock, and lifetime verified-source
  limits prevent open-ended research. Resume gets a fresh attempt budget without
  removing the run-wide evidence bound. When a limit is reached, Anodex keeps the
  evidence and produces a clearly partial report when possible.
- Search results are stored as unverified leads. Fetched pages are stored as
  verified evidence sidecars with requested/final URLs, status/content type,
  hashes, truncation warnings, and query-focused passages. URLs written only
  in model prose never become trusted sources. Candidate ranking favors
  government, academic, primary-study, and journal results and avoids common
  login-wall, discussion, metadata-only, and media-only hosts.
- The final Markdown report includes clickable inline citations, a source trail,
  and explicit limits/open questions. Evidence-backed bar, line, and pie charts
  are rendered when quantitative comparison is useful. A separate constrained
  chart-selection phase may add them after prose synthesis, but only exact values
  from one cited passage survive validation.
- Reports are synthesized in a separate tool-free phase from a bounded evidence
  packet. Every substantive prose/list/table block needs a verified citation;
  source IDs, quotations, raw URLs, numbers, and chart values are validated. One
  bounded repair pass runs first. If a broad local-model draft is still unusable,
  Anodex writes and validates one evidence-bounded section per research step,
  then creates a constrained cross-section summary. If both attempts for one
  section are unsafe, exact verified passages fill that section instead of
  dropping the research topic. Evidence packets label source class and prioritize
  scholarly and official sources within each step; weak-only support for a central
  claim triggers repair. A bounded consistency pass narrows overbroad absence
  claims and corrects direct cross-section conflicts before the overview is
  written. Deterministic recovery ranks complete, relevant result sentences above
  methods, navigation, figure, and supplementary fragments. Final source lists
  include only evidence cited by retained content, and the limits section remains
  concise. Adaptive output budgets and persisted synthesis diagnostics keep a
  short or malformed generation from erasing the research already gathered.
- Reports persist locally across restarts and can be copied as Markdown or
  exported as a polished, report-only PDF with citations and charts intact.

Critical Thinking uses the active local/cloud model and the web-search provider
configured in Settings → Tools.

## AI workspace tools

When a project is open, the assistant gets a set of tools confined to that
folder (path traversal outside it is blocked):

Settings → Tools can disable individual built-in tools for normal chats. This
removes their schemas from the model's context as well as preventing calls;
agent runs and scheduled tasks keep their own explicit per-run tool selections.

On smaller local-model contexts, Anodex also budgets the active tool surface
automatically. Task-relevant tools keep native function schemas; unrelated
Gmail, MCP, and project tools remain available through a compact on-demand
discover/describe/call gateway instead of crowding the reply out before it can
start. The chat context meter shows exact local tool-schema usage and how many
additional tools are available on demand.

- **Read (never need approval):** `list_directory`, `read_file`,
  `read_file_range`, `read_multiple_files`, `get_file_info`, `search_files`,
  `find_files`, `code_outline` (compact imports/exported-symbol map),
  `preview_html` (inline chat preview for HTML pages/games), `git_status`,
  `git_diff`, `git_commit_summary` (drafts a conventional commit message from
  status/diff stats), and `inspect_visual` (lets an image-capable model inspect
  a workspace image or a sandboxed screenshot of its HTML work).
- **Write/mutate (approval depends on permission mode):** `write_file`,
  `edit_file`, `patch_file`, `delete_file`, `move_file`, `delete_directory`,
  `create_directory` (always low-risk, never confirms), `run_command`,
  `run_project_check` (structured test/typecheck/lint/build diagnostics), and
  `save_email_attachment` (when Gmail is enabled, saves an attachment into the
  project).
- **Web (workspace-independent, available in general chat too):**
  `fetch_url` (read a public URL using focused passage extraction and retain a
  structured artifact), `web_search` (via a provider you choose in
  Settings — SearXNG self-hosted, Brave, Tavily, or Google Programmable
  Search; the tool doesn't exist at all when no provider is configured).
- **Plan:** `write_plan` / `update_plan_step` — a visible, structured task
  list the model can create and check off as it works.
- **Project notes:** `update_project_notes` (writes to the project's
  `ANODEX.md`).
- **Memory:** `remember_fact` saves approved global or project-scoped facts
  when memory is enabled.

## GitHub and MCP integrations

Settings → GitHub connects Anodex to GitHub's official hosted MCP server with a
fine-grained personal access token. The token is encrypted with Electron
`safeStorage` and never returned to the renderer after it is saved. GitHub runs
read-only by default; repository, issue, pull-request, and Actions toolsets can
be enabled independently. Turning off read-only exposes write tools, but every
GitHub mutation still requires explicit approval regardless of the global
permission mode.

An active project can be linked to an `owner/repository` target manually or by
detecting its `origin` git remote. The link is added to that project's model
context so GitHub tools use the right repository without repeatedly asking.

Settings → MCP Servers remains the advanced, provider-neutral surface for local
stdio and remote Streamable HTTP servers. Tools are discovered dynamically and
work with local, OpenAI, and Anthropic models. Remote bearer tokens, OAuth
records, and local-server environment values are encrypted in the OS credential
store; only non-secret configuration and environment-variable names are kept in
the MCP server config. Generic MCP calls are treated as sensitive because server
annotations are hints, while the trusted GitHub preset can distinguish verified
reads from approval-gated writes and destructive actions.

## Skills

Anodex has a lightweight markdown skill catalog for reusable workflows. Skills
tell the assistant _how_ to do recurring work; tools still decide what actions
it can actually take.

- **Project skills:** `.anodex/skills/*.md` in the active workspace. These are
  versionable with the repo and take precedence over personal skills with the
  same name.
- **Personal skills:** app-data `skills/*.md`, shared across projects on the
  local machine.
- **Assistant tools:** `find_skill` searches the active catalog and `load_skill`
  loads the exact instructions. They are always available to normal chats and
  autonomous agent runs.
- **Composer discovery:** while you type, Anodex shows a small, dismissible
  “Relevant skill” hint when the active project/personal catalog appears to
  match your request. Choosing **Use** prepends a concise instruction to use that
  skill without adding persistent composer clutter.
- **Pinned project skills:** Settings → Skills contains project-scoped skills
  and personal skills, and can pin either kind to the active project. Pinned skills
  are auto-loaded into the project prompt and shown in the compact context
  summary above the composer.
- **Context transparency:** project chats show a collapsed-by-default context row
  summarizing active project, project instructions, pinned skills, attachments,
  compaction summary state, and tool availability.
- **Skill draft helper:** assistant replies that used tools expose a subtle
  **Draft skill** footer action that opens a reviewable markdown skill draft in
  the active project's contextual settings, so the user can edit before saving.
- **Skill library/editor:** Settings → Skills contains the active project's
  skill library and the global personal library, which works without an active
  project. Both support search, starter markdown,
  duplication, deletion, editing, and pin controls where applicable.
- **Tool health dashboard:** Settings → Tools shows compact tool readiness cards
  for master enablement, project-scoped tool availability, web search, and
  approval mode, plus collapsed availability details explaining hidden tools; the
  searchable full tool catalog is collapsed by default.

Skill files use a small markdown format:

```md
---
name: code-review
description: Review code changes for correctness, safety, tests, and docs.
keywords: [review, pr, quality]
tools: [git_status, git_diff, read_file]
---

# Code review

Follow these steps...
```

The Anodex repo includes starter project skills for code review, TDD feature
work, bug triage, release checks, UI polish, dependency upgrades, and handoff
notes under `.anodex/skills/`.

### Workspace security model

File and directory tools resolve paths through the workspace boundary and check
real filesystem targets, including symlink/junction ancestors, before reading or
writing. A link inside the project that points outside the project is blocked.

Shell execution is different: `run_command` and the Workspace Dock terminal
start in the workspace directory, but they are real local shells, not OS
sandboxes. They can access anything the current user account can access. Anodex
protects those paths with risk classification, confirmation prompts, and a
destructive-command backstop rather than pretending shell commands are path
confined like file tools.

**Permission modes** (`ask` / `full` / `untethered`) control how much
mutating tools confirm with you before running; risk-classified per call
(`trivial` / `safe` / `sensitive` / `destructive`) so a `run_command` that
looks like `rm -rf` or a force-push always confirms regardless of mode.

## Workspace Dock

A side panel with configurable sections alongside the chat:

- **Plan** — the model's current task list for the conversation, live.
- **Files** — every file in the project, each attributed to you or the AI
  (by matching recent tool-write activity against file mtimes), with an
  in-app **code editor** (syntax-highlighted, live-edit-vs-your-own-edit
  banner so you never silently lose unsaved changes), an **image viewer**,
  and a sandboxed **HTML preview** with a code/preview toggle.
- **Activity** — a live feed of tool calls as they happen.
- **Outputs** — anything the model has produced worth surfacing outside the
  chat transcript.
- **Checkpoints** - project-wide history for AI file changes, with review,
  selective restore, and conflict-checked undo restore actions.

## Local model engine

- Point Anodex at any local `.gguf` file, or use the built-in catalog to
  **download a model in-app** with a real progress bar and cancel support.
- **Local vision models**: pair a vision-capable GGUF (including Qwen3.6) with
  its matching `mmproj` GGUF, then drag or attach PNG/JPEG/GIF/BMP images in
  chat. Discovered Hugging Face models download their published projector
  automatically; manually added models expose an **Add vision projector**
  action in the installed-models table.
- Vision inference stays inside Anodex. Packaged builds include a pinned
  llama.cpp runtime that runs privately on loopback; text-only models continue
  through the existing `node-llama-cpp` engine.
- OpenAI and Anthropic chats use the same bounded composer images and can
  revisit available image attachments from recent history. Cloud image bytes
  are sent only when one of those providers is selected.
- Image-capable providers expose a bounded `inspect_visual` feedback loop. The
  assistant can inspect workspace images or render an HTML page into a
  network-blocked, sandboxed screenshot, then use those pixels to revise its
  work. Each inspected image opens directly beneath its tool call and remains
  available after reopening the conversation. Uploaded and inspected images
  share the same fullscreen zoom viewer. When the same workspace output is
  inspected more than once in a turn, the activity offers a responsive
  before/after comparison of the latest two captures. Exact preview pixels live
  in bounded conversation assets; chat JSON stores only a small reference and
  never the base64 payload. Text-only local models do not receive this tool.
- **Hardware-aware recommendations**: detects your RAM/VRAM/GPU and scores
  every catalog model against your actual machine (a 0-100 fit score), with
  "Best Overall / Best Coding / Fastest / Low RAM / Large Context" picks.
- **Per-model reliability scoring**: tracks real tool-call success/error
  rates and fabrication incidents per model, surfaced as a score with a
  per-tool breakdown, so you can see when a smaller/weaker model is actually
  struggling instead of just trusting its own confident-sounding replies.
- Auto-configures context size/GPU layers/max tokens from your hardware on
  first launch; adjustable anytime in AI & Models settings.
- A safety pre-flight check refuses to load a model that won't fit in
  available RAM, with a clear message instead of risking a native crash.

## Token activity (usage page)

Settings → Profile shows all-time usage stats, independent of individual
conversations (so deleting a conversation never loses your history):
lifetime tokens, sessions, messages, active days, peak day/hour, current and
longest streaks, longest single task, and a favorite-model pick — plus a
GitHub-style activity heatmap and a tokens-over-time chart (All/30d/7d range,
Daily/Weekly/Cumulative view) broken down and colored per model, with an
input/output split per model underneath.

## Settings

- **Profile** — your name/avatar/email/plan-tier display, token activity,
  local-only account status, and global assistant voice/tone preferences.
- **Appearance** — Dark/Light/System theme, curated dark-mode color presets
  (a full custom palette editor too), font family/size, density, diff-view
  style (unified vs. side-by-side), optional interface click and task-status
  sounds with selectable palettes and volume control, desktop notifications,
  reduced motion, compact mode.
- **Memory** — structured project/personal memory, past-chat recall controls,
  and manual memory management.
- **Skills** — project instructions, project skills, and the global personal
  skill library.
- **Tools** — permission mode, terminal shell, tool health/catalog, and web
  search provider.
- **AI & Models** — local and cloud model control: load/unload, providers, hardware
  panel, recommended-model strip, installed-models table with fit + reliability
  scores, in-catalog search/download, and response-generation defaults.
- **Email** — Gmail connection, sync scope, and advanced OAuth setup.
- **GitHub** — official hosted MCP connection, read-only/toolset controls, and
  active-project repository linking.
- **MCP Servers** — advanced local/remote MCP server configuration, connection
  status, and discovered-tool inspection.
- **Archive** — restore or permanently remove archived chats/projects and bulk
  archive active conversations.
- **Diagnostics** — persistent local errors/warnings with configurable detail,
  startup cleanup, and retention limits.
- **About** — version info, hardware spec summary, and update status.

Projects are managed directly from the left sidebar. Each project's action menu
owns folder access, renaming, archiving, instructions, and project-specific skills.

## Auto-update

Built on `electron-updater` against GitHub Releases (check → download →
restart-and-install, each an explicit step, never silent). Currently
disclosed-limited: the source repo is private, and a packaged build has no
way to check a private repo's releases without embedding a token in every
distributed copy — which Anodex deliberately does not do. Update checks fail
closed (a caught, logged message, not a crash) until that's resolved (a
public releases mirror, a small relay service, or making the repo public).

## Privacy

Local-first by design: model inference, conversations, projects, and
settings all stay on your machine. The only network calls are ones you
explicitly opt into (web search, fetching a URL the model was asked to read,
connected email/GitHub/MCP providers, downloading a model, or checking for app
updates).

## Tech stack

Electron + electron-vite, React 18 + TypeScript, Zustand for state,
`node-llama-cpp` for text inference plus a pinned llama.cpp runtime for local
vision, CSS Modules with a
design-token theme (no CSS framework), Vitest + Playwright for testing.

## Getting started

```bash
npm install   # installs deps, including node-llama-cpp's native binaries
npm run prepare:vision # downloads the pinned llama.cpp vision runtime for this OS
npm run dev   # launches Anodex with hot reload
```

Load a model: **AI & Models → Recommended** to download one, or **Add
model** to point at a `.gguf` file you already have. Once it shows "ready",
start chatting. For a manually downloaded vision model, use the image button
beside the installed model to select its matching `mmproj` file; Anodex reloads
the model with vision enabled. `npm run dist` prepares and packages the vision
runtime automatically.

See `AGENTS.md` for architecture, conventions, and contribution details, and
`ROADMAP.md` for planned/in-progress features not covered above.
Real-model verification for long tool turns and Critical Thinking is documented
in `docs/CONTEXT_RELIABILITY_TESTING.md`.

## License

UNLICENSED — private project.
