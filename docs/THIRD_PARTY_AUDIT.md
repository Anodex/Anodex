# Third-party code audit — licensing, ownership, and what we could own

**Audited 2026-07-26.** Written ahead of a possible commercial release, to answer two
questions: what in Anodex isn't ours, and how much of it could we realistically write
ourselves without making the product worse.

Re-run the measurements before trusting the numbers — dependency trees drift. The commands
used are noted in each section.

---

## The headline

**Nothing in Anodex blocks commercial release.** There is no GPL, AGPL, or LGPL anywhere in
the production dependency tree. Every license present is permissive: it lets us sell the
product, keep our source closed, and pay no royalties.

The important consequence, easy to lose sight of: **we already own the right to ship and sell
all of it.** Rewriting a dependency gains us installer size, behavioural control, and a
smaller supply chain — never legal standing, because we already have that. Reasons to
self-implement are engineering reasons and should be weighed as such.

The one genuinely strong argument for reducing dependency count: 262 packages is 262 chances
for a compromised release to reach our users, and we cannot audit them all.

---

## What ships that we didn't write

### npm packages

262 production packages (counted as `name@version`; 240 unique names).

| License          | Count | Obligation                                         |
| ---------------- | ----- | -------------------------------------------------- |
| MIT              | 217   | Retain notice                                      |
| ISC              | 21    | Retain notice                                      |
| BSD-2-Clause     | 6     | Retain notice                                      |
| BlueOak-1.0.0    | 6     | Retain notice                                      |
| BSD-3-Clause     | 5     | Retain notice; no endorsement claims               |
| **Apache-2.0**   | 2     | Retain notice, state modifications, pass on NOTICE |
| Other permissive | 5     | `nodemailer` MIT-0, `argparse` Python-2.0, etc.    |

Apache-2.0 covers `openai` and `pdfjs-dist`. Both are unmodified, so the obligation is
paperwork only.

**Checked by hand rather than trusting metadata:** `imapflow`, `mailparser`, and `nodemailer`
all come from Postal Systems / Andris Reinman, who has moved other products in that family to
dual AGPL/commercial licensing. The installed copies are plainly MIT (verified against their
`LICENSE` files, not just the `license:` field). **Re-check on upgrade** — this is exactly the
kind of thing that changes in a minor version.

### The runtime

- **Electron 40** — MIT. Bundles Chromium (BSD-3-Clause plus a large third-party set) and
  Node.js (MIT). electron-builder already ships `LICENSE.electron.txt` and
  `LICENSES.chromium.html` into the build. This is currently the only place we are compliant
  by default.
- **llama.cpp / ggml** — MIT. Official prebuilt binaries in `resources/llama-server/`,
  downloaded by `npm run prepare:vision`, ~95 MB of DLLs. **No license file ships alongside
  them** (gap, see below).
- **node-llama-cpp** — MIT.

### Model weights

`resources/embedding-model/nomic-embed-text-v1.5.Q4_K_M.gguf`, 84 MB, bundled into the
installer for local semantic code search.

**This is the single item most worth checking before selling**, because model weights are
invisible to every dependency scanner and model licences are frequently _not_ standard open
source. Expected to be Apache-2.0 from Nomic AI, but that is an unverified recollection —
**confirm against the model card**, and confirm the provenance of that specific GGUF
quantization, which may have been produced by someone other than Nomic.

The wider version of the question: our model-recommendation and Hugging Face download system
points users at third-party models. Models a _user_ chooses are the user's business, but
anything Anodex recommends or auto-downloads deserves thought — Llama carries attribution
requirements and a 700M-MAU clause; Qwen and Gemma have their own terms.

### Trademarked assets

Twelve provider logos in `src/renderer/assets/providers/`: Anthropic, OpenAI, Google, Azure,
DeepSeek, Groq, Kimi, Mistral, OpenRouter, Qwen, xAI.

These are **trademarks, not licensed assets**. Using a logo to identify a real integration is
normally acceptable, but most of these companies publish brand guidelines with specific rules,
and a paid product attracts more scrutiny than a free one. Worth a review before charging.

### Icons

The glyphs in `src/renderer/components/Icon.tsx` are Lucide-shaped (Lucide is ISC, which
requires retaining its copyright notice). We have no attribution for them today.

### Fonts

None bundled. System fonts only. Clean.

---

## Compliance gaps to close before selling

1. **No `THIRD-PARTY-NOTICES` file** in the repo or the build, beyond Electron's own.
2. **llama.cpp binaries and the .gguf model ship with no accompanying licence text.**
3. **Icon attribution** for the Lucide-derived glyph set.
4. **`package.json` says `"license": "UNLICENSED"`, `"private": true`.** Fine today; needs a
   deliberate decision before distribution.

---

## How much could we write ourselves?

Measured by fan-out — packages and disk pulled in by each direct dependency. Two dependencies
account for **173 of the 262 packages** and share only 9 between them.

| Direct dep                  | Packages | MB   | Verdict                     |
| --------------------------- | -------- | ---- | --------------------------- |
| `node-llama-cpp`            | 91       | 42.5 | **Never**                   |
| `@modelcontextprotocol/sdk` | 91       | 14.6 | Possible, costly            |
| `pdfjs-dist`                | 1        | 35.6 | Trim, don't rewrite ✅ done |
| `openai`                    | 1        | 11.2 | Good candidate              |
| `@anthropic-ai/sdk`         | 7        | 6.8  | Good candidate              |
| `@xterm/xterm`              | 1        | 5.6  | **Never**                   |
| `imapflow`                  | 25       | 5.4  | **Don't**                   |
| `highlight.js`              | 1        | 5.2  | Already subsetted           |
| `mailparser`                | 27       | 3.9  | **Don't**                   |
| `electron-updater`          | 16       | 2.2  | Keep                        |
| `undici`                    | 1        | 1.1  | Keep — load-bearing         |
| `diff`                      | 1        | 0.6  | Replaceable, low value      |

### Never rewrite

- **llama.cpp / node-llama-cpp** — hand-written SIMD kernels across a dozen CPU
  microarchitectures, GPU backends, quantization formats. The most valuable thing we get free.
- **`imapflow` / `mailparser`** — IMAP and MIME look simple and are not. Real mail is
  malformed constantly: broken encodings, nested multipart, servers that lie about
  capabilities, UTF-7 mailbox names. These encode years of fixes against real servers.
  Rewriting them is the fastest way to make Anodex's email _worse_.
- **`@xterm/xterm`** — VT100/ANSI emulation, same reasoning.
- **`pdfjs-dist`** — font and CID decoding is where naive extractors return garbage on exactly
  the documents that matter, like invoices.

### Worth doing

- **The two provider SDKs (`openai` + `@anthropic-ai/sdk`, 18 MB combined).** Both are HTTP +
  SSE wrappers over documented REST APIs. A focused client is a few hundred lines and would
  give direct control over streaming and tool-call delta accumulation — historically our
  reliability battleground. The risk is what SDKs quietly do well: retry with backoff,
  distinguishing retryable from fatal errors, mid-stream disconnects, tracking API changes.
  Budget a week each; keep them behind the existing `LlmProvider` seam so they can be A/B'd.
- **`@modelcontextprotocol/sdk`** is the biggest package-count prize (91) and MCP is just
  JSON-RPC 2.0 over stdio/SSE. The reason to hesitate is the _ongoing_ cost: MCP is a moving
  spec and remote-server OAuth is fiddly. We would be tracking someone else's spec forever to
  save 14 MB. Only worth it if supply-chain surface becomes the primary concern.
- **`diff`** — Myers diff is a well-specified ~150-line algorithm with one call site.

### Realistic ceiling

Roughly **40 MB off the installer with no quality loss**, most of it packaging config rather
than code. Beyond that — MCP, PDF, email protocols — we trade quality or months of work for
diminishing returns.

---

## Two corrections worth recording

Both were claims made during this audit that did not survive checking the code. Noted so they
are not repeated:

1. **`undici` is not removable.** It is imported in `webTools.ts` for a per-hop
   `undici.Agent` that pins a resolved IP address into the TCP connection — that is the SSRF
   defence for `fetch_url`. An earlier grep was truncated and appeared to show it referenced
   only in comments.
2. **`highlight.js` is already subsetted.** `src/renderer/lib/highlight.ts` imports
   `highlight.js/lib/core` plus individual languages, so Vite tree-shakes it. There was no
   language-subsetting win to take.

---

## What was done on 2026-07-26

### `html-to-text` replaced with our own converter

New: `src/main/tools/htmlToText.ts`, with `src/main/tools/__tests__/htmlToText.test.ts`.

**This did not reduce the package count** — `mailparser` depends on `html-to-text` too, so it
stays in the tree. The wins are different:

- **Better extraction.** The old pipeline had a downstream filter,
  `looksLikeBoilerplatePassage`, whose comment documents `html-to-text` flattening navigation
  menus and footers into research "evidence". Our converter drops page chrome at the source
  (`<nav>`, `<header>`, `<footer>`, `<aside>`, `<form>`) and narrows to `<main>`/`<article>`
  when a page marks its content. The filter stays as a second line of defence for pages that
  mark nothing.
- **Also better:** table cells get a separator instead of running together, `<pre>` blocks keep
  their indentation, and entity decoding resolves `&amp;lt;` to the literal `&lt;` a page wrote
  rather than double-decoding it.
- One fewer direct dependency to track and audit; if `mailparser` is ever replaced,
  `html-to-text` leaves with it.

Two bugs found and fixed while writing it, both caught by the tests: list items were each
becoming their own passage (which would have blinded the boilerplate detector, since it counts
markers _within_ a passage), and table-cell separators were being overridden by the generic
block rule.

**Pre-existing behaviour noted, not changed:** `looksLikeBoilerplatePassage` matches whitespace
on _both_ sides of a list marker, and passages are trimmed before testing — so the first item's
marker never counts and the effective threshold is 7 items, not the 6 the constant suggests.

### Packaging trims

`electron-builder.yml` now excludes two groups from the asar. electron-builder copies
production `node_modules` in regardless of the `files` patterns, which is why these are needed.

1. **Renderer-only libraries** — `highlight.js`, `@xterm/*`, `zustand`, `immer`,
   `use-sync-external-store`, `diff`. Vite bundles these into `out/renderer`, so their package
   sources were shipping twice. Verified no `src/main` or `src/preload` file imports any of
   them, and verified the renderer bundle inlines them.
   **If one of these ever moves into the main process, it will work in dev and fail at
   require-time in a packaged build.** Re-check this list first.
2. **Unused `pdfjs-dist` subdirectories** — `build`, `web`, `image_decoders`, `cmaps`,
   `standard_fonts`, `types`. We load exactly one entry point,
   `pdfjs-dist/legacy/build/pdf.mjs`. `cmaps` is excluded because `cMapUrl` is not configured,
   so pdf.js cannot load them anyway — **wiring that up is what would improve CJK PDF text
   extraction**, not shipping the files.

Plus source maps, READMEs/CHANGELOGs, and test/example/docs directories. The markdown pattern
is deliberately narrow: a blanket `*.md` exclusion would drop the `LICENSE.md` files some
packages use, which are exactly what has to ship.

**Result: app.asar 54.3 MB → 40.4 MB.** Larger than it looks — that build also _added_
`pdfjs-dist` (17.6 MB of `legacy/`), so the exclusions themselves are worth roughly 31 MB.
Installer: 495.6 MB, dominated by the llama.cpp runtime and the embedding model.

Verified after the build: entry points and `LICENSE` files intact for everything kept, all
main-process dependencies present, renderer-only packages absent.

---

## Suggested next steps

1. Generate `THIRD-PARTY-NOTICES.md` from the dependency tree, add the llama.cpp / model /
   Lucide entries, and ship it via `extraResources`.
2. Confirm the nomic-embed-text-v1.5 licence from its model card.
3. Review the provider-logo trademark question.
4. Decide the `package.json` licence field.
5. Optional, later: replace the two provider SDKs.
