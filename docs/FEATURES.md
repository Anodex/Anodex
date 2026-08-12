# Anodex Feature Overview

Anodex is a local-first desktop AI workspace for building, researching, automating,
and managing real projects from one app. It combines chat, local models, optional
cloud models, workspace tools, persistent project context, scheduled automation,
critical research workflows, email, Git, GitHub, MCP integrations, and a dedicated
Workspace Dock.

This document is written for GitHub and website copy. It focuses on what Anodex can
do today and why each feature is useful.

## Short Positioning

Anodex is an AI assistant that lives with your work instead of hovering outside it.
It can chat, inspect code, edit files, run checks, search the web, remember project
context, work through tasks unattended, schedule recurring jobs, research complex
questions, manage email, and connect to GitHub or MCP tools while keeping the core
experience local-first.

### One-line version

Anodex is a local-first AI workspace that can understand, change, review, and
automate your projects from a desktop app.

### Website hero copy

**Headline:** Anodex

**Subheadline:** A local-first AI workspace for serious project work, with chat,
code tools, scheduled automation, research workflows, email, GitHub, and model
control built in.

**Primary value:** Use a private local model by default, add cloud models when you
want them, and give the assistant carefully controlled tools for the work in front
of you.

## What Makes Anodex Good

Anodex is useful because it is not only a chat box. It is built around the real shape
of day-to-day work:

- It can operate on a project workspace, not just answer questions in isolation.
- It supports local GGUF models, so core AI work can happen on the user's machine.
- It has optional OpenAI and Anthropic providers for heavier or specialized jobs.
- It has reviewable tools for files, commands, Git, web search, email, GitHub, and
  MCP servers.
- It keeps long-running project context through memory, transcript recall, project
  notes, skills, checkpoints, and change proposals.
- It separates different work modes: chat, autonomous agent runs, scheduled tasks,
  critical research, email, settings, and the Workspace Dock.
- It treats safety as a product feature: approvals, destructive-action safeguards,
  path confinement, checkpoints, diffs, restore flows, secure credential storage,
  and local diagnostics are all part of the design.

## Local-first Desktop AI

Anodex is built as a desktop app using Electron, React, TypeScript, Zustand, and
CSS Modules. The local model engine uses `node-llama-cpp`, the Node.js bindings for
`llama.cpp`, to run GGUF models directly on the machine.

Why it is good:

- The core assistant can run without sending project content to a remote AI service.
- Local model loading, unloading, context size, GPU layers, and generation settings
  are controlled by the user.
- The app can preflight local model memory needs before loading, reducing crashes
  from oversized models or settings.
- The local engine streams output, supports tool use, reuses chat sessions where
  possible, and rebuilds context when conversations change.
- Reasoning or "thought" output from compatible local models is displayed separately
  from the final assistant response.

## Optional Cloud Providers

Anodex can also use OpenAI and Anthropic when the user connects API keys. These
providers are optional and sit alongside the local engine rather than replacing it.

Why it is good:

- Users can keep normal work local and switch to a cloud model only when needed.
- OpenAI and Anthropic providers use the same Anodex workspace tools as the local
  provider.
- API keys are stored through the app's secure settings path when available.
- Cloud usage can be tracked with token activity and daily cap warnings.
- Provider checks can verify whether a configured key and model are reachable.

The provider settings UI also lays groundwork for a broader model library. Local,
OpenAI, and Anthropic are active provider choices today, while additional providers
are represented as future-ready options.

## Model Discovery And Hardware Fit

Anodex includes a model management experience instead of assuming the user already
knows which GGUF file to pick.

Key capabilities:

- Add local GGUF files manually.
- Discover GGUF models from Hugging Face.
- Download recommended models with progress, retry, and cancel states.
- View installed models and load, unload, or refresh them.
- Detect local hardware and recommend safer settings.
- Apply recommended context, GPU, and token settings.
- Track per-model reliability based on tool success, tool errors, and fabrication
  detection.
- Show compatibility and performance-oriented model panels in settings.

Why it is good:

- Local AI is powerful, but model choice is confusing. Anodex makes model selection
  more practical by combining hardware awareness, curated recommendations, live
  discovery, and reliability history.

## Chat Experience

The chat view is the everyday command center. It supports both general chats and
project chats.

Key capabilities:

- Streaming assistant replies.
- Syntax-highlighted code blocks.
- Tool activity shown in the transcript.
- Separate reasoning/thought sections for compatible local models.
- Task phase indicators while the assistant is working.
- User message editing and assistant regeneration.
- Copy actions for assistant output.
- Token and speed statistics on assistant turns.
- Stop generation.
- Queue the next message while a response is still generating.
- Jump-to-latest behavior for long conversations.
- Desktop notifications and toast summaries.
- Automatic chat title generation.
- Context meter and manual context compaction.
- Automatic context compaction and bounded continuation that preserve completed
  tool work instead of treating a recoverable limit as a failed task.
- Drag-and-drop attachments.
- File picker attachments.
- Internal file drag from the Files panel into chat.
- Attachment chips with size and truncation information.
- Images are scoped to the message that introduced them; choose **Keep for follow-ups** on an
  image when it should remain available to a vision model in later messages.
- A unified `/` picker for built-in commands and available project or personal skills. The full-width
  picker aligns with the composer, uses distinct icons for every built-in command, and uses a shared
  skill icon. Commands include `/goal`, `/continue`, `/plan`, `/next`, `/test`, `/review`,
  `/refactor`, and `/summarize`; choose a skill to insert an explicit instruction before writing the
  rest of the request. A dedicated icon is reserved for future custom slash commands.
- A Tab-completable next-action suggestion in the empty composer: unfinished plan steps take priority;
  otherwise Anodex generates and caches one short follow-up from the completed reply. Suggestions are
  never added to chat history or model context unless the user accepts and sends them.
- Relevant skill suggestions directly in the composer.
- Permission mode control from the composer.

Why it is good:

- Chat is not treated as disposable. It can carry file context, tool results,
  remembered facts, transcript recall, checkpoints, skill handoffs, and model stats
  while still feeling like a normal conversation.

## Projects And Workspace Context

Anodex has separate general chats and project-based chats. A project links a
conversation to a workspace folder and gives the assistant access to project tools.

Key capabilities:

- Create, rename, archive, restore, and delete projects.
- Create project conversations.
- Keep general chats separate from project chats.
- Search chats from the sidebar.
- Mark conversations unread.
- Archive all active general chats.
- Store project instructions.
- Store project notes in `ANODEX.md`.
- Maintain a living project specification through `.anodex/SPEC.md`.
- Track active change proposals under `.anodex/changes`.
- Store project skills under `.anodex/skills`.
- Store checkpoints under `.anodex/checkpoints`.
- Keep user and AI file touch history for workspace files.

Why it is good:

- A real project has history, conventions, open tasks, and decisions. Anodex gives
  the assistant more than a single prompt window, so it can keep continuity across
  sessions.

## Memory And Transcript Recall

Anodex includes two complementary context systems: structured memory and transcript
recall.

Memory capabilities:

- Store global or project-scoped memories.
- Memory kinds include identity, convention, gotcha, preference, and open task.
- Pin important memories.
- Archive, update, or delete memories.
- Deduplicate similar memory entries.
- Use a `remember_fact` tool when memory is enabled.
- Show memory used by a response in the chat transcript.

Transcript recall capabilities:

- Search earlier conversations for relevant excerpts.
- Scope recall to the active project by default.
- Optionally include cross-scope or archived conversations.
- Control whether transcript recall is available to cloud providers.
- Show recalled transcript references in the chat transcript.

Why it is good:

- Memory captures durable facts. Transcript recall finds useful prior discussion.
  Together they help Anodex avoid forcing the user to re-explain the same project
  every session.

## Semantic Code Search

Anodex can build a background code index for projects and expose semantic search
through the `search_code` tool.

Key capabilities:

- Search code by meaning, not just exact text.
- Chunk and embed project files in the background.
- Re-index changed and new files instead of rebuilding everything every time.
- Persist the index per project.
- Skip generated Anodex checkpoint files.
- Return ranked code chunks with paths and line numbers.

Why it is good:

- Developers often know the concept they want but not the exact symbol or filename.
  Semantic code search helps the assistant locate relevant code faster and with less
  prompting.

## Workspace Tools

Anodex gives the assistant a broad tool system that can be enabled, disabled, and
controlled by context.

Read tools:

- List directories.
- Read files.
- Read file ranges.
- Read multiple files.
- Search files by text.
- Find files by glob or name.
- Get file metadata.
- Generate code outlines.
- Preview HTML inside chat.
- Read Git status and diffs.
- Summarize Git changes.
- Fetch URLs.
- Search the web when a provider is configured.
- Find and load skills.

Write and mutation tools:

- Write files.
- Edit files.
- Apply patches.
- Delete files.
- Move files.
- Create directories.
- Delete directories.
- Run shell commands.
- Run structured project checks for test, typecheck, lint, build, or custom commands.
- Update project notes.
- Propose changes.
- Update change tasks.
- Archive completed changes into the project spec.
- Update plan steps.
- Remember facts.

Email tools:

- List linked email accounts.
- List threads.
- Search email across every linked account.
- Read email.
- Summarize threads.
- Find attachments.
- List mailboxes, labels, and folders.
- Draft email.
- Send email with approval, optionally attaching workspace files.
- Reply in-thread with approval.
- Mark read or unread, star, and archive.
- Move messages between mailboxes.
- Save attachments into a project workspace.

Extensibility tools:

- Expose connected MCP server tools.
- Expose GitHub MCP tools when GitHub is connected.

Why it is good:

- The assistant can move from "I think" to "I checked" and from "you could" to "I
  changed it", while the app still controls which tools are available and when
  approval is required.

## Workspace Dock

The Workspace Dock is a right-side work surface for project state. It can be docked,
resized, collapsed, or floated on narrower screens.

Panels include:

- Plan: current assistant plan and task progress, protected from duplicate-plan
  resets and reconciled before a normal task completion.
- Changes: active change proposals and task status.
- Checkpoints: snapshots created by assistant file edits.
- Git: repository status, branches, commits, push/publish actions.
- Files: searchable workspace file tree with edit attribution.
- Terminal: a local shell rooted in the active workspace.

File viewer capabilities:

- Open files from the dock.
- Edit text files with syntax highlighting.
- Save with `Ctrl+S` or `Cmd+S`.
- Preview HTML.
- View images.
- Open large or unsupported files in the default app.
- Detect unsaved changes.
- Warn if the AI changes a file that is open with unsaved user edits.
- Auto-reload clean open files after AI edits.

Why it is good:

- The dock turns chat into a workspace. The user can inspect files, watch changes,
  review checkpoints, run commands, and manage Git without leaving Anodex.

## Checkpoints, Diffs, And Restore

Anodex records checkpoints around assistant file changes.

Key capabilities:

- Capture changed files after assistant edits.
- Review file-changing assistant turns from chat.
- Browse checkpoints from the Workspace Dock.
- Restore earlier file versions.
- Detect conflicts when restoring over newer edits.
- Undo a restore operation.
- Refresh checkpoint state after AI writes.

Why it is good:

- AI-assisted editing should be reversible. Checkpoints give users confidence to let
  the assistant work on real files because changes can be inspected and rolled back.

## Change Proposals And Project Specs

Anodex can track multi-step work as change proposals.

Key capabilities:

- Create structured change proposals with title, rationale, and tasks.
- Update task completion state.
- Track proposal status as proposed, in progress, or done.
- Archive completed proposals.
- Fold archived proposal summaries into `.anodex/SPEC.md`.
- Keep proposal files under `.anodex/changes`.

Why it is good:

- Larger work needs a paper trail. Change proposals help Anodex keep design intent,
  task progress, and completed decisions connected to the project.

## Safety And Approval System

Anodex is built with safety controls for local file and command access.

Key safeguards:

- Renderer code does not receive direct Node or Electron access.
- Main and renderer communicate through a typed preload IPC bridge.
- IPC handlers return structured `Result<T>` values instead of throwing into the UI.
- Workspace paths are confined to the active workspace.
- Symlink and junction escape attempts are blocked by realpath checks.
- Read tools do not require approval.
- Write and command tools use risk-based approval.
- Destructive actions always require confirmation in interactive use.
- Unattended agent and scheduled task runs fail closed on destructive actions.
- Tool permissions can run in Ask, Full, or Untethered modes.
- Sensitive actions are gated more strictly than normal writes.
- Tool loops are guarded against repeated identical calls.
- User-denied tool calls return an explicit denial result to the model.
- File-changing tool calls can create checkpoint records.
- Secrets such as provider keys and MCP credentials use secure storage when
  available.

Why it is good:

- Anodex is powerful enough to touch real projects, so safety cannot be cosmetic.
  Permissions, confinement, checkpoints, and secure storage are part of the core
  design.

## Autonomous Agent Runs

The Agent page lets the user give Anodex a goal and let it work through multiple
turns.

Key capabilities:

- Create agent runs with a goal.
- Choose a project or run without a project.
- Choose local, OpenAI, or Anthropic provider when configured.
- Select a model.
- Require plan review before execution.
- Approve, reject, or edit plans before work starts.
- Set turn, token, and duration budgets.
- Disable limits deliberately when desired.
- Select exactly which tools the agent may use.
- See running, review-needed, done, stopped, and errored runs.
- Stop, retry, delete, or open the backing conversation.
- Track tokens, turns, provider, last result, and errors.
- Flag suspected fabrication.
- Show periodic check-in notifications during longer runs.

Why it is good:

- Some tasks require more than one chat turn. Agent runs give Anodex a controlled
  way to continue working toward a goal while keeping budgets, tools, and plan
  approval visible.

## Scheduled Tasks

The Scheduler page lets Anodex run recurring prompts while the app is open.

Key capabilities:

- Create one-time, daily, weekly, or interval-based tasks.
- Use intervals as short as five minutes.
- Select weekdays for weekly tasks.
- Assign a task to a project.
- Choose the tool allowlist per task.
- Run a task immediately.
- Pause and resume tasks.
- Search and sort task cards.
- Enable a keep-awake option.
- Record last run status, summary, and history.
- Show completion or failure notifications.

Example tasks:

- Daily project check-in.
- Weekly project summary.
- Watch for web updates.
- Dependency check.

Why it is good:

- Repeated AI work should not require repeated prompting. Scheduled tasks let Anodex
  handle maintenance, monitoring, summaries, and recurring checks in the background.

## Critical Thinking Research

Critical Thinking is a dedicated research mode for complex questions.

Key capabilities:

- Start with a research question.
- Generate a research plan.
- Review and edit the plan before research begins.
- Add, edit, and remove plan steps.
- Run research with only web search and page fetching tools.
- Run every approved plan step as persisted adaptive rounds made from short,
  isolated query-selection and evidence-assessment model calls.
- Constrain local planning, query-selection, and assessment output to the expected
  JSON shape, with one bounded correction attempt and deterministic query recovery.
- Search focused queries and fetch selected public pages directly with bounded
  concurrency instead of keeping the model inside a long native tool-call loop.
- Track live step, round, research phase, remaining evidence gaps, activity,
  evidence count, and synthesis/validation progress.
- Require a service-side evidence floor before accepting the model's claim that
  a step has sufficient coverage.
- Store search leads and fetched-page evidence separately from the model transcript.
- Prefer authoritative research hosts during page selection and exclude common
  login-wall, discussion, metadata-only, and media-only results before fetching.
- Extract focused passages from large pages instead of returning only a prefix.
- Combine evidence from repeated focused fetches of the same page without losing
  earlier passages.
- Persist round queries, selected URLs, assessments, findings, and evidence ownership.
- Resume stopped, limited, or app-interrupted investigations from the unfinished
  round while reusing saved evidence.
- Bound every active attempt by step, round, query, page, total-search,
  total-fetch, and wall-clock limits; produce an explicit partial result when
  remaining gaps cannot be closed within those limits.
- Bound verified pages across the run lifetime so repeated Resume attempts cannot
  grow persisted evidence indefinitely.
- Generate a structured report in a separate tool-free synthesis phase.
- Scale synthesis, repair, evidence, and output budgets to the active model context.
- Recover broad local reports section by section when one-shot synthesis remains
  unusable; independently validate each section before assembling the report.
- Persist bounded synthesis attempts and validation issues with the run for diagnosis.
- Require verified citations on substantive report blocks and validate source IDs,
  passage IDs, quotations, numeric claims, raw URLs, and chart data.
- Sanitize source titles during citation rendering and rewrite chart citations
  structurally so untrusted metadata cannot break Markdown or JSON.
- Copy the report.
- Save the report as a PDF.
- Stop or inspect previous runs.

Why it is good:

- Research needs a different safety shape than coding. Critical Thinking limits the
  toolset to search and source reading, forces a plan review step, and produces a
  report with sources instead of mixing research into a normal chat thread.

## Email

Anodex works with Gmail, Outlook and Microsoft 365, and any mailbox reachable over
IMAP and SMTP. Several accounts can be linked at once.

Linking an account starts from the address alone. Anodex looks up the domain and
then either opens a browser sign-in (Gmail, Outlook) or prefills the IMAP and SMTP
server settings, using a built-in table for the large providers and Mozilla's
autoconfig database for everything else. Providers that require an app-specific
password say so and link straight to the page that generates one.

Key capabilities:

- Link Gmail and Outlook through a browser OAuth sign-in with PKCE.
- Link any other mailbox over IMAP and SMTP with an app password.
- Link several accounts and pick which one is the default.
- Choose header-only or full-message sync scope per account.
- List recent inbox threads.
- Search mail — every linked account at once, unless one is named.
- Read messages in a centered, newest-first thread spine with sender addresses visible,
  summarize threads, and find attachments.
- List mailboxes, labels, and folders.
- Create drafts.
- Send email only with confirmation, optionally attaching workspace files.
- Reply in-thread only with confirmation, with correct threading headers.
- Mark read or unread, star, archive, and move between mailboxes.
- Save email attachments into a project workspace.
- Unlink an account, which also erases its stored credentials.

Where credentials live:

- OAuth tokens and IMAP passwords are encrypted with the operating system's
  credential store and held outside `settings.json`.
- `settings.json` holds only non-secret account details: addresses, hostnames,
  ports, and sync scope.

Why it is good:

- Email often contains important project context. Anodex can help search, summarize,
  draft, reply to, and attach email information to work while keeping every
  outbound message behind explicit approval. Deleting mail is not possible at all —
  the tools cover archiving and moving, never permanent removal.

## Git And GitHub

Anodex has both local Git support and GitHub integration through MCP.

Local Git capabilities:

- Detect whether the active workspace is a Git repository.
- Initialize a repository.
- Show current branch, head, remote, upstream, ahead/behind state, and diff stats.
- List, search, create, and switch branches.
- Show staged, unstaged, and untracked changes.
- Write a commit message.
- Commit all changes.
- Push or publish the current branch.
- Use Git status, diff, and commit-summary tools from chat.

GitHub capabilities:

- Connect GitHub through the official hosted MCP server.
- Use a fine-grained personal access token.
- Choose read-only mode.
- Select GitHub toolsets such as repositories, issues, pull requests, and actions.
- Detect a project repository from Git remote origin.
- Link a project to an owner and repository.
- Show connected account and discovered tool count.

Why it is good:

- Local Git tools cover everyday repository hygiene, while GitHub MCP support lets
  Anodex reach issues, pull requests, repositories, and actions when the user
  connects it.

## MCP Extensibility

Anodex can connect to Model Context Protocol servers.

Key capabilities:

- Add local stdio MCP servers.
- Add remote Streamable HTTP MCP servers.
- Enable, disable, edit, reconnect, or remove servers.
- Support OAuth flows for remote servers that require authorization.
- Support static bearer tokens.
- Store local MCP environment secrets securely when available.
- Discover tools when servers connect.
- Update tool lists when servers change.
- Run MCP tools with normalized content and structured results.
- Apply stricter confirmation behavior for sensitive or destructive MCP tools.

Why it is good:

- MCP lets Anodex grow beyond built-in tools. Teams and power users can connect
  specialized systems without Anodex needing a hardcoded integration for everything.

## Skills

Skills are reusable Markdown instructions that help shape how Anodex works.

Key capabilities:

- Create personal skills.
- Create project skills.
- Search, read, edit, duplicate, delete, and pin skills.
- Store project skills in `.anodex/skills`.
- Store personal skills globally.
- Include skill frontmatter such as name, description, keywords, and suggested
  tools.
- Let chat suggest relevant skills.
- Draft a skill from an assistant turn that used tools.

Why it is good:

- Skills turn repeated prompting into reusable context. They help Anodex remember
  workflows, conventions, review styles, or project-specific procedures without
  burying them in chat history.

## Web Search And Web Fetching

Anodex supports web fetching and optional web search.

Key capabilities:

- Fetch URL contents.
- Configure web search providers.
- Supported search provider settings include SearXNG, Brave, Tavily, and Google.
- Require approval before web searches when configured.
- Use web search in chat, agent runs, scheduled tasks, and Critical Thinking.

Why it is good:

- Local-first does not have to mean cut off from current information. Anodex lets
  the user decide when web access is available and which provider supplies it.

## Archive And Conversation Management

Anodex includes archive management for projects and chats.

Key capabilities:

- Archive active chats and projects.
- Browse archived chats and projects.
- Search archives.
- Filter archived items by kind.
- Restore archived chats and projects.
- Permanently delete selected archived items.
- Archive all active general chats.
- Show archive summary stats.

Why it is good:

- Long-term AI work creates a lot of conversation history. Archive management keeps
  the workspace clean without forcing users to immediately delete old context.

## Diagnostics, Updates, And Runtime Visibility

Anodex includes diagnostic and maintenance surfaces in Settings.

Diagnostics capabilities:

- Show local runtime diagnostic entries.
- Surface background-service failures (local engine, mailboxes, MCP, updater) with the
  scope they came from, the full technical detail, and a suggested next step.
- Capture failures raised before the window existed — startup errors, unhandled
  rejections, and renderer/child-process crashes — and replay them once it opens.
- Write every main-process log line to a rotating file on disk (`anodex.log`, 2 MB × 2)
  and reveal it from Settings, so a packaged install can produce a real bug report.
- Filter by severity.
- Export diagnostic logs, or copy a single entry as a self-contained report.
- Clear diagnostic entries.
- Configure verbose logging.
- Set diagnostic history limits.
- Show suggested fixes and details.

Update capabilities:

- Check for packaged app updates.
- Download updates only after user action.
- Restart to install only after user action.
- Avoid automatic disruptive restarts.

Runtime visibility:

- Show app version.
- Show local data path.
- Show hardware and system details.
- Show technical runtime details.
- Link to the local model engine foundations.

Why it is good:

- Anodex is a local desktop tool, so users need visibility into what is happening on
  their machine and control over when updates or diagnostics are handled.

## Appearance And Personalization

Anodex can be customized for comfort and long work sessions.

Key capabilities:

- Profile display name, email, plan tier, and avatar.
- Global assistant style guidance.
- Multiple app themes.
- Custom color swatches.
- Chat background choices.
- Font, font size, and density controls.
- Unified or side-by-side diff preference.
- Desktop notification settings.
- Sound effects with themes and volume.
- Reduced motion setting.
- Compact mode.

Why it is good:

- The app is intended to stay open while users work. Appearance, motion, sound, and
  assistant style controls help Anodex feel less generic and more like a workspace
  that belongs to the user.

## Token Activity And Usage Awareness

Anodex tracks local usage statistics over time.

Key capabilities:

- Token activity charts.
- All-time, 30-day, and 7-day ranges.
- Daily, weekly, and cumulative views.
- Model usage breakdowns.
- Input and output token estimates.
- Tool usage totals.
- Session counts.
- Hourly activity patterns.
- Longest generation tracking.
- Ancillary cloud compaction usage tracking.

Why it is good:

- Token and usage visibility helps users understand how they work with models, which
  models they rely on, and when cloud usage may matter.

## Startup Experience

Anodex includes a startup overlay that reflects actual readiness.

Key capabilities:

- Animated startup sequence.
- Reduced motion support.
- Readiness-driven completion instead of a purely decorative timer.
- Error panel with retry and settings actions.
- Main app can render beneath the overlay while startup completes.

Why it is good:

- Startup is a product moment, but it is tied to real app state. The user gets a
  polished launch without hiding failures behind animation.

## Technical Foundation

Important implementation choices:

- Electron desktop app.
- React 18 renderer.
- TypeScript across main, preload, renderer, shared types, and tests.
- Typed IPC contract in `src/shared/ipc.ts`.
- Context isolation enabled and Node integration disabled in the renderer.
- `Result<T>` responses across IPC.
- Local model runtime through `node-llama-cpp`.
- Zustand stores for renderer state.
- CSS Modules for UI styling.
- Vitest unit tests.
- Playwright end-to-end tests.
- Prettier and ESLint project standards.

Why it is good:

- Anodex is built as a typed desktop application, not a thin web wrapper. The
  architecture gives the app a safer main/renderer boundary, persistent local state,
  real filesystem access through controlled tools, and a testable codebase.

## Feature Card Copy For Website

Use these as website cards or GitHub feature bullets.

### Local-first AI

Run GGUF models on your own machine with `llama.cpp` bindings. Keep normal project
work local, then opt into OpenAI or Anthropic when a cloud model is the better fit.

### Real workspace tools

Let the assistant read files, search code, preview HTML, edit files, run checks,
inspect Git, fetch web pages, search the web, and use approved integrations.

### Reversible file changes

Assistant edits create checkpoints, review surfaces, and restore flows, so users can
inspect changes and roll back when needed.

### Autonomous agent runs

Give Anodex a goal, a project, a provider, a tool allowlist, and a budget. Require a
plan review first or let trusted runs continue automatically.

### Scheduled automation

Run recurring project check-ins, summaries, monitoring prompts, and maintenance tasks
while Anodex is open.

### Critical research mode

Plan, review, research, source, and export reports from a workflow that only has web
search and page-reading tools.

### Email support

Link Gmail, Outlook, or any IMAP mailbox from the address alone, then search, read,
summarize, draft, reply, and organize mail — with explicit confirmation on anything
that sends.

### Git and GitHub

Manage local branches, commits, status, and pushes, then connect GitHub through MCP
for repositories, issues, pull requests, and actions.

### MCP-ready

Connect local or remote MCP servers to bring in specialized tools, systems, and
workflows.

### Project memory

Keep durable facts, project instructions, transcript recall, skills, notes, change
proposals, and specs close to the work.

### Model control

Discover, download, load, tune, and monitor local models with hardware-aware
recommendations and reliability tracking.

### Safety by design

Use approval modes, path confinement, destructive-action checks, secure credential
storage, tool logs, diagnostics, and checkpoint restore flows.

## Privacy And Control Copy

Anodex is local-first. Project files, conversations, models, memory, checkpoints,
and settings live on the user's machine by default. Cloud model providers, web
search, email, GitHub, and MCP servers are optional integrations that only become
available when the user connects or configures them.

The important promise is control: choose the model, choose the tools, choose the
workspace, review risky actions, and keep a path back when files change.
