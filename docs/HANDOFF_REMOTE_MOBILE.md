# Handoff — Anodex Remote (Android client)

**Status:** design only. No code has been written. Nothing in `src/` has been changed for this.
**Written:** 2026-09-05.
**Design mockup:** [`docs/ui-samples/anodex-mobile.html`](ui-samples/anodex-mobile.html) —
published at <https://claude.ai/code/artifact/3b6de307-3df6-4cfa-bfef-baab85b7859a>.

This document is self-contained. A session picking it up cold should not need the conversation that
produced it. Every architectural claim below was verified against the tree at commit `cf8e62f`
(branch `main`) — re-verify before trusting any of it, the same way you would any other stale doc.

---

## 1. What is being proposed

An Android client that **controls the desktop Anodex app**. The phone runs nothing: no model, no
inference, no tools, no filesystem access. It renders the stream coming off the desktop and answers
the questions that block it. All work happens on the PC exactly as it does today.

This is deliberately **not** "Anodex on your phone". Parity is the failure mode — it turns a
two-week project into a six-month one competing with the desktop app for attention.

### The actual argument for building it

Anodex has agents, a scheduler, and unattended runs with budgets. `needsTurnGate` in
`src/main/tools/permissions.ts` guarantees at least one human checkpoint per turn _even in
untethered mode_ — a good safety design, but it means the more autonomous Anodex gets, the more
time it spends frozen waiting for a person who is not in the room.

**The product is a remote approval-and-monitoring surface.** It unlocks autonomy features that are
already built and paid for. Judge every scope decision against that sentence.

### The arguments against, recorded honestly

- It is the **first feature that adds an attack surface**. Everything else Anodex does is contained
  to the machine. This opens a listening socket into a process with `run_command` and a terminal
  that is explicitly not sandboxed (`src/main/terminal/TerminalService.ts`). The security design is
  the bulk of the work, not a footnote.
- **It cannot really be "finished."** LAN-only is the honest version and will feel limiting within a
  week. The escape is a relay server, which means hosting, uptime, and routing a local-first app's
  traffic through third-party infrastructure. That is a change to what Anodex _is_, not a feature.
- **Opportunity cost.** The standing rule from the reliability work (see the `anodex-guard-restraint`
  memory) is to build what a real failure demands. Several existing frontiers are half-finished.

---

## 2. Do this first — Phase 0, the cheap 10%

**Do not start Phase 1 until Phase 0 has run for two weeks.**

Phase 0 is notify-only. The desktop pushes outbound to your phone (ntfy.sh, Pushover, or a Telegram
bot) on three events:

- an agent run or turn is **blocked on a confirmation**
- a run **finished**
- a run **exhausted its budget** or died

Outbound HTTPS only. No listening port, no pairing, no TLS, no attack surface, ~50 lines in main.
Hook it where `requestToolConfirmation` is called and where `AgentRunService` settles a run.

**The decision gate:** after two weeks, which is true?

| Observation                                                   | What to do                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| "I kept wishing I could tap **Approve** on the notification." | Build Phase 1. The value is proven and you know which screens matter. |
| "Knowing was enough — I got to the PC when I could."          | Stop here. Phase 0 _is_ the feature. Close this document.             |
| "I was never away from the machine anyway."                   | Stop here, and delete the notifier too.                               |

This gate exists because the whole project rests on one unmeasured assumption: that runs sit blocked
while nobody is there to answer. Phase 0 measures it for the cost of an afternoon.

---

## 3. Architecture findings (verified)

### 3.1 The renderer already has exactly one seam

```
src/renderer/lib/anodex.ts   →   export const anodex: AnodexApi = window.anodex
```

That is the **only** place in the renderer that reads `window.anodex`. Two other files match a grep
for the string: `src/renderer/stores/__tests__/chatStore.test.ts` (a test) and
`src/renderer/features/settings/pages/about/updateStatusText.ts` (a _comment_ explaining why the
module was split out — no actual call).

Every component imports `anodex` as a normal module. **Point that one module at a socket and the
entire renderer works over a network unchanged.** This is the single fact that makes the project
tractable, and it was an accident of good hygiene, not a design for this.

### 3.2 The API surface maps onto network RPC almost 1:1

- `src/shared/ipc.ts` — 923 lines, **183 channel strings** in the `IpcChannel` enum.
- `src/main/ipc/*.ts` — **178 `ipcMain.handle` registrations** across 31 handler files.
- Every call is `invoke(channel, ...args) → Promise`, plus event subscriptions via
  `subscribe(channel, listener)` in `src/preload/index.ts` (335 lines).

That shape is request/response plus server-push. It becomes:

```
client → server   { id, channel, args }
server → client   { id, ok: true,  result }
server → client   { id, ok: false, error }
server → client   { event: channel, payload, seq }   // no id — a push
```

### 3.3 Most handlers do not touch Electron at all

Counted across `src/main/ipc/*.ts`:

| Signature                                                            | Count | Meaning                                                       |
| -------------------------------------------------------------------- | ----- | ------------------------------------------------------------- |
| `(_event, …)`                                                        | 118   | Ignores the event entirely — travels as-is, no changes needed |
| `(event)` / `(event, …)`                                             | 22    | Takes it                                                      |
| real uses of `event.sender` / `BrowserWindow.fromWebContents(event)` | 21    | Must be handled explicitly                                    |

The 21 real uses are: native dialogs (`attachments`, `backup`, `project`, `workspace`, `model`,
`settings`, `diagnostics`), PDF export (`criticalThinking`), and the chat streaming path.

**Design rule that follows:** the bridge must re-dispatch to the _same_ handler functions. Do not
fork the handlers into a second implementation. A forked handler is a second place every future
feature has to be added, and it will silently drift.

### 3.4 Existing precedent for a local server

- `src/main/tools/inspectionServer.ts` — a confined HTTP server. Read its doc comment before writing
  any of this; the confinement pattern (bind 127.0.0.1, ephemeral port, per-session random token
  prefix, `resolveInWorkspace` on every path, GET/HEAD only, lifetime scoped to one operation) is
  the house style and should be extended, not reinvented.
- `src/main/oauth/loopbackServer.ts` — 160 lines, the PKCE loopback listener.

Note the difference in threat model, though: the inspection server serves read-only files to a local
browser. The remote bridge exposes **tool execution to another device.** The pattern is a starting
point, not a sufficient answer.

### 3.5 Broadcasting is already centralised

`src/main/broadcast.ts` — `sendToWindow(window, channel, ...args)` and
`broadcastToWindows(channel, ...args)`, both frame-disposal safe. Remote fan-out belongs here: one
file, and every existing caller gets remote delivery for free.

### 3.6 The confirmation system is already multi-client, almost

This is the best find in the codebase for this project. In `src/main/ipc/tools.handlers.ts`:

- `pendingConfirmations` is a **module-level map keyed by request id**, not per-window.
- The `Tools.confirmResponse` handler is registered as `(_event, id, response) => …` — it **ignores
  the event entirely**. Any client that knows the id can already answer any pending confirmation.
- `Tools.confirmCancelled` already exists (`src/shared/ipc.ts:220`) for the case where a request was
  _settled somewhere other than the client showing the card_, so that client drops its dead prompt.

So the design already anticipates a request being answered by someone other than the asker. What is
missing is only the fan-out: `requestToolConfirmation` currently does
`sender.send(IpcChannel.Tools.confirmRequest, request)` to one `WebContents`, and the same for
`confirmCancelled`. Both need to go to every attached client instead.

Also note (`tools.handlers.ts:44-55`): a `turnGate: true` request deliberately bypasses remembered
"always allow this tool" approvals. Preserve that on the remote path — it is the once-per-turn human
checkpoint, and quietly satisfying it from a phone would defeat its purpose.

---

## 4. The three refactors required in existing code

These are the only invasive changes. Everything else is additive.

### 4.1 `chat.handlers.ts` — replace `event.sender` with a reply channel

`src/main/ipc/chat.handlers.ts:50-74` streams tokens, thinking, tool activity and confirmation
requests directly to `event.sender`. That is point-to-point to the originating renderer.

Introduce a small interface — a `ClientChannel` with `send(channel, payload)` and an `isAlive()` —
implemented twice: once wrapping `WebContents`, once wrapping a WebSocket. Resolve it once per
generation from whoever initiated the turn.

This is a good refactor regardless of whether the mobile client ever ships: it removes the chat
pipeline's hard dependency on Electron's window model.

### 4.2 `requestToolConfirmation` — take a channel, and fan out

`src/main/ipc/tools.handlers.ts:39` is `requestToolConfirmation(sender: WebContents, …)`. Change the
parameter to the same `ClientChannel` abstraction, and broadcast `confirmRequest` /
`confirmCancelled` to all attached clients rather than one.

Add **expiry** while you are here (see §6). It does not exist today and the remote path needs it.

### 4.3 `broadcast.ts` — fan out to sockets

Add remote clients to `broadcastToWindows`. Keep it dependency-light as its doc comment insists.

---

## 5. Client strategy — decided

**Serve the existing React renderer as a mobile web app**, hosted by the desktop, wrapped in a thin
Android shell (WebView / Capacitor / TWA).

Rejected: a native Kotlin/Compose client. It means reimplementing the client half of 183 channels in
a second language, and every future Anodex feature becomes a two-sided change. For a solo maintainer
that is where the project dies.

The cost of the web approach is real and should be planned for: the current UI is a desktop app
(sidebar, workspace dock, file tree, diff viewer, xterm terminal) and needs a responsive pass. Do it
**by scoping, not by squeezing** — render a small mobile-specific shell around the existing chat
components rather than trying to make the whole desktop layout collapse gracefully.

---

## 6. Protocol and reliability requirements

These are the requirements a naive implementation will miss. Each one exists because of a specific
failure.

| Requirement                                                                                        | Failure it prevents                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sequence numbers per conversation** on every pushed event, and a `resume(afterSeq)` on reconnect | A dropped socket mid-stream loses tokens and corrupts the transcript. The conversation store on disk is authoritative, so replay is possible — but only if you number the events. |
| **Confirmation expiry** (a visible countdown, ~5 min, then auto-deny)                              | The phone walks out of Wi-Fi with a prompt on screen. `requestToolConfirmation` returns a promise that would otherwise never settle, wedging the generation forever.              |
| **The desktop keeps showing the same prompt** while a phone has it                                 | Otherwise the answer is hostage to the device that happens to be holding it. `confirmCancelled` already exists to drop the loser's card.                                          |
| **Heartbeat + explicit `offline` state in the UI**                                                 | A silently dead socket that still looks connected is worse than a visibly disconnected one.                                                                                       |
| **Backpressure on the token stream**                                                               | Local generation can outrun a phone on cellular. Coalesce tokens into ~50ms frames rather than one message per token.                                                             |
| **Explicit refusal for desktop-only channels**                                                     | A remote call to `attachments:pick-files` would pop a native dialog on the _host_ machine, in front of nobody. Refuse with a named error; never fail silently.                    |

---

## 7. Security model — non-negotiables

Anodex writes files, runs commands, and ships a terminal that is deliberately not sandboxed. An open
port into it is remote code execution on the user's PC for anyone who reaches it. These are
requirements, not preferences.

1. **Off by default.** No listener until explicitly enabled in Settings.
2. **Visibly on.** While listening, the desktop title bar says so and says how many devices are
   attached. An open port the user forgot about is the failure mode to design against.
3. **One device, one key.** Pairing mints a key bound to that phone. Listed in Settings with a
   last-seen timestamp and a Revoke button. No shared password. Store keys via `safeStorage`,
   following the pattern in `src/main/email/EmailAuthStore.ts` — never in `settings.json`.
4. **Pairing is out-of-band and mutually verified.** QR on the phone, scanned at the desktop, and a
   short fingerprint shown on _both_ screens that the user confirms matches.
5. **TLS with a self-signed cert the phone pins at pairing.** You cannot get a real cert for a LAN
   IP. Pin at pairing time and refuse on mismatch afterwards.
6. **A remote session's permission mode is capped.** Regardless of the desktop's
   `general.permissionMode`, a remote client never operates untethered. Untethered exists because a
   human is sitting there; a phone in a pocket is precisely the case it was never meant to cover.
   Enforce in `resolvePermission`'s caller, not in the UI.
7. **LAN only, and honest about it.** Bind to the local network. Off-network access is the user's own
   Tailscale or tunnel. **Do not build a relay.** Anodex running a server that user traffic passes
   through contradicts the product.
8. **Rate-limit and cap the auth attempt count** on the listener, and log every connection to
   `diagnostics`.

---

## 8. Scope — every surface decided once

| Surface                                              | On the phone             | Why                                                                                                                 |
| ---------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `chat:stream`, `chat:send`, `chat:stop`              | **Ships first**          | The reason the client exists. Needs the sequence-number resume from §6.                                             |
| `tools:confirm-request` / `-response` / `-cancelled` | **Ships first**          | Unblocking a paused run from another room is the single strongest argument for the project. Nearly free — see §3.6. |
| `agent:*`, `scheduler:*`                             | **Ships first**          | Read-mostly, small payloads, exactly what you want to glance at away from the desk.                                 |
| `conversations:list` / `get-state`                   | **Ships first**          | Needed to render anything. Read-only.                                                                               |
| `models:get-state` (read)                            | **Ships first**          | Feeds the host bar — which model is loaded, how full the context is.                                                |
| `email:*`                                            | **Later**                | Already a list-and-read UI so it ports cleanly, but you have a mail app. Earns its place last.                      |
| `git:*`, `checkpoints:*`                             | **Read only**            | Seeing what changed is useful on a phone. Reviewing a diff and committing is a desk job.                            |
| `terminal:*`                                         | **Desktop only**         | xterm on a 390px screen with a software keyboard, against a shell that is not a real PTY. No.                       |
| `attachments:pick-*`                                 | **Rebuilt, not proxied** | Opens a native dialog on the _host_. The phone needs its own picker that uploads.                                   |
| `models:add` / `download` / `load`                   | **Desktop only**         | Loading a 30B model is something you do at the machine, deliberately.                                               |
| `computerControl:*`                                  | **Desktop only**         | Driving the host's mouse from a phone is a category of bad idea.                                                    |
| Settings, MCP config, memory editing                 | **Desktop only**         | Configuration surfaces. No reason to be remote, and each one widens the blast radius.                               |

---

## 9. Build plan

| Phase | Deliverable                                                                                                                                     | Rough cost   |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **0** | Outbound push notifier + the two-week decision gate (§2)                                                                                        | an afternoon |
| **1** | `ClientChannel` refactor (§4) + `RemoteBridge` WS server, no auth, localhost only, driven from a desktop browser tab with a swapped `anodex.ts` | a weekend    |
| **2** | Pairing, key storage, TLS + pinning, permission cap, Settings → Remote panel with device list and revoke                                        | ~1 week      |
| **3** | Mobile shell: host bar, chat view, approval card, agent list, bottom tabs. Sequence-number resume, confirmation expiry, backpressure            | ~1–2 weeks   |
| **4** | Android wrapper (Capacitor/TWA), FCM or fallback to Phase 0's notifier for background alerts                                                    | ~1 week      |

Phases 1 and 2 are not separable in practice — do not leave an unauthenticated bridge lying around
between them, even locally.

---

## 10. Open questions the user must answer

1. **Has a run actually sat blocked while you were away from the machine, and how often?** This is
   the Phase 0 gate and the entire justification. Nobody can answer it from the code.
2. **Android only, or should the web client be device-agnostic?** The web approach makes an iPad or
   a second laptop nearly free; the wrapper is the only Android-specific part.
3. **Is Tailscale acceptable as the off-network answer?** If not, the honest answer is "LAN only,
   forever," because the alternative is a relay and §7.7 rules that out.
4. **Should a paired phone be able to _start_ work, or only watch and approve?** Watching and
   approving is a far smaller trust surface. Starting a turn from a phone means arbitrary prompts
   into a machine with a shell. Recommended: approve-and-watch in Phase 3, sending in Phase 4 behind
   its own setting.

---

## 11. Design reference

`docs/ui-samples/anodex-mobile.html` is the visual spec. It follows the house convention for that
folder: tokens mirrored from `src/renderer/styles/theme.css` and
`src/renderer/styles/themes/midnight.css`, with a `data-theme='light'` block mirroring
`themes/light.css`, and a dark/light toggle.

It contains four screens (home, live turn, approval, agent runs) plus the pairing screen, and its own
copy of the scope table in §8. Two pieces of UI in it have no desktop equivalent and are the only
genuinely new design work:

- **The host bar** — which machine you are driving, its connection state, which model it has loaded,
  how full its context is. Present on every screen. Without it the phone gives no sense that the work
  is happening elsewhere.
- **The approval card's expiry row** — a visible countdown plus "or answer on desktop". This is the
  UI expression of two §6 requirements, and it is what stops a phone in a dead spot from wedging a
  turn.

Everything else in the mockup is the existing Anodex design system applied at a smaller size. The
chat screen deliberately reuses the real proportions from `MessageBubble.module.css` (user bubble
capped at ~72–78% width, assistant text unbubbled) and the approval card mirrors
`ToolConfirmCard.module.css` including its 2px pulsing left edge.

---

## 12. Notes for whoever picks this up

- **Re-verify the counts in §3 before relying on them.** They were taken at `cf8e62f`. The commands:
  `grep -oE "'[a-zA-Z]+:[a-zA-Z-]+'" src/shared/ipc.ts | sort -u | wc -l` (183),
  `grep -rn "ipcMain.handle" src/main/ipc/*.ts | wc -l` (178),
  `grep -rhoE "\(_?event[,)]" src/main/ipc/*.ts | sort | uniq -c` (118 / 17 / 5).
- **Do not fork the IPC handlers.** §3.3. If you find yourself writing a second implementation of a
  handler for the remote path, stop and fix the dispatch instead.
- **Do not build the relay.** §7.7. If off-network access becomes the priority, that is a separate
  decision with the user, not an implementation detail of this work.
- **Nothing here is started.** There is no branch, no stub, no partial implementation to find. If a
  later memory or doc claims otherwise, check `git log` before believing it.
