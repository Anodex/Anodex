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
  <img src="https://img.shields.io/badge/platform-Windows%20tested-1c2333?style=flat-square" alt="Windows is the currently tested platform" />
  <img src="https://img.shields.io/badge/AI-local--first-6d4aff?style=flat-square" alt="Local-first AI" />
  <img src="https://img.shields.io/badge/built_with-Electron%20%2B%20TypeScript-1c2333?style=flat-square" alt="Built with Electron and TypeScript" />
</p>

<p align="center">
  <a href="https://github.com/Anodex/Anodex/releases">Download</a>
  &nbsp;&middot;&nbsp;
  <a href="docs/FEATURES.md">Explore features</a>
  &nbsp;&middot;&nbsp;
  <a href="#take-it-with-you">On your phone</a>
  &nbsp;&middot;&nbsp;
  <a href="CONTRIBUTING.md">Contribute</a>
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

## Take it with you

Anodex has a native Android companion: [**Anodex Mobile**](https://github.com/Anodex/anodex-mobile).

Pair it over a QR code from **Settings → Remote** and you get Chat, Workspace, Agents,
Email and Scheduler on your phone. Every bit of the work still happens on your machine
— the phone renders, asks and answers; it never runs a model, holds a workspace,
executes a tool, or touches a file. Your models, projects, keys and history do not
leave your PC.

Start an agent run from away and watch it work. Read what it changed before it lands.
See from a locked screen what the computer is doing right now.

## Availability

Installers are published on the [Releases page](https://github.com/Anodex/Anodex/releases)
for Windows, macOS and Linux. Every release is signed against a key compiled into the
app, and the in-app updater refuses an update it cannot verify.

**Platform status:** Windows is the currently tested platform. macOS and Linux build and
publish on every release but are not yet tested, so they are not advertised as supported.

### Build from source

You can also run Anodex from source. You will need Git and a supported Node.js LTS
release.

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

Creating a Windows installer with `npm run dist` also requires the .NET 8 SDK;
it compiles the self-contained, bounded desktop-control helper before packaging.

## Built with intention

Electron, React, TypeScript, Zustand, CSS Modules, and `node-llama-cpp` / llama.cpp.
Anodex uses a typed Electron boundary, sandboxed workspace tools, and local
persistence to keep the desktop experience fast, private, and accountable.

## Source available, not open source

Anodex's source is published so you can read it, audit it, learn from it, and check that
the software does what it says — which matters more than usual for something that runs
models and edits files on your machine. It is not an open-source licence: redistribution,
republished builds, and derivative products are not granted by default, and Anodex remains
copyright © 2026 Anodex. See [LICENSE.md](LICENSE.md).

That limit is about ownership and distribution. It is not about keeping people out.

**Bug reports, reproduction cases, UX criticism, performance findings and feature ideas
are all welcome**, and they are the most useful thing you can send — the project is
maintained centrally, so the usual shape is that you describe the problem and the fix gets
written here. [CONTRIBUTING.md](CONTRIBUTING.md) explains how that works, and the terms
that apply if you do send code.

Security findings are welcome too, and have their own private channel:
[SECURITY.md](SECURITY.md).

Anodex is built on a great deal of software other people wrote, none of which the licence
above covers. Those components keep their own terms, and their licences and copyright
notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — generated from what is
actually installed, and packaged into the application so the notices ship with the code they
belong to.

## Project status

Anodex is under active development. The [roadmap](ROADMAP.md) tracks the work in
progress and the product decisions behind what comes next.

---

<p align="center">
  <sub>Private intelligence for the work that matters.</sub>
</p>
