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
  at a glance what a turn is actually doing.
- **Context compaction**: long conversations don't crash when they outgrow the
  model's context window. Older turns are summarized by the model itself
  (on a separate, isolated context — never the active conversation's) and
  folded into the system prompt, triggered proactively before the limit is
  hit, with a reactive safety net as a last resort. You get a toast telling
  you it happened.
- **Attachments**: drag a file into the composer to attach it to your next
  message (not sandboxed to a project — you chose the file explicitly).
- Desktop notifications and a short AI-generated toast summary when a reply
  finishes while the window isn't focused.
- A "jump to latest" button appears when you've scrolled up during a long or
  streaming reply.

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

## AI workspace tools

When a project is open, the assistant gets a set of tools confined to that
folder (path traversal outside it is blocked):

- **Read (never need approval):** `list_directory`, `read_file`,
  `read_file_range`, `read_multiple_files`, `get_file_info`, `search_files`,
  `git_status`, `git_diff`.
- **Write/mutate (approval depends on permission mode):** `write_file`,
  `edit_file`, `delete_file`, `move_file`, `delete_directory`,
  `create_directory` (always low-risk, never confirms), `run_command`.
- **Web (workspace-independent, available in general chat too):**
  `fetch_url` (read a public URL), `web_search` (via a provider you choose in
  Settings — SearXNG self-hosted, Brave, Tavily, or Google Programmable
  Search; the tool doesn't exist at all when no provider is configured).
- **Plan:** `write_plan` / `update_plan_step` — a visible, structured task
  list the model can create and check off as it works.
- **Project notes:** `update_project_notes` (writes to the project's
  `ANODEX.md`).

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

A side panel with four tabs alongside the chat:

- **Plan** — the model's current task list for the conversation, live.
- **Files** — every file in the project, each attributed to you or the AI
  (by matching recent tool-write activity against file mtimes), with an
  in-app **code editor** (syntax-highlighted, live-edit-vs-your-own-edit
  banner so you never silently lose unsaved changes), an **image viewer**,
  and a sandboxed **HTML preview** with a code/preview toggle.
- **Activity** — a live feed of tool calls as they happen.
- **Outputs** — anything the model has produced worth surfacing outside the
  chat transcript.

## Local model engine

- Point Anodex at any local `.gguf` file, or use the built-in catalog to
  **download a model in-app** with a real progress bar and cancel support.
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

- **Profile** — your name/avatar/email/plan-tier display, the token-activity
  usage page, and local-only account status.
- **Appearance** — Dark/Light/System theme, curated dark-mode color presets
  (a full custom palette editor too), font family/size, density, diff-view
  style (unified vs. side-by-side), sound effects, reduced motion, compact
  mode.
- **General** — permission mode, other global behavior toggles.
- **Projects** — manage saved projects and their instructions.
- **AI & Models** — the local engine control center: load/unload, hardware
  panel, recommended-model strip, installed-models table with fit + reliability
  scores, in-catalog search/download.
- **Diagnostics** — surfaces real errors/warnings for troubleshooting.
- **About** — version info, hardware spec summary, and update status.

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
downloading a model, or checking for app updates).

## Tech stack

Electron + electron-vite, React 18 + TypeScript, Zustand for state,
`node-llama-cpp` as the local inference engine, CSS Modules with a
design-token theme (no CSS framework), Vitest + Playwright for testing.

## Getting started

```bash
npm install   # installs deps, including node-llama-cpp's native binaries
npm run dev   # launches Anodex with hot reload
```

Load a model: **AI & Models → Recommended** to download one, or **Add
model** to point at a `.gguf` file you already have. Once it shows "ready",
start chatting.

See `AGENTS.md` for architecture, conventions, and contribution details.

## License

UNLICENSED — private project.
