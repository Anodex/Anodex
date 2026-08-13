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
  `npm run dist` packages per host platform, and the Package workflow builds
  each target on its own runner — Anodex cannot be cross-compiled, because
  `prepare:vision` fetches the _host_ platform's llama.cpp runtime. A Linux
  AppImage is verified building end to end (623 MB, with `latest-linux.yml`
  for auto-update).

  Still outstanding before macOS or Linux can ship:
  - **Linux: run the AppImage.** It builds; nobody has launched it. Worth one
    pass over the same things the Windows packaged build needs checked — a
    code block, the Terminal panel, a diff, a PDF attachment — plus whether a
    local model actually loads through the bundled runtime.
  - **macOS: signing, and it is the gate.** The `.dmg` builds, but current
    macOS makes an unsigned, un-notarized app genuinely hard for an ordinary
    user to open, so this is not a distributable artifact yet. Needs an Apple
    Developer Program membership plus notarization. Start the paperwork early;
    it is calendar time rather than work time.
  - **Windows signing** is the same class of problem: OV certificates have
    required a hardware token or cloud HSM since June 2023, so a plain `.pfx`
    in CI is no longer an option.
  - Linux AppImages need no signing at all, which is why Linux remains the
    cheapest platform to actually ship.

## Next product work

- **Project health** — bring git state, recent checks, active plans, changed files,
  and scheduled or agent activity together in the Workspace Dock.
- **Support bundle** — produce a redacted local diagnostic bundle with app version,
  hardware, model, logs, and recent failures for hands-on support.

## Product improvements to explore

- **Structured computer-use control.** Add a Codex-style `ComputerControlService` in which a vision-capable model emits typed actions (`screenshot`, `click`, `double_click`, `drag`, `scroll`, `keypress`, `type`, and `wait`), Anodex validates and executes them, and a fresh screenshot is returned for the next step. Roll this out in phases: browser/project testing with stable DOM targets, Anodex-owned surfaces with reliable element targets, then explicitly enabled Windows desktop control. Require a visible control session, application and window allowlists, step/time budgets, pause/stop, action previews, approval for consequential actions, protection for password and secret fields, and a complete action/screenshot audit trail. Keep the executor provider-neutral so local vision and future cloud computer-use models can share it.
- **Interactive vision navigation.** `inspect_visual` now samples up to three named HTML sections and lets the model request a particular section by id, so a visual review no longer sees only the header or a partial target area. The next step is a bounded, durable visual session with explicit `scroll` and `page` actions, viewport identity, post-scroll screenshots, a larger session-level image budget delivered in focused batches, and nested-target capture. Preserve position between visual steps, detect clipped or nested scroll containers, and add regression coverage for sticky headers, lazy-loaded content, nested scrolling, and screenshots taken after scrolling.

- **Composer continuity and accessibility.**
  - Paste images and files directly into the composer.
  - Preserve a separate unsent draft and its staged attachments for each chat across chat switches and restarts.
  - Let people edit and reorder messages queued behind an active response.
  - Finish the slash picker's assistive-technology wiring: expose whether it is open, connect it to the composer input, and announce the active option.
- **Anodex Voice.** Give completed assistant replies a speaker action and a chat-level **Read replies automatically** toggle for hands-free use. It remains off by default and never reads hidden thoughts, tool calls, approvals, or streaming partials. Include pause, resume, stop, speed, **Read selection**, and stop playback as soon as the user begins a new request.

  This is an Anodex feature end to end: ship an original, purpose-designed Anodex voice and an Anodex-controlled speech runtime. Do not use operating-system voices, browser speech synthesis, a generic third-party default voice, or a fallback that changes the product's voice. The first voice must be either trained from Anodex-owned recordings or performed by a voice actor with written, explicit rights covering AI training, commercial use, redistribution, derivative voices, termination, geography, and language scope.

  Build a provider-neutral `SpeechService` boundary so the model can improve without changing chat or playback. Anodex owns reply filtering, text normalization, sentence chunking, streaming playback, pause/resume/stop, caching, voice settings, automatic-read policy, and health/error handling. The neural runtime remains replaceable behind that boundary, but every shipped voice and runtime must have verified commercial redistribution terms, required notices, and a provenance record for weights, datasets, recordings, prompts, and generated assets. Validate the complete rights chain with counsel before public distribution.

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
- Persistent `/goal` markers above the composer, with plan-backed progress and completion state.
- In-app model discovery/downloads, hardware recommendations, reliability scoring,
  token activity, and the Workspace Dock.

For implementation conventions and architecture, see [AGENTS.md](AGENTS.md).
