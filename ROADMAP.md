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
  back four `echo` answers, which #382's guard catches. Re-run on 0.19.2
  (Windows, 2026-10-14): "Send <file> from my Downloads to my phone" found the
  file and said to pair a phone or link email, with no shell command; "What does
  my todo list say?" did not invent a path but presented a file that only
  mentioned a todo as the list, which `find_my_files` now flags (#397).
  **0.19.1 (#391):** a plain local chat message about none of the computer, the
  web or Anodex now keeps every tool behind the gateway, and the gateway is
  described by purpose rather than by naming the catalogue. Fresh-chat suite on
  the Iris Xe laptop, 8 questions and sums plus 3 computer tasks: Llama 3.1 8B
  4/8 → 7/8 (7/8 without Anodex), Gemma 4 E4B 8/8 with no tool calls, computer
  tasks still answered with the right tool. Llama still made the odd stray
  gateway call, and the gateway's dead ends then sent it searching again; #397
  answers those with "answer in your reply" on plain questions: 10/12 → 12/12
  over three launches, with no minutes-long replies.
  **0.21.0:** on the 54-question battery the wrong tool had become the commonest
  failure (9 of 15 across two runs). A local plain chat now sees the person's
  files as one tool, `my_files` (find, list, open, send; send and open take a
  name and find it), with the shell, `move_to_trash` and `request_folder_access`
  out of view on a message about only files; and a successful tool result ends
  "(Answer the person from this, in plain words.)". Gemma 4 E4B 52 → 53 of 54,
  Llama 3.1 8B 49 → 51, no turn at the time limit. Llama still runs a command for
  "Which AI model are you running on right now?" ("running" is a machine word)
  and for "latest Node.js version", a web question.
- ~~**A local tool call that never closes runs to the 15-minute limit.**~~
  Fixed in 0.20.2 and 0.20.3. #397's diagnostics never fired for it, because the
  budget's time limit read as the person's Stop (#402 fixed that); with them,
  Gemma 4 E4B on "How much free disk space do I have?" wrote `"name": "C:\"` (the
  backslash escapes the closing quote) and then its own `<tool_call|>`,
  thoughts and answer into one argument, 2 times in 8. The model's own turn
  markers inside arguments now stop the call (#402), and the round reads it back
  into the call it meant and runs it, 9 of 9 answered (#404). Also caught: a
  run of one short piece (Llama writing `\\` 3,600 times, #404), and lookups
  past six a turn (#404). **Still open:** one turn on "What files are in my
  Downloads folder?" wrote a 12,337-character `run_command` with neither sign;
  0 more in 30 tries. Local test builds log any argument past 3,000 characters,
  so the next one shows its text.
- ~~**"Fastest" ranks by file size, which misjudges per-layer-embedding models.**~~
  Fixed: `speedRankOf` reads the parameters a model computes with from its name
  (`E4B`, `30B-A3B`: `activeParametersB`), and on the Fastest card variety only
  breaks a tie on speed, never overrides it. Gemma 4 E4B is now "Fastest" on
  laptops and 8 GB cards where it was Llama 3.1 8B; quality stays with the
  file's class. Memory still reads the whole file: a mixture-of-experts model
  needs room for everything it stores.

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
  memory for big models, at the cost of a slower first reply. **Measured, not
  shipped:** on Windows (Iris Xe, 32 GB) Qwen3.6-14B-A3B used the same memory
  with it on or off (9.05 against 9.04 GB on the GPU; 2.04 GB either way
  CPU-only) and answered as fast. Still worth trying on the 27B, on Linux, and on
  a machine short of RAM, where it may behave differently.
- **Native Jinja fallback and better reasoning extraction (3.20–3.21).** Qwen3.8
  ran under the plain Jinja wrapper and leaked its reasoning into replies; we strip
  it (`stripLeakedEngineText`). Check whether 3.22 parses it properly, and retire
  the workaround if so. On 3.22.1 Qwen3.6-14B-A3B leaked nothing in 17 raw
  rounds, but it resolves to `QwenChatWrapper`, not the Jinja fallback that
  leaked, so this needs Qwen3.8 itself before the workaround can go.

## Next product work

- **Project health** — bring git state, recent checks, active plans, changed files,
  and scheduled or agent activity together in the Workspace Dock.
- **Fewer, broader tools for local models.** A small local model picks between
  tools that do nearly the same job badly, and every extra schema costs prompt it
  re-reads. Measured where it has been done: `my_files` (find, list, open and
  send a file, in place of three tools) raised Gemma 4 E4B 52 → 53 and Llama 3.1
  8B 49 → 51 on the everyday set. Email (19 tools → 5 combined plus
  `list_email_accounts` and `list_mailboxes`) is in progress.

  The rule each step follows, so this does not turn into a rewrite:
  - The combined tool hands each action to the separate tool that already does
    it, so approval, cards, checkpoints and safety stay that tool's. Nothing is
    deleted; the separate tools stay one gateway step away.
  - Shown only to a local model (`ToolRuntimeContext` flag, copied by name in
    both engines, with a test that fails if a transport drops it). Cloud models
    and agent runs keep the full surface until a measurement says otherwise.
  - Measured before and after on Gemma 4 E4B and Llama 3.1 8B, on the same
    machine and the same data, twice each where a run is noisy. A group that
    does not improve is not shipped.

  The project and agent tools have had no reliability round yet. In order, by
  how often a small model reaches for them and how much a wrong pick costs:
  1. **A project battery first.** No combining until there is a measurement:
     explain a file, find where something is defined, fix a failing test, add a
     small feature, run the checks, summarise the git changes, on a fixture
     project, through `ANODEX_AGENT_AUTORUN`.
  2. **Reading and finding** (`read_file`, `read_file_range`,
     `read_multiple_files`, `get_file_info`; `list_directory`, `find_files`,
     `search_files`, `search_code`, `code_outline`). The repeated-read loops the
     loop guard exists for come from here.
  3. **Background processes** (`start_process`, `stop_process`, `list_processes`,
     `read_process_output`) as one tool with an action, and `git_status` with
     `git_diff`.
  4. **Change tasks** (`propose_change`, `update_change_task`, `archive_change`,
     `list_changes`), and the small pairs: `request_key`/`save_key`,
     `find_cleanup`/`move_to_trash`, `delete_file`/`delete_directory`.
  5. **Editing last** (`edit_file`, `replace_lines`, `patch_file`,
     `append_file`). The highest-risk group: line endings, stale views and
     partial writes all live here (see "Anodex ships on Windows, macOS and
     Linux" in `AGENTS.md`), so it is combined only if steps 1–4 show it is
     worth the risk.

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
  execution state, never prompt-keyword guards. (Keywords decide only which tools a
  local model's plain chat message sees in full; everything stays reachable.)
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
