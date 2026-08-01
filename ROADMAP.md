# Anodex Roadmap

This document tracks work that is still ahead of us. Current capabilities belong in
the [feature overview](docs/FEATURES.md); completed work is kept here only as a
short record so it does not reappear as a future task.

## Current focus: release readiness

- **Windows release validation** — finish the quality, packaging, and installer
  checks needed for a dependable first public Windows release.
- **Release delivery and updates** — publish installer assets through GitHub
  Releases and choose a safe update-distribution path that does not embed private
  repository credentials in a distributed application.
- **Public launch path** — complete first-run guidance, release notes, support
  information, and the visual product materials that make a new install feel
  intentional from the first minute.
- **Platform validation** — Windows is the currently released platform. macOS and
  Linux are being brought up to the same bar and are now real targets, not
  someday ones. CI runs unit tests and builds on all three, so regressions on
  the two unreleased platforms surface immediately instead of at packaging time.
  Still outstanding before either can ship:
  - `npm run dist` is Windows-only — `scripts/build-branded-installer.mjs` calls
    electron-builder with `--win nsis`, and the branded installer shell only
    targets `win`. macOS (`.dmg`) and Linux (AppImage) need their own paths;
    neither wants an NSIS-style wrapper, so this is new work rather than a flag.
  - Anodex cannot be cross-compiled. `prepare:vision` downloads the _host_
    platform's llama.cpp runtime, so releases need a per-platform build matrix.
  - Signing, which is calendar time rather than work time and should be started
    well before it is needed. macOS requires an Apple Developer Program
    membership plus notarization — without it Gatekeeper effectively blocks the
    app. Windows OV certificates have required a hardware token or cloud HSM
    since June 2023, so a plain `.pfx` in CI is no longer an option. Linux
    AppImages need no signing at all, which makes Linux the cheapest second
    platform by a wide margin.

## Next product work

- **First-run success path** — guide a new user from an empty install to a working
  model, project, and first useful result without requiring deep settings knowledge.
- **Model capability guidance** — make model strengths and tradeoffs (coding, tools,
  long context, speed, and reliability) easy to compare when choosing a model.
- **Project health** — bring git state, recent checks, active plans, changed files,
  and scheduled or agent activity together in the Workspace Dock.
- **Conversation-to-work artifacts** — let users promote useful chat outcomes into
  durable plans, implementation notes, decision records, release notes, or project
  instructions.
- **Support bundle** — produce a redacted local diagnostic bundle with app version,
  hardware, model, logs, and recent failures for hands-on support.

## Product improvements to explore

- **Batch file-change review** — let people review multiple proposed changes in one
  clear surface rather than approving a sequence of individual modals.
- **Tool result filtering** — make long tool-heavy turns easier to scan by filtering
  for failures, changed files, and verification output.
- **Safer command presets** — offer predictable install, test, lint, build, and
  development-server actions without weakening the existing approval model.
- **Custom slash commands** — extend the shipped built-in commands with user-defined
  reusable prompt shortcuts.
- **Renderer code-splitting and broader E2E coverage** — continue improving startup
  cost and confidence in high-value user flows.

## Deliberately deferred

- **Executable skills, remote skill sharing, and a skills marketplace.** Keep skills
  as reviewable markdown workflows until the simpler local model proves its value.
- **Broad document RAG.** The existing workspace code search is useful today; a
  larger embeddings-and-indexing system needs a clearer product need before it adds
  more local infrastructure.

## Recently shipped

These are complete capabilities, not action items:

- Local and cloud model support, including local vision, image attachments, visual
  inspection, and durable image previews.
- Workspace tools with scoped access, approval controls, diffs, checkpoints, and
  conflict-aware restore.
- Critical Thinking: planned, evidence-backed research with citations, charts,
  persisted runs, and PDF export.
- Email integration, scheduled AI tasks, autonomous agent runs, GitHub integration,
  and configurable MCP servers.
- Project and personal skills, the skills editor, suggestions, pinned skills, and
  draft-to-editor handoff.
- Built-in slash commands, semantic workspace code search, structured project checks,
  and AI-assisted Git commit summaries.
- In-app model discovery/downloads, hardware recommendations, reliability scoring,
  token activity, and the Workspace Dock.

For implementation conventions and architecture, see [AGENTS.md](AGENTS.md).
