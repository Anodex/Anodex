# Anodex — Agent Notes

This file is for coding agents working on Anodex. It supplements `README.md` with
conventions, commands, and architecture details you need to make changes safely.

## Project overview

Anodex is a local-first desktop AI assistant built on **Electron + React + TypeScript**.
The local model engine is [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp)
(llama.cpp bindings). The UI is React 18 with CSS Modules and Zustand for state.

**Before starting new feature work**, check `README.md` (what exists and how it
should behave) and `ROADMAP.md` (what's planned, in progress, or deliberately
deferred and why) — several sessions work on this repo concurrently, and
`ROADMAP.md` exists specifically so work doesn't get duplicated or built out
of sync with an already-settled design decision.

## Quick commands

```bash
npm install        # install dependencies (includes native binaries)
npm run dev        # start with hot reload
npm run build      # production build into out/
npm run dist       # build + package installers
npm run typecheck  # TypeScript check without emit
npm run lint       # ESLint
npm run lint:fix   # ESLint with auto-fix
npm run format     # Prettier write
npm run format:check # Prettier check
npm run test       # Vitest unit tests
npm run test:watch # Vitest watch mode
npm run test:e2e   # Playwright E2E (requires npm run build first)
```

## Code style

- **Formatter:** Prettier (configured in `.prettierrc.json`).
  - `semi: false`
  - `singleQuote: true`
  - `tabWidth: 2`
  - `printWidth: 100`
  - `trailingComma: none`
- **Linter:** ESLint 9 flat config in `eslint.config.mjs`.
- Prefer `function` declarations for pure helpers and named React components.
- Use arrow functions for callbacks and short handlers.
- Import Node built-ins with the `node:` prefix (`node:path`, `node:fs/promises`).
- Use `import type` for type-only imports.
- React components return `JSX.Element` explicitly.
- Keep files small and single-purpose.

## TypeScript project layout

- `tsconfig.node.json` — main process, preload, shared, configs, tests.
- `tsconfig.web.json` — renderer + shared.
- Aliases:
  - `@main/*` → `src/main/*`
  - `@shared/*` → `src/shared/*`
  - `@renderer/*` → `src/renderer/*`

## Architecture

### Main / renderer boundary

`src/shared/ipc.ts` is the single source of truth. It defines `IpcChannel` and
`AnodexApi`. Main handlers and the preload bridge must conform to it. The
renderer accesses the API through `window.anodex`.

### Result type across IPC

Main handlers return `Result<T>` from `src/shared/result.ts` instead of throwing.
The renderer branches on `result.ok`.

### Local model engine

`src/main/llama/LlamaService.ts` owns the shared lifecycle:

1. Lazy dynamic `import('node-llama-cpp')` on first use.
2. Text models use `loadModel()` → `getLlama()` → `loadModel()` →
   `createContext()`.
3. A model with `visionProjectorPath` uses `LlamaVisionService` and an
   Anodex-owned `LlamaServerRuntime` process instead. It must remain
   loopback-only, API-key protected, hidden, and stopped on unload/quit.
4. `generate()` streams tokens and can attach the same guarded workspace tools
   on either backend.
5. Text-model `LlamaChatSession` is reused per conversation; switching
   conversations replays history. Vision history is projected into bounded
   OpenAI-compatible chat messages and reopens persisted image attachment paths.

Persisted user image attachments remain metadata-only. `MessageAttachments`
reopens their pixels through the typed preload bridge for inline transcript
display; do not persist its data URLs in conversation JSON. Chat image surfaces
use the shared `ExpandableImage`/`ImageLightbox` UI components so fullscreen
behavior, zoom bounds, keyboard handling, and focus restoration do not drift.
`visualComparisonsByMessage()` derives before/after pairs from repeated,
successful `inspect_visual` calls for the same path across the full transcript.
Never treat `preview_html` as comparison evidence; it is an interactive
document, not a captured screenshot. Comparison state is not persisted
separately. `VisualComparison` starts expanded and keeps both panes in one grid
row at every width.

The pinned llama.cpp runtime is prepared by `npm run prepare:vision`, stored
under ignored `resources/llama-server/<platform>-<arch>`, and packaged by
`npm run dist`. Do not commit extracted runtime binaries. Projector GGUFs are
model components: keep them out of the normal model list and store explicit
model-to-projector pairings in `visionProjectorPaths`.

### Critical Thinking research

Critical Thinking is a persisted orchestration layer, not a long chat/tool turn:

- `src/main/criticalThinking/CriticalThinkingService.ts` owns the run lifecycle,
  provider pinning, synthesis, validation, stop/resume, and renderer broadcasts.
- `CriticalThinkingResearchRunner.ts` executes each plan step as persisted rounds:
  isolated query selection, direct bounded search, direct bounded fetch, and an
  isolated structured coverage assessment.
- Model phases must use an empty logical history and `sessionMode: 'isolated'`.
  Do not reintroduce a shared `LlamaChatSession` or native function-call loop for
  research orchestration.
- Search and fetch I/O use the configured providers directly, accept an
  `AbortSignal`, and stay within the pinned `CriticalThinkingResearchPolicy`.
- Attempt-level round/search/fetch/time counters reset on Resume;
  `maxVerifiedSourcesPerRun` is a lifetime bound and must not reset.
- Search artifacts are leads. Only successful `web-fetch` artifacts with focused
  passages are verified evidence and may satisfy coverage or support citations.
- The model proposes coverage; `assessmentIsSufficient()` enforces the minimum
  fetched-evidence floor. Budget and completion decisions remain service-owned.
- Persist and flush the round/evidence checkpoint before advancing phases. Keep
  aggregate step fields (`evidenceIds`, `finding`, `uncertainties`) in sync for
  synthesis and compatibility with older runs.
- `CriticalThinkingStore.normalizeCriticalThinkingRun()` must remain backward
  compatible with runs that predate policies and rounds. New persisted fields
  need defensive defaults rather than a destructive migration.
- Final synthesis remains tool-free and uses a bounded evidence packet. Preserve
  substantive-block citation coverage; source/passage, quote, numeric, raw-URL,
  and chart validation; safe citation rendering; and the single bounded repair
  pass.

See `docs/CRITICAL_THINKING_ARCHITECTURE.md` for the state machine and invariants.

### AI workspace tools

Tools live in `src/main/tools/` and are registered in `src/main/tools/registry.ts`.
The catalog shown in Settings is `TOOL_CATALOG` in `src/shared/tools.types.ts`.

#### Adding a new tool

1. Choose the right file (or create one):
   - Read operations → `fileTools.ts`, `codeOutlineTools.ts`, or `gitTools.ts`
   - Git summaries/commit-message assistance → `gitCommitTools.ts`
   - Web page fetching → `webTools.ts`
   - Web search → `webSearchTools.ts` + `src/main/tools/search/`
   - File mutations → `mutationTools.ts`
   - Directory mutations → `directoryTools.ts`
   - Shell commands → `commandTools.ts`
   - Structured verification/check wrappers → `diagnosticsTools.ts`
   - Provider-visible image/HTML inspection → `visualInspectionTools.ts`
   - User-visible workspace image replies → `imageDisplayTools.ts`
   - Email actions → `emailTools.ts`
2. Export a `ToolFactory` that calls `define({ description, params, handler })`.
3. Use `runReadTool()` for safe reads or `runGuardedTool()` for mutations.
4. Confine all paths with `resolveInWorkspace(ctx.workspaceRoot, path)`.
5. Return `{ modelResult: string, detail?: string }`.
6. Register the factory in `registry.ts`.
7. Add a catalog entry to `TOOL_CATALOG`.
8. Add unit tests in `src/main/tools/__tests__/`.

Keep `registry.ts`, `TOOL_CATALOG`, `README.md`, and the tool tests in sync.
`registry.test.ts` has a catalog parity check so hidden runtime tools do not
drift away from the Settings/docs surface.

`inspect_visual` is registered only when `ToolRuntimeContext.visualInputs` is
present. Cloud providers and `LlamaVisionService` own that per-generation,
four-image queue and inject drained images into the next provider round.
Text-only `LlamaService` must not expose the tool. Its `ToolCallPreview`
contains an ephemeral image data URL plus a sandboxed
`ConversationAssetStore` reference. `chatSanitizer.ts` must preserve the live
data URL for rendering, remove only the data URL from persisted `toolCalls` and
timeline blocks, and remove the entire preview from model-history replay.

`show_image` is a different read-only workspace tool: it is available to text
and vision models, displays a confined existing image to the user, persists the
same durable preview reference, and never queues pixels back into the provider.

`ConversationAssetStore` enforces both per-conversation and global byte limits,
oldest-first, and owns usage/clear operations exposed through typed conversation
IPC. Clearing assets must never delete conversations; stale references degrade
through the unavailable-preview UI.
Permanent conversation deletion must remove its assets.

Missing user attachments use the native `attachments.pickImage` bridge and
validate the replacement through `attachments.readFile` before rewriting only
that message's attachment metadata. Missing tool previews retry their durable
asset first; Re-inspect/Show Again creates an ordinary user follow-up so the
normal tool registry, permissions, and workspace confinement still apply.

#### Tool approval

- Read tools (`runReadTool`): never ask.
- Web tools (`fetch_url`): never ask.
- `web_search`: asks when `ctx.webSearch.requireApproval` is true (passed as
  `forceConfirm` to `runGuardedTool`).
- Write/command tools (`runGuardedTool`): confirmation is decided by
  `resolvePermission(ctx.permissionMode, spec.risk)` in
  `src/main/tools/permissions.ts`, not a plain boolean:
  - `risk: 'trivial'` always auto-runs, regardless of `permissionMode` (used
    by `create_directory`).
  - `permissionMode: 'ask'` always confirms (except `'trivial'` above).
  - `risk: 'destructive'` always confirms, regardless of `permissionMode`.
  - `permissionMode: 'full'` + `risk: 'sensitive'` confirms; every other
    combination auto-runs.
  - `spec.forceConfirm` overrides the above and always asks when `true`.

#### Adding a web search provider

1. Create a new file in `src/main/tools/search/providers/`.
2. Export `create<Provider>Provider(apiKey, ...): SearchProvider`.
3. Add the provider to `WebSearchSettings.provider` in `src/shared/settings.types.ts`.
4. Wire it up in `src/main/tools/search/index.ts`.
5. Add a UI option in `src/renderer/features/settings/SettingsView.tsx`.
6. Add unit tests with mocked `fetch`.

### Tests

- **Unit:** Vitest. Config in `vitest.config.mjs`.
- **E2E:** Playwright. Config in `playwright.config.ts`, tests in `e2e/`.
- Test helpers for tools are in `src/main/tools/__tests__/test-helpers.ts`.

## Anodex ships on Windows, macOS and Linux

**All three are first-class. A change that only works on the machine you are
sitting at is not finished.** CI runs unit tests and a build on
`windows-latest`, `ubuntu-latest` and `macos-latest`, and a change that passes
locally can still fail there.

Real defects this has caused, all found after the code looked correct:

- **`edit_file` could not touch a CRLF file at all.** A model sends bare
  newlines; the file on disk used CRLF; the literal match found nothing and
  every multi-line edit was refused. That is most of Windows, and any checkout
  with `core.autocrlf=true` anywhere. It hid because `replace_lines` still
  worked, so runs continued slightly worse with nothing reporting a bug.
- **A PDF test timed out on `windows-latest` only**, because the runner was slow
  enough that a dynamic `import()` inside the test exceeded its own five-second
  budget. Main was red for two days over a test that passes everywhere else.

What that means in practice:

- **Never assume a line ending.** Match what the file already uses and preserve
  it; renormalising turns a one-line change into a whole-file diff.
- **Never assume a path separator or case.** Go through `resolveInWorkspace()`
  and `path.join`; Linux and macOS are case-sensitive and Windows is not.
- **Never assume speed.** A Windows CI runner can be five times slower than your
  machine. If a test's own timeout has to cover a heavy import, move the import
  out of the test rather than raising the timeout.
- **Platform-specific code must degrade, not break.** Desktop control is
  Windows-only _by design_ and says so through `desktopControlEligibility()`
  rather than failing at the call site. Follow that shape.
- **Check the shell you are assuming.** `run_command` runs under `cmd.exe` on
  Windows and the user's `$SHELL` elsewhere, so a command written for one may be
  a syntax error on the other. `DESTRUCTIVE_COMMAND_PATTERNS` in
  `permissions.ts` covers POSIX, PowerShell and cmd forms of the same act for
  this reason.

Before finishing a change that touches the filesystem, shell, or timing, ask
which of the three it was written against and whether the other two behave the
same. When you cannot test them, say so.

## Releasing

**Merging is not shipping.** A change that a user would notice is not delivered
until there is a release on GitHub carrying it, because that is the only thing
the in-app updater can see. `anodex-mobile` has always been released this way —
every change gets a version and a real set of notes — and this repository is
held to the same standard. When work lands here, cut the release too, rather
than leaving it merged and invisible.

### Version numbers

`MAJOR.MINOR.PATCH`, and the updater only cares that the new number sorts
higher than the installed one.

- **PATCH** (`0.2.0` → `0.2.1`) — bug fixes only, nothing new.
- **MINOR** (`0.2.1` → `0.3.0`) — a new capability. Resets patch to 0.
- **MAJOR** — still `0`, meaning the shape of the app is not yet promised.

The version lives in **three** places and all three must agree: `version` in
`package.json`, and _both_ `version` (root) and `packages[""].version` in
`package-lock.json`. Missing the third is easy — `package-lock.json` also
contains unrelated dependencies that happen to sit at the same number, so never
blanket-replace the string; edit the two known lines. A lockfile that disagrees
with `package.json` fails CI rather than shipping wrong, which is the good case;
the bad case is noticing during a release.

### Cutting one

`.github/workflows/package.yml` triggers on `tags: ['v*']` and runs
`npm run dist -- --publish always`. So the tag _is_ the release trigger — push
it and the three platform builds package themselves into a **draft** release.

A draft is where they stop. Publishing is a separate, deliberate step that
happens after the installers are signed; see below.

Two settings exist because their absence produced a release that looked correct
and did nothing:

- `releaseType: draft` in `electron-builder.yml`. **A draft release is invisible
  to electron-updater.** That was once the bug — the whole chain ran against
  something no client could see, and every install went on reporting it was up
  to date. It is now the mechanism: invisibility is exactly what you want in the
  window between "the installers exist" and "the installers are signed".
- `latest.yml` must be published beside the installer. That file, not the
  installer, is what the updater reads. Builds used to upload as workflow
  artifacts, which only somebody already inside the repository can reach.

### Signing it

Every installer is signed with the Anodex release key, and an install refuses an
update it cannot verify. This is the step that makes an update trustworthy
rather than merely intact.

The distinction is worth being precise about. `latest.yml` carries a sha512 for
each installer, but that hash travels in the same GitHub release as the
installer — it catches corruption in transit and nothing else. Anyone able to
write to a release can replace both halves, and before signing existed every
install would have accepted the result. The Ed25519 signature is what makes that
substitution fail, because the private key is not in the repository, not in CI,
and not reachable by any token that can write a release.

After CI finishes and the draft release has all three installers:

```
gh release download v0.2.2 --dir dist --pattern '*.exe' --pattern '*.dmg' --pattern '*.AppImage'
npm run release:sign -- --key ~/.anodex/release-signing-key.pem dist/*.exe dist/*.dmg dist/*.AppImage
gh release upload v0.2.2 dist/*.sig
gh release edit v0.2.2 --draft=false
```

Only that last command makes the release visible to anybody's updater.

**The failure mode to know:** publish a release without uploading its `.sig`
files and every install will refuse the update. That is correct behaviour — the
check is fail-closed on purpose, because whoever can replace an installer can
equally delete the signature beside it — but the first time it happens it will
look exactly like a broken updater. If an install reports "this release carries
no signature", the release is at fault, not the client.

The key itself is generated once, by `npm run release:keygen`, on the machine
that cuts releases. Its public half is compiled into the app
(`src/main/updates/releaseKey.ts`), which is what pins the trust: the copy
somebody already installed is the thing that judges the update, so reaching the
release is not enough to forge one. The corollary is that **losing the private
key cannot be undone by reissuing it** — a new key means shipping a build
carrying the new public half before anyone can update past it. Back it up
offline.

### Release notes are written, not generated

This is the part that is easy to skip and the part people actually read. Say
what changed and why it mattered, in the app's own voice — the same voice the
code comments use. A generated list of commit subjects is not release notes.

Include the install line: which file to download per platform, and the fact
that each platform is built on its own machine (Anodex ships the llama.cpp
runtime for the system it was built on, so a Windows build made on Linux fails
the moment a vision model loads).

### Verify the bytes match the tag

`anodex-mobile` shipped a release tagged 0.44.0 whose APK contained 0.43.0. The
phone updated, reinstalled the same build, and offered the update again for
ever — an install loop with nothing visibly wrong at either end. The cause was
picking a CI run by recency moments after pushing, catching the merge that came
just before the version bump.

`tools/release_apk.py` there now resolves the run by commit sha and refuses to
upload an APK whose `versionName` does not match the tag. This repository
publishes from the tagged commit's own workflow run so it cannot make that
mistake — but the lesson generalises: **a correct tag on the wrong bytes is
indistinguishable from success until somebody installs it.** Check the version
inside the artifact, not just the name on the release.

### Then check the release is whole

A green workflow does not mean a complete release. After publishing, confirm the
release carries **all three installers and all three metadata files**:

```
Anodex-Setup-<v>.exe   latest.yml        # Windows
Anodex-<v>-arm64.dmg   latest-mac.yml    # macOS
Anodex-<v>.AppImage    latest-linux.yml  # Linux
```

A platform missing its `latest*.yml` is the failure that looks most like
success: the release page shows files, the workflow is green, and every install
on that platform goes on reporting it is up to date for ever.

v0.2.1 shipped as **two releases on the same tag**, created in the same second,
because the three matrix jobs each asked GitHub for the release and each was
told to create one. Windows landed on one, macOS and Linux on the other, and
`/releases/latest` returned whichever it preferred. `max-parallel: 1` in
`package.yml` is what prevents it; if that is ever removed, this comes back.

```bash
gh api repos/Anodex/Anodex/releases --jq \
  '.[] | select(.tag_name=="vX.Y.Z") | "\(.id) \([.assets[].name]|join(","))"'
```

More than one line means a duplicate; consolidate onto the one
`/releases/latest` resolves to and delete the other.

## Security notes

- Never expose Node/Electron APIs directly to the renderer. Use the typed preload
  bridge.
- All file-system tools must pass through `resolveInWorkspace()`.
- Do not allow arbitrary shell commands without approval (`run_command` already
  requires approval when enabled).
- Keep `contextIsolation: true` and `nodeIntegration: false` in `window.ts`.

## Common gotchas

- `node-llama-cpp` is ESM-only; import it with dynamic `import()`.
- The app must be built (`npm run build`) before `npm run test:e2e`.
- Husky hooks require the directory to be a git repo (`git init`).
- If ESLint reports a file is not in any tsconfig, add the file to
  `tsconfig.node.json` or disable type-checked rules for that pattern.
- Anodex holds an Electron single-instance lock, and the autorun harnesses
  (`ANODEX_CHAT_AUTORUN`, `ANODEX_AGENT_AUTORUN`, `ANODEX_CT_AUTORUN`) leave the
  app running when their script finishes. Start a second `npm run dev` while one
  is alive and it builds, launches Electron, and that Electron immediately quits
  — `npm` exits 0, nothing warns you, and the log simply stops after
  "starting electron app...". The harness never arms, so a watcher waiting for
  the completion line waits forever on a run that never began. Kill the previous
  instance first and confirm it is gone before launching; "port 5173 is in use"
  in the log is the tell that you did not.
