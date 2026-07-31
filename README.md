<p align="center">
  <img src="docs/assets/anodex-readme-hero.png" alt="An abstract violet portal, representing Anodex's local-first AI workspace" width="100%" />
</p>

<h1 align="center">Anodex</h1>

<p align="center">
  <strong>Local-first AI for real project work.</strong>
</p>

<p align="center">
  A private desktop workspace for thinking, building, researching, and automating—on your terms.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-1c2333?style=flat-square" alt="Windows, macOS, and Linux" />
  <img src="https://img.shields.io/badge/AI-local--first-6d4aff?style=flat-square" alt="Local-first AI" />
  <img src="https://img.shields.io/badge/built_with-Electron%20%2B%20TypeScript-1c2333?style=flat-square" alt="Built with Electron and TypeScript" />
</p>

<p align="center">
  <a href="#availability">Availability</a>
  &nbsp;&middot;&nbsp;
  <a href="docs/FEATURES.md">Explore features</a>
  &nbsp;&middot;&nbsp;
  <a href="ROADMAP.md">View roadmap</a>
</p>

## The assistant that works where you do

Anodex brings capable AI into a focused desktop workspace. Run open models locally,
keep your conversations and project context on your own machine, and opt into cloud
services only when they are useful to you.

|                           |                                                                                                           |
| :------------------------ | :-------------------------------------------------------------------------------------------------------- |
| **Private by default**    | Core chats, models, projects, and settings live locally. No account is required for the core experience.  |
| **Ready for real work**   | Work with code, files, commands, Git, web research, and project context from one place.                   |
| **Power with oversight**  | Tool activity, approvals, diffs, and restore points make assistant actions easy to understand and review. |
| **Built to think deeply** | Turn bigger questions into source-backed research with a visible plan, evidence trail, and clear limits.  |

## A calmer way to work with AI

Anodex is designed around a simple idea: an assistant should be capable without
becoming a black box.

- **Local-first, not local-only.** Use local GGUF models through llama.cpp, then add
  optional cloud models and connected services when the task calls for them.
- **Context that carries forward.** Projects can keep instructions, notes, skills,
  attachments, checkpoints, and durable working memory together.
- **Safety built into the flow.** Workspace access is scoped, consequential actions
  are approval-gated, and changes remain reviewable and reversible.

## What you can do

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Build</h3>
      <p>Chat with local or connected models, inspect a project, edit files, run checks, review diffs, generate approved images, and keep your work grounded in a real workspace.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Research</h3>
      <p>Plan and run bounded research with direct source reading, explicit coverage checks, citations, charts, and a preserved evidence trail.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>Organize</h3>
      <p>Use project memory, reusable skills, conversation recall, change proposals, and checkpoints to keep long-running work coherent.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Automate</h3>
      <p>Schedule recurring tasks, connect trusted tools, and keep meaningful actions visible and under your control.</p>
    </td>
  </tr>
</table>

For the full product tour—including models, vision, tools, email, GitHub, MCP, and
workspace controls—see the [feature overview](docs/FEATURES.md).

## Availability

Anodex is being prepared for public release. When installers are available, they
will be published on the [Releases page](https://github.com/Anodex/Anodex/releases).

### Build from source

Until then, authorized contributors can run Anodex from source. You will need Git,
a supported Node.js LTS release, and access to this private repository.

```bash
git clone https://github.com/Anodex/Anodex.git
cd Anodex
npm install
npm run dev
```

This installs the JavaScript and native dependencies, then launches Anodex with hot
reload. Use **AI & Models** in the app to download a recommended model or add an
existing `.gguf` model.

### Optional: local vision support

If you plan to use a vision-capable local model, prepare the matching llama.cpp
server runtime for your platform first:

```bash
npm run prepare:vision
```

This downloads a pinned, checksum-verified runtime into the local checkout. It is
not required for text-only local models.

```bash
npm run build      # production build
npm run typecheck  # TypeScript validation
npm run test       # unit tests
```

## Built with intention

Electron, React, TypeScript, Zustand, CSS Modules, and `node-llama-cpp` / llama.cpp.
Anodex uses a typed Electron boundary, sandboxed workspace tools, and local
persistence to keep the desktop experience fast, private, and accountable.

## Project status

Anodex is under active development. The [roadmap](ROADMAP.md) tracks the work in
progress and the product decisions behind what comes next.

---

<p align="center">
  <sub>Private intelligence for the work that matters.</sub>
</p>
