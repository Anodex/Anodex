<div align="center">

# Anodex

**A local-first AI assistant for coding help and general chat.**

Runs open models on your own machine — private, fast, and offline-capable.

</div>

---

## Overview

Anodex is a desktop application built on **Electron + React + TypeScript**, with a
first-class local model engine powered by **[`node-llama-cpp`](https://github.com/withcatai/node-llama-cpp)**
(llama.cpp under the hood). It is designed as a solid product foundation: clean
architecture, small single-purpose files, and clear extension points for the
features that come next (coding workflows, agents, remote providers, in-app model
downloads).

The local model system is a core part of the app, not an add-on — the main
process owns the engine, and the entire UI is built around loading a model,
seeing its status, and chatting with it.

## Tech stack

| Concern            | Choice                      | Why                                                            |
| ------------------ | --------------------------- | -------------------------------------------------------------- |
| Shell              | Electron                    | Native desktop, direct filesystem + Node access for the engine |
| Build              | electron-vite + Vite        | Fast HMR, clean main/preload/renderer separation               |
| UI                 | React 18 + TypeScript       | Familiar, typed, componentised                                 |
| State              | Zustand (+ Immer)           | Minimal, ergonomic, no boilerplate                             |
| Local model engine | node-llama-cpp              | Prebuilt N-API binaries → runs in Electron with no rebuild     |
| Styling            | CSS Modules + design tokens | No framework dependency, full control over the visual identity |

## Getting started

```bash
npm install       # installs deps (Electron + node-llama-cpp binaries)
npm run dev        # launches Anodex with hot reload
```

Other scripts:

```bash
npm run build         # type-check + production build into out/
npm run typecheck     # type-check main + renderer without emitting
npm run dist          # build + package installers via electron-builder
npm run lint          # run ESLint on the whole project
npm run lint:fix      # run ESLint and auto-fix issues
npm run format        # format everything with Prettier
npm run format:check  # check Prettier formatting without writing
npm run test          # run Vitest unit tests
npm run test:watch    # run Vitest in watch mode
npm run test:e2e      # run Playwright E2E smoke tests (requires npm run build first)
```

### Development workflow

Anodex uses ESLint + Prettier for code quality, Vitest for unit tests, and
Playwright for E2E smoke tests. Husky + lint-staged run linting and formatting
on every commit once the repo is initialised with `git init`.

A GitHub Actions workflow in `.github/workflows/ci.yml` runs typecheck, lint,
format checks, unit tests, and a production build on every push and PR.

### Loading a model

1. Obtain a `.gguf` model file (see the **Recommended** list in the Models tab for
   good starting points, e.g. Qwen2.5 Coder 3B).
2. Either use **Models → Add model** to pick the file, or drop it into the models
   folder (**Models → Open models folder**) and press **Refresh**.
3. Click **Load model**. Once the status badge turns green, start chatting.

Models and settings are stored under Electron's `userData` directory
(`Models → Open models folder`).

## Architecture

```
src/
├── main/                 # Electron main process (Node side)
│   ├── index.ts          # App lifecycle & single-instance lock
│   ├── window.ts         # BrowserWindow creation & security posture
│   ├── llama/            # ★ The local model engine (first-class)
│   │   ├── LlamaService.ts   # Model load/unload, sessions, streaming generation
│   │   └── modelScanner.ts   # Discover .gguf files on disk
│   ├── ipc/              # Typed IPC handlers, one file per domain
│   ├── settings/         # Persisted settings (JSON in userData)
│   ├── tools/            # AI assistant workspace tools
│   │   ├── fileTools.ts      # read, search, info, range, batch reads
│   │   ├── mutationTools.ts  # write, edit, delete, move
│   │   ├── directoryTools.ts # create / delete directories
│   │   ├── commandTools.ts   # run shell commands
│   │   ├── gitTools.ts       # git status / diff
│   │   ├── registry.ts       # builds the complete tool set
│   │   ├── workspace.ts      # path confinement safety boundary
│   │   └── helpers.ts        # activity emit + approval flow
│   └── utils/            # Logger, helpers
│
├── preload/index.ts      # contextBridge → exposes typed `window.anodex`
│
├── shared/               # Types & contracts shared by both sides
│   ├── ipc.ts            # Channel names + AnodexApi surface (source of truth)
│   ├── result.ts         # Result<T> for errors that cross IPC
│   ├── *.types.ts        # Model / chat / settings / system types
│   └── recommendedModels.ts
│
└── renderer/             # React UI (browser side)
    ├── components/        # Shared UI: shell, sidebar, logo, primitives
    ├── features/          # Self-contained features
    │   ├── chat/          # Transcript, composer, streaming, markdown-lite
    │   ├── models/        # Catalogue, load/unload, recommendations
    │   └── settings/      # Assistant, model, generation, storage, about
    ├── stores/            # Zustand stores (chat, model, settings, ui)
    ├── hooks/             # useAnodexBridge — wires IPC events to stores
    ├── lib/               # anodex API accessor, formatting, ids
    └── styles/            # theme.css (design tokens) + global.css
```

### Design principles

- **The engine lives in the main process.** Heavy, Node-only work (llama.cpp)
  never touches the renderer. The UI only ever talks through the typed bridge.
- **One typed contract.** `src/shared/ipc.ts` defines every channel and the
  `AnodexApi` shape. Main handlers and the preload bridge both conform to it, so
  they can't drift.
- **Errors don't throw across IPC.** Handlers return `Result<T>`; the renderer
  branches on `ok`/`error` and surfaces friendly toasts.
- **Features are self-contained.** Each feature folder owns its components and
  styles, so the app grows by adding folders, not editing god-files.

### AI workspace tools

When a workspace folder is selected, the assistant gets a set of filesystem tools
that are confined to that folder (`src/main/tools/workspace.ts` blocks any path
that escapes it). Read-only tools (`list_directory`, `read_file`, `search_files`,
`get_file_info`, `read_file_range`, `read_multiple_files`, `git_status`,
`git_diff`) never require approval. The `fetch_url` web tool lets the assistant read public URLs it already knows
about. The `web_search` tool turns a query into result titles, URLs, and
snippets using a provider chosen in Settings:

- **SearXNG** — self-hosted, unlimited, no API key.
- **Brave Search** — 2,000 queries/month free.
- **Tavily** — 1,000 API calls/month free.
- **Google Programmable Search** — 100 queries/day free.

When the provider is "none", `web_search` is not registered and cannot be called.
Mutating tools (`write_file`, `edit_file`, `delete_file`, `move_file`,
`delete_directory`, `run_command`) ask for approval when the "Require approval"
setting is on. `create_directory` is a mutation but is treated as low-risk and
does not require approval.

#### Self-hosted SearXNG

To use the free SearXNG provider, start the bundled Docker Compose file:

```bash
docker compose -f docker-compose.searxng.yml up -d
```

Then choose **SearXNG (self-hosted)** in Settings → Web Search. The default URL
is `http://localhost:8080`.

### How the local Llama system works

1. **Lazy engine init.** `node-llama-cpp` is ESM-only and heavy, so
   `LlamaService` imports it via dynamic `import()` on first use — the app starts
   instantly and the main process stays CommonJS-compatible.
2. **Load.** `LlamaService.loadModel()` calls `getLlama()` → `loadModel()` →
   `createContext()`, replacing any previously loaded model and emitting state.
3. **Chat.** For each turn, a `LlamaChatSession` is (re)used per conversation.
   Prior turns are replayed on conversation switch so context is preserved.
   Tokens stream back to the renderer over the `chat:stream` channel and the
   invoke resolves with final stats.
4. **Stop.** Each generation runs under an `AbortController`; the Stop button
   aborts it and returns the partial text already produced.
5. **State broadcast.** Any engine state change (`loading → ready → generating`)
   is pushed to every window and reflected in the status badge instantly.

## Where future features go

| Feature                             | Where to build it                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **In-app model downloads**          | Add a `ModelDownloader` in `src/main/llama/`, consume `shared/recommendedModels.ts`, expose `models:download` in `shared/ipc.ts`, add progress events, then re-scan. |
| **Conversation persistence**        | Add a `ConversationStore` in `src/main/` (JSON or SQLite); hydrate `chatStore` on launch. The store shape is already persistence-ready.                              |
| **Remote providers** (OpenAI, etc.) | Introduce a `providers/` layer in main behind the same chat IPC; `ModelInfo.source` is already an enum for this.                                                     |
| **Agents / tools**                  | Layer on top of `LlamaService` (node-llama-cpp supports function calling); add an `agents/` feature folder in the renderer.                                          |
| **Coding workflows**                | New feature folder under `renderer/features/` (e.g. `workspace/`) reusing the chat engine.                                                                           |
| **Light theme**                     | Override the tokens in `styles/theme.css`; the UI already references variables only.                                                                                 |

## What to build next

1. **In-app model downloads** with progress — turns the Recommended list into
   one-click setup (the highest-leverage next step for "easy setup").
2. **Conversation persistence** so chats survive restarts.
3. **Syntax highlighting** in code blocks (drop a highlighter into `CodeBlock`).
4. **Packaging & auto-update** via the existing `electron-builder.yml`.

## License

UNLICENSED — private project foundation.
