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
