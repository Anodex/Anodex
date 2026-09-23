# Handoff prompt — let Anodex use the programs installed on this machine

Paste everything below the line into a fresh Claude Code session opened on
`C:\Users\Owner\Desktop\Anodex4`.

---

I want Anodex to be able to discover and drive the creative and build programs
installed on this machine — Blender, Unreal Engine, GIMP, ImageMagick and so on
— so an agent run can actually use them instead of only editing text files.

## What you are working on

Anodex is a local-first Electron desktop app (main / preload / renderer /
shared) at `C:\Users\Owner\Desktop\Anodex4`. Windows 11, PowerShell.
TypeScript, vitest, Playwright for e2e. It runs a local llama.cpp model and
several cloud providers, and it has an agent runner that executes unattended
multi-turn tasks with a tool loop.

Read `CLAUDE.md` and the memory index first if one is offered to you. Branch off
`main` for this work — do not touch `feat/keep-going`, which has an open PR.

## What is already verified on this machine

I checked these directly; you can re-verify but you do not need to rediscover
them.

- **Blender 5.1.2** — `C:\Program Files\Blender Foundation\Blender 5.1\blender.exe`.
  **Not on PATH.** Confirmed working headless: a script run with
  `blender --background --python script.py` built a scene through `bpy`,
  rendered a 320×240 PNG and exited in about 2.5 seconds. The render lands on
  disk, which means output is inspectable and gradeable.
- **Unreal Engine 5.8.3** — `C:\Program Files\Epic Games\UE_5.8`. Fully
  installed. `UnrealEditor-Cmd.exe`, `UnrealEditor.exe`, `RunUAT.bat`,
  `Build.bat`, `UnrealBuildTool.exe` and the `PythonScriptPlugin` are all
  present. `UnrealEditor-Cmd.exe -version` runs and UnrealBuildTool validates
  Win64 against SDK 10.0.22621.
- Also present: GIMP 3.2 (`gimp-console` batch scripting), ImageMagick 7
  (`magick` on PATH), Python 3.14, Node 25, .NET, CMake, **Visual Studio Build
  Tools 2022** (so native C++ compilation works), git, Steam.
- Not installed: Godot, Unity, ffmpeg.
- There are **214 installed entries** across `HKLM`, `HKLM\WOW6432Node` and
  `HKCU` uninstall keys. That number matters — see the design note below.

## The design I want

**Do not build an "enumerate everything installed" tool.** Two reasons. A list
of 214 programs is mostly noise to a model and burns context. And a full
software inventory is fingerprintable personal data that would then be sent to
whichever cloud provider the run uses.

Build three things instead:

1. **A recipe registry.** A curated, typed list of programs Anodex knows how to
   drive. Each entry: a stable id, a display name, how to detect it (candidate
   absolute paths, registry display-name patterns, PATH executable names), the
   headless invocation form, and a one-line description of what it can produce.
   Start with Blender, ImageMagick and GIMP. Add Unreal, but see the caveat.
2. **A probe** that resolves the registry against the machine and caches the
   result. Detection must handle the Blender case: installed, real, and _not on
   PATH_ — so registry keys and known install paths both matter, not just
   `where.exe`.
3. **One tool** the model can call to ask what is available, following the
   `anodex_status` pattern in `src/main/tools/anodexStatusTool.ts`. Read that
   file first — it is the precedent, and its docstring explains the reasoning
   (read-only by construction rather than by instruction; one tool with an
   argument rather than five tools, because tool count is a real budget).

Execution itself already works — `run_command` can invoke any of this today. So
the missing pieces are discovery and knowing the invocation, not running things.

## Hard constraints

- **A new tool must be forwarded by all five transports or it silently reaches
  nobody.** They each rebuild the tool context by hand:
  `src/main/llama/LlamaService.ts`, `src/main/llama/LlamaVisionService.ts`,
  `src/main/llm/AnthropicProvider.ts`, `src/main/llm/OpenAiProvider.ts`,
  `src/main/llm/OpenAiCompatibleProvider.ts`. Registry-level tests do **not**
  catch a transport that forgot. Check `src/main/tools/__tests__/` for an
  existing "reaches all transports" test to copy.
- **Registration** goes through `src/main/tools/registry.ts`. Pick the right
  factory map — this tool needs no workspace and no project, so
  `GLOBAL_FACTORIES` is likely right. Look at how the neighbours are gated.
- **Tool count is a budget.** `maxDirectToolsForContext` in
  `src/main/llama/toolSurface.ts` means that on a small window only about ten
  tools stay directly callable and the rest fall behind a find/describe/call
  gateway. One tool, not one per program.
- **Guidance may only name tools the run can actually call.** See
  `src/main/tools/toolAvailability.ts` — there is a recent fix for exactly this
  class of bug. If you write any model-facing prose that names a tool, ask that
  module whether the run has it.
- **Privacy is a setting, not a default.** The probe should be user-controlled.
  Report what was found, never a full inventory, and never raw registry dumps.
- **Tests must fail against the pre-change source.** Take the baseline from
  `git show HEAD:<file>`, never by reconstructing it by hand, and read _why_ a
  test failed rather than counting that it did.
- **Open a PR** with `gh pr create`. Do not push to `main`.
- Match the surrounding code: this codebase comments the _why_ and the history
  of a decision, not the _what_. Read a few neighbouring files before writing.

## The Unreal caveat — be honest about this

Unreal is installed and drivable, but it is not equivalent to Blender:

- C++ changes go through UnrealBuildTool and routinely take 10–60 minutes.
  Anodex's agent run budget is currently 75 minutes _total_ per feature, so a
  compile can consume the whole thing.
- Blueprints are binary assets an agent cannot meaningfully edit.
- The Python API is editor-scoped and narrower than Blender's `bpy`.

So the realistic Unreal surface is Python-driven editor automation, asset
import/export pipelines, and `RunUAT` packaging — not "build me a game". Put
that in the recipe's own description so the model does not over-reach, and do
not claim more in the PR than you have actually run.

## Definition of done

- The tool returns what is genuinely installed here, including Blender despite
  it not being on PATH, and does not return a 214-entry inventory.
- Unit tests cover detection against a fixture filesystem/registry shape, and a
  test proves the tool reaches all five transports.
- `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm run test`
  all pass. Run `npx playwright test` too if you touched anything the e2e suite
  covers — **rebuild first with `npm run build`**, because Playwright runs
  `out/main` and a stale build produces false results.
- At least one end-to-end demonstration you actually executed: an agent run, or
  a manual `run_command` sequence, that drives Blender headlessly and produces
  a file. Show the output. Do not describe it as working without having run it.
- A PR whose description says what was measured and what was not.
