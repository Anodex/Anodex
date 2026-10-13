# Anodex Roadmap

This document tracks work that is still ahead of us. Current capabilities belong in
the [feature overview](docs/FEATURES.md); completed work is kept here only as a
short record so it does not reappear as a future task.

## Current focus: confidence on every platform

Windows, macOS (Apple silicon) and Linux all ship from one tag. Each installer is
built on its own runner, signed with the Anodex release key (Ed25519, checked by
the in-app updater against the key compiled into the app), and published only
once all three have built and signed. Release notes are written by hand and the
publish job refuses placeholders. 0.17.0 is the current release.

- **Windows release validation.** Run each release on the Windows machine before
  calling it done: install over the previous version, the welcome, a local model
  load through the bundled runtime, and the updater.
- **Linux: run the AppImage.** It builds and publishes; check a code block, the
  Terminal panel, a diff, a PDF attachment and a local model load from the
  packaged build.
- **Installer certificates.** The installers carry Anodex's own signature but no
  Microsoft or Apple certificate, so each system warns on first launch (the notes
  say how to get past it). Paid certificates are out of scope; the free macOS
  ad-hoc signature is tracked below. Linux AppImages need none.

## Tracked fixes and improvements

Found while testing 0.17 on real hardware (RX 7900 XTX, Qwen3.8-27B and Llama 3.1
8B, two Galaxy S7 phones). Each item says where it was seen, so it can be picked
up cold. Strike an item through, or move it to "Recently shipped", when it lands.

### Needs fixing

- **Run the engine upgrade on Qwen3.8-27B itself.** node-llama-cpp 3.22.1 shipped
  in #376 after the crash pattern behind #369 was run on the hybrid
  Qwen3.6-14B-A3B (Windows, Iris Xe) without a crash. The 27B is still untested:
  run a tool reply, the title and suggestion calls, stops and a reload once its
  GPU is free.
- **Small models reach for the shell: check the fix on the 8B.** The 8B answered
  "What is the capital of France?" with `echo Paris`, invented a file path to
  `grep`, and, asked to send a file to the phone, proposed
  `gio trash ~/Downloads/gpl-3.0.txt && xdg-open …`. Now a command that only
  prints text is answered without running (and without asking), the prompt puts
  the purpose-built tools ahead of the shell and says never to guess a path, and
  the Trash hint says it is only for removing something. Unit-tested; still to
  re-run those three asks on the 8B once the GPU is free.
  Plain questions re-run on Windows (Iris Xe laptop, 16K, chat autorun): seven
  questions such as "Name one fruit." went from seven `run_command` calls to
  none in both complete runs (a third was closed after two clean turns). The tool descriptions no longer name what a plain answer is ("Not
  for … a fact", "Check facts about this computer" each drew the questions),
  and the example commands come only with a message that may be about the
  computer. Still fragile: one wording change elsewhere in the prompt brought
  back four `echo` answers, which #382's guard catches. The invented path and
  the send-to-phone ask are still to re-run.

### Phone and platforms

- **Android 13+ test.** Only Android 8 has run 0.89; 13 and later ask before
  showing notifications.

### From the model engine (node-llama-cpp 3.20–3.22)

Not used yet, and each fits something Anodex already does by hand.

- **Structured decisions (`LlamaDecisionContext`, 3.22).** Fast, constrained
  choices from a fixed set. Critical Thinking's "is the evidence sufficient?" and
  query selection, and tool choice on small models, are made today by generating
  JSON under a grammar. Likely the largest quality gain for small local models.
- **The engine's own memory figures (`model.memoryUsage`, `context.memoryUsage`,
  3.21).** Replace our estimates in the fit check (`describeInsufficientMemory`),
  the Settings readout and the context recommendation with what is actually used.
- **Automatic context sizing in the engine** (`contextSize: { min, max }`). Sizes
  the window to the memory that is free, up to what the model was trained for. A
  model without a size of its own is now sized from its file on first load
  (`shouldSizeForModel`); the engine's own sizing could refine that further.
- **Quantized KV cache** (`experimentalKvCacheKeyType` / `ValueType`, e.g.
  `q8_0`). Roughly halves the conversation cache, so about twice the context on
  the same card. **Held:** in 3.22.1 the option is still marked experimental and
  "highly unstable", may crash the process, and node-llama-cpp asks that end users
  not be able to set it. Offer it in Settings → AI & Models (a "Conversation
  memory: Full / Compact" row under Context size) once it is stable.
- **Lazy loading (`lazyMode`, 3.21).** Reads the largest tensors on demand: less
  memory for big models, at the cost of a slower first reply. Try on the 27B and
  on machines short of RAM.
- **Native Jinja fallback and better reasoning extraction (3.20–3.21).** Qwen3.8
  ran under the plain Jinja wrapper and leaked its reasoning into replies; we strip
  it (`stripLeakedEngineText`). Check whether 3.22 parses it properly, and retire
  the workaround if so.

## Next product work

- **Project health** — bring git state, recent checks, active plans, changed files,
  and scheduled or agent activity together in the Workspace Dock.

## Product improvements to explore

- **Structured computer-use control.** Add a Codex-style `ComputerControlService` in which a vision-capable model emits typed actions (`screenshot`, `click`, `double_click`, `drag`, `scroll`, `keypress`, `type`, and `wait`), Anodex validates and executes them, and a fresh screenshot is returned for the next step. Roll this out in phases: browser/project testing with stable DOM targets, Anodex-owned surfaces with reliable element targets, then explicitly enabled Windows desktop control. Require a visible control session, application and window allowlists, step/time budgets, pause/stop, action previews, approval for consequential actions, protection for password and secret fields, and a complete action/screenshot audit trail. Keep the executor provider-neutral so local vision and future cloud computer-use models can share it.
- **Interactive vision navigation.** `inspect_visual` now samples up to three named HTML sections and lets the model request a particular section by id, so a visual review no longer sees only the header or a partial target area. A response can inspect eight images in batches of four. The next step is a bounded, durable visual session with explicit `scroll` and `page` actions, viewport identity, post-scroll screenshots, a larger session-level image budget across responses, and nested-target capture. Preserve position between visual steps, detect clipped or nested scroll containers, and add regression coverage for sticky headers, lazy-loaded content, nested scrolling, and screenshots taken after scrolling.

- **Composer continuity and accessibility.**
  - Paste images and files directly into the composer.
  - Preserve a separate unsent draft and its staged attachments for each chat across chat switches and restarts.
  - Let people edit and reorder messages queued behind an active response.
  - Finish the slash picker's assistive-technology wiring: expose whether it is open, connect it to the composer input, and announce the active option.
- **An original Anodex voice.** Read-aloud has shipped (local Qwen3-TTS, a default
  voice, nine built-in speakers, and an optional recording of the user's own voice;
  see the feature overview). What remains is a voice of Anodex's own, trained from
  Anodex-owned recordings or a voice actor with written rights covering AI
  training, commercial use, redistribution, derivative voices, termination,
  geography and language, before it is positioned as Anodex's voice in public.
  Training is under way in the separate Anodex Voice checkout (see
  `docs/VOICE_ENGINE_TRIAL.md`). Every shipped voice and runtime needs verified
  redistribution terms, required notices, and a provenance record for weights,
  datasets, recordings, prompts and generated assets, checked with counsel.

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
- Provider-neutral context recovery across local text, local vision, and cloud tool loops,
  including hard provider-round aborts, no-op-aware progress, durable-work handoffs,
  same-reply transcript shedding, and productive continuation beyond an arbitrary
  three-epoch boundary.
- A deterministic bounded native tool core with every other enabled capability
  reachable through the deferred gateway, plus ordered mixed-channel chat streaming
  and readable recovery when a local provider interrupts visible prose with reasoning
  or a tool call. Tool availability and continuation are driven by configuration and
  execution state, never prompt-keyword guards.
- In-app model discovery/downloads, hardware recommendations, reliability scoring,
  token activity, and the Workspace Dock.
- Signed releases on all three platforms through GitHub, with the in-app updater
  and hand-written notes (0.15–0.17).
- Everyday help in any chat (0.17): folder access on request, reminders delivered
  to the desktop, phone or email, downloads, disk cleanup to the Trash, opening
  files and pages, finding and emailing a file, taking a service key, "tell me
  when it's done", and a shell that knows its computer.
- A first-run welcome (name, look, model, phone pairing with a QR download), the
  Scheduler month view on desktop and phone, and the redrawn Agents and Critical
  Thinking pages, with editable agent plans (0.17).
- Read-aloud with local voices, the support bundle in Diagnostics, and the paired
  Anodex Mobile app.
- Since 0.17: opening a folder or document from anywhere on the computer; saved
  replies keep the break where a tool ran; the macOS app is ad-hoc signed
  (checked with `codesign --verify` in the Package workflow); "send it to my
  phone" goes straight to the paired phone (phone 0.90); the phone's Agents list
  matches the desktop's sections.

For implementation conventions and architecture, see [AGENTS.md](AGENTS.md).
