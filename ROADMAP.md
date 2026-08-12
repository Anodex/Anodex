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

- **Structured computer-use control.** Add a Codex-style `ComputerControlService` in which a vision-capable model emits typed actions (`screenshot`, `click`, `double_click`, `drag`, `scroll`, `keypress`, `type`, and `wait`), Anodex validates and executes them, and a fresh screenshot is returned for the next step. Roll this out in phases: browser/project testing with stable DOM targets, Anodex-owned surfaces with reliable element targets, then explicitly enabled Windows desktop control. Require a visible control session, application and window allowlists, step/time budgets, pause/stop, action previews, approval for consequential actions, protection for password and secret fields, and a complete action/screenshot audit trail. Keep the executor provider-neutral so local vision and future cloud computer-use models can share it.
- **Interactive vision navigation.** `inspect_visual` now samples up to three named HTML sections and lets the model request a particular section by id, so a visual review no longer sees only the header or a partial target area. The next step is a bounded, durable visual session with explicit `scroll` and `page` actions, viewport identity, post-scroll screenshots, a larger session-level image budget delivered in focused batches, and nested-target capture. Preserve position between visual steps, detect clipped or nested scroll containers, and add regression coverage for sticky headers, lazy-loaded content, nested scrolling, and screenshots taken after scrolling.

- **Composer continuity and accessibility.**
  - Paste images and files directly into the composer.
  - Preserve a separate unsent draft and its staged attachments for each chat across chat switches and restarts.
  - Let people edit and reorder messages queued behind an active response.
  - Finish the slash picker's assistive-technology wiring: expose whether it is open, connect it to the composer input, and announce the active option.
- **Optional spoken replies.** Add a speaker action to completed assistant replies, with a chat-level **Read replies automatically** toggle for people who want hands-free use. It should remain off by default and never read hidden thoughts, tool calls, approvals, or streaming partials. Include pause, resume, stop, speed, voice selection, and **Read selection** for a highlighted passage; stop playback when the user begins a new request. The first-quality path should be a purpose-made Anodex voice: an original designed voice or a professionally licensed and consented voice-actor model, behind an explicit TTS-provider setting. Keep local/open models as a separate privacy-first option, and treat operating-system voices as an optional fallback rather than the default.
- **Commercial-grade Anodex speech architecture.** Build a provider-neutral `SpeechService` boundary owned by Anodex before selecting a production model. Anodex should own text normalization, safe reply filtering, sentence chunking, streaming playback, pause/resume/stop, caching, voice settings, automatic-read policy, and provider health/error handling. Keep the neural model replaceable behind that boundary so a model license, vendor, or quality decision never becomes the product architecture. For a sellable release, use only a model and runtime whose commercial redistribution terms are verified; keep required notices and attribution; avoid copyleft dependencies in the shipped runtime unless counsel approves them; and maintain a provenance record for model weights, datasets, prompts, recordings, and generated voice assets. The initial voice should be an original designed voice or a voice actor with written rights covering AI training, commercial use, redistribution, derivative voices, termination, and geographic/language scope. Validate the full chain with counsel before public distribution. Long term, evaluate fine-tuning or training an Anodex-owned model only after usage data, GPU budget, and quality tests justify that investment.

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
