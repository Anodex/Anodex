# Anodex — Agent Notes

This file is for coding agents working on Anodex. It supplements `README.md` with
conventions, commands, and architecture details you need to make changes safely.

## Project overview

Anodex is a local-first desktop AI assistant built on **Electron + React + TypeScript**.
The local model engine is [`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp)
(llama.cpp bindings). The UI is React 18 with CSS Modules and Zustand for state.

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

`src/main/llama/LlamaService.ts` owns the entire lifecycle:

1. Lazy dynamic `import('node-llama-cpp')` on first use.
2. `loadModel()` → `getLlama()` → `loadModel()` → `createContext()`.
3. `generate()` streams tokens and can attach workspace tools.
4. `LlamaChatSession` is reused per conversation; switching conversations replays
   history.

### AI workspace tools

Tools live in `src/main/tools/` and are registered in `src/main/tools/registry.ts`.
The catalog shown in Settings is `TOOL_CATALOG` in `src/shared/tools.types.ts`.

#### Adding a new tool

1. Choose the right file (or create one):
   - Read operations → `fileTools.ts` or `gitTools.ts`
   - Web page fetching → `webTools.ts`
   - Web search → `webSearchTools.ts` + `src/main/tools/search/`
   - File mutations → `mutationTools.ts`
   - Directory mutations → `directoryTools.ts`
   - Shell commands → `commandTools.ts`
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
